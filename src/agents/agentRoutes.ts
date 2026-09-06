/**
 * agentRoutes.ts — the custom-agent HTTP + SSE surface.
 *
 * A thin Express Router: list, draft (compose + gather, never persists), save/
 * update/delete, interactive SSE run (same ToolCtx semantics as /api/chat:
 * confirmWrites ON, steps as `event: search`, memory distilled and emitted as a
 * final `event: lessons`), run history, gather-again, memory/knowledge editing.
 *
 * All routes sit behind verifyVaultAccess + rateLimit; both are injected at
 * mount time (they live in index.ts, unexported) — injecting keeps this module
 * importable by tests without dragging the 6k-line monolith in.
 *
 * SECURITY. The run path never touches anything the request didn't bring:
 *   - Interactive runs use the BYOK keys from the request (x-groq-key etc.),
 *     exactly like /api/chat.
 *   - Draft/gather use the request's keys for distillation; the internet
 *     path only ever clones github.com URLs and nothing is executed (see
 *     gather.ts + skills.ts SECURITY NOTEs).
 *   - Agent definitions store no keys, ever.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  type AgentEntry, listAgents, getAgent, saveAgent, deleteAgent,
  sanitizeAgentDraft, buildAgentSystemPrompt, resolveProviderConfig,
  distillAgentMemory, deleteRuns, loadRuns, VALID_TOOLS, CAPS,
  matchAgentForMessage,
} from './agents.js';
import {
  observeTrafficForNeuralLearning, trafficDepth, neuralFocusBlock, emptyNeuralState,
} from './neural.js';
import { trainAgentNeural } from './trainer.js';
import { gatherDomainKnowledge, type GatherOpts } from './gather.js';
import { skillGuidesFor, scheduledToolSpecs } from './scheduler.js';
import { listSkills, getSkill } from '../skills/skills.js';
import { loadBundledSkills } from '../skills/bundled-skills.js';
import { runAgentLoop, type ToolCtx, type ProviderConfig, TOOL_SPECS } from '../agent/agent-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local clone-bucket limiter for the gather path inside /draft (same shape as
// index.ts's rateLimit: per-IP sliding minute window). Kept local because the
// shared limiter lives unexported in the monolith and responds on the res
// object directly, which an inline "limited?" check can't reuse safely.
const LOCAL_BUCKETS = new Map<string, { count: number; reset: number }>();
function localRateLimited(bucket: string, req: Request, maxPerMin: number): boolean {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const id = `${bucket}:${ip}`;
  const now = Date.now();
  let slot = LOCAL_BUCKETS.get(id);
  if (!slot || slot.reset <= now) slot = { count: 0, reset: now + 60_000 };
  slot.count += 1;
  LOCAL_BUCKETS.set(id, slot);
  return slot.count > maxPerMin;
}

/** Express 5 types route params as string | string[] — normalize once. */
function paramId(req: Request): string {
  const v = req.params?.id;
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

// ── Model-pool machinery (module level — the neural trainer reuses it) ──────
// The drafter's free-model pool, health scoreboard, and provider chat call
// live at MODULE level, not inside createAgentRouter, so the background
// trainer (trainer.ts) can hunt for a working drafting brain with server-env
// keys — same BYOK background rule as the scheduler (never per-request
// client keys, never anything a request could inject into background work).

/** Server-env keys only — the background trainer's key source. */
export function SERVER_KEYS(): Record<string, string> {
  return {
    groq: process.env.GROQ_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    nvidia: process.env.NVIDIA_API_KEY || '',
    hf: process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '',
    pollinations: process.env.POLLINATIONS_API_KEY || '',
  };
}

const modelCachePath = (): string => (process.env.ENZO_MODEL_CACHE
  ? path.resolve(process.env.ENZO_MODEL_CACHE)
  : path.resolve(__dirname, '../../model-cache.json'));

// ── Drafter race: fire MANY free models at once, first good answer wins ──
// The user's spec: don't try candidates one-by-one (a rate-limited or dead
// endpoint burns seconds per failure) — try ~10 at once and use whichever
// answers, while a background health check keeps promoting the best model
// for FUTURE drafts. Candidate pool = best free model per provider
// (trust order) + the top few extra free models per keyed provider.
function draftCandidatePool(keys: Record<string, string>): Array<{ model: string }> {
  const order: Array<{ prov: string; key: string }> = [
    { prov: 'groq', key: keys.groq || process.env.GROQ_API_KEY || '' },
    { prov: 'openrouter', key: keys.openrouter || process.env.OPENROUTER_API_KEY || '' },
    { prov: 'nvidia', key: keys.nvidia || process.env.NVIDIA_API_KEY || '' },
    { prov: 'hf', key: keys.hf || process.env.HUGGINGFACE_API_KEY || '' },
    // Pollinations' anonymous tier is DEAD (live-verified 2026-09-06: 401 "A
    // valid API key is required" with and without Referer) — only a real key
    // admits pollinations candidates now.
    { prov: 'pollinations', key: keys.pollinations || process.env.POLLINATIONS_API_KEY || '' },
  ];
  const pool: Array<{ model: string }> = [];
  try {
    const cachePath = modelCachePath();
    if (!fs.existsSync(cachePath)) return pool;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const models: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.models) ? parsed.models : []);
    if (!models.length) return pool;
    for (const { prov, key } of order) {
      if (!key) continue;
      const candidates = models.filter((m: any) => {
        if (typeof m?.id !== 'string' || !m.id.startsWith(`${prov}/`)) return false;
        if (m.type !== 'text' && m.type !== 'multimodal') return false;
        if (!m.free) return false;
        if (/embed|rerank|tts|stt|whisper|keep|featherless|tinker|modelshift|gas|uhd-ai|gpt-4o-nano|nano|mini|preview|exp|alpha|beta|test/i.test(m.id)) return false;
        if (/embed|rerank|tts|stt|whisper|guard|moderation|guardian|image|diffusion|flux|vision-only|dpo|gptq|awq|base\b/i.test(m.id)) return false;
        return true;
      });
      if (!candidates.length) continue;
      // Mid-tier, not monster-tier: 7B–80B instruct models with decent
      // context win; tiny (≤4B) toys lose hard.
      const score = (m: any): number => {
        const ctx = Number(m.context_length || 0);
        let s = Math.min(ctx / 8000, 40);
        const sizeMatch = /(\d+(?:\.\d+)?)\s*b\b/i.exec(m.id);
        const size = sizeMatch ? parseFloat(sizeMatch[1]) : 24;
        if (size >= 7 && size <= 80) s += 30;
        if (size < 5) s -= 25;
        if (/instruct|it\b|chat|latest|versatile|qwen\d|gemini|deepseek|glm|mistral|kimi/i.test(m.id)) s += 15;
        return s;
      };
      candidates.sort((a: any, b: any) => score(b) - score(a));
      // ~2 free models per keyed provider, plus the best for each
      // non-keyed-but-available provider: a wide net, still trust-ordered.
      for (const m of candidates.slice(0, 2)) {
        pool.push({ model: String(m.id) });
      }
    }
  } catch {
    /* cache unreadable — the legacy chain still serves */
  }
  return pool;
}

