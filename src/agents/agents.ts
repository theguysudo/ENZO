/**
 * agents.ts — the custom-agent store.
 *
 * Owns: the `agents/` directory and its `index.json` — CRUD over AgentEntry,
 * plus `sanitizeAgentDraft`, the single validation gate every agent write
 * passes through (HTTP routes, scheduler, tests). Called by: agentRoutes.ts,
 * scheduler.ts, tests/agents.test.ts.
 *
 * `agents/` is gitignored: it is per-install user data (same policy as
 * `skills/`). Docker mounts a named volume over it.
 *
 * SECURITY NOTE. An AgentEntry NEVER stores provider keys. Interactive runs
 * use the keys sent per-request (BYOK); scheduled runs use server-env keys
 * only. `systemPrompt`, `knowledge` and `memory` are model-authored text that
 * gets injected into future prompts — sanitizeAgentDraft caps every one of
 * them, because uncapped prompt-injected content is how a "learned" agent
 * could balloon into a prompt the provider rejects or a vector for whatever
 * the model read off the internet. Keep the caps.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { type NeuralState, neuralFocusBlock, sanitizeNeuralState } from './neural.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ENZO_AGENTS_DIR lets tests relocate the store to a temp dir; default is the
// per-install `agents/` next to this file (gitignored, volume-mounted).
export const AGENTS_DIR = process.env.ENZO_AGENTS_DIR
  ? path.resolve(process.env.ENZO_AGENTS_DIR)
  : path.resolve(__dirname, 'agents');
const AGENTS_INDEX = path.join(AGENTS_DIR, 'index.json');

/** The 9 tools the agent loop can offer — must stay in lockstep with
 *  TOOL_SPECS in src/agent/agent-tools.ts. */
export const VALID_TOOLS = new Set([
  'web_search', 'deep_research',
  'gmail_list', 'gmail_send',
  'calendar_list', 'calendar_create',
  'recommend_model', 'compare_models', 'document_assist',
]);

/** Write tools — excluded from scheduled runs (no human to confirm). */
export const WRITE_TOOLS = new Set(['gmail_send', 'calendar_create']);

export const CAPS = {
  name: 80,
  description: 500,
  systemPrompt: 8000,
  knowledgeNotes: 12,
  knowledgeNoteLen: 1500,
  memoryEntries: 30,
  memoryLen: 400,
  skills: 10,
  urls: 5,
} as const;

export interface AgentSchedule {
  kind: 'daily' | 'interval';
  time?: string;           // 'HH:MM' (daily)
  intervalMinutes?: number; // 5..1440 (interval)
  timezone: string;        // IANA name, e.g. 'Asia/Kolkata'
}

export interface AgentEntry {
  id: string;              // 'agt_<hex8>'
  name: string;
  description: string;     // the plain-English task the user described
  systemPrompt: string;    // the expert manual
  tools: string[];         // subset of VALID_TOOLS
  model: string;           // pinned model ('provider/model' or bare)
  skills: string[];        // skill ids (learned skills this agent uses)
  knowledge: string[];     // distilled domain notes (capped)
  memory: string[];        // accumulating lessons (capped, editable)
  /** What professional domain this agent was specialized for ('MUN research',
   *  'fermentation science') + its insider terms — set by the two-pass draft,
   *  used to route matching chat messages to this agent. */
  domain?: string;
  /** Which FREE model the discovery step picked to write this agent's manual
   *  (provenance, surfaced in the UI: 'drafted by X'). Empty = hardcoded
   *  fallback path or manual creation. */
  draftModel?: string;
  /** Self-trained attention weights (the neural layer, see neural.ts): term →
   *  strength, grown by background training cycles from observed platform
   *  traffic. Server-computed ONLY — sanitizeAgentDraft ignores any
   *  client-supplied neural state, so a hostile payload can't preload a fake
   *  "trained brain" into future run prompts. */
  neural?: NeuralState;
  schedule: AgentSchedule | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

interface AgentsIndex {
  agents: AgentEntry[];
}

const EMPTY_INDEX: AgentsIndex = { agents: [] };

let indexCache: AgentsIndex | null = null;

function loadIndex(): AgentsIndex {
  if (indexCache) return indexCache;
  try {
    if (fs.existsSync(AGENTS_INDEX)) {
      const raw = JSON.parse(fs.readFileSync(AGENTS_INDEX, 'utf-8'));
      if (raw && Array.isArray(raw.agents)) {
        indexCache = raw as AgentsIndex;
        return indexCache;
      }
    }
  } catch (err) {
    console.error('[agents] Error reading agents index:', err);
  }
  indexCache = EMPTY_INDEX;
  return indexCache;
}

function persistIndex(index: AgentsIndex): void {
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.writeFileSync(AGENTS_INDEX, JSON.stringify(index, null, 2), 'utf-8');
    indexCache = index;
  } catch (err) {
    console.error('[agents] Error writing agents index:', err);
  }
}

