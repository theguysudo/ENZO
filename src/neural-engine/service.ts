/**
 * service.ts — the Neural Engine's pure business logic.
 *
 * No I/O in this file: every function takes state (or a state accessor) and
 * returns values, which is what makes precedence, context budgeting and
 * forget-semantics unit-testable without a filesystem. store.ts handles
 * persistence; router.ts handles HTTP; this file owns the rules:
 *
 *  - Precedence: task override > user_explicit > inferred > none. Explicit
 *    never loses to confidence math; inferred needs >= 2 samples.
 *  - Context assembly: bounded (CAPS.contextChars), irrelevant graph nodes
 *    are never injected, provenance always shown, unverified claims labeled.
 *  - Events: confirm/correct/reject/forget mutate profile + graph and append
 *    an audit event; Forget also sets excludedFromTraining so Phase 5's
 *    dataset builder can honor it.
 *  - Graph: nodes dedupe by normalizedValue; edges are validated upstream
 *    (store.sanitizeEdgeInput) and carry evidence refs; unverified model
 *    guesses stay verified:false and are labeled in context.
 */
import {
  CAPS, newId, type EventInput, type NeuralOwnerState, type NeuralNode, type NeuralEdge,
  type LearningEvent, type PrefDimension, type PrefValue, type SourceRecord,
} from './store.js';
import { PREF_DIMENSIONS, type ResearchProfile } from './types.js';

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeValue(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Preference precedence (§4.2) ─────────────────────────────────────────────

export interface EffectivePreference {
  dimension: PrefDimension;
  value: string | null;
  source: 'user_explicit' | 'inferred' | 'default';
  confidence: number;
  samples: number;
}

const MIN_INFERRED_SAMPLES = 2;

/** Resolve one dimension. Task overrides (explicit, per-request) win first,
 *  then saved explicit values (most recently set wins among them), then
 *  inferred values that have enough support, else null. */
export function effectivePreference(
  profile: ResearchProfile,
  dimension: PrefDimension,
  taskOverride?: string,
): EffectivePreference {
  if (taskOverride && taskOverride.trim()) {
    return { dimension, value: taskOverride.trim(), source: 'user_explicit', confidence: 1, samples: 1 };
  }
  const candidates = profile.preferences[dimension] ?? {};
  const explicit = Object.values(candidates).filter((p) => p.source === 'user_explicit')
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (explicit.length) {
    return { dimension, value: explicit[0].value, source: 'user_explicit', confidence: 1, samples: explicit[0].samples };
  }
  const inferred = Object.values(candidates).filter((p) => p.source === 'inferred' && p.samples >= MIN_INFERRED_SAMPLES)
    .sort((a, b) => (b.confidence - a.confidence) || (b.lastSeenAt - a.lastSeenAt));
  if (inferred.length) {
    return { dimension, value: inferred[0].value, source: 'inferred', confidence: inferred[0].confidence, samples: inferred[0].samples };
  }
  return { dimension, value: null, source: 'default', confidence: 0, samples: 0 };
}

export function effectivePreferences(profile: ResearchProfile, taskOverrides?: Partial<Record<PrefDimension, string>>): EffectivePreference[] {
  return PREF_DIMENSIONS.map((d) => effectivePreference(profile, d, taskOverrides?.[d]));
}

// ── Graph retrieval (token overlap, bounded — same approach as gather.ts) ────

const STOPWORDS = new Set(['a','an','the','and','or','but','of','to','in','on','at','for','with','from','by','is','are','was','were','be','it','its','this','that','these','those','what','why','how','when','where','who','which','not','no','do','does','did']);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
}

export function scoreNodeAgainstQuery(node: NeuralNode, query: string): number {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const hay = tokenize(`${node.label} ${node.normalizedValue}`);
  let hits = 0;
  for (const t of tokens) {
    if (hay.some((h) => h === t || (t.length >= 4 && h.length >= 4 && (h.startsWith(t) || t.startsWith(h))))) hits++;
  }
  // Zero topical overlap → never injected, no matter how fresh or confident.
  if (hits === 0) return 0;
  const recency = Math.min(1, node.lastSeenAt > 0 ? Math.max(0, 1 - (Date.now() - node.lastSeenAt) / (90 * 86_400_000)) : 0);
  return hits + node.confidence * 0.5 + recency * 0.3;
}

