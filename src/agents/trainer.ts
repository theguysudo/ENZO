/**
 * trainer.ts — the background neural trainer ("keeps building itself smarter
 * whether the user runs the agent or not").
 *
 * A 90s unref'd interval walks every saved agent and runs ONE training cycle:
 *
 *   traffic (observed chat messages from /match) ─▶ trainCycle (Hebbian)
 *        │
 *        └─▶ deep tune (only when traffic exists AND a free drafting model
 *             is reachable) — an LLM reviews traffic + weights and proposes
 *             lessons (merged into the agent's editable memory) and focus
 *             boosts (potentiated weights, same α·x rule).
 *
 * BYOK background rule (same as the scheduler): SERVER-ENV keys only, never
 * per-request client keys, and never write tools. Failures are logged and
 * swallowed — a crashed trainer takes the server down with it, so nothing in
 * the tick path may throw. Test-seam `_chat` bypasses all network.
 */
import { listAgents, getAgent, saveAgent, CAPS } from './agents.js';
import {
  emptyNeuralState, trainCycle, drainTraffic, trafficDepth,
  runNeuralDeepTune, type NeuralState,
} from './neural.js';
import { SERVER_KEYS, poolChatFor, probeBrains } from './agentRoutes.js';

const TICK_MS = 90_000;
const DEEP_TUNE_EVERY = 3; // deep-tune at most every Nth cycle (rate-budget kind)

export interface TrainOpts {
  _chat?: (sys: string, user: string) => Promise<string>; // test seam
  _now?: () => number;
}

export interface TrainOutcome {
  agentId: string;
  trained: boolean;
  traffic: number;
  deepTuned: boolean;
  lessons: string[];
}

/** Run one training cycle for one agent. Never throws. Returns null when the
 *  agent is gone or there was no traffic to learn from (nothing to do —
 *  agents without activity simply don't train, by design: no traffic, no
 *  signal, no invented weights). */
export async function trainAgentNeural(agentId: string, opts: TrainOpts = {}): Promise<TrainOutcome | null> {
  try {
    const agent = getAgent(agentId);
    if (!agent) return null;
    const traffic = drainTraffic(agentId);
    if (!traffic.length) return null;

    const state0: NeuralState = agent.neural || emptyNeuralState();
    let state = trainCycle(state0, traffic, agent);

    // Deep tune every Nth cycle with traffic — one LLM pass per few minutes
    // per agent is the free-tier-friendly budget.
    let deepTuned = false;
    let lessons: string[] = [];
    if (state.cycles % DEEP_TUNE_EVERY === 0) {
      const chat = opts._chat
        ? opts._chat
        : ((sys: string, user: string) => poolChatFor(SERVER_KEYS(), sys, user));
      const deep = await runNeuralDeepTune(agent, state, traffic, { _chat: chat });
      if (deep) {
        state = deep.state;
        deepTuned = true;
        // Merge the model-proposed lessons into the agent's memory (dedup,
        // cap — same policy as run distillation). The memory stays editable
        // by the user, so this is never a one-way door.
        const existing = new Set(agent.memory.map((m) => m.toLowerCase()));
        const merged = [...agent.memory];
        for (const l of deep.lessons) {
          const note = l.slice(0, CAPS.memoryLen).trim();
          if (!note || existing.has(note.toLowerCase())) continue;
          existing.add(note.toLowerCase());
          merged.push(note);
          if (merged.length >= CAPS.memoryEntries) break;
        }
        lessons = merged.slice(agent.memory.length).filter(Boolean);
        if (merged.length > agent.memory.length) agent.memory = merged.slice(0, CAPS.memoryEntries);
      }
    }

    const updated = {
      ...agent,
      neural: state,
      memory: agent.memory,
      updatedAt: opts._now ? opts._now() : Date.now(),
    };
    saveAgent(updated);
    return { agentId, trained: true, traffic: traffic.length, deepTuned, lessons };
  } catch (err: any) {
    console.error(`[agents-trainer] cycle failed for ${agentId}:`, err?.message ?? err);
    return null;
  }
}

/** One sweep over all agents. Exported for tests; the interval calls this. */
export async function sweepTrainer(opts: TrainOpts = {}): Promise<number> {
  let trained = 0;
  for (const a of listAgents()) {
    if (!trafficDepth(a.id)) continue; // cheap check before any async work
    const out = await trainAgentNeural(a.id, opts);
    if (out) trained++;
  }
  return trained;
}

let timer: NodeJS.Timeout | null = null;

/** Boot the trainer. Safe in any environment (including keyless CI): the
 *  interval is unref'd, every tick is try/catch'd, and with zero traffic in
 *  the queues the sweep does no network at all. */
export function startNeuralTrainer(opts: TrainOpts = {}): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      void sweepTrainer(opts).then((n) => {
        if (n) {
          console.log(`[agents-trainer] trained ${n} agent(s) this tick`);
          return;
        }
        // Idle platform: nothing to train — keep the drafter's health
        // scoreboard warm instead, so the next real draft doesn't race blind
        // candidates. probeBrains is self-throttled (≤1 round / 15 min),
        // uses server-env keys only, and no-ops when there are none. The
        // test seam (_chat) means zero-network — skip probing then too.
        if (!opts._chat) probeBrains(SERVER_KEYS());
      });
    } catch (err: any) {
      console.error('[agents-trainer] tick failed:', err?.message ?? err);
    }
  }, TICK_MS);
  timer.unref();
  console.log('[agents-trainer] started (90s neural training sweep)');
}

export function stopNeuralTrainer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