// ── Brain health scoreboard ─────────────────────────────────────────────
// Online additive-Hebbian update (the same learning rule the per-agent
// weights use): every drafting attempt potentiated (+) or depresses (−)
// a model's score; scores decay toward 0 so old evidence fades. Routing
// always keeps the healthy head start: proven models come first, and
// scored-negative models sink to the end instead of being banned outright.
const brainHealth = new Map<string, number>();
function markBrainHealth(model: string, delta: number): void {
  const cur = brainHealth.get(model) || 0;
  brainHealth.set(model, cur + delta);
  if (brainHealth.size > 400) {
    // Trim: keep the strongest 200 signals.
    const keep = [...brainHealth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
    brainHealth.clear();
    for (const [k, v] of keep) brainHealth.set(k, v);
  }
}
function healthBoost(model: string): number {
  const s = brainHealth.get(model) || 0;
  return s > 0 ? Math.min(s, 8) * 1.5 : Math.max(s, -8) * 4;
}
function brainHealthSnapshot(): Array<{ model: string; score: number }> {
  return [...brainHealth.entries()]
    .map(([model, score]) => ({ model, score }))
    .sort((a, b) => b.score - a.score);
}

/** One OpenAI-compatible non-streaming chat call against any provider. The
 *  race passes an external AbortSignal so stragglers are cancelled the moment
 *  a winner answers (a settled-race would keep hammering rate-limited
 *  endpoints for nothing). maxTokens is caller-tuned: reasoning-style models
 *  (gpt-oss family, qwen3 thinkers) spend budget on internal reasoning before
 *  content, so tight budgets return empty content and a false failure. */
async function brainChat(
  keys: Record<string, string>,
  model: string,
  sys: string,
  user: string,
  timeoutMs = 30000,
  label = 'draft brain',
  maxTokens = 1600,
  raceSignal?: AbortSignal,
): Promise<string> {
  const [prov, ...rest] = model.split('/');
  const modelId = rest.join('/');
  const baseUrls: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
    hf: 'https://router.huggingface.co/v1',
    pollinations: 'https://gen.pollinations.ai/v1',
  };
  const apiKey = prov === 'pollinations'
    ? (keys.pollinations || '')
    : (keys[prov] || process.env[`${prov.toUpperCase()}_API_KEY`] || '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  if (prov === 'openrouter') {
    headers['HTTP-Referer'] = 'https://enzo-hub.duckdns.org';
    headers['X-Title'] = 'ENZO AI Hub';
  }
  const r = await fetch(`${baseUrls[prov]}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
    signal: raceSignal ? AbortSignal.any([raceSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${label} ${model} HTTP ${r.status}`);
  const j: any = await r.json();
  const t = j?.choices?.[0]?.message?.content;
  if (!t) throw new Error(`${label} ${model} returned no content`);
  return String(t);
}

type RaceResult =
  | { ok: true; model: string; text: string }
  | { ok: false; model: string; err: string };

/** Race every candidate simultaneously — the FIRST usable answer wins and
 *  aborts the stragglers (a settled-race would wait for the slowest 12s
 *  candidate and keep hammering already-limited endpoints). Returns null when
 *  the pool is empty or every candidate failed (the legacy chain serves
 *  then). Every outcome — win, lose, abort — potentiated/depressed the health
 *  scoreboard future drafts consult. */
async function raceDraftChat(
  keys: Record<string, string>,
  sys: string,
  user: string,
  label: string,
  via: { model: string },
  timeoutMs = 12000,
  maxTokens = 1600,
  maxCandidates = 0,
): Promise<string | null> {
  const poolAll = draftCandidatePool(keys);
  if (!poolAll.length) return null;
  const pool = maxCandidates ? poolAll.slice(0, maxCandidates) : poolAll;
  // Health ordering: proven-healthy models fire first (array order is only a
  // tiebreaker — all fire simultaneously).
  const ordered = [...pool].sort((a, b) => healthBoost(b.model) - healthBoost(a.model));
  const ctrl = new AbortController();
  const outcomes: RaceResult[] = [];
  const futures = ordered.map((c): Promise<void> =>
    brainChat(keys, c.model, sys, user, timeoutMs, label, maxTokens, ctrl.signal)
      .then((text) => { outcomes.push({ ok: true, model: c.model, text }); if (String(text).trim()) ctrl.abort(); })
      .catch((err: any) => {
        // A failure AFTER the race was won is an abort artifact, not a signal
        // about the model — never record it.
        if (!ctrl.signal.aborted) outcomes.push({ ok: false, model: c.model, err: String(err?.message ?? err) });
      }),
  );
  await Promise.allSettled(futures); // every future resolves (outcomes, never rejects)
  const winner = outcomes.find(
    (x): x is Extract<RaceResult, { ok: true }> => x.ok && String(x.text).trim().length > 0,
  );
  // Health: winner +1; every other candidate −1 only if it failed on its own
  // BEFORE the race was won (aborted stragglers never reach `outcomes` as
  // failures, so they keep their score).
  for (const res of outcomes) markBrainHealth(res.model, res.ok ? +1 : -1);
  if (winner) {
    via.model = winner.model;
    console.log(`[agents] race: ${winner.model} answered first of ${ordered.length} candidates`);
    return winner.text as string;
  }
  const errs = outcomes
    .filter((o): o is Extract<RaceResult, { ok: false }> => !o.ok)
    .slice(0, 3)
    .map((o) => `${o.model.split('/')[0]}: ${o.err}`)
    .join(' | ');
  console.warn(`[agents] race failed on all ${ordered.length} candidates — legacy chain (${errs})`);
  return null;
}

/** The legacy hardcoded chain — LAST resort under the race. Live-verified
 *  2026-09-06: Groq delisted llama-3.3-70b-versatile AND llama-3.1-8b-instant
 *  (404 model_not_found), OpenRouter delisted meta-llama/llama-3.1-8b-instruct:free.
 *  Replacements live-verified the same day: gpt-oss-20b serves json mode
 *  (with reasoning-token headroom), glm-5.2:free is OpenRouter's remaining
 *  large free instruct model. Sets via on success. */
async function legacyDraftChat(
  keys: Record<string, string>,
  sys: string,
  user: string,
  via?: { model: string },
): Promise<string> {
  const groq = keys.groq || process.env.GROQ_API_KEY || '';
  const orKey = keys.openrouter || process.env.OPENROUTER_API_KEY || '';
  if (groq) {
    const { Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey: groq, timeout: 45000, maxRetries: 0 });
    const r = await client.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.4,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });
    const t = r.choices[0]?.message?.content;
    if (t) {
      if (via) via.model = 'groq/openai/gpt-oss-20b';
      return t;
    }
  }
  if (orKey) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.2:free',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.4,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const t = j?.choices?.[0]?.message?.content;
      if (t) {
        if (via) via.model = 'openrouter/z-ai/glm-5.2:free';
        return t;
      }
    }
  }
  throw new Error('No provider key available for drafting (add a Groq or OpenRouter key).');
}

