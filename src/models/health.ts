// ── Model health monitor (health.ts) ─────────────────────────────────────────
// Background pass every 5 minutes (configurable) probes every catalog model and
// records live/offline status + measured latency into model-health.json.
// The store is served back to the marketplace so cards can show a live status
// dot and the real measured response time.
//
// Guardrails so probing 1000+ models never trips provider rate limits:
//   • bounded concurrency (worker pool)
//   • per-provider cooldown on 429 / auth_failed (skip the rest of that provider
//     for the current pass instead of hammering it)
//   • Pollinations models share one backend, so a single catalog probe covers
//     the whole provider
//   • image-generation models can't be probed with a chat ping → status 'n/a'
//   • passes are self-rescheduled (min interval between pass starts, no overlap)
//   • per-provider daily probe budget (throttle.ts): the monitor checks
//     dailyRemaining() before each probe and spendProbe() after, so a pass never
//     burns a user's daily quota (e.g. OpenRouter free tier = 50 req/day → 10
//     probes/day cap). Budgets persist in throttle-state.json and reset at UTC
//     midnight.
//
// Called by: index.ts (starts the monitor at boot; serves /api/models/health and
// /api/ping-model), tunnel.ts (skips a model the store already knows is offline),
// model-sync.ts (attaches last-known health to each catalog entry).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dailyRemaining, spendProbe } from '../models/throttle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_PATH = path.join(__dirname, 'model-health.json');
const POLLINATIONS_GEN = 'https://gen.pollinations.ai';

export type HealthStatus = 'online' | 'degraded' | 'offline' | 'n/a' | 'unknown';

export interface ModelHealth {
  status: HealthStatus;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

interface HealthStore {
  lastPassAt: string | null;
  lastPassDurationMs: number | null;
  passesCompleted: number;
  models: Record<string, ModelHealth>;
}

let store: HealthStore = loadStore();

function loadStore(): HealthStore {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (raw && typeof raw === 'object' && raw.models) {
        // Drop placeholder 'unknown' entries from older versions — this build
        // only records real probe results (or 'n/a' for image-gen).
        if (raw.models) {
          for (const id of Object.keys(raw.models)) {
            if (raw.models[id]?.status === 'unknown') delete raw.models[id];
          }
        }
        return raw as HealthStore;
      }
    }
  } catch {
    // corrupt / unreadable store — start fresh
  }
  return { lastPassAt: null, lastPassDurationMs: null, passesCompleted: 0, models: {} };
}

function saveStore(): void {
  try {
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.warn('[health] failed to persist model-health.json:', (err as Error)?.message);
  }
}

export function getHealthStore(): HealthStore {
  return store;
}

export function getModelHealth(id: string): ModelHealth | undefined {
  return store.models[id];
}

/** Record a live failure straight from a chat call so the health store reflects
 *  reality even before the next background pass (e.g. a 404 "model not found"). */
export function recordModelFailure(id: string, error: string, status?: number) {
  store.models[id] = {
    status: 'offline',
    latencyMs: 0,
    checkedAt: new Date().toISOString(),
    error: status === 404 || status === 400 || status === 422 ? 'unsupported' : (error || 'unknown'),
  };
  saveStore();
}

// ── Error classification (shared with /api/ping-model) ───────────────────────
export type SafeErr =
  | 'auth_failed'
  | 'rate_limited'
  | 'quota'
  | 'timeout'
  | 'unreachable'
  | 'provider_error'
  | 'unsupported'
  | 'unknown';

export class PingStatusError extends Error {
  status: number;
  constructor(status: number) {
    super(`upstream status ${status}`);
    this.name = 'PingStatusError';
    this.status = status;
  }
}

export function classifyPingError(err: any): SafeErr {
  if (!err) return 'unknown';
  if (err instanceof PingStatusError) {
    if (err.status === 401 || err.status === 403) return 'auth_failed';
    if (err.status === 429) return 'rate_limited';
    if (err.status === 402) return 'quota'; // billing/credits depleted
    if (err.status === 400 || err.status === 404 || err.status === 422 || err.status === 406) return 'unsupported';
    if (err.status >= 500) return 'provider_error';
    return 'unknown';
  }
  const name = err?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (err?.cause?.code || name === 'TypeError' || name === 'FetchError') return 'unreachable';
  return 'unknown';
}

export interface ProbeKeys {
  openrouter: string;
  huggingface: string;
  groq: string;
  pollinations: string;
  nvidia: string;
  llm7?: string;
  google?: string;
  puter?: string;
  cloudflare?: string;
  cloudflareAccount?: string;
  nvidiaBaseUrl?: string;
}