/** Active (not forgotten, not outdated) nodes ranked for a query. */
export function relevantNodes(state: NeuralOwnerState, query: string, limit = CAPS.contextNodes): NeuralNode[] {
  return state.nodes
    .filter((n) => !n.excludedFromTraining && !n.outdated)
    .map((n) => ({ n, s: scoreNodeAgainstQuery(n, query) }))
    .filter((x) => x.s > 0.6)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.n);
}

// ── Context assembly (§4.3) — bounded, provenance-carrying, injection-safe ──

export interface TaskOverrides {
  query: string;
  preferences?: Partial<Record<PrefDimension, string>>;
}

/** The research-style brief injected into chat/research prompts. Returns ''
 *  when there is nothing to say (empty profile → byte-for-byte no-op for the
 *  prompt), never exceeds CAPS.contextChars, and always labels inferred
 *  values as learned + unverified claims as such. */
export function buildResearchContext(state: NeuralOwnerState, task: TaskOverrides): string {
  const prefs = effectivePreferences(state.profile, task.preferences);
  const set = prefs.filter((p) => p.value);
  const facts = relevantNodes(state, task.query);
  if (!set.length && !facts.length) return '';

  const lines: string[] = ['[RESEARCH PROFILE — how this user wants research done; their current message overrides any item here]'];
  const chars = () => lines.join('\n').length;
  for (const p of set) {
    if (!p.value) continue;
    const tag = p.source === 'user_explicit' ? 'explicit' : `learned, confidence ${p.confidence.toFixed(2)} from ${p.samples} observations`;
    const line = `- ${p.dimension}: ${p.value} (${tag})`;
    if (chars() + line.length + 2 > CAPS.contextChars) break;
    lines.push(line);
  }
  if (facts.length) {
    lines.push('Relevant knowledge from this user\'s research graph:');
    for (const n of facts) {
      const flag = n.verified ? '' : ' [UNVERIFIED — treat as a hypothesis, not a fact]';
      const line = `- (${n.type}) ${n.label}${flag}`;
      if (chars() + line.length + 2 > CAPS.contextChars) break;
      lines.push(line);
    }
  }
  return lines.join('\n').slice(0, CAPS.contextChars);
}

// ── Graph mutation ───────────────────────────────────────────────────────────

/** Add a node, merging into an existing one when the normalized value matches
 *  (merging bumps confidence toward 1 and refreshes lastSeenAt). */
