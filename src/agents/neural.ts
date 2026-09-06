/**
 * neural.ts — the agent self-training layer ("grows smarter whether used or not").
 *
 * What this IS, honestly: gradient descent on a hosted model's weights is not
 * possible from a self-hosted BYOK box — those weights live behind a provider
 * API. What IS possible, and what this module implements, is the classical
 * functional equivalent used in online-learning systems: a per-agent vector of
 * adaptive association weights updated by an additive Hebbian-style rule with
 * exponential decay —
 *
 *     w(t+1) = clamp(w(t)·λ + α·x)      λ = decay per cycle (forgetting)
 *                                     x = activation (signal frequency)
 *
 * — exactly the update family behind Hopfield/Oja neural memories. Two
 * continuous training signals drive it:
 *
 *   1. PLATFORM TRAFFIC: every chat message whose content falls inside an
 *      agent's domain is observed by the terminal's pre-send /match call — the
 *      agent learns from what the user does, even if the agent is never run.
 *   2. SELF-PLAY: periodically, when a free drafting model is reachable, a
 *      "deep tune" pass reviews the accumulated traffic + current weights and
 *      proposes new expert lessons (merged into the agent's editable memory).
 *
 * The learned weights are not inert telemetry — buildAgentSystemPrompt injects
 * the strongest ones into every future run as a NEURAL FOCUS block, so learning
 * measurably changes behavior.
 */
import type { AgentEntry } from './agents.js';

export interface NeuralState {
  /** term → strength (additive Hebbian with decay; pruned below PRUNE_AT). */
  weights: Record<string, number>;
  /** how many local training cycles have run. */
  cycles: number;
  /** how many deep-tune (LLM) passes have run. */
  deepTunes: number;
  /** last local cycle, epoch ms. */
  lastTrainedAt?: number;
  /** rolling fitness log: net weight change per cycle, capped. */
  history: Array<{ at: number; delta: number; traffic: number }>;
}

const DECAY = 0.995;        // per-cycle forgetting
const CAP_W = 60;           // saturation — no runaway weights
const PRUNE_AT = 0.4;       // forgotten below this
const TOP_K = 8;            // focus terms injected into runs
const HISTORY_CAP = 30;

/** Same stopword spirit as the routing matcher — 'the/and/for' are noise, not
 *  features. Single shared copy, redeclared locally to keep this module
 *  self-contained. */
const NEURAL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'into', 'you',
  'your', 'are', 'can', 'could', 'would', 'should', 'have', 'has', 'had',
  'what', 'when', 'where', 'which', 'does', 'did', 'will', 'want', 'need',
  'please', 'help', 'make', 'give', 'tell', 'show', 'find', 'get', 'set',
  'some', 'any', 'all', 'new', 'latest', 'good', 'best', 'just', 'now', 'how',
  'who', 'why', 'was', 'were', 'our', 'out', 'use', 'using', 'used', 'like',
  'know', 'also', 'more', 'most', 'than', 'then', 'them', 'they', 'she', 'her',
  'his', 'him', 'its', 'it', 'one', 'two', 'very', 'much', 'many', 'each',
  'every', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'here',
]);

/** Tokenize text into candidate feature terms: ≥4 chars, non-stopword. */
export function extractFeatures(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || NEURAL_STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) { out.push(raw); continue; } // repeats raise activation
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Sanitize a neural state coming off disk or from the trainer. NEVER accepts a
 *  client-supplied state — sanitizeAgentDraft ignores incoming `neural` fields
 *  and only the trainer (server-side) ever writes here. */
export function sanitizeNeuralState(n: any): NeuralState {
  const weights: Record<string, number> = {};
  if (n && typeof n === 'object' && n.weights && typeof n.weights === 'object') {
    for (const [k, v] of Object.entries(n.weights).slice(0, 200)) {
      const w = Number(v);
      if (Number.isFinite(w) && w > PRUNE_AT) {
        weights[String(k).toLowerCase().slice(0, 40)] = Math.min(w, CAP_W);
      }
    }
  }
  const history = Array.isArray(n?.history)
    ? n.history
      .filter((h: any) => h && Number.isFinite(h.at))
      .slice(0, HISTORY_CAP)
      .map((h: any) => ({ at: Number(h.at), delta: Number(h.delta) || 0, traffic: Number(h.traffic) || 0 }))
    : [];
  return {
    weights,
    cycles: Math.max(0, Math.min(Number(n?.cycles) || 0, 1_000_000)),
    deepTunes: Math.max(0, Math.min(Number(n?.deepTunes) || 0, 1_000_000)),
    ...(Number.isFinite(Number(n?.lastTrainedAt)) ? { lastTrainedAt: Number(n.lastTrainedAt) } : {}),
    history,
  };
}

export function emptyNeuralState(): NeuralState {
  return { weights: {}, cycles: 0, deepTunes: 0, history: [] };
}

/** One local learning cycle: fold `signals` (domain traffic texts) into the
 *  weights. Features already rooted in the agent's identity (domain words,
 *  manual words) potentiate stronger — the network is conditioned on who the
 *  agent already is. Returns the new state; pure — no disk. */
