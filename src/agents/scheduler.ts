/**
 * scheduler.ts — server-side scheduled agent runs.
 *
 * `startAgentScheduler()` is called once at boot (beside startModelSync). A 60s
 * unref'd interval sweeps every agent with a schedule; due agents run headless
 * via the same runAgentLoop as interactive runs, with two hard differences
 * imposed because no human is watching:
 *   - WRITE TOOLS ARE EXCLUDED (gmail_send, calendar_create) — the confirm
 *     loop needs a human; a scheduled agent that could send mail would be a
 *     mail bomb with a cron trigger.
 *   - SERVER-ENV KEYS ONLY (never per-request BYOK keys, never anything a
 *     client could inject into a scheduled run).
 *
 * Failures are recorded as errored runs, never thrown — a crashed scheduler
 * takes the server down with it, so nothing in the tick path may throw. The
 * keyless boot (CI pentest) is safe: agents without server keys record an
 * error run at most once per period.
 */
import {
  type AgentEntry, type RunRecord, getAgent, listAgents, saveAgent, recordRun,
  buildAgentSystemPrompt, resolveProviderConfig, distillAgentMemory, WRITE_TOOLS,
  type AgentKeys, type SkillGuide,
} from './agents.js';
import { getSkill } from '../skills/skills.js';
import { loadBundledSkills } from '../skills/bundled-skills.js';
import { runAgentLoop, type ToolCtx, TOOL_SPECS } from '../agent/agent-tools.js';

const TICK_MS = 60_000;
const LOCK_TIMEOUT_MS = 10 * 60_000;

const running = new Map<string, number>(); // agentId → run start (ms); stale locks expire

/** Guides of the skills an agent has attached (loaded at run time, not
 *  stored in the entry — the skill store owns that text). */
export function skillGuidesFor(agent: AgentEntry): SkillGuide[] {
  const guides: SkillGuide[] = [];
  for (const id of agent.skills.slice(0, 3)) {
    const s = getSkill(id);
    if (s) { guides.push({ name: s.name, instructions: s.instructions }); continue; }
    // Bundled skills (skills-bundled/) never enter the learned store, so
    // getSkill misses them — resolve against the bundled library instead of
    // silently dropping a skill the agent explicitly attached.
    const b = loadBundledSkills().find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (b) guides.push({ name: b.name, instructions: b.instructions });
  }
  return guides;
}

/** Tools a scheduled run may use: the agent's own subset minus write tools. */
export function scheduledToolSpecs(agent: AgentEntry): any[] {
  return TOOL_SPECS.filter(
    (t: any) => agent.tools.includes(t.function.name) && !WRITE_TOOLS.has(t.function.name)
  );
}

/** Pure schedule math. Returns the next due timestamp for an agent, or null
 *  when it has no schedule.
 *   - interval: due every N minutes after the last run (or creation). An
 *     overdue agent is due immediately — downtime catch-up, not skip-ahead.
 *   - daily: due at HH:MM in the agent's timezone, but only if it hasn't
 *     already run today (tz-local). */
export function nextDue(agent: AgentEntry, now: number = Date.now()): number | null {
  const sched = agent.schedule;
  if (!sched) return null;
  const anchor = Math.max(agent.lastRunAt || 0, agent.createdAt || 0);

  if (sched.kind === 'interval') {
    const step = Math.max(5, Math.min(1440, Number(sched.intervalMinutes) || 5)) * 60_000;
    if (!anchor) return now;
    const due = anchor + step;
    return due <= now ? now : due;
  }

  if (sched.kind === 'daily') {
    const [h, m] = String(sched.time || '09:00').split(':').map(Number);
    try {
      const tz = sched.timezone || 'UTC';
      // Offset of the agent's timezone at `now` (ms east of UTC), via the
      // "local wall clock interpreted as UTC, minus actual epoch" trick.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(new Date(now))) parts[p.type] = p.value;
      const asUTC = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour === '24' ? 0 : parts.hour), Number(parts.minute), Number(parts.second),
      );
      const tzOffsetMs = asUTC - now;
      // Epoch of today's 00:00 in the agent's timezone.
      const localMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - tzOffsetMs;
      let due = localMidnight + (h * 60 + m) * 60_000;
      if (due <= anchor) due += 24 * 60 * 60_000; // already ran since today's slot → tomorrow
      return due;
    } catch {
      return null;
    }
  }
  return null;
}

export interface HeadlessRunOpts {
  keys: AgentKeys;                 // server-env keys at boot/sweep time
  userTimezone?: string;
  _createStream?: (opts: any) => Promise<AsyncIterable<any>>; // test seam
  _distillChat?: (sys: string, user: string) => Promise<string>; // memory-distill seam
  userContent?: string;            // override the default task-as-instruction
}

/** Run one agent headless (scheduler or re-run). Never throws — the outcome is
 *  the returned RunRecord, and the agent's lastRunAt/memory are updated on
 *  disk. Returns [record, updatedAgent]. */