/** Single-call drafting primitive: race the free pool, fall back to the legacy
 *  chain. `via` records which model actually served. */
async function draftChat(
  keys: Record<string, string>,
  sys: string,
  user: string,
  via?: { model: string },
  timeoutMs = 45000,
  maxTokens = 3200,
): Promise<string> {
  const text = await raceDraftChat(keys, sys, user, 'draft brain', via || { model: '' }, timeoutMs, maxTokens);
  if (text !== null) return text;
  return legacyDraftChat(keys, sys, user, via);
}

/** The two-pass drafting chat. Pass 1 (tiny domain-analysis JSON) races the
 *  pool ONCE; the winner is then PINNED — pass 2 (the full expert manual)
 *  calls that same proven-reachable model directly, one request with a
 *  manual-scale budget, instead of firing a second full race. This is the
 *  rate-budget fix: two 8-candidate races in two seconds exhaust a free-tier
 *  key's requests-per-minute so pass 2 all-429s and the draft lands on the
 *  template. If the pinned model does fail (mid-draft 429/timeout), only then
 *  does a fresh race fire. Falls back to the legacy chain throughout. */
export function makeDraftChat(
  keys: Record<string, string>,
  via: { model: string },
): (sys: string, user: string) => Promise<string> {
  let pinned: string | null = null;
  let calls = 0;
  return async (sys: string, user: string): Promise<string> => {
    calls++;
    if (pinned) {
      try {
        const t = await brainChat(keys, pinned, sys, user, 45000, 'draft brain (pinned)', 3200);
        markBrainHealth(pinned, +1);
        return t;
      } catch (err: any) {
        markBrainHealth(pinned, -1);
        console.warn(`[agents] pinned brain ${pinned} failed pass 2 (${String(err?.message ?? err).slice(0, 80)}) — re-racing`);
        pinned = null;
      }
    }
    // Call #1 is pass 1 (tiny domain JSON — short race, small budget); every
    // later call is pass 2 (the 400-1000-word manual — long race, big budget).
    const text = await raceDraftChat(
      keys, sys, user, 'draft brain', via,
      calls === 1 ? 12000 : 45000,
      calls === 1 ? 1600 : 3200,
    );
    if (text !== null) {
      pinned = via.model; // the race winner is now the proven brain
      return text;
    }
    return legacyDraftChat(keys, sys, user, via);
  };
}

/** The background trainer's chat fn: race the free pool, fall back to the
 *  legacy chain, and NEVER throw — a training cycle that can't reach a brain
 *  simply skips its deep-tune pass and keeps its local (Hebbian) learning. */
export async function poolChatFor(keys: Record<string, string>, sys: string, user: string): Promise<string | null> {
  try {
    const text = await raceDraftChat(keys, sys, user, 'trainer brain', { model: '' });
    if (text !== null) return text;
  } catch { /* race never throws, but belt-and-braces */ }
  try {
    return await legacyDraftChat(keys, sys, user);
  } catch {
    return null;
  }
}

/** Background health probe: ping the pool's head with a one-token message so
 *  the scoreboard stays warm for future drafts (the "keep looking for better
 *  models" half of the spec). SELF-THROTTLED to at most one 3-ping round per
 *  15 minutes — probing after every draft was eating the same free-tier rate
 *  budget the drafts themselves need, right at its most-exhausted moment.
 *  Fire-and-forget; never throws. */
const PROBE_EVERY_MS = 15 * 60_000;
let lastProbeAt = 0;
export function probeBrains(keys: Record<string, string>): void {
  if (Date.now() - lastProbeAt < PROBE_EVERY_MS) return;
  lastProbeAt = Date.now();
  const pool = draftCandidatePool(keys).slice(0, 3);
  if (!pool.length) return;
  void Promise.allSettled(
    pool.map((c) =>
      brainChat(keys, c.model, 'You are a health probe. Reply with exactly: ok', 'ping', 10000, 'health probe', 300)
        .then(() => markBrainHealth(c.model, +1))
        .catch(() => markBrainHealth(c.model, -1))
    ),
  ).then(() => {
    const top = brainHealthSnapshot().slice(0, 3)
      .map((x) => `${x.model} (${x.score > 0 ? '+' : ''}${x.score})`).join(', ');
    if (top) console.log(`[agents] brain health top: ${top}`);
  }).catch(() => { /* never */ });
}

