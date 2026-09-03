// ── Provider throttle (throttle.ts) ───────────────────────────────────────────
// Two independent guards, both keyed by the catalog `provider` string (lowercase):
//
//   1. Chat pacing + cooldowns — per-process. Every outbound chat request
//      crosses `acquireProvider(provider)` first, which enforces a minimum
//      interval between calls to the SAME provider (so a burst of prompts never
//      trips the provider's RPM limit). When a call comes back 429 (rate limit)
//      / 402 (quota) / 401 (bad key), `markProviderCooldown()` puts the whole
//      provider on a timeout so the next attempt skips it instead of hammering it.
//
//   2. Daily probe budget — persisted to throttle-state.json (gitignored),
//      used ONLY by the health monitor. The monitor's auto-probes must never
//      consume a user's billable daily quota (e.g. OpenRouter free-tier allows
//      50 free-model requests/day — one eager passing would burn them all).
//      `dailyRemaining(provider)` returns how many probes are still allowed
//      today and `spendProbe(provider)` increments the counter. Budgets reset
//      at UTC midnight and survive restarts.
//
// Every knob is env-overridable:
//   ENZO_THROTTLE_PACING_<PROVIDER>_MS      min ms between chat calls
//   ENZO_THROTTLE_COOLDOWN_<PROVIDER>_MS    cooldown after 429/402/401
//   ENZO_HEALTH_DAILY_BUDGET_<PROVIDER>     probes per day for the health monitor
//
// Called by: index.ts (every outbound chat call + thunder-pause pacing),
// health.ts (the daily probe budget), model-sync.ts (paces catalog scraping).
// Guard 1 is per-process and in-memory; guard 2 persists. ponytail: both are
// single-instance assumptions — two replicas each get the full pacing allowance.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, 'throttle-state.json');

// ── 1. Chat pacing + cooldowns ────────────────────────────────────────────────
// Conservative per-provider intervals. Chat waits use a small "earliest time"
// table, so N simultaneous users to the same provider queue up instead of
// bursting past the RPM cap.
const DEFAULT_PACING_MS: Record<string, number> = {
  openrouter: 1500,
  groq: 1000,
  nvidia: 1600, // NVIDIA NIM free tier caps at 40 RPM → 60s/40 = 1500ms min; 1600ms keeps headroom
  pollinations: 600,
  hf: 800,
  huggingface: 800,
  llm7: 2000, // LLM7 free tier 30 RPM (120 RPM with token) → 2000ms keeps clear headroom
  google: 2000, // free Flash tier ~5-15 RPM per project → 2000ms stays well under the 1580ms floor
  puter: 2000, // user-pays credits → conservative so pacing never wastes the user's balance
  cloudflare: 2000, // Workers AI free tier ~50 neurons/min → stays clear of the burst cap
};

// How long to park a provider after a rate-limit/quota/auth response.
const DEFAULT_COOLDOWN_MS: Record<string, number> = {
  openrouter: 90_000,
  groq: 30_000,
  nvidia: 60_000,
  pollinations: 20_000,
  hf: 30_000,
  huggingface: 30_000,
  llm7: 30_000,
  google: 60_000, // 429s on Google default to 60s (they roll over the same rolling window)
  puter: 30_000,
  cloudflare: 30_000,
};

function pacingMs(provider: string): number {
  const key = `ENZO_THROTTLE_PACING_${provider.toUpperCase()}_MS`;
  const env = Number(process.env[key]);
  return Number.isFinite(env) && env >= 0 ? env : (DEFAULT_PACING_MS[provider] ?? 1000);
}

function cooldownMs(provider: string): number {
  const key = `ENZO_THROTTLE_COOLDOWN_${provider.toUpperCase()}_MS`;
  const env = Number(process.env[key]);
  return Number.isFinite(env) && env >= 0 ? env : (DEFAULT_COOLDOWN_MS[provider] ?? 60_000);
}

// Earliest allowed call time per provider (ms epoch). Reserved synchronously so
// concurrent callers pick distinct slots even while awaiting.
const nextAllowedAt = new Map<string, number>();
// Providers parked by a rate-limit/quota/auth response — skip until this time.
const cooldownUntil = new Map<string, number>();

