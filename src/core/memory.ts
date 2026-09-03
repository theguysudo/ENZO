/**
 * memory.ts — the agent's durable notes, in one JSON file.
 *
 * Owns: `memory-store.json` and everything that reads or edits it —
 * `recordMemory`, `rememberFact`, `forgetMemory`, `getFacts`, `buildMemoryContext`,
 * plus the intent detectors (`isRememberIntent`, `isForgetIntent`,
 * `isContinueIntent`, `isListMemoryIntent`, `isIdentityProbe`) that decide when a
 * message is about memory rather than a normal turn.
 * Called by: index.ts (chat routes), tunnel.ts (the OpenAI-compatible endpoint).
 *
 * Entries are keyed by TOPIC, never by the model that produced them. That is the
 * whole design: research started on one provider can be continued on another
 * after a restart, because recall does not depend on who wrote it.
 *
 * ponytail: one JSON file, rewritten whole, no index. Fine at a few hundred
 * entries and a single operator. If it grows past that, or gets a second
 * concurrent writer, this wants SQLite — the read/write pair is the seam.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_PATH = path.resolve(__dirname, 'memory-store.json');

// Memory is deliberately model/provider agnostic: entries are keyed by topic,
// not by the model that produced them, so any model/API can recall work done
// earlier by a different model/API (e.g. research started on Groq/deepseek can
// be continued on Llama after a reboot).

export interface MemoryEntry {
  id: string;
  topic: string; // short normalized topic (derived from first user message)
  title: string; // human-readable title (first user message snippet)
  model: string; // model that produced this entry
  provider: string; // provider (groq, openrouter, pollinations, nvidia, hf)
  mode: string; // chatMode (normal / thinking / research / coding)
  summary: string; // what was accomplished (last assistant text, truncated)
  lastUserMessage: string;
  lastAssistantText: string;
  createdAt: number;
  updatedAt: number;
  kind?: 'work' | 'fact'; // 'fact' = explicit /remember fact, always injected
}

interface MemoryStore {
  entries: MemoryEntry[];
  facts?: string[]; // explicit long-term facts (legacy-safe)
}

const EMPTY: MemoryStore = { entries: [] };

let cache: MemoryStore | null = null;

export function loadMemory(): MemoryStore {
  if (cache) return cache;
  try {
    if (fs.existsSync(MEMORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
      if (raw && Array.isArray(raw.entries)) {
        cache = raw as MemoryStore;
        return cache;
      }
    }
  } catch (err) {
    console.error('[memory] Error reading memory store:', err);
  }
  cache = { entries: [] };
  return cache;
}

export function persistMemory(store: MemoryStore): void {
  try {
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(store, null, 2), 'utf-8');
    cache = store;
  } catch (err) {
    console.error('[memory] Error writing memory store:', err);
  }
}

const MAX_ENTRIES = 200;

/** Split a message into meaningful lowercase tokens (drops stopwords/punct). */
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','so','of','to','in','on','at','for','with',
  'from','by','is','are','was','were','be','been','being','it','its','this','that','these',
  'those','i','me','my','we','our','you','your','they','them','their','he','she','his','her',
  'not','no','do','does','did','have','has','had','can','could','will','would','should',
  'about','into','over','up','down','as','anymore','please','now','just','get','got','want',
  'need','like','still','there','here','what','why','how','when','where','who','which',
]);

/**
 * True when a turn is an identity/meta probe ("which model are you", "who are
 * you", "what are you powered by"). These turns are model-specific trivia, NOT
 * durable work: recording their answer (e.g. "I am the gemma-4-26b-a4b-it:free
 * model") contaminates memory, and injecting another model's identity answer
 * into a different model's context makes THAT model parrot the wrong identity
 * (a cross-model memory echo). They're excluded from both recording and recall.
 */
const IDENTITY_PROBE_RE =
  /\b(which|what|who)\b.{0,30}\b(model|provider|engine|name|this|are\s+you|you\s+are|running\s+on|powered\s+by|built\s+on)\b/i;