export interface AgentRouteDeps {
  verifyVaultAccess: (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (bucket: string, maxPerMin: number) => (req: Request, res: Response, next: NextFunction) => void;
  // Test seams (ponytail): injected in tests so routes run with zero network.
  _draftChat?: (sys: string, user: string) => Promise<string>;
  _gather?: typeof gatherDomainKnowledge;
  _createStream?: (opts: any) => Promise<AsyncIterable<any>>;
  // Test seam for the neural deep-tune pass (trainer's LLM review).
  _trainChat?: (sys: string, user: string) => Promise<string>;
}

export function createAgentRouter(deps: AgentRouteDeps): express.Router {
  const router = express.Router();
  const { verifyVaultAccess, rateLimit } = deps;

  // Attachable skills = the learned store PLUS the bundled skills offered by
  // gather (their ids live in skills-bundled/, not the index) — otherwise
  // sanitizeAgentDraft silently strips every pre-checked bundled selection.
  const agentSkillIds = (): Set<string> =>
    new Set([
      ...listSkills().map((s) => s.id.toLowerCase()),
      ...loadBundledSkills().map((s) => s.id.toLowerCase()),
    ]);

  // Tool specs filtered to an agent's subset (offered to the model).
  const agentToolSpecs = (agent: AgentEntry): any[] =>
    TOOL_SPECS.filter((t: any) => agent.tools.includes(t.function.name));

  const keysFromRequest = (req: Request): Record<string, string> => ({
    groq: String(req.headers['x-groq-key'] || (req.body?.providerKeys?.groq as string) || ''),
    exa: String(req.headers['x-exa-key'] || (req.body?.providerKeys?.exa as string) || ''),
    nvidia: String(req.headers['x-nvidia-key'] || (req.body?.providerKeys?.nvidia as string) || ''),
    openrouter: String(req.headers['x-openrouter-key'] || (req.body?.providerKeys?.openrouter as string) || ''),
    pollinations: String(req.body?.providerKeys?.pollinations || ''),
    hf: String(req.headers['x-huggingface-key'] || (req.body?.providerKeys?.huggingface as string) || ''),
  });

  const serverKeys = (): Record<string, string> => ({
    groq: process.env.GROQ_API_KEY || '',
    openrouter: process.env.OPENROUTER_API_KEY || '',
    nvidia: process.env.NVIDIA_API_KEY || '',
    exa: process.env.EXA_API_KEY || '',
  });

  // ── Model ranking: strongest model the caller's keys support ────────────
  // Simple, deterministic, catalog-aware: chat-capable text models from the
  // live cache on providers the caller has keys for, preferring larger
  // context + reasoning/coding tags + free tier. Falls back to the Groq
  // default when the cache is missing (fresh boot).
  function rankModelForKeys(keys: Record<string, string>): { model: string; reason: string } {
    const hasKey: Record<string, boolean> = {
      groq: !!keys.groq, openrouter: !!keys.openrouter, nvidia: !!keys.nvidia,
      pollinations: !!keys.pollinations, hf: !!keys.hf,
    };
    try {
      const cachePath = modelCachePath();
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const models: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.models) ? parsed.models : []);
        const eligible = models.filter((m: any) => {
          if (!m?.id || typeof m.id !== 'string') return false;
          if (!m.id.includes('/')) return false;
          const prov = m.id.split('/')[0];
          if (!hasKey[prov]) return false;
          if (m.type !== 'text' && m.type !== 'multimodal') return false;
          if (/embed|tts|stt|whisper|guard|moderation|image|vision-only/i.test(`${m.id} ${m.name || ''}`)) return false;
          return true;
        });
        if (eligible.length) {
          const score = (m: any): number => {
            let s = Number(m.context_length || 0) / 1000;
            const tags = Array.isArray(m.tags) ? m.tags.join(' ') : '';
            if (/coding|reasoning/i.test(tags)) s += 50;
            if (m.free) s += 20;
            if (/70b|405b|scout|maverick|sonnet|opus|gpt-4|large/i.test(m.id)) s += 30;
            return s;
          };
          eligible.sort((a: any, b: any) => score(b) - score(a));
          const best = eligible[0];
          return {
            model: String(best.id),
            reason: `Strongest model your keys support (${best.free ? 'free tier, ' : ''}${Math.round(Number(best.context_length || 0) / 1000) || '?'}k context)`,
          };
        }
      }
    } catch {
      /* cache unreadable — fall through */
    }
    if (keys.groq) return { model: 'groq/openai/gpt-oss-20b', reason: 'Groq default (catalog unavailable)' };
    if (keys.openrouter) return { model: 'openrouter/z-ai/glm-5.2:free', reason: 'OpenRouter default (catalog unavailable)' };
    return { model: 'groq/openai/gpt-oss-20b', reason: 'No provider key found — Groq default' };
  }

  // ── Draft composition (the expert-manual LLM prompt) ──────────────────────

  const DRAFT_TOOLS: Record<string, string> = {
    gmail_list: 'reading the user\'s Gmail inbox',
    gmail_send: 'sending email on the user\'s behalf',
    calendar_list: 'reading the user\'s calendar',
    calendar_create: 'creating calendar events',
    web_search: 'searching the web',
    deep_research: 'multi-source research',
    document_assist: 'editing text',
    recommend_model: 'comparing AI models',
    compare_models: 'comparing AI models',
  };

  /** Two-pass drafting, the substitute for fine-tuning. Pass one extracts the
   *  domain itself (what field, which sub-field, what the deliverable looks
   *  like, who consumes it); pass two writes the expert manual from that
   *  structured understanding. A single-pass prompt collapses both jobs, and
   *  what falls out is generic — the exact weakness we're engineering away. */
  async function composeDraft(
    description: string,
    keys: Record<string, string>,
    chatFn: (sys: string, user: string) => Promise<string>,
  ): Promise<{ name: string; systemPrompt: string; tools: string[]; domain: string }> {
    const toolMenu = Object.entries(DRAFT_TOOLS).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    // Pass 1 — domain analysis. Short JSON, cheap model, fast.
    const analyzeSys = `You are a domain analyst. Extract the professional domain hiding inside a task description, so an AI agent can be specialized for it.

Return ONLY JSON:
{
  "domain": "the professional field, e.g. 'fermentation science (sake brewing)' or 'MUN procedural rules and country-position research'",
  "subfield": "the specific corner of it this task lives in",
  "deliverable": "what a finished output of this task looks like in this domain",
  "audience": "who consumes that output and what they do with it",
  "expertProfile": "one sentence: what a 30-year veteran of exactly this subfield knows that a generalist doesn't",
  "domainTerms": ["4-8 vocabulary words/abbreviations insiders use that outsiders don't"]
}`;
    let domain = {
      domain: '', subfield: '', deliverable: '', audience: '',
      expertProfile: '', domainTerms: [] as string[],
    };
    try {
      const raw = await chatFn(analyzeSys, `Task: ${description}`);
      const m = String(raw).match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : {};
      domain = {
        domain: String(parsed.domain || '').slice(0, 200),
        subfield: String(parsed.subfield || '').slice(0, 200),
        deliverable: String(parsed.deliverable || '').slice(0, 200),
        audience: String(parsed.audience || '').slice(0, 200),
        expertProfile: String(parsed.expertProfile || '').slice(0, 300),
        domainTerms: (Array.isArray(parsed.domainTerms) ? parsed.domainTerms : []).map(String).slice(0, 8),
      };
    } catch {
      domain = { domain: description.slice(0, 120), subfield: '', deliverable: '', audience: '', expertProfile: '', domainTerms: [] };
    }

    // Pass 2 — the manual, written FROM the domain analysis. This is where the
    // "feels fine-tuned" effect is won or lost: the drafting model is told to
    // impersonate the specialist the analysis identified, using the field's
    // own vocabulary, with the tacit-knowledge sections a generalist never
    // thinks to write.
    const sys = `You write the operating manual for an AI agent that must behave like a lifelong specialist. You are given a DOMAIN ANALYSIS. Do not restate it — build on it, like a veteran writing the onboarding doc for their successor.

Think about ${domain.domain || 'the task domain'}${domain.subfield ? ` — specifically ${domain.subfield}` : ''}. The finished output is: ${domain.deliverable || 'a completed run of the task'}. Consumers: ${domain.audience || 'the operator'}. A 30-year veteran here: ${domain.expertProfile || 'knows the failure modes, the jargon, and the judgment calls that no manual covers'}.

Write the agent's system prompt as if ${domain.domain || 'this field'} were your own life's work${domain.domainTerms.length ? ` — use the field's real vocabulary (${domain.domainTerms.join(', ')}) naturally, the way insiders do, not as decoration` : ''}.

The manual must contain these sections, in order:
- IDENTITY — second paragraph, first person ("I am...", "In my work I always..."): decades of this exact work, what the agent holds opinions about.
- TACIT KNOWLEDGE — 5-8 things a 30-year specialist of this subfield knows that never appear in documentation: how things actually go wrong, which "rules" are soft, what to trust and what to double-check. This section is what separates a fine-tuned feel from a generic one.
- OPERATING PROCEDURE — the SOP, written for THIS domain's workflow (not generic steps): what to check first, how to work, when to escalate.
- DECISION HEURISTICS — the judgment calls, with the domain's real trade-offs: what makes something urgent, what's noise, when precision beats speed here.
- OUTPUT FORMAT — the deliverable (${domain.deliverable || 'the task output'}) formatted the way this field expects, every time.
- EDGE CASES — this domain's specific failure modes.

Also pick the agent's tools (give ONLY what the task genuinely needs — never give an agent a tool it doesn't need):
${toolMenu}