/** Wait until this provider accepts another outbound request (pacing only). */
export async function acquireProvider(provider: string): Promise<void> {
  recordProviderRequest(provider);
  const now = Date.now();
  const prev = nextAllowedAt.get(provider) ?? 0;
  const slot = Math.max(now, prev);
  nextAllowedAt.set(provider, slot + pacingMs(provider));
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** True when the provider is parked (recent 429/402/401) and should be skipped. */
export function isProviderCooledDown(provider: string): boolean {
  return (cooldownUntil.get(provider) ?? 0) > Date.now();
}

/** Park a provider after a throttle-worthy upstream response. */
export function markProviderCooldown(provider: string, ms?: number) {
  cooldownUntil.set(provider, Date.now() + (ms ?? cooldownMs(provider)));
}

/** Remaining ms until a parked provider is usable again (0 = usable now). */
export function providerCooldownMs(provider: string): number {
  return Math.max(0, (cooldownUntil.get(provider) ?? 0) - Date.now());
}

// ── 1b. Rolling RPM window + thunder-pause ─────────────────────────────────
// The per-request pacing above prevents self-inflicted bursts, but a LONG
// coding build (many auto-continuation rounds back-to-back) can still cross a
// provider's *effective* per-minute ceiling — NVIDIA advertises 40 RPM but
// throttles at ~20 on the free tier. Crossing it mid-fence gets the whole
// build hard-429'd. So every request is logged into a sliding 60s window and
// the chat attempt loop reads `rpmUsed()` — when a route's window is at the
// provider's soft ceiling it parks the STREAM for `streamPauseMs()` (SSE
// keepalives + a status event) instead of letting the provider cut us off,
// then resumes exactly where it stopped. Knobs:
//   ENZO_STREAM_RPM_<PROVIDER>   soft per-minute ceiling for the stream pause
//   ENZO_STREAM_PAUSE_MS         how long to park when the ceiling is hit
//   ENZO_STREAM_PACING=0         disables the thunder-pause entirely
const requestLog = new Map<string, number[]>();

/** Record one outbound request at the current instant (rolling window). */
export function recordProviderRequest(provider: string): void {
  const now = Date.now();
  const q = requestLog.get(provider) || [];
  q.push(now);
  // Keep only the last 3 minutes of history — enough to answer both the 60s
  // window and the (up to 2-minute) pause tracking.
  while (q.length && q[0] < now - 180_000) q.shift();
  if (q.length > 500) q.splice(0, q.length - 500);
  requestLog.set(provider, q);
}

/** Requests fired in the last 60 seconds across this provider. */
export function rpmUsed(provider: string): number {
  const now = Date.now();
  const q = requestLog.get(provider) || [];
  let i = 0;
  while (i < q.length && q[i] < now - 60_000) i++;
  return q.length - i;
}

// Soft per-minute ceilings the stream pauses at. These sit WELL below the
// advertised caps because the providers' *real* enforced limits are lower
// (NVIDIA NIM free ≈ 20 RPM despite advertising 40) and we never want the
// provider to return a hard rate-limit mid-generation.
const DEFAULT_SOFT_RPM: Record<string, number> = {
  openrouter: 20,
  groq: 30,
  nvidia: 15,
  pollinations: 15,
  hf: 20,
  llm7: 15,
  google: 10,
  puter: 10,
  cloudflare: 20,
};

export function softRpmLimit(provider: string): number {
  const key = `ENZO_STREAM_RPM_${provider.toUpperCase()}`;
  const env = Number(process.env[key]);
  return Number.isFinite(env) && env > 0 ? env : (DEFAULT_SOFT_RPM[provider.toLowerCase()] ?? 15);
}

export function streamPauseMs(): number {
  const env = Number(process.env.ENZO_STREAM_PAUSE_MS);
  return Number.isFinite(env) && env >= 0 ? env : 120_000;
}

/** True when the rolling RPM window is at/above the provider's soft ceiling —
 *  the stream should park (thunder-pause) rather than risk a hard 429.
 *  Returns ms to pause, or 0 when the window is clear. */
export function streamPauseNeeded(provider: string): number {
  if (process.env.ENZO_STREAM_PACING === '0') return 0;
  if (rpmUsed(provider) >= softRpmLimit(provider)) return streamPauseMs();
  return 0;
}

// ── 2. Daily probe budget (persisted) ─────────────────────────────────────────
// Defaults keep the background monitor strictly out of a user's paid/free
// daily allowance. OpenRouter free-tier = 50 free-model requests/day, so the
// monitor is allowed at most ~10 probes/day and rotates which models it covers.
const DEFAULT_DAILY_BUDGET: Record<string, number> = {
  openrouter: 10,
  groq: 500,
  nvidia: 40,
  pollinations: 1, // blanket catalog probe covers the whole provider
  hf: 100,
  huggingface: 100,
  llm7: 60, // free tier 30 RPM → keep the background monitor well clear
  google: 50, // free tier ~1,500 RPD for Flash — but protect the key's quota ceiling
  puter: 20, // user-pays credits → monitor probes stay out of the user's balance
  cloudflare: 50, // free tier ~50 neurons/min over 100 prompts → keep clear of daily limits
};

interface DailyState {
  day: string; // UTC yyyy-mm-dd
  counts: Record<string, number>;
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

let state: DailyState = loadState();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function loadState(): DailyState {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as DailyState;
      if (raw && typeof raw === 'object' && raw.day) {
        if (raw.day === dayKey()) return raw;
        return { day: dayKey(), counts: {} }; // new day → fresh budget
      }
    }
  } catch {
    // corrupt state — start over
  }
  return { day: dayKey(), counts: {} };
}

function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const tmp = `${STATE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, STATE_PATH);
    } catch (err) {
      console.warn('[throttle] failed to persist daily budget:', (err as Error)?.message);
    }
  }, 300);
}

export function dailyBudgetOf(provider: string): number {
  const key = `ENZO_HEALTH_DAILY_BUDGET_${provider.toUpperCase()}`;
  const env = Number(process.env[key]);
  return Number.isFinite(env) && env >= 0 ? env : (DEFAULT_DAILY_BUDGET[provider.toLowerCase()] ?? 100);
}

/** How many probe requests this provider may still send today. */
export function dailyRemaining(provider: string): number {
  provider = provider.toLowerCase();
  if (state.day !== dayKey()) {
    state = { day: dayKey(), counts: {} };
  }
  const used = state.counts[provider] ?? 0;
  return Math.max(0, dailyBudgetOf(provider) - used);
}

/** Charge one probe against the provider's daily budget. */
export function spendProbe(provider: string): void {
  provider = provider.toLowerCase();
  if (state.day !== dayKey()) {
    state = { day: dayKey(), counts: {} };
  }
  state.counts[provider] = (state.counts[provider] ?? 0) + 1;
  persistState();
}

/** Today's probe counts (for /api/models/health diagnostics). */
export function getDailyProbeCounts(): Record<string, number> {
  return { ...state.counts };
}