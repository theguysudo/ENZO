/**
 * store.ts — the Neural Engine per-owner persistence.
 *
 * One JSON file per owner (`owners/<ownerId>.json`) holding profile, nodes,
 * edges, events, sources and usage counters. Same per-install policy as
 * agents/ and intelligence/ (gitignored, volume-mounted); ENZO_NEURAL_DIR
 * relocates it for tests. Writes are atomic (tmp + rename).
 *
 * Migrations (guide Phase 1): JSON stores have no migration runner, so each
 * file carries schemaVersion and loadOwner() runs migrateOwner() on read —
 * today a no-op passthrough for v1, later the single place where v1→v2 field
 * transforms live. New fields must be defaulted here so an older file never
 * crashes a newer build.
 *
 * SECURITY NOTES (keep these true):
 *  - ownerId comes from the vault-verified x-enzo-owner header and is
 *    charset-validated here — it is also a path component, so anything
 *    outside [a-z0-9-] is rejected before it can touch the filesystem.
 *  - sanitizeProfilePatch is the single validation gate for preference
 *    writes: unknown dimensions/values are rejected, every string is capped.
 *  - Nothing here ever stores provider keys.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  SCHEMA_VERSION, PREF_DIMENSIONS, PREF_VALUES, NODE_TYPES, EDGE_RELATIONS,
  type NeuralOwnerState, type ResearchProfile, type NeuralNode, type NeuralEdge,
  type LearningEvent, type SourceRecord, type PrefDimension, type PrefValue,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NEURAL_DIR = process.env.ENZO_NEURAL_DIR
  ? path.resolve(process.env.ENZO_NEURAL_DIR)
  : path.resolve(__dirname, 'data');
const OWNERS_DIR = path.join(NEURAL_DIR, 'owners');

export const CAPS = {
  label: 160,
  rationale: 240,
  detail: 300,
  url: 600,
  title: 300,
  trustNotes: 300,
  nodes: 500,
  edges: 1500,
  events: 1000,
  sources: 400,
  usage: 200,
  payloadBytes: 12_000,          // max request body for events/nodes writes
  contextChars: 1400,            // hard cap on the assembled overlay context
  contextNodes: 3,               // max graph facts injected per request
} as const;

export function validOwnerId(ownerId: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(ownerId);
}

export function emptyProfile(): ResearchProfile {
  const preferences = {} as ResearchProfile['preferences'];
  for (const d of PREF_DIMENSIONS) preferences[d] = {};
  return { preferences, consentVersion: 1, trainingAllowed: false, updatedAt: Date.now() };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function ownerPath(ownerId: string): string {
  return path.join(OWNERS_DIR, `${ownerId}.json`);
}

/** v1→current migrations. Every new schema version adds a step here. */
function migrateOwner(raw: any): NeuralOwnerState {
  // (v1 is the initial version — nothing to transform yet. Future steps:
  // if (raw.schemaVersion < 2) { ... raw.schemaVersion = 2 })
  raw.schemaVersion = SCHEMA_VERSION;
  return raw as NeuralOwnerState;
}

/** Defense-in-depth coercion for anything read off disk. */
function coerceOwner(raw: any, ownerId: string): NeuralOwnerState {
  const migrated = migrateOwner(raw);
  migrated.ownerId = ownerId;
  migrated.profile = migrated.profile && typeof migrated.profile === 'object' ? migrated.profile : emptyProfile();
  const prefs: ResearchProfile['preferences'] = migrated.profile.preferences ?? emptyProfile().preferences;
  for (const d of PREF_DIMENSIONS) if (!prefs[d] || typeof prefs[d] !== 'object') prefs[d] = {};
  migrated.profile.preferences = prefs;
  migrated.nodes = Array.isArray(migrated.nodes) ? migrated.nodes : [];
  migrated.edges = Array.isArray(migrated.edges) ? migrated.edges : [];
  migrated.events = Array.isArray(migrated.events) ? migrated.events : [];
  migrated.sources = Array.isArray(migrated.sources) ? migrated.sources : [];
  migrated.usage = Array.isArray(migrated.usage) ? migrated.usage : [];
  return migrated;
}

const ownerCache = new Map<string, { state: NeuralOwnerState; loadedAt: number }>();

export function loadOwner(ownerId: string): NeuralOwnerState {
  if (!validOwnerId(ownerId)) throw new Error('invalid owner id');
  const cached = ownerCache.get(ownerId);
  if (cached) return cached.state;
  const file = ownerPath(ownerId);
  try {
    if (fs.existsSync(file)) {
      const state = coerceOwner(JSON.parse(fs.readFileSync(file, 'utf-8')), ownerId);
      ownerCache.set(ownerId, { state, loadedAt: Date.now() });
      return state;
    }
  } catch (err) {
    console.error('[neural-engine] Error reading owner state:', err);
  }
  const fresh: NeuralOwnerState = {
    schemaVersion: SCHEMA_VERSION,
    ownerId,
    profile: emptyProfile(),
    nodes: [],
    edges: [],
    events: [],
    sources: [],
    usage: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  ownerCache.set(ownerId, { state: fresh, loadedAt: Date.now() });
  return fresh;
}

export function saveOwner(state: NeuralOwnerState): void {
  if (!validOwnerId(state.ownerId)) throw new Error('invalid owner id');
  fs.mkdirSync(OWNERS_DIR, { recursive: true });
  // Caps on save — the store must not grow without bound.
  if (state.nodes.length > CAPS.nodes) state.nodes = state.nodes.filter((n) => !n.excludedFromTraining).slice(-CAPS.nodes);
  if (state.edges.length > CAPS.edges) state.edges = state.edges.slice(-CAPS.edges);
  if (state.events.length > CAPS.events) state.events = state.events.slice(-CAPS.events);
  if (state.sources.length > CAPS.sources) state.sources = state.sources.slice(-CAPS.sources);
  if (state.usage.length > CAPS.usage) state.usage = state.usage.slice(-CAPS.usage);
  state.updatedAt = Date.now();
  state.schemaVersion = SCHEMA_VERSION;
  const file = ownerPath(state.ownerId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  ownerCache.set(state.ownerId, { state, loadedAt: Date.now() });
}

export function deleteOwner(ownerId: string): boolean {
  if (!validOwnerId(ownerId)) return false;
  const file = ownerPath(ownerId);
  ownerCache.delete(ownerId);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/** Test seam — drop all cached state. */
export function resetOwnerCache(): void {
  ownerCache.clear();
}

// ── Validation gate ───────────────────────────────────────────────────────────

export interface ProfilePatch {
  set?: Array<{ dimension: PrefDimension; value: string; rationale?: string }>;
  clear?: Array<{ dimension: PrefDimension; value: string }>;
  trainingAllowed?: boolean;
}

/** Throws with a short human message on invalid input; caps everything else. */
export function sanitizeProfilePatch(body: any): ProfilePatch {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const out: ProfilePatch = {};
  if (Array.isArray(body.set)) {
    out.set = body.set.slice(0, 16).map((s: any) => {
      const dimension = String(s?.dimension ?? '') as PrefDimension;
      if (!(PREF_DIMENSIONS as readonly string[]).includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
      const value = String(s?.value ?? '').trim();
      if (!PREF_VALUES[dimension].includes(value)) {
        throw new Error(`invalid value "${value}" for ${dimension} — allowed: ${PREF_VALUES[dimension].join(', ')}`);
      }
      return {
        dimension,
        value,
        ...(s?.rationale ? { rationale: String(s.rationale).trim().slice(0, CAPS.rationale) } : {}),
      };
    });
  }
  if (Array.isArray(body.clear)) {
    out.clear = body.clear.slice(0, 16).map((c: any) => {
      const dimension = String(c?.dimension ?? '') as PrefDimension;
      if (!(PREF_DIMENSIONS as readonly string[]).includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
      const value = String(c?.value ?? '').trim().slice(0, 120);
      if (!value) throw new Error('clear requires a value');
      return { dimension, value };
    });
  }
  if (body.trainingAllowed !== undefined) {
    out.trainingAllowed = body.trainingAllowed === true;
  }
  if (!out.set?.length && !out.clear?.length && out.trainingAllowed === undefined) {
    throw new Error('patch is empty — set, clear or trainingAllowed required');
  }
  return out;
}

/** Bounded node input from routes. Throws on invalid type/label. */
export function sanitizeNodeInput(body: any): { type: NeuralNode['type']; label: string; confidence: number; verified: boolean; sourceUrl?: string } {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const type = String(body?.type ?? '') as NeuralNode['type'];
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`invalid node type "${type}" — allowed: ${NODE_TYPES.join(', ')}`);
  }
  const label = String(body?.label ?? '').trim().slice(0, CAPS.label);
  if (!label) throw new Error('label is required');
  const confidence = Math.max(0, Math.min(1, Number(body?.confidence ?? 0.5) || 0.5));
  const verified = body?.verified === true && confidence >= 0.9;
  let sourceUrl: string | undefined;
  if (body?.sourceUrl) {
    const u = String(body.sourceUrl).trim().slice(0, CAPS.url);
    if (!/^https?:\/\//.test(u)) throw new Error('sourceUrl must be http(s)');
    sourceUrl = u;
  }
  return { type, label, confidence, verified, ...(sourceUrl ? { sourceUrl } : {}) };
}

/** Edge input: both endpoints must exist, relation must be known. */
export function sanitizeEdgeInput(body: any, nodes: NeuralNode[]): { from: string; relation: NeuralEdge['relation']; to: string; confidence: number } {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const from = String(body?.from ?? '');
  const to = String(body?.to ?? '');
  const relation = String(body?.relation ?? '') as NeuralEdge['relation'];
  if (!(EDGE_RELATIONS as readonly string[]).includes(relation)) {
    throw new Error(`invalid relation "${relation}" — allowed: ${EDGE_RELATIONS.join(', ')}`);
  }
  if (!nodes.some((n) => n.id === from)) throw new Error(`unknown from-node: ${from}`);
  if (!nodes.some((n) => n.id === to)) throw new Error(`unknown to-node: ${to}`);
  if (from === to) throw new Error('self-edges are not allowed');
  const confidence = Math.max(0, Math.min(1, Number(body?.confidence ?? 0.6) || 0.6));
  return { from, relation, to, confidence };
}

/** Structured event input — `modelId` is routed into provenance by applyEvent. */
export interface EventInput {
  type: LearningEvent['type'];
  dimension?: PrefDimension;
  value?: string;
  nodeId?: string;
  detail?: string;
  modelId?: string;
}

/** Bounded event input from routes. Throws on unknown types/dimensions. */
export function sanitizeEventInput(body: any): EventInput {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  // Payload gate BEFORE any truncation — a 10MB "detail" must be rejected,
  // not quietly walked down to 300 chars field by field.
  if (JSON.stringify(body).length > CAPS.payloadBytes) throw new Error('event payload too large');
  const type = String(body?.type ?? '') as LearningEvent['type'];
  if (!(['preference_confirmed', 'preference_corrected', 'source_rejected', 'answer_chosen', 'memory_forgotten', 'training_consent_changed'] as const).includes(type as any)) {
    throw new Error(`invalid event type "${type}"`);
  }
  const out: EventInput = { type: type as LearningEvent['type'] };
  if (body?.dimension !== undefined) {
    const dimension = String(body.dimension) as PrefDimension;
    if (!(PREF_DIMENSIONS as readonly string[]).includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
    out.dimension = dimension;
  }
  if (body?.value !== undefined) {
    const value = String(body.value).trim().slice(0, 120);
    // A preference value must be one of the allowed values for its dimension —
    // PATCH /profile already enforces this and the event route must too:
    // otherwise a bogus value ("totally-bogus") gets stored as an explicit
    // preference and injected straight into the model's context.
    if (out.dimension && !PREF_VALUES[out.dimension].includes(value)) {
      throw new Error(`invalid value "${value}" for ${out.dimension} — allowed: ${PREF_VALUES[out.dimension].join(', ')}`);
    }
    out.value = value;
  }
  if (body?.nodeId !== undefined) out.nodeId = String(body.nodeId).slice(0, 40);
  if (body?.detail !== undefined) out.detail = String(body.detail).trim().slice(0, CAPS.detail);
  if (body?.modelId !== undefined) out.modelId = String(body.modelId).slice(0, 120);
  if (JSON.stringify(out).length > CAPS.payloadBytes) throw new Error('event payload too large');
  return out;
}

export type { NeuralOwnerState, ResearchProfile, NeuralNode, NeuralEdge, LearningEvent, SourceRecord, PrefDimension, PrefValue };