export function listAgents(): AgentEntry[] {
  return loadIndex().agents;
}

export function getAgent(id: string): AgentEntry | null {
  const norm = String(id || '').toLowerCase();
  return loadIndex().agents.find((a) => a.id.toLowerCase() === norm) || null;
}

export function newAgentId(): string {
  return `agt_${crypto.randomBytes(4).toString('hex')}`;
}

export function saveAgent(entry: AgentEntry): AgentEntry {
  const index = loadIndex();
  const existing = index.agents.findIndex((a) => a.id === entry.id);
  if (existing >= 0) index.agents[existing] = entry;
  else index.agents.unshift(entry);
  persistIndex(index);
  return entry;
}

export function deleteAgent(id: string): boolean {
  const norm = String(id || '').toLowerCase();
  const index = loadIndex();
  const idx = index.agents.findIndex((a) => a.id.toLowerCase() === norm);
  if (idx === -1) return false;
  index.agents.splice(idx, 1);
  persistIndex(index);
  return true;
}

// ── Validation ───────────────────────────────────────────────────────────────

function cleanStr(v: unknown, maxLen: number): string {
  return String(v ?? '').trim().slice(0, maxLen);
}

/** Normalize a schedule object. Returns null for anything unparseable or
 *  out of range — never throws. */
function sanitizeSchedule(v: unknown): AgentSchedule | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const kind = String(s.kind || '');
  const timezone = String(s.timezone || '').trim();
  // Reject bogus timezone names by letting Intl validate the string.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  if (kind === 'daily') {
    const time = String(s.time || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return null;
    const [h, m] = time.split(':').map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { kind: 'daily', time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, timezone };
  }
  if (kind === 'interval') {
    const n = Number(s.intervalMinutes);
    if (!Number.isFinite(n) || n < 5 || n > 1440) return null;
    return { kind: 'interval', intervalMinutes: Math.round(n), timezone };
  }
  return null;
}

export interface AgentDraft {
  name?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  model?: unknown;
  skills?: unknown;
  knowledge?: unknown;
  memory?: unknown;
  schedule?: unknown;
  [k: string]: unknown;
}

/** Validate + normalize a draft agent from an untrusted payload into a full
 *  AgentEntry. Unknown tools dropped, skills filtered against `validSkillIds`
 *  (pass the real learned-skill ids from the caller — kept as a param so the
 *  store has no hard dependency on the skills store), knowledge/memory capped,
 *  schedule normalized. Survives hostile payloads: never throws, never
 *  executes anything, drops anything it cannot make sense of.
 *
 *  When `partial` (an existing entry) is passed, any field ABSENT from the
 *  draft is inherited from it — a PUT with just {tools} updates tools and
 *  leaves the manual untouched, instead of wiping it. Explicit empty values
 *  (null schedule, '') still override. */