export async function runAgentHeadless(
  agentId: string,
  opts: HeadlessRunOpts,
): Promise<[RunRecord, AgentEntry] | null> {
  const agent = getAgent(agentId);
  if (!agent) return null;

  const startedAt = Date.now();
  const steps: string[] = [];
  let output = '';
  let status: RunRecord['status'] = 'ok';

  const keys: AgentKeys = {
    groq: opts.keys.groq || process.env.GROQ_API_KEY || '',
    openrouter: opts.keys.openrouter || process.env.OPENROUTER_API_KEY || '',
    nvidia: opts.keys.nvidia || process.env.NVIDIA_API_KEY || '',
    pollinations: opts.keys.pollinations || process.env.POLLINATIONS_API_KEY || '',
    hf: opts.keys.hf || process.env.HF_TOKEN || '',
    exa: opts.keys.exa || process.env.EXA_API_KEY || '',
  };

  const providerConfig = resolveProviderConfig(agent.model, keys);
  const ctx: ToolCtx = {
    groq: keys.groq,
    exa: keys.exa,
    nvidia: keys.nvidia,
    openrouter: keys.openrouter,
    pollinations: keys.pollinations,
    hf: keys.hf,
    confirmWrites: false, // irrelevant — write tools are excluded entirely
    onStep: (t: string) => { if (steps.length < 40) steps.push(String(t).slice(0, 200)); },
    emitEvent: () => {},
    userMessage: agent.description,
    userTimezone: opts.userTimezone || agent.schedule?.timezone || 'UTC',
  };

  const systemContent = buildAgentSystemPrompt(agent, skillGuidesFor(agent));
  const userContent = opts.userContent || `Run your task now. ${agent.description}`;

  try {
    const handled = await runAgentLoop({
      providerConfig,
      systemContent,
      userContent,
      ctx,
      tools: scheduledToolSpecs(agent),
      maxIters: 12,
      writeContent: (t: string) => { output += t; },
      writeError: (t: string) => { output += `\n[error] ${t}`; status = 'error'; },
      ...(opts._createStream ? { _createStream: opts._createStream } : {}),
    });
    if (!handled && !output) {
      status = 'error';
      output = 'The model call failed before producing output (check server provider keys).';
    }
  } catch (err: any) {
    status = 'error';
    output = String(err?.message ?? err).slice(0, 1000);
  }

  // Best-effort memory distillation — the accumulating "fine-tune".
  let lessons: string[] = [];
  let updated: AgentEntry = { ...agent, lastRunAt: startedAt };
  try {
    const merged = await distillAgentMemory(updated, output, userContent, {
      groqKey: keys.groq,
      ...(opts._distillChat ? { _chat: opts._distillChat } : {}),
    });
    if (merged !== updated.memory) {
      lessons = merged.filter((m) => !updated.memory.includes(m));
      updated = { ...updated, memory: merged };
    }
  } catch (err: any) {
    console.error('[agents-scheduler] memory distill failed:', err?.message ?? err);
  }

  saveAgent(updated);

  const rec: RunRecord = {
    startedAt,
    finishedAt: Date.now(),
    status,
    trigger: 'schedule',
    steps,
    output: output.slice(0, 4000),
    lessons,
  };
  recordRun(agent.id, rec);
  return [rec, updated];
}

/** Sweep once: run every due agent that isn't already running. Exported for
 *  tests; the interval in startAgentScheduler calls this. */
export async function sweepAgents(now: number = Date.now(), opts: HeadlessRunOpts = { keys: {} }): Promise<number> {
  let launched = 0;
  const nowMs = now;
  for (const agent of listAgents()) {
    if (!agent.schedule) continue;
    const due = nextDue(agent, nowMs);
    if (due === null || due > nowMs) continue;

    // Stale lock sweep (a crashed run can't hold the slot forever).
    const held = running.get(agent.id);
    if (held && nowMs - held < LOCK_TIMEOUT_MS) continue;
    running.set(agent.id, nowMs);
    launched++;

    // Fire-and-forget per agent: one slow run never delays the next agent's slot.
    runAgentHeadless(agent.id, opts)
      .catch(() => { /* recorded as an errored run inside */ })
      .finally(() => { running.delete(agent.id); });
  }
  return launched;
}

let timer: NodeJS.Timeout | null = null;

/** Boot the scheduler. Safe to call in any environment (including keyless CI):
 *  the interval is unref'd and every tick is try/catch'd. */
export function startAgentScheduler(opts: HeadlessRunOpts = { keys: {} }): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      void sweepAgents(Date.now(), opts);
    } catch (err: any) {
      console.error('[agents-scheduler] tick failed:', err?.message ?? err);
    }
  }, TICK_MS);
  timer.unref();
  console.log('[agents-scheduler] started (60s sweep)');
}

export function stopAgentScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