export function trainCycle(
  state: NeuralState,
  signals: string[],
  agent: { domain?: string; systemPrompt?: string },
): NeuralState {
  // Identity conditioning: features present in the agent's domain/manual get
  // an activation multiplier — training strengthens what the agent IS.
  const identity = new Set(extractFeatures(`${agent.domain || ''} ${agent.systemPrompt || ''}`));
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(state.weights)) weights[k] = v * DECAY;
  let delta = 0;
  let traffic = 0;
  for (const signal of signals) {
    const feats = extractFeatures(signal);
    if (!feats.length) continue;
    traffic++;
    const counts = new Map<string, number>();
    for (const f of feats) counts.set(f, (counts.get(f) || 0) + 1);
    for (const [f, n] of counts) {
      const activation = identity.has(f) ? 1.5 * n : 0.5 * n;
      const before = weights[f] || 0;
      weights[f] = Math.min(CAP_W, before + activation);
      delta += weights[f] - before;
    }
  }
  // Prune forgotten weights.
  for (const k of Object.keys(weights)) if (weights[k] < PRUNE_AT) delete weights[k];
  const history = [...state.history, { at: Date.now(), delta: Math.round(delta * 100) / 100, traffic }]
    .slice(-HISTORY_CAP);
  return { ...state, weights, cycles: state.cycles + 1, lastTrainedAt: Date.now(), history };
}

/** The focus block injected into runs — the visible behavioral effect of
 *  learning. Top-K weights, strength-ordered. */
export function neuralFocusBlock(state: NeuralState | undefined): string | null {
  if (!state) return null;
  const top = Object.entries(state.weights)
    .filter(([, w]) => w >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_K);
  if (!top.length) return null;
  const terms = top.map(([t, w]) => `${t}:${w.toFixed(1)}`).join(' · ');
  return `[NEURAL FOCUS — areas this agent has self-trained strongest on from your platform activity. Weight them first: ${terms}]`;
}

// ── Traffic ingestion ────────────────────────────────────────────────────────
// In-memory per-agent buffers of domain-matched chat messages. Volatile by
// design: traffic is only interesting live; restart clears the backlog. Capped
// so a chatty user can't balloon memory.

const TRAFFIC_QUEUE_CAP = 40;
const trafficQueues = new Map<string, string[]>();

/** Called by the terminal's pre-send /match route on every domain hit — the
 *  "learns while you use the platform" ingestion point. */
export function observeTrafficForNeuralLearning(agentId: string, message: string): void {
  let q = trafficQueues.get(agentId);
  if (!q) { q = []; trafficQueues.set(agentId, q); }
  const msg = String(message || '').slice(0, 500);
  if (!msg.trim()) return;
  q.push(msg);
  if (q.length > TRAFFIC_QUEUE_CAP) q.splice(0, q.length - TRAFFIC_QUEUE_CAP);
}

export function drainTraffic(agentId: string): string[] {
  const q = trafficQueues.get(agentId);
  if (!q || !q.length) return [];
  const drained = q.splice(0, q.length);
  return drained;
}

export function trafficDepth(agentId: string): number {
  return trafficQueues.get(agentId)?.length || 0;
}

// ── Deep tune (the LLM pass) ──────────────────────────────────────────────────

export interface DeepTuneResult {
  lessons: string[];   // 0-3 new expert lessons, capped to CAPS.memory style
  focus: string[];     // terms the model says deserve weight boosts
}

/** Prompt pair for the deep pass. Exported for tests. */
export function deepTunePrompt(agent: { name: string; domain?: string; systemPrompt?: string }, traffic: string[], state: NeuralState): string {
  const top = Object.entries(state.weights).sort((a, b) => b[1] - a[1]).slice(0, TOP_K)
    .map(([t, w]) => `${t} (${w.toFixed(1)})`).join(', ') || '(nothing yet)';
  const excerpts = traffic.slice(-8).map((t) => `- ${t.slice(0, 160)}`).join('\n') || '(no recent traffic)';
  return `You are the self-training system for an AI agent named "${agent.name}", specialized in ${agent.domain || 'its task'}.

The agent's current operating manual (excerpt): ${String(agent.systemPrompt || '').slice(0, 1200)}

Recent user activity in this agent's domain (traffic it has observed):
${excerpts}

Its self-trained attention weights so far: ${top}

From the traffic and the manual, propose how this agent should get sharper.

Return ONLY JSON:
{
  "lessons": ["1-3 short imperatives this agent should always follow, grounded in the traffic. Each ≤200 chars. No repeats of the manual's existing rules."],
  "focus": ["2-6 single terms whose attention weight should grow"]
}`;
}

export interface DeepTuneOpts {
  _chat?: (sys: string, user: string) => Promise<string>; // test seam
}

/** Run one deep-tune pass: an LLM reviews accumulated traffic + weights and
 *  proposes lessons + focus boosts. Returns null when no seam/LLM available. */
export async function runNeuralDeepTune(
  agent: AgentEntry,
  state: NeuralState,
  traffic: string[],
  opts: DeepTuneOpts = {},
): Promise<(DeepTuneResult & { state: NeuralState }) | null> {
  const sys = 'You are an expert-training engine. You improve AI agents by studying how they are actually used. Reply with JSON only.';
  const user = deepTunePrompt(agent, traffic, state);
  let raw: string;
  try {
    if (opts._chat) {
      raw = await opts._chat(sys, user);
    } else {
      return null; // production callers pass a chat fn wired to the free-model pool
    }
  } catch {
    return null;
  }
  let parsed: any = null;
  try {
    const m = String(raw).match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return null;
  const lessons: string[] = (Array.isArray(parsed.lessons) ? parsed.lessons : [])
    .map((x: any) => String(x || '').trim())
    .filter((s: string) => s.length >= 10 && s.length <= 300)
    .slice(0, 3);
  const focus: string[] = (Array.isArray(parsed.focus) ? parsed.focus : [])
    .map((x: any) => String(x || '').toLowerCase().trim())
    .filter((s: string) => s.length >= 4 && s.length <= 30)
    .slice(0, 6);
  // Focus boosts potentiate the weights (same rule as traffic, α·x).
  const weights = { ...state.weights };
  for (const f of focus) {
    weights[f] = Math.min(CAP_W, (weights[f] || 0) + 2);
  }
  return { lessons, focus, state: { ...state, weights, deepTunes: state.deepTunes + 1 } };
}