export function sanitizeAgentDraft(draft: AgentDraft, validSkillIds: Set<string>, partial?: AgentEntry): AgentEntry {
  const d = draft && typeof draft === 'object' ? draft : {};
  const has = (v: unknown) => v !== undefined;

  const rawTools = Array.isArray(d.tools) ? d.tools : (has(d.tools) ? [] : (partial?.tools ?? []));
  const tools = [...new Set(
    rawTools.map((t) => String(t || '').trim()).filter((t) => VALID_TOOLS.has(t))
  )];

  const rawSkills = Array.isArray(d.skills) ? d.skills : (has(d.skills) ? [] : (partial?.skills ?? []));
  const skills = [...new Set(
    rawSkills.map((s) => String(s || '').trim().toLowerCase()).filter((s) => validSkillIds.has(s))
  )].slice(0, CAPS.skills);

  const rawKnowledge = Array.isArray(d.knowledge) ? d.knowledge : (has(d.knowledge) ? [] : (partial?.knowledge ?? []));
  const knowledge = rawKnowledge
    .map((k) => cleanStr(k, CAPS.knowledgeNoteLen))
    .filter(Boolean)
    .slice(0, CAPS.knowledgeNotes);

  const rawMemory = Array.isArray(d.memory) ? d.memory : (has(d.memory) ? [] : (partial?.memory ?? []));
  const memory = rawMemory
    .map((m) => cleanStr(m, CAPS.memoryLen))
    .filter(Boolean)
    .slice(0, CAPS.memoryEntries);

  const name = (typeof d.name === 'string' && d.name.trim())
    ? cleanStr(d.name, CAPS.name)
    : (partial?.name || 'Untitled agent');
  const description = (typeof d.description === 'string' && d.description.trim())
    ? cleanStr(d.description, CAPS.description)
    : (partial?.description || '');
  const systemPrompt = (typeof d.systemPrompt === 'string' && d.systemPrompt.trim())
    ? cleanStr(d.systemPrompt, CAPS.systemPrompt)
    : (partial?.systemPrompt || '');
  const model = (typeof d.model === 'string' && d.model.trim())
    ? cleanStr(d.model, 200)
    : (partial?.model || 'groq/openai/gpt-oss-20b');
  const domain = (typeof d.domain === 'string' && d.domain.trim())
    ? cleanStr(d.domain, 200)
    : (partial?.domain || '');
  const draftModel = (typeof d.draftModel === 'string' && d.draftModel.trim())
    ? cleanStr(d.draftModel, 200)
    : (partial?.draftModel || '');
  const schedule = has(d.schedule)
    ? sanitizeSchedule(d.schedule)
    : (partial?.schedule ?? null);
  // Neural state comes ONLY from the server's trainer — never from the draft
  // payload (a client-supplied "brain" would be a prompt-injection vector
  // straight into future run prompts). Inherit the stored one when present.
  const neural = partial?.neural ? sanitizeNeuralState(partial.neural) : undefined;

  const now = Date.now();
  return {
    id: partial?.id || newAgentId(),
    name,
    description,
    systemPrompt,
    tools,
    model,
    skills,
    knowledge,
    memory,
    ...(domain ? { domain } : {}),
    // draftModel is always written, even as '' — the "drafted by" card must be
    // able to distinguish "template drafted, no model claimed" from "unknown".
    draftModel,
    ...(neural ? { neural } : {}),
    schedule,
    createdAt: partial?.createdAt || now,
    updatedAt: now,
    lastRunAt: partial?.lastRunAt,
  };
}

/** Re-run sanitizeAgentDraft's caps over an entry loaded from disk, so a
 *  hand-edited or corrupted index can never resurrect oversized fields. */
export function sanitizeAgentEntry(entry: AgentEntry, validSkillIds: Set<string>): AgentEntry {
  return sanitizeAgentDraft(entry as unknown as AgentDraft, validSkillIds, entry);
}

// ── Run history ──────────────────────────────────────────────────────────────

export interface RunRecord {
  startedAt: number;
  finishedAt: number;
  status: 'ok' | 'error';
  trigger: 'manual' | 'schedule';
  steps: string[];      // ≤40 step lines
  output: string;      // ≤4000 chars of final answer
  lessons: string[];   // memory entries this run added
}

const MAX_RUNS = 20;

function runsFile(agentId: string): string {
  return path.join(AGENTS_DIR, `runs-${agentId.replace(/[^a-z0-9_-]/gi, '')}.json`);
}

export function loadRuns(agentId: string): RunRecord[] {
  try {
    if (fs.existsSync(runsFile(agentId))) {
      const raw = JSON.parse(fs.readFileSync(runsFile(agentId), 'utf-8'));
      if (Array.isArray(raw)) return raw as RunRecord[];
    }
  } catch (err) {
    console.error('[agents] Error reading runs:', err);
  }
  return [];
}

export function recordRun(agentId: string, rec: RunRecord): void {
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    const all = loadRuns(agentId);
    all.unshift(rec);
    fs.writeFileSync(runsFile(agentId), JSON.stringify(all.slice(0, MAX_RUNS), null, 2), 'utf-8');
  } catch (err) {
    console.error('[agents] Error writing runs:', err);
  }
}

export function deleteRuns(agentId: string): void {
  try { fs.rmSync(runsFile(agentId), { force: true }); } catch { /* already gone */ }
}

// ── Prompt assembly (shared by interactive runs and the scheduler) ──────────

export interface SkillGuide {
  name: string;
  instructions: string;
}

/** Assemble the full system prompt for one agent run: the expert manual, the
 *  attached skill guides (always injected — an agent's skills are fixed, unlike
 *  chat's message-driven matching), the gathered domain knowledge, and the
 *  accumulating memory. Capped so a bloated agent can't outgrow the context. */