Return ONLY JSON:
{
  "name": "Short memorable name (2-4 words, title case)",
  "tools": ["tool_name", ...],
  "systemPrompt": "The manual, 400-1000 words, imperative + first person, zero placeholders, zero 'As an AI' language. An expert reader should not be able to tell it wasn't written by a colleague."}`;
    const raw = await chatFn(sys, `Task description: ${description}`);
    let parsed: any;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    } catch {
      parsed = {};
    }
    const name = String(parsed?.name || '').slice(0, CAPS.name) || 'Custom agent';
    const tools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
      .map(String)
      .filter((t: string) => VALID_TOOLS.has(t));
    let systemPrompt = String(parsed?.systemPrompt || '').slice(0, CAPS.systemPrompt).trim();
    if (!systemPrompt) throw new Error('The draft model returned no usable system prompt.');
    // Dynamic tools, second opinion: the task text itself argues for certain
    // tools regardless of what the LLM felt like returning. Union of the LLM's
    // picks and the text-picks, then clean overlaps the LLM list (its ordering
    // reflects domain reasoning better than regex order).
    const textPicks = guessToolsFromText(description);
    const merged = [...new Set([...tools, ...textPicks])];
    systemPrompt = systemPrompt.slice(0, CAPS.systemPrompt);
    return { name, systemPrompt, tools: merged, domain: domain.domain };
  }

  // ── Background model hunt ────────────────────────────────────────────────
  // Two mechanisms that keep improving the drafter WITHOUT the user waiting:
  //   1. scheduleAgentRefine — when /auto landed a template manual (every
  //      candidate was down/rate-limited), retry the two-pass draft later and
  //      upgrade the SAME agent the moment a model frees up.
  //   2. probeBrains — after each draft, ping the candidate pool with a tiny
  //      message so the health scoreboard stays warm for future drafts.
  const refining = new Set<string>();
  const REFINE_DELAYS_MS = [90_000, 5 * 60_000, 15 * 60_000]; // 1.5min, 5min, 15min, then give up

  function scheduleAgentRefine(agentId: string, description: string, attempt = 0): void {
    // Background rule: server-env keys only, never the per-request BYOK keys
    // the /auto route happened to carry — a timer outliving the request must
    // not keep firing the user's key at providers after they logged out.
    const keys = SERVER_KEYS();
    if (attempt >= REFINE_DELAYS_MS.length || refining.has(agentId)) return;
    refining.add(agentId);
    const t = setTimeout(() => {
      refining.delete(agentId);
      void (async () => {
        const current = getAgent(agentId);
        if (!current) return;
        // Only upgrade a manual the user hasn't touched since creation: the
        // mechanical template is byte-identical, so anything else means the
        // user (or a previous refine) already wrote a real manual here.
        if (current.systemPrompt !== mechanicalManual(description)) return;
        const via: { model: string } = { model: '' };
        try {
          const composed = await composeDraft(description, keys, makeDraftChat(keys, via));
          if (composed.systemPrompt === mechanicalManual(description)) throw new Error('still templated');
          const updated = sanitizeAgentDraft({
            ...current,
            systemPrompt: composed.systemPrompt,
            domain: composed.domain || current.domain,
            tools: composed.tools.length ? composed.tools : current.tools,
            draftModel: via.model || current.draftModel,
          } as any, agentSkillIds());
          saveAgent(updated);
          console.log(`[agents] self-refined "${updated.name}" — manual upgraded by ${updated.draftModel}`);
        } catch (err: any) {
          console.warn(`[agents] refine attempt ${attempt + 1} for ${agentId} failed: ${err?.message ?? err}`);
          scheduleAgentRefine(agentId, description, attempt + 1);
        }
      })();
    }, REFINE_DELAYS_MS[attempt]);
    t.unref();
    console.log(`[agents] refine scheduled for ${agentId} in ${Math.round(REFINE_DELAYS_MS[attempt] / 1000)}s (attempt ${attempt + 1})`);
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  // ponytail (rate buckets): agent CRUD sits on its OWN 'agents-crud' bucket,
  // not the app-wide 'vault' one — the vault bucket also gates the Vault tab,
  // memory and skills, so a normal agents session (open the tab, review a few
  // agents, edit one, train, delete one) used to eat the shared 10/min and
  // 429'd the user's OWN next vault read. Reads 60/min, writes 20/min — still
  // per-IP token-bucket guarded, just not shared with the rest of the app.

  router.get('/api/agents', verifyVaultAccess, rateLimit('agents-crud', 60), (_req, res) => {
    const ids = agentSkillIds();
    res.json({
      success: true,
      agents: listAgents().map((a) => ({ ...a })),
      validSkillIds: [...ids],
      validTools: [...VALID_TOOLS],
      serverKeys: { groq: !!process.env.GROQ_API_KEY, openrouter: !!process.env.OPENROUTER_API_KEY },
    });
  });

  // Draft: compose the manual + pin a model (+ optionally gather). NEVER persists.
  router.post('/api/agents/draft', verifyVaultAccess, rateLimit('agents-draft', 6), async (req, res) => {
    const description = String(req.body?.description || '').trim().slice(0, 1000);
    const internet = req.body?.gatherInternet === true;
    const urls: string[] = (Array.isArray(req.body?.urls) ? req.body.urls : []).map(String).slice(0, CAPS.urls);
    if (description.length < 10) {
      res.status(400).json({ success: false, error: 'description_too_short', message: 'Describe the task in at least a sentence.' });
      return;
    }
    const keys = keysFromRequest(req);
    try {
      const ranked = rankModelForKeys(keys);
      // Who actually wrote the manual — the chat fn fills the `via` box, so the
      // "Drafted by" card can never claim a model that failed. Seam mode (tests)
      // reports the top catalog pick instead: the seam stands in for it.
      const via: { model: string } = { model: '' };
      const trackedChat = deps._draftChat
        ? (sys: string, user: string) => deps._draftChat!(sys, user)
        : makeDraftChat(keys, via); // pass 1 races once; pass 2 pins the winner
      let composed: { name: string; systemPrompt: string; tools: string[]; domain?: string };
      let templateDrafted = false;
      try {
        composed = await composeDraft(description, keys, trackedChat as any);
      } catch (err: any) {
        // A missing draft LLM key shouldn't dead-end the whole flow: fall back
        // to a mechanical template the user can edit in the review form.
        composed = {
          name: 'Custom agent',
          tools: guessToolsFromText(description),
          systemPrompt: mechanicalManual(description),
        };
        templateDrafted = true;
      }

      // Optional internet gathering — opt-in only, additional strict bucket.
      const gather = deps._gather ?? gatherDomainKnowledge;
      let gatherResult: Awaited<ReturnType<typeof gatherDomainKnowledge>> | null = null;
      if (internet || urls.length) {
        if (internet && localRateLimited('agents-learn', req, 3)) {
          res.status(429).json({ success: false, error: 'rate_limited', message: 'Too many gathering requests — wait a minute and try again.' });
          return;
        }
        gatherResult = await gather(description, {
          internet,
          urls,
          groqKey: keys.groq || undefined,
          exaKey: keys.exa || undefined,
        });
      }

      // Keep the brain hunt warm in the background: probeBrains is
      // self-throttled (≤1 round / 15 min), so this never burns the budget a
      // draft needs. Never under the test seam (zero-network tests).
      if (!deps._draftChat) probeBrains(keys);

      res.json({
        success: true,
        draft: {
          name: composed.name,
          description,
          systemPrompt: composed.systemPrompt,
          tools: composed.tools.length ? composed.tools : guessToolsFromText(description),
          domain: composed.domain || '',
          model: ranked.model,
          modelReason: ranked.reason,
        draftModel: templateDrafted ? '' : (via.model || draftCandidatePool(keys)[0]?.model || ''),
        draftModelReason: templateDrafted
          ? 'No drafting model was reachable (free-tier rate limits or missing keys) — this is the local template. Retry Draft in a minute or two, or save it and edit the manual directly; a saved agent also re-drafts itself in the background.'
          : (via.model
            ? `First responder of a simultaneous free-model race (${draftCandidatePool(keys).length} candidates), then pinned to write the manual directly — health-scored for future drafts.`
            : 'Hardcoded drafting fallback (Groq gpt-oss-20b → OpenRouter free).'),
        },
        gather: gatherResult,
      });
    } catch (err: any) {
      console.error('[agents] draft failed:', err?.message ?? err);
      res.status(400).json({ success: false, error: 'draft_failed', message: String(err?.message ?? err).slice(0, 300) });
    }
  });

  // Save (create or update — id presence decides).
  router.post('/api/agents', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const body = req.body || {};
    const ids = agentSkillIds();
    const partial = body.id ? getAgent(String(body.id)) || undefined : undefined;
    if (body.id && !partial) {
      res.status(404).json({ success: false, error: 'not_found', message: 'No agent with that id to update.' });
      return;
    }
    const entry = sanitizeAgentDraft(body, ids, partial);
    if (!entry.systemPrompt.trim()) {
      res.status(400).json({ success: false, error: 'prompt_required', message: 'An agent needs a system prompt.' });
      return;
    }
    saveAgent(entry);
    res.json({ success: true, agent: entry });
  });

  router.put('/api/agents/:id', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const existing = getAgent(paramId(req));
    if (!existing) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const entry = sanitizeAgentDraft(req.body || {}, agentSkillIds(), existing);
    entry.id = existing.id; // an update can never change identity
    saveAgent(entry);
    res.json({ success: true, agent: entry });
  });

  router.delete('/api/agents/:id', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const id = paramId(req);
    const ok = deleteAgent(id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    deleteRuns(id);
    res.json({ success: true });
  });

  // Re-gather for a saved agent → proposed skills/knowledge, NOT applied.
  router.post('/api/agents/:id/gather', verifyVaultAccess, rateLimit('agents-learn', 3), async (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const keys = keysFromRequest(req);
    const internet = req.body?.internet === true;
    const urls: string[] = (Array.isArray(req.body?.urls) ? req.body.urls : []).map(String).slice(0, CAPS.urls);
    const gather = deps._gather ?? gatherDomainKnowledge;
    const result = await gather(agent.description, {
      internet,
      urls,
      groqKey: keys.groq || undefined,
      exaKey: keys.exa || undefined,
    });
    res.json({ success: true, proposed: result });
  });

  // Run history.
  router.get('/api/agents/:id/runs', verifyVaultAccess, rateLimit('agents-crud', 60), (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    res.json({ success: true, runs: loadRuns(agent.id) });
  });

  // Memory management: clear-all or remove one entry.
  router.delete('/api/agents/:id/memory', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const updated = { ...agent, memory: [], updatedAt: Date.now() };
    saveAgent(updated);
    res.json({ success: true, agent: updated });
  });

  router.delete('/api/agents/:id/memory/:idx', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= agent.memory.length) {
      res.status(400).json({ success: false, error: 'bad_index' });
      return;
    }
    const memory = agent.memory.filter((_, i) => i !== idx);
    const updated = { ...agent, memory, updatedAt: Date.now() };
    saveAgent(updated);
    res.json({ success: true, agent: updated });
  });

  // Knowledge: remove one note.
  router.delete('/api/agents/:id/knowledge/:idx', verifyVaultAccess, rateLimit('agents-crud', 20), (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= agent.knowledge.length) {
      res.status(400).json({ success: false, error: 'bad_index' });
      return;
    }
    const knowledge = agent.knowledge.filter((_, i) => i !== idx);
    const updated = { ...agent, knowledge, updatedAt: Date.now() };
    saveAgent(updated);
    res.json({ success: true, agent: updated });
  });

  // ── Neural layer surface ─────────────────────────────────────────────────
  // GET  /:id/neural       — the agent's self-training state (weights, cycles,
  //                         deep-tunes, history, pending traffic depth)
  // POST /:id/neural/train — trigger one training cycle NOW (the UI's "Train
  //                         now" button; the background trainer does the same
  //                         thing every 90s on its own)

  router.get('/api/agents/:id/neural', verifyVaultAccess, rateLimit('agents-crud', 60), (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const state = agent.neural || emptyNeuralState();
    const focus = neuralFocusBlock(state);
    res.json({
      success: true,
      neural: {
        ...state,
        weightsTop: Object.entries(state.weights)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([term, w]) => ({ term, weight: Math.round(w * 10) / 10 })),
        pendingTraffic: trafficDepth(agent.id),
        focusLine: focus,
      },
    });
  });

  router.post('/api/agents/:id/neural/train', verifyVaultAccess, rateLimit('agents-train', 6), async (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    if (trafficDepth(agent.id) === 0) {
      res.json({
        success: true,
        trained: false,
        message: 'No domain traffic observed yet — use the platform normally; the agent trains on what it sees.',
      });
      return;
    }
    // Interactive training uses the caller's own BYOK keys for the deep-tune
    // pass (this is a user-triggered action, same policy as /draft), while the
    // background trainer sticks to server-env keys per the background rule.
    const keys = keysFromRequest(req);
    const chat = deps._trainChat
      ? deps._trainChat
      : async (sys: string, user: string) => {
        const t = await poolChatFor({ ...SERVER_KEYS(), ...keys }, sys, user);
        if (t === null) throw new Error('No drafting model reachable for the deep-tune pass.');
        return t;
      };
    const out = await trainAgentNeural(agent.id, { _chat: chat as any });
    res.json({
      success: true,
      trained: !!(out && out.trained),
      ...(out ? { traffic: out.traffic, deepTuned: out.deepTuned, lessons: out.lessons } : {}),
      message: out && out.trained
        ? `Trained on ${out.traffic} observed message(s)${out.deepTuned ? ' + a deep-tune pass' : ''}.`
        : 'Training skipped — no fresh traffic.',
    });
  });

  // ── Interactive SSE run ──────────────────────────────────────────────────
  // Same streaming contract as /api/chat: `event: search` for tool steps,
  // plain data lines for content, `event: lessons` at the end with the memory
  // this run added. writeTools are excluded server-side when confirmWrites is
  // explicitly off; default ON (the confirm-card flow the terminal already
  // renders).
  router.post('/api/agents/:id/run', verifyVaultAccess, rateLimit('agents-run', 10), async (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const userMessage = String(req.body?.message || '').trim().slice(0, 4000) || `Run your task now. ${agent.description}`;
    const keys = { ...keysFromRequest(req) };
    const gather = deps._gather ?? gatherDomainKnowledge;
    const confirmWrites = req.body?.confirmWrites !== false;
    let tools = agentToolSpecs(agent);
    if (!confirmWrites) tools = tools.filter((t: any) => !['gmail_send', 'calendar_create'].includes(t.function.name));

    const providerConfig: ProviderConfig = resolveProviderConfig(agent.model, keys);

    // Prior turns of this SSE chat, so a "yes, send it" reply actually reaches
    // the tool that proposed the write (same contract as /api/chat). The client
    // sends its transcript as messages[]; turn-capped and length-capped.
    const rawHistory = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const chatHistory = rawHistory
      .slice(-10)
      .map((m: any) => ({
        role: m?.role === 'assistant' ? 'assistant' : 'user',
        content: String(m?.content ?? m?.text ?? '').trim(),
      }))
      .filter((m: any) => m.content)
      .slice(0, 20);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string | null, data: unknown) => {
      const payload = JSON.stringify(data);
      res.write(event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`);
    };

    let output = '';
    const steps: string[] = [];
    const ctx: ToolCtx = {
      groq: keys.groq,
      exa: keys.exa,
      nvidia: keys.nvidia,
      openrouter: keys.openrouter,
      pollinations: keys.pollinations,
      hf: keys.hf,
      confirmWrites,
      onStep: (t: string) => {
        if (steps.length < 40) steps.push(String(t).slice(0, 200));
        send('search', { text: t });
      },
      emitEvent: (event, payload) => send(String(event), payload),
      userMessage,
      userTimezone: String(req.headers['x-timezone'] || agent.schedule?.timezone || 'UTC'),
    };

    const systemContent = buildAgentSystemPrompt(agent, skillGuidesFor(agent));

    try {
      const handled = await runAgentLoop({
        providerConfig,
        systemContent,
        userContent: userMessage,
        history: chatHistory,
        ctx,
        tools,
        // 16, not 12: specialist agents legitimately chain more tool hops than
        // chat (gather → cross-check → draft is three alone), and cutting an
        // expert off mid-verification is exactly the "weak agent" feel the
        // builder is being upgraded away from.
        maxIters: 16,
        writeContent: (t: string) => { output += t; send('content', { text: t }); },
        writeError: (t: string) => { send('error', { text: t }); },
        ...(deps._createStream ? { _createStream: deps._createStream } : {}),
      });
      if (!handled && !output) {
        send('error', { text: 'The model call failed before any output — check your provider keys in the vault.' });
      }
    } catch (err: any) {
      send('error', { text: String(err?.message ?? err).slice(0, 300) });
    }

    // Memory distillation + run record (best-effort; never blocks the stream end).
    let lessons: string[] = [];
    try {
      // Re-read AFTER the run (the pre-run snapshot would miss anything that
      // happened while it streamed). A null here means the agent was deleted
      // mid-run — never saveAgent an orphan (resurrecting a deleted agent).
      const fresh = getAgent(agent.id);
      if (fresh) {
        const merged = await distillAgentMemory(fresh, output, userMessage, { groqKey: keys.groq });
        // The distill just awaited for up to tens of seconds — re-read once
        // more so a memory deleted mid-distill stays deleted, then write only
        // this run's additions back onto the current on-disk state.
        const added = merged.filter((m) => !fresh.memory.includes(m));
        const latest = getAgent(agent.id);
        if (latest) {
          lessons = added.filter((m) => !latest.memory.includes(m));
          const memory = lessons.length ? [...latest.memory, ...lessons] : latest.memory;
          saveAgent({ ...latest, memory, lastRunAt: Date.now(), updatedAt: Date.now() });
        }
        send('lessons', { lessons });
      }
    } catch {
      send('lessons', { lessons: [] });
    }
    try {
      const { recordRun } = await import('./agents.js');
      recordRun(agent.id, {
        startedAt: Date.now(), finishedAt: Date.now(),
        status: output ? 'ok' : 'error',
        trigger: 'manual',
        steps,
        output: output.slice(0, 4000),
        lessons,
      });
    } catch { /* history is best-effort */ }

    res.end();
  });

  // ── Headless re-run on demand (same path the scheduler takes) ───────────
  router.post('/api/agents/:id/run-headless', verifyVaultAccess, rateLimit('agents-run', 3), async (req, res) => {
    const agent = getAgent(paramId(req));
    if (!agent) {
      res.status(404).json({ success: false, error: 'not_found' });
      return;
    }
    const { runAgentHeadless } = await import('./scheduler.js');
    const keys = serverKeys();
    const [rec] = (await runAgentHeadless(agent.id, { keys })) || [];
    if (!rec) {
      res.status(500).json({ success: false, error: 'run_failed' });
      return;
    }
    res.json({ success: true, run: rec });
  });

  // ── Chat ↔ agent handoff surface ──────────────────────────────────────────
  // The terminal consults these while a chat message is being composed/sent:
  //   /match   — "does one of my custom agents own this topic?" (pure local
  //              scoring, no LLM, <1ms — called BEFORE the chat is sent so the
  //              user can choose to route the message through the agent)
  //   /handoff — "is this message asking to CREATE an agent?" (regex prefilter
  //              + one LLM confirmation; called in the background, and on
  //              confirm the terminal fires /auto)
  //   /auto    — the full two-pass draft, SAVED without review. Called only
  //              after /handoff confirmed genuine create-intent.

  router.post('/api/agents/match', verifyVaultAccess, rateLimit('agent-match', 60), (req, res) => {
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    const hit = message.length >= 5 ? matchAgentForMessage(message) : null;
    // Neural ingestion: a domain-matched message is a training signal even if
    // the user never runs the agent — the "learns while you use the platform"
    // half of the layer. The background trainer drains this queue.
    if (hit) observeTrafficForNeuralLearning(hit.agent.id, message);
    if (!hit) {
      res.json({ success: true, agent: null });
      return;
    }
    res.json({
      success: true,
      agent: {
        id: hit.agent.id,
        name: hit.agent.name,
        description: hit.agent.description,
        domain: hit.agent.domain || '',
        tools: hit.agent.tools,
        score: hit.score,
      },
    });
  });

  router.post('/api/agents/handoff', verifyVaultAccess, rateLimit('agents-draft', 6), async (req, res) => {
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    // Cheap regex prefilter — callers should already apply the same test
    // client-side; this re-checks so a stray caller can't burn LLM tokens.
    if (
      message.length < 15 ||
      !/\bagent\b/i.test(message) ||
      !/\b(create|make|build|design|set\s?up|spin\s?up|draft|new|custom|specialist|expert)\b/i.test(message)
    ) {
      res.json({ success: true, create: null });
      return;
    }
    const keys = keysFromRequest(req);
    // A yes/no classification is one tiny prompt — racing all 8 candidates
    // would burn a whole draft's rate budget on it. Top 3 healthiest, small
    // budget, legacy chain as backstop; anything else means "don't create".
    const chat = deps._draftChat ?? (async (sys: string, user: string) => {
      const via: { model: string } = { model: '' };
      const text = await raceDraftChat(keys, sys, user, 'handoff classify', via, 10000, 600, 3);
      if (text !== null) return text;
      return legacyDraftChat(keys, sys, user);
    });
    try {
      const sys = `You classify user messages. Does this message ask for a NEW custom AI agent to be created (not merely mention agents or ask to use one)?

Return ONLY JSON: {"create": true|false, "task": "If true: the task restated as a one-sentence standalone instruction (e.g. 'Research Model UN country positions and draft position papers'), max 300 chars. If false: empty string."}`;
      const raw = await chat(sys, `Message: ${message}`);
      const m = String(raw).match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : {};
      if (parsed?.create === true) {
        const task = String(parsed.task || '').trim().slice(0, 500);
        if (task.length >= 10) {
          res.json({ success: true, create: { task } });
          return;
        }
      }
      res.json({ success: true, create: null });
    } catch (err: any) {
      // No LLM available / provider error → never confirm, never block chat.
      console.error('[agents] handoff classify failed:', err?.message ?? err);
      res.json({ success: true, create: null });
    }
  });

  router.post('/api/agents/auto', verifyVaultAccess, rateLimit('agents-draft', 6), async (req, res) => {
    const description = String(req.body?.description || '').trim().slice(0, 1000);
    if (description.length < 10) {
      res.status(400).json({ success: false, error: 'description_too_short' });
      return;
    }
    const keys = keysFromRequest(req);
    const ranked = rankModelForKeys(keys);
    // Who actually wrote the manual (same via pattern as the draft route):
    // pass 1 races once, pass 2 is pinned to the winner.
    const via: { model: string } = { model: '' };
    const trackedChat = deps._draftChat
      ? (sys: string, user: string) => deps._draftChat!(sys, user)
      : makeDraftChat(keys, via);
    let composed: { name: string; systemPrompt: string; tools: string[]; domain?: string };
    let templateDrafted = false;
    try {
      composed = await composeDraft(description, keys, trackedChat as any);
    } catch {
      composed = {
        name: 'Custom agent',
        tools: guessToolsFromText(description),
        systemPrompt: mechanicalManual(description),
      };
      templateDrafted = true;
    }
    const entry = sanitizeAgentDraft({
      name: composed.name,
      description,
      systemPrompt: composed.systemPrompt,
      tools: composed.tools,
      model: ranked.model,
      domain: composed.domain || '',
      draftModel: templateDrafted ? '' : (via.model || draftCandidatePool(keys)[0]?.model || ''),
      knowledge: [],
      memory: [],
      schedule: null,
    } as any, agentSkillIds());
    saveAgent(entry);
    console.log(`[agents] auto-created "${entry.name}" from a chat request (drafted by ${entry.draftModel || 'local template'})`);

    // Background re-tune (the user's spec): if the template drafted or a weak
    // model served, keep hunting in the background — a later re-draft upgrades
    // THIS agent as soon as a candidate frees up. The re-tune never runs under
    // the test seam and only overwrites an un-edited template manual.
    let pendingRefine = false;
    if (!deps._draftChat && (templateDrafted || !entry.draftModel)) {
      pendingRefine = true;
      scheduleAgentRefine(entry.id, description);
    }
    if (!deps._draftChat) probeBrains(keys); // keep the health hunt warm
    res.json({ success: true, agent: entry, draftModel: entry.draftModel || '', pendingRefine });
  });

  return router;
}