export function isIdentityProbe(message: string): boolean {
  const m = (message || '').trim().toLowerCase();
  if (!m) return false;
  if (IDENTITY_PROBE_RE.test(m)) return true;
  // Bare questions like "who are you?", "what are you?" also qualify.
  return /^(who|what)\s+are\s+you\??$/i.test(m);
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function overlapScore(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  let hits = 0;
  for (const t of aTokens) if (bSet.has(t)) hits += 1;
  return hits;
}

/** Normalize a user message into a stable topic key (for grouping/recall). */
export function topicKey(text: string): string {
  return tokenize(text).slice(0, 6).join(' ') || (text || '').slice(0, 40).toLowerCase();
}

/** Create/update a memory entry for a completed conversation turn. */
export function recordMemory(input: {
  userMessage: string;
  assistantText: string;
  model: string;
  provider: string;
  mode: string;
}): void {
  const store = loadMemory();
  const now = Date.now();

  // Identity/meta probes ("which model are you", "who are you") are NOT durable
  // work — and their answers are model-specific trivia that contaminates other
  // models' contexts if re-injected. Skip recording them entirely.
  if (isIdentityProbe(input.userMessage || '')) return;

  const topic = topicKey(input.userMessage) || 'general';

  // Reuse the most recent entry sharing the same topic (same thread), so
  // follow-up turns fold into one memory entry instead of piling up.
  const existing = store.entries.find(
    (e) => e.topic === topic && now - e.updatedAt < 24 * 60 * 60 * 1000
  );

  const summary = (input.assistantText || '').trim().slice(0, 400);
  const title = (input.userMessage || '').trim().slice(0, 80) || topic;

  if (existing) {
    existing.title = title;
    existing.model = input.model;
    existing.provider = input.provider;
    existing.mode = input.mode;
    existing.summary = summary;
    existing.lastUserMessage = (input.userMessage || '').trim().slice(0, 500);
    existing.lastAssistantText = (input.assistantText || '').trim().slice(0, 2000);
    existing.updatedAt = now;
  } else {
    store.entries.unshift({
      id: `mem_${now}_${Math.random().toString(36).slice(2, 7)}`,
      topic,
      title,
      model: input.model,
      provider: input.provider,
      mode: input.mode,
      summary,
      lastUserMessage: (input.userMessage || '').trim().slice(0, 500),
      lastAssistantText: (input.assistantText || '').trim().slice(0, 2000),
      createdAt: now,
      updatedAt: now,
    });
  }

  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(0, MAX_ENTRIES);
  }

  persistMemory(store);
}

/** True when the user message reads like "continue the previous work". */
export function isContinueIntent(message: string): boolean {
  const m = (message || '').toLowerCase();
  return /(continue|resume|pick\s*up|keep\s*going|carry\s*on|go\s*ahead|same\s*thing|where\s*were\s*we|last\s*time|as\s*we\s*discussed|finish\s*(it|the)|complete\s*(it|the)|on\s*it)/.test(m);
}

/** Store an explicit long-term fact (e.g. "/remember my name is Enzo"). Facts are
 *  always injected into the system prompt, independent of topic scoring — they
 *  survive across providers, APIs, and models. */
export function rememberFact(fact: string): MemoryEntry {
  const store = loadMemory();
  const now = Date.now();
  const text = fact.trim();
  const topic = 'fact:' + (topicKey(text).slice(0, 24) || 'fact');

  // Fold repeated identical facts; keep a per-fact dedupe within 24h.
  const existing = store.entries.find((e) => e.kind === 'fact' && e.lastUserMessage === text);
  if (existing) {
    existing.updatedAt = now;
    existing.summary = text.slice(0, 400);
    persistMemory(store);
    return existing;
  }

  const entry: MemoryEntry = {
    id: `fact_${now}_${Math.random().toString(36).slice(2, 7)}`,
    topic,
    title: 'REMEMBER: ' + text.slice(0, 60),
    model: '',
    provider: '',
    mode: 'fact',
    summary: text.slice(0, 400),
    lastUserMessage: text.slice(0, 500),
    lastAssistantText: '',
    createdAt: now,
    updatedAt: now,
    kind: 'fact',
  };
  store.entries.unshift(entry);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(0, MAX_ENTRIES);
  }
  persistMemory(store);
  return entry;
}

/** Remove memory entries (facts or work) whose text matches a query. Returns the
 *  number of entries removed. Supports /forget <query> and /forget-all. */
export function forgetMemory(query?: string): number {
  const store = loadMemory();
  const q = (query || '').trim().toLowerCase();
  if (!q || q === 'all' || q === '*') {
    const n = store.entries.length;
    store.entries = [];
    persistMemory(store);
    return n;
  }
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => {
    const hay = `${e.title} ${e.summary} ${e.lastUserMessage} ${e.lastAssistantText}`.toLowerCase();
    return !hay.includes(q);
  });
  const removed = before - store.entries.length;
  if (removed > 0) persistMemory(store);
  return removed;
}

/** List all stored facts (explicit long-term memories). */
export function getFacts(): string[] {
  const store = loadMemory();
  return store.entries.filter((e) => e.kind === 'fact').map((e) => e.summary);
}