export function buildAgentSystemPrompt(agent: AgentEntry, skillGuides: SkillGuide[]): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const parts: string[] = [];

  parts.push(agent.systemPrompt);

  if (skillGuides.length) {
    parts.push(
      '[AGENT SKILLS — FOLLOW THESE GUIDES]',
      ...skillGuides.slice(0, 3).map((g) =>
        `● Skill: ${g.name}\n${String(g.instructions || '').slice(0, 3000)}`
      )
    );
  }

  if (agent.knowledge.length) {
    parts.push(
      '[DOMAIN KNOWLEDGE — gathered for this agent, treat as reference]',
      ...agent.knowledge.map((k, i) => `${i + 1}. ${k}`)
    );
  }

  if (agent.memory.length) {
    parts.push(
      '[LEARNED MEMORY — lessons distilled from previous runs of this agent. Apply them.]',
      ...agent.memory.map((m, i) => `${i + 1}. ${m}`)
    );
  }

  // The neural layer's behavioral output: the terms this agent has self-trained
  // hardest on from observed platform traffic. Null until the trainer has run
  // at least one productive cycle, so fresh agents carry zero noise.
  const focus = neuralFocusBlock(agent.neural);
  if (focus) parts.push(focus);

  parts.push(`Today's date is ${today}.`);
  return parts.join('\n\n').slice(0, 12000);
}

// ── Provider resolution ──────────────────────────────────────────────────────

export interface AgentKeys {
  groq?: string;
  openrouter?: string;
  nvidia?: string;
  hf?: string;
  pollinations?: string;
  exa?: string;
  [k: string]: string | undefined;
}

/** Map a pinned model id ('provider/model' or bare) + the keys this
 *  invocation actually has → a ProviderConfig for the agent loop. If the
 *  pinned provider has no key, falls back to the first keyed provider with a
 *  known-good default model, mirroring the chat path's smart fallback. */
export function resolveProviderConfig(model: string, keys: AgentKeys): { provider: string; model: string; apiKey: string } {
  const raw = String(model || '').trim();
  if (raw.includes('/')) {
    const [prefix, ...rest] = raw.split('/');
    const modelId = rest.join('/');
    const keyFor: Record<string, string | undefined> = {
      groq: keys.groq, openrouter: keys.openrouter, nvidia: keys.nvidia,
      hf: keys.hf, pollinations: keys.pollinations,
    };
    const apiKey = keyFor[prefix] ?? '';
    if (apiKey) return { provider: prefix, model: modelId, apiKey };
    // Fall through to the keyed-provider chain below.
  }
  if (keys.groq) return { provider: 'groq', model: 'openai/gpt-oss-20b', apiKey: keys.groq };
  if (keys.openrouter) return { provider: 'openrouter', model: 'z-ai/glm-5.2:free', apiKey: keys.openrouter };
  if (keys.nvidia) return { provider: 'nvidia', model: 'meta/llama-3.1-8b-instruct', apiKey: keys.nvidia };
  if (keys.pollinations) return { provider: 'pollinations', model: 'openai', apiKey: keys.pollinations };
  if (keys.hf) return { provider: 'hf', model: 'meta-llama/Llama-3.1-8B-Instruct', apiKey: keys.hf };
  return { provider: 'groq', model: 'openai/gpt-oss-20b', apiKey: String(keys.groq || '') };
}

// ── Chat → agent routing match ───────────────────────────────────────────────

const MATCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'about', 'into', 'you',
  'your', 'are', 'can', 'could', 'would', 'should', 'have', 'has', 'had',
  'what', 'when', 'where', 'which', 'does', 'did', 'will', 'want', 'need',
  'please', 'help', 'make', 'give', 'tell', 'show', 'find', 'get', 'set',
  'some', 'any', 'all', 'new', 'latest', 'good', 'best', 'just', 'now',
]);

/**
 * How strongly a chat message belongs to one custom agent. Pure + local — no
 * model call, safe to run on every message. Signals:
 *   - domain phrase overlap (strongest): message contains the agent's domain
 *     terms — 'mun', 'sake brewing', 'position paper'
 *   - name-token overlap: message uses words from the agent's name
 *   - description phrase overlap: weaker, generic-task vocabulary
 * Never matches on stop-words. Threshold used by callers: >= 5.
 */