// ── Draft fallbacks (no draft-LLM key) ──────────────────────────────────────

function guessToolsFromText(description: string): string[] {
  const t = description.toLowerCase();
  const tools: string[] = [];
  if (/mail|inbox|email/.test(t)) tools.push('gmail_list');
  if (/send|reply|draft.*mail|email.*(reply|send)|outreach/.test(t)) tools.push('gmail_send');
  if (/calendar|schedule|meeting|appointment/.test(t)) tools.push('calendar_list', 'calendar_create');
  if (/research|news|latest|price|monitor|track|check\b/.test(t) || /search/.test(t)) tools.push('web_search');
  if (/in-depth|deep research|report/.test(t)) tools.push('deep_research');
  if (/document|write|summar|rewrite|proofread/.test(t)) tools.push('document_assist');
  return [...new Set(tools)].filter((x) => VALID_TOOLS.has(x));
}

function mechanicalManual(description: string): string {
  const task = String(description || '').slice(0, CAPS.description);
  return `ROLE: You are a dedicated specialist agent. Your task: ${task}

OPERATING PROCEDURE:
1. On each run, gather the current facts you need with your tools before answering — never guess.
2. Apply the decision heuristics below to whatever the run surfaced.
3. Present the result in the output format below, every time.

DECISION HEURISTICS:
- Prefer verifiable, tool-derived facts over recollection.
- When something is ambiguous, state the ambiguity in one line and proceed with the most useful default.
- Prioritize the urgent and time-sensitive first.

OUTPUT FORMAT:
- A short summary line, then bullet points with the specifics.
- Always include times/dates exactly as the tools reported them.

EDGE CASES:
- If a tool returns nothing, say so plainly and end the run — do not fabricate results.
- If asked to do something outside your task, decline briefly and suggest the right agent or tool.`;
}