/** True when the user is asking the assistant to remember something. */
export function isRememberIntent(message: string): boolean {
  return /^\s*\/(remember|memorize|note)\b/i.test(message);
}

/** Extract the fact text from a "/remember <fact>" style message. */
export function extractFactFromMessage(message: string): string | null {
  const m = (message || '').trim();
  const match = m.match(/^\s*\/(remember|memorize|note)\s+(.+)/is);
  return match ? match[2].trim() : null;
}

/** True when the user is asking to forget a memory. */
export function isForgetIntent(message: string): boolean {
  return /^\s*\/(forget|forget-memory|forget-fact|clear-memory|wipe-memory)\b/i.test(message);
}

/** Extract the target from a "/forget <query>" style message. */
export function extractForgetQuery(message: string): string | null {
  const m = (message || '').trim();
  const match = m.match(/^\s*\/(forget|forget-memory|forget-fact|clear-memory|wipe-memory)\s*(.*)$/is);
  if (!match) return null;
  const q = match[2].trim();
  return q || 'all';
}

/** True when the user asks to list memory. */
export function isListMemoryIntent(message: string): boolean {
  return /^\s*\/(memory|memories|list-memory)\b/i.test(message);
}

/**
 * Build a `[MEMORY — PREVIOUS WORK]` context block for the system prompt when
 * the current user message references prior work (continuation intent or a
 * topic overlap with a stored entry). Returns '' when nothing is relevant.
 */
export function buildMemoryContext(userMessage: string, opts?: { maxEntries?: number }): string {
  const store = loadMemory();
  if (!store.entries.length) return '';

  const max = opts?.maxEntries ?? 3;
  const userTokens = tokenize(userMessage);
  const wantsContinue = isContinueIntent(userMessage);

  // Explicit facts are ALWAYS relevant — they're durable, cross-model memory.
  const facts = store.entries.filter((e) => e.kind === 'fact');

  // Score entries: topic/title overlap with the current message, plus a
  // recency boost so "continue" naturally lands on the last thing we did.
  // Identity-probe entries (recorded before they were blocked) are never
  // injected — a model must answer from its own awareness, not parrot a
  // different model's stored self-identification.
  const scored = store.entries
    .filter((e) => e.kind !== 'fact' && !isIdentityProbe(e.lastUserMessage) && !isIdentityProbe(e.title))
    .map((e) => {
      const topicTokens = tokenize(e.topic + ' ' + e.title);
      const summaryTokens = tokenize(e.summary + ' ' + e.lastUserMessage);
      let score = overlapScore(userTokens, topicTokens) * 2 + overlapScore(userTokens, summaryTokens);
      const ageDays = (Date.now() - e.updatedAt) / 86400000;
      score += Math.max(0, 1 - ageDays / 30); // recent entries score higher
      if (wantsContinue) score += ageDays < 7 ? 2 : 0; // continuation targets recent work
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const threshold = wantsContinue ? 0.5 : 2.5;
  const relevant = scored.filter((s) => s.score >= threshold).slice(0, max);

  if (!relevant.length && !facts.length) return '';

  const blocks: string[] = [];

  if (facts.length) {
    const factLines = facts
      .slice(0, 8)
      .map((f) => `- ${f.summary}`)
      .join('\n');
    blocks.push(
      `[MEMORY — FACTS]\n` +
      `The user has explicitly asked you to remember these facts. Always honor them in responses:\n${factLines}`
    );
  }

  if (relevant.length) {
    const lines = relevant.map(({ e }, i) => {
      const age =
        e.updatedAt === e.createdAt
          ? 'recently'
          : `last updated ${new Date(e.updatedAt).toLocaleString()}`;
      return (
        `${i + 1}. Topic: ${e.title}\n` +
        `   Done on: ${[e.provider, e.model].filter(Boolean).join('/') || 'unknown model'} (${e.mode} mode), ${age}\n` +
        `   What was done: ${e.summary || '(no summary — see last exchange)'}\n` +
        (e.lastAssistantText
          ? `   Last response tail: "${e.lastAssistantText.slice(-240)}"\n`
          : '')
      );
    });

    blocks.push(
      `[MEMORY — PREVIOUS WORK]\n` +
      `The user previously worked on the following (possibly with a different model/provider). ` +
      `Use it to continue seamlessly if the user asks you to.\n${lines.join('\n')}`
    );
  }

  return blocks.join('\n\n');
}

/** Load memory entries for debugging / future endpoints. */
export function getMemoryEntries(limit = 20): MemoryEntry[] {
  return loadMemory().entries.slice(0, limit);
}

/** Wipe the memory store (admin action). */
export function clearMemory(): void {
  persistMemory({ entries: [] });
}