export function scoreAgentMatch(agent: AgentEntry, message: string): number {
  const msg = String(message || '').toLowerCase();
  if (!msg.trim()) return 0;
  let score = 0;

  // Domain terms + name get phrase matching (a keyword like 'model united
  // nations' is worth more than any single shared word).
  const name = (agent.name || '').toLowerCase();
  const domain = (agent.domain || '').toLowerCase();
  const description = (agent.description || '').toLowerCase();

  const phrases = [
    ...name.split(/[^a-z0-9]+/).filter((w) => w.length > 2),
    ...domain.split(/[^a-z0-9]+/).filter((w) => w.length > 2),
  ];
  const seen = new Set<string>();
  for (const p of phrases) {
    if (seen.has(p) || MATCH_STOPWORDS.has(p)) continue;
    seen.add(p);
    if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(msg)) score += 4;
  }

  // Description words are weak, additive context ('research', 'invoice').
  const msgTokens = new Set(msg.split(/[^a-z0-9]+/));
  for (const w of description.split(/[^a-z0-9]+/)) {
    if (w.length <= 3 || MATCH_STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    if (msgTokens.has(w)) score += 1;
  }
  return score;
}

/** The best saved agent for a chat message, or null when none clears the
 *  threshold. Used by /api/agents/match (the terminal's pre-send check). */
export function matchAgentForMessage(message: string): { agent: AgentEntry; score: number } | null {
  let best: AgentEntry | null = null;
  let bestScore = 0;
  for (const agent of listAgents()) {
    const score = scoreAgentMatch(agent, message);
    if (score > bestScore) { best = agent; bestScore = score; }
  }
  if (best && bestScore >= 5) return { agent: best, score: bestScore };
  return null;
}

// ── Memory distillation (the fine-tuning effect) ─────────────────────────────

export interface MemoryDistillOpts {
  groqKey?: string;
  _chat?: (sys: string, user: string) => Promise<string>; // test seam
}

/** Distill what a run learned into the agent's accumulating memory. Returns
 *  the merged memory list (existing + new lessons, deduped, capped at 30 × 400).
 *  Best-effort: on any LLM failure the existing memory is returned unchanged. */
export async function distillAgentMemory(agent: AgentEntry, runOutput: string, userMessage: string, opts: MemoryDistillOpts = {}): Promise<string[]> {
  const existing = agent.memory || [];
  const output = String(runOutput || '').slice(0, 3000);
  if (!output.trim()) return existing;

  const sys = `You maintain the memory of a personal AI agent. The agent's task: "${agent.description}". Existing memory:\n` +
    (existing.length ? existing.map((m, i) => `${i + 1}. ${m}`).join('\n') : '(empty)') +
    `\n\nThe agent just ran. User message: "${String(userMessage || '').slice(0, 500)}". Agent output:\n${output}\n\n` +
    `Return ONLY JSON: {"memory": ["..."]} — the merged memory list (existing entries still relevant, plus 0-3 NEW lessons about this user/task: preferences, facts, what worked, corrections). Max 30 entries, each a standalone note under 400 characters. Drop anything stale or duplicated.`;

  const parse = (raw: string): string[] | null => {
    try {
      const j = JSON.parse(raw);
      if (!Array.isArray(j.memory)) return null;
      const seen = new Set<string>();
      const merged: string[] = [];
      for (const m of j.memory) {
        const note = String(m ?? '').trim().slice(0, CAPS.memoryLen);
        const key = note.toLowerCase();
        if (!note || seen.has(key)) continue;
        seen.add(key);
        merged.push(note);
        if (merged.length >= CAPS.memoryEntries) break;
      }
      return merged;
    } catch {
      return null;
    }
  };

  try {
    let raw: string | null = null;
    if (opts._chat) {
      raw = await opts._chat(sys, 'Return JSON only.');
    } else {
      const groq = opts.groqKey || process.env.GROQ_API_KEY || '';
      const orKey = process.env.OPENROUTER_API_KEY || '';
      if (groq) {
        const { Groq } = await import('groq-sdk');
        const client = new Groq({ apiKey: groq, timeout: 15000, maxRetries: 0 });
        const r = await client.chat.completions.create({
          model: 'openai/gpt-oss-20b', // live-verified json mode (2026-09-06) — llama-3.1-8b-instant delisted
          messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Return JSON only.' }],
          temperature: 0.3,
          max_tokens: 900,
          response_format: { type: 'json_object' },
        });
        raw = r.choices[0]?.message?.content || '';
      } else if (orKey) {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'z-ai/glm-5.2:free', // meta-llama/llama-3.1-8b-instruct:free delisted
            messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Return JSON only.' }],
            temperature: 0.3,
            max_tokens: 900,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (r.ok) {
          const j: any = await r.json();
          raw = j?.choices?.[0]?.message?.content || '';
        }
      }
    }
    if (raw) {
      const merged = parse(raw);
      if (merged) return merged;
    }
  } catch (err: any) {
    console.error('[agents] memory distill failed:', err?.message ?? err);
  }
  return existing;
}