export function upsertNode(
  state: NeuralOwnerState,
  input: { type: NeuralNode['type']; label: string; confidence: number; verified: boolean; sourceUrl?: string },
  sourceEventId?: string,
): { node: NeuralNode; merged: boolean } {
  const normalized = normalizeValue(input.label);
  const existing = state.nodes.find((n) => !n.excludedFromTraining && n.normalizedValue === normalized && n.type === input.type);
  if (existing) {
    existing.lastSeenAt = Date.now();
    existing.confidence = Math.min(1, Math.max(existing.confidence, input.confidence) + 0.05);
    existing.verified = existing.verified || input.verified;
    if (sourceEventId && !existing.sourceEventId) existing.sourceEventId = sourceEventId;
    return { node: existing, merged: true };
  }
  let sourceRecordId: string | undefined;
  if (input.sourceUrl) sourceRecordId = upsertSource(state, { url: input.sourceUrl, title: input.label.slice(0, CAPS.label), sourceType: 'web', retrievedAt: Date.now() }).id;
  const node: NeuralNode = {
    id: newId('nn'),
    type: input.type,
    label: input.label,
    normalizedValue: normalized,
    confidence: input.confidence,
    verified: input.verified,
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(sourceRecordId ? { sourceRecordId } : {}),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  state.nodes.push(node);
  return { node, merged: false };
}

export function upsertSource(state: NeuralOwnerState, input: { url: string; title: string; sourceType: string; retrievedAt: number; trustNotes?: string; contentHash?: string }): SourceRecord {
  const existing = state.sources.find((s) => s.url === input.url);
  if (existing) {
    existing.retrievedAt = input.retrievedAt;
    if (input.title) existing.title = input.title.slice(0, CAPS.title);
    return existing;
  }
  const rec: SourceRecord = {
    id: newId('sr'),
    url: input.url.slice(0, CAPS.url),
    title: input.title.slice(0, CAPS.title),
    sourceType: input.sourceType.slice(0, 40),
    retrievedAt: input.retrievedAt,
    ...(input.trustNotes ? { trustNotes: input.trustNotes.slice(0, CAPS.trustNotes) } : {}),
    ...(input.contentHash ? { contentHash: input.contentHash } : {}),
  };
  state.sources.push(rec);
  return rec;
}

export function addEdge(state: NeuralOwnerState, input: { from: string; relation: NeuralEdge['relation']; to: string; confidence: number }, evidenceRefs: string[] = []): NeuralEdge {
  const dup = state.edges.find((e) => e.from === input.from && e.to === input.to && e.relation === input.relation);
  if (dup) {
    dup.confidence = Math.min(1, Math.max(dup.confidence, input.confidence) + 0.05);
    for (const ref of evidenceRefs) if (!dup.evidenceRefs.includes(ref)) dup.evidenceRefs.push(ref);
    return dup;
  }
  const edge: NeuralEdge = {
    id: newId('ne'),
    from: input.from,
    relation: input.relation,
    to: input.to,
    confidence: input.confidence,
    evidenceRefs: evidenceRefs.slice(0, 8),
    createdAt: Date.now(),
  };
  state.edges.push(edge);
  return edge;
}

// ── Events (§6) — the only mutation path for feedback ────────────────────────

export function appendEvent(state: NeuralOwnerState, ev: EventInput & { signal: LearningEvent['signal']; provenance?: Partial<LearningEvent['provenance']> }): LearningEvent {
  const event: LearningEvent = {
    ...ev,
    id: newId('evt'),
    provenance: { createdAt: Date.now(), ...(ev.provenance ?? {}) },
  };
  state.events.push(event);
  return event;
}

/** Record an explicit user preference (from the profile UI or a correction). */
export function setExplicitPreference(state: NeuralOwnerState, dimension: PrefDimension, value: string, rationale?: string): PrefValue {
  const bucket = state.profile.preferences[dimension];
  // A new explicit value for a dimension supersedes other explicit values:
  // mark them removed (delete) — explicit history lives in events.
  for (const [v, p] of Object.entries(bucket)) {
    if (p.source === 'user_explicit' && v !== value) delete bucket[v];
  }
  const pref: PrefValue = { value, source: 'user_explicit', confidence: 1, samples: Math.max(1, bucket[value]?.samples ?? 1), lastSeenAt: Date.now(), ...(rationale ? { rationale } : {}) };
  bucket[value] = pref;
  state.profile.updatedAt = Date.now();
  return pref;
}

/** Record an observed preference signal (inferred — never from a single click). */
export function recordInferredPreference(state: NeuralOwnerState, dimension: PrefDimension, value: string, rationale: string): PrefValue {
  const bucket = state.profile.preferences[dimension];
  const existing = bucket[value];
  if (existing && existing.source === 'user_explicit') {
    // An explicit choice never loses to an inference — the user's own
    // statement outranks anything the system observed. (The chat path also
    // guards this, but the rule belongs to the service, not to one caller.)
    return existing;
  }
  if (existing && existing.source === 'inferred') {
    existing.samples += 1;
    existing.confidence = Math.min(0.95, existing.confidence + 0.08);
    existing.lastSeenAt = Date.now();
    return existing;
  }
  const pref: PrefValue = { value, source: 'inferred', confidence: 0.4, samples: 1, lastSeenAt: Date.now(), rationale: rationale.slice(0, CAPS.rationale) };
  bucket[value] = pref;
  state.profile.updatedAt = Date.now();
  return pref;
}

/** Apply a validated learning event to state. Returns the event + a short
 *  human summary of what changed (for the UI), or null if it was a no-op. */
export function applyEvent(
  state: NeuralOwnerState,
  input: EventInput,
  signal: 'explicit' | 'inferred',
): { event: LearningEvent; summary: string } | null {
  switch (input.type) {
    case 'preference_confirmed': {
      if (!input.dimension || !input.value) return null;
      const bucket = state.profile.preferences[input.dimension];
      const pref = bucket[input.value];
      if (pref) {
        pref.confidence = Math.min(1, pref.confidence + 0.15);
        pref.samples += 1;
        pref.lastSeenAt = Date.now();
      } else {
        // Confirming a value the profile has never seen is still the user
        // stating a preference — record it as explicit instead of pretending
        // something changed (the old path returned "Confirmed …" with no
        // profile change at all).
        setExplicitPreference(state, input.dimension, input.value);
      }
      const event = appendEvent(state, { ...input, signal, provenance: { ...(input.modelId ? { modelId: input.modelId } : {}) } });
      return { event, summary: `Confirmed ${input.dimension}: ${input.value}` };
    }
    case 'preference_corrected': {
      if (!input.dimension || !input.value) return null;
      setExplicitPreference(state, input.dimension, input.value, input.detail);
      const event = appendEvent(state, { ...input, signal: 'explicit', provenance: {} });
      return { event, summary: `Corrected ${input.dimension} → ${input.value} (explicit)` };
    }
    case 'source_rejected': {
      if (!input.nodeId) return null;
      const node = state.nodes.find((n) => n.id === input.nodeId);
      if (!node) return null;
      node.confidence = 0;
      node.outdated = true;
      node.excludedFromTraining = true;
      // Downgrade edges that leaned on this node.
      for (const e of state.edges) {
        if (e.from === node.id || e.to === node.id) e.confidence = Math.max(0, e.confidence - 0.3);
      }
      const event = appendEvent(state, { ...input, signal, provenance: {} });
      return { event, summary: `Rejected "${node.label.slice(0, 60)}" — excluded from context and future datasets` };
    }
    case 'answer_chosen': {
      // A/B choice — becomes a DPO pair candidate ONLY after review (Phase 5).
      const event = appendEvent(state, { ...input, signal, provenance: { ...(input.modelId ? { modelId: input.modelId } : {}) } });
      return { event, summary: 'Recorded response choice (reviewed pairs feed the Phase 5 dataset builder)' };
    }
    case 'memory_forgotten': {
      let summary = '';
      if (input.nodeId) {
        const node = state.nodes.find((n) => n.id === input.nodeId);
        if (node) {
          node.excludedFromTraining = true;
          node.outdated = true;
          state.edges = state.edges.filter((e) => e.from !== node.id && e.to !== node.id);
          summary = `Forgot node "${node.label.slice(0, 60)}" — removed from graph context and excluded from future datasets`;
        }
      }
      if (input.dimension && input.value) {
        const bucket = state.profile.preferences[input.dimension];
        if (bucket[input.value]) {
          delete bucket[input.value];
          summary = (summary ? summary + '; ' : '') + `Forgot ${input.dimension}: ${input.value}`;
        }
      }
      if (!summary) return null;
      const event = appendEvent(state, { ...input, signal, provenance: {} });
      return { event, summary };
    }
    default:
      return null;
  }
}

/** Observe a research task for inferred-preference learning — called from the
 *  research/chat path ONLY when the user's explicit settings don't cover a
 *  dimension. Deliberately conservative: one observation is never enough. */
export function observeResearchTask(state: NeuralOwnerState, task: { outputForm?: string; depth?: string }): string[] {
  const notes: string[] = [];
  if (task.outputForm) {
    recordInferredPreference(state, 'outputForm', task.outputForm, 'repeated research-output choice');
    appendEvent(state, {
      type: 'answer_chosen',
      dimension: 'outputForm',
      value: task.outputForm,
      detail: 'inferred from repeated research-output choices',
      signal: 'inferred',
      provenance: {},
    });
    notes.push(`outputForm ← ${task.outputForm}`);
  }
  if (task.depth) {
    recordInferredPreference(state, 'depth', task.depth, 'repeated research-depth choice');
    appendEvent(state, {
      type: 'answer_chosen',
      dimension: 'depth',
      value: task.depth,
      detail: 'inferred from repeated research-depth choices',
      signal: 'inferred',
      provenance: {},
    });
    notes.push(`depth ← ${task.depth}`);
  }
  return notes;
}