export interface ProbeRoute {
  provider: 'groq' | 'pollinations' | 'openrouter' | 'hf' | 'nvidia' | 'llm7' | 'google' | 'puter' | 'cloudflare';
  model: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: SafeErr;
}

// One live probe against the exact endpoint the tunnel routes to.
// Returns a result object — never throws.
export async function probeModelHealth(
  modelId: string,
  route: ProbeRoute,
  keys: ProbeKeys,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const retries = Math.max(0, opts.retries ?? 0);
  const provider = route.provider || 'groq';
  const start = Date.now();

  const pingOnce = async (): Promise<void> => {
    const base: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
    const chat = (headers: Record<string, string>) => ({
      ...base,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        model: route.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });

    if (provider === 'groq') {
      if (!keys.groq) throw new PingStatusError(401);
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', chat({ Authorization: `Bearer ${keys.groq}` }));
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'openrouter') {
      if (!keys.openrouter) throw new PingStatusError(401);
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', chat({ Authorization: `Bearer ${keys.openrouter}` }));
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'nvidia') {
      if (!keys.nvidia) throw new PingStatusError(401);
      const nimBase = keys.nvidiaBaseUrl || 'https://integrate.api.nvidia.com/v1';
      const r = await fetch(`${nimBase}/chat/completions`, chat({ Authorization: `Bearer ${keys.nvidia}` }));
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'hf') {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (keys.huggingface) headers['Authorization'] = `Bearer ${keys.huggingface}`;
      // Same route the tunnel posts chat to — hf-inference/models/{id} rejects
      // most models, but /v1/chat/completions is the authoritative router.
      const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
        ...base,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'llm7') {
      // LLM7 requires a key — no anonymous tier. Skip the probe when missing
      // (anonymous calls serve a rotating shared model, so they'd report
      // bogus health for the requested id).
      if (!keys.llm7) throw new PingStatusError(401);
      const r = await fetch('https://api.llm7.io/v1/chat/completions', {
        ...base,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.llm7}`,
        },
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'google') {
      // Google Gemini — keyed only (keyless model listing 404s). Free Flash
      // tier is chat-pingable exactly like any other keyed provider.
      if (!keys.google) throw new PingStatusError(401);
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        ...base,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.google}`,
        },
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'puter') {
      // Puter user-pays gateway — keyed chat only (catalog is keyless, but a
      // keyless chat probe would bill/behave unpredictably, so require a token).
      // Conservative probes so free monthly credits aren't burned by the monitor.
      if (!keys.puter) throw new PingStatusError(401);
      const r = await fetch('https://api.puter.com/puterai/openai/v1/chat/completions', {
        ...base,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.puter}`,
        },
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!r.ok) throw new PingStatusError(r.status);
    } else if (provider === 'cloudflare') {
      // Cloudflare Workers AI — keyed only (no anonymous tier), and the account
      // id is a required URL path segment. Without either, skip the probe.
      if (!keys.cloudflare || !keys.cloudflareAccount) throw new PingStatusError(401);
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(keys.cloudflareAccount)}/ai/v1/chat/completions`, {
        ...base,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.cloudflare}`,
        },
        body: JSON.stringify({
          model: route.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      });
      if (!r.ok) throw new PingStatusError(r.status);
    } else {
      // Pollinations: real lightweight GET of its model catalog — all models
      // share this backend, so it doubles as the availability probe.
      const r = await fetch(`${POLLINATIONS_GEN}/models`, base);
      if (!r.ok) throw new PingStatusError(r.status);
    }
  };

  let lastErr: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await pingOnce();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      lastErr = err;
    }
  }
  return { ok: false, latencyMs: Date.now() - start, error: classifyPingError(lastErr) };
}

// ── Background monitor ────────────────────────────────────────────────────────
export interface HealthMonitorOptions {
  catalogFile?: string;
  intervalMs?: number;
  startupDelayMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  providerCooldownMs?: number;
  providerGapMs?: Record<string, number>;
  resolveKeys: () => ProbeKeys;
  resolveRoute: (id: string) => ProbeRoute;
}

let monitorStarted = false;

// Persists across passes so rate-limited providers stay throttled, not just for
// one pass. Gaps grow adaptively on repeated 429s (never beyond 30s).
// Keyed by the catalog `provider` field, lowercased (e.g. 'HuggingFace' → 'huggingface').
const DEFAULT_GAPS: Record<string, number> = {
  openrouter: 3000, // free tier ~20 RPM
  groq: 2000, // ~30 RPM shared
  nvidia: 1600, // NIM free tier 40 RPM → 1500ms min, keep headroom
  hf: 600, // router free tier ~100 RPM
  huggingface: 600, // same provider, catalog-string key
  pollinations: 0, // covered by blanket probe, no individual pings
  llm7: 2000, // free tier 30 RPM → keep well under
  google: 2000, // free Flash tier ~5-15 RPM per project → stay well under
  puter: 2000, // user-pays credits → conservative so probes never waste tokens
  cloudflare: 2000, // Workers AI free tier ~50 neurons/min → stay well under
};
let effectiveGaps: Record<string, number> = { ...DEFAULT_GAPS };
// Round-robins each provider's model order so probes that fit under the rate
// limit cover a different slice every pass (models never starve permanently).
let rotationOffsets: Record<string, number> = {};

export function startHealthMonitor(opts: HealthMonitorOptions): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const catalogFile = opts.catalogFile ?? path.join(__dirname, 'model-cache.json');
  const intervalMs = opts.intervalMs ?? 300_000; // 5 minutes
  const startupDelayMs = opts.startupDelayMs ?? 10_000;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const timeoutMs = opts.timeoutMs ?? 4000;
  const retries = Math.max(0, opts.retries ?? 0);
  const providerCooldownMs = opts.providerCooldownMs ?? 120_000; // 2 min backoff
  if (opts.providerGapMs) {
    for (const [prov, gap] of Object.entries(opts.providerGapMs)) {
      if (Number.isFinite(gap)) effectiveGaps[prov] = Math.max(0, gap);
    }
  }

  let passRunning = false;
  let passTimer: NodeJS.Timeout | null = null;

  async function runPass(): Promise<void> {
    if (passRunning) return;
    passRunning = true;
    const passStart = Date.now();
    try {
      let models: any[] = [];
      try {
        const raw = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
        models = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : [];
      } catch {
        models = [];
      }
      if (!models.length) {
        console.warn('[health] no catalog to ping (model-cache.json missing or empty)');
        return;
      }

      const keys = opts.resolveKeys();
      const cooldowns: Record<string, number> = {};
      const cooledDown = (provider: string) => (cooldowns[provider] || 0) > Date.now();
      const backoff = (provider: string, ms: number) => {
        cooldowns[provider] = Date.now() + ms;
      };
      // Pacing: keep a per-provider min interval between probes so a burst never
      // trips the provider's RPM limit. Adaptive — gaps grow on 429, and stay
      // widened for subsequent passes.
      const gapOf = (prov: string) => effectiveGaps[prov] ?? 250;
      // Budget: a provider can send at most what fits inside this pass window
      // given its min gap. Anything beyond that waits for the next pass (the
      // rotated order makes sure a different slice gets checked each time).
      const budgetOf = (prov: string) => Math.max(1, Math.floor((intervalMs * 0.9) / gapOf(prov)));
      const probedCount: Record<string, number> = {};
      const nextAllowedAt: Record<string, number> = {};
      // Reserve a start slot synchronously (single-threaded = atomic) so workers
      // pick distinct times; otherwise the await lets them cluster.
      const throttle = async (prov: string) => {
        const gap = gapOf(prov);
        const now = Date.now();
        const prev = nextAllowedAt[prov] ?? 0;
        const slot = Math.max(now, prev);
        nextAllowedAt[prov] = slot + gap;
        const wait = slot - now;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      };

      const classifyProvider = (m: any): string => String(m.provider || '').toLowerCase();

      // ── 1. Pollinations blanket probe ──
      const pollinationsModels = models.filter((m) => classifyProvider(m) === 'pollinations');
      if (pollinationsModels.length && dailyRemaining('pollinations') > 0) {
        const blanket = await probeModelHealth('pollinations', { provider: 'pollinations', model: '' }, keys, {
          timeoutMs,
          retries: 1,
        });
        spendProbe('pollinations');
        const checkedAt = new Date().toISOString();
        const polHealth: ModelHealth = blanket.ok
          ? {
              status: blanket.latencyMs > 3000 ? 'degraded' : 'online',
              latencyMs: blanket.latencyMs,
              checkedAt,
            }
          : { status: 'offline', latencyMs: blanket.latencyMs, checkedAt, error: blanket.error };
        for (const m of pollinationsModels) store.models[String(m.id)] = { ...polHealth };
        if (!blanket.ok && (blanket.error === 'rate_limited' || blanket.error === 'auth_failed')) {
          backoff('pollinations', providerCooldownMs);
        }
        console.log(`[health] pollinations blanket probe -> ${polHealth.status} (${polHealth.latencyMs}ms) for ${pollinationsModels.length} models`);
      }

      // ── 2. Individual probes for the rest ──
      // Build per-provider queues (text/multimodal only), rotating each so the
      // slice that fits under the provider's rate budget changes every pass.
      const byProvider = new Map<string, any[]>();
      for (const m of models) {
        const prov = classifyProvider(m);
        if (prov === 'pollinations') continue; // covered by blanket probe
        const type = String(m.type || '');
        if (type !== 'text' && type !== 'multimodal') continue; // can't chat-ping image-gen etc.
        if (!byProvider.has(prov)) byProvider.set(prov, []);
        byProvider.get(prov)!.push(m);
      }
      const pending: any[] = [];
      for (const [prov, list] of byProvider) {
        const offset = rotationOffsets[prov] ?? 0;
        rotationOffsets[prov] = offset + 1;
        const rotated = [...list.slice(offset % list.length), ...list.slice(0, offset % list.length)];
        pending.push(...rotated);
      }

      let idx = 0;
      const probeWorker = async (): Promise<void> => {
        while (true) {
          const i = idx++;
          if (i >= pending.length) return;
          const m = pending[i];
          const prov = classifyProvider(m);
          if (cooledDown(prov)) continue; // provider is backing off — leave its models untouched
          if ((probedCount[prov] || 0) >= budgetOf(prov)) continue; // budget used up this pass
          if (dailyRemaining(prov) <= 0) continue; // daily budget spent — never burn user quota
          const id = String(m.id);
          await throttle(prov);
          if (cooledDown(prov)) continue; // re-check after the pacing wait
          if ((probedCount[prov] || 0) >= budgetOf(prov)) continue;
          if (dailyRemaining(prov) <= 0) continue;
          probedCount[prov] = (probedCount[prov] || 0) + 1;
          spendProbe(prov);
          const result = await probeModelHealth(id, opts.resolveRoute(id), keys, { timeoutMs, retries });
          const checkedAt = new Date().toISOString();
          if (result.ok) {
            store.models[id] = {
              status: result.latencyMs > 3000 ? 'degraded' : 'online',
              latencyMs: result.latencyMs,
              checkedAt,
            };
          } else {
            store.models[id] = { status: 'offline', latencyMs: result.latencyMs, checkedAt, error: result.error };
            if (result.error === 'rate_limited' || result.error === 'auth_failed' || result.error === 'quota') {
              effectiveGaps[prov] = Math.min(gapOf(prov) * 2, 30_000);
              backoff(prov, providerCooldownMs);
            }
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => probeWorker()));

      // ── 3. Non-probeable models (image-gen): record 'n/a' once so cards can tell
      //       "not probed" apart from "offline". Models we couldn't reach this pass
      //       (rate-limited / no key) keep their last-known status untouched.
      const nowIso = new Date().toISOString();
      for (const m of models) {
        const id = String(m.id);
        if (store.models[id]) continue;
        const type = String(m.type || '');
        if (type !== 'text' && type !== 'multimodal' && classifyProvider(m) !== 'pollinations') {
          store.models[id] = { status: 'n/a', latencyMs: 0, checkedAt: nowIso, error: 'image-gen not probed' };
        }
      }

      const statusCounts: Record<string, number> = {};
      for (const h of Object.values(store.models)) statusCounts[h.status] = (statusCounts[h.status] || 0) + 1;

      const probeLog = Object.entries(probedCount)
        .map(([p, n]) => `${p}=${n}/${byProvider.get(p)?.length ?? 0}`)
        .join(' ');

      store.lastPassAt = new Date().toISOString();
      store.lastPassDurationMs = Date.now() - passStart;
      store.passesCompleted += 1;
      saveStore();
      console.log(
        `[health] pass ${store.passesCompleted} done in ${store.lastPassDurationMs}ms — ` +
          `${Object.keys(store.models).length} models tracked, ` +
          `counts ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join(' ')}, ` +
          `probed ${probeLog}, last pass ${store.lastPassAt}`,
      );
    } finally {
      passRunning = false;
    }
  }

  const scheduleNext = (delay: number) => {
    passTimer = setTimeout(() => {
      runPass().finally(() => scheduleNext(intervalMs));
    }, delay);
  };

  console.log(`[health] monitor started — probing every ${(intervalMs / 1000).toFixed(0)}s (concurrency ${concurrency})`);
  scheduleNext(startupDelayMs);
}
