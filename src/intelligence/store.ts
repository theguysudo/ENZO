/**
 * store.ts — the investigation store.
 *
 * Owns the `intelligence/` data directory: an index.json of summaries plus one
 * inv-<id>.json per investigation. Same per-install policy as agents/ and
 * skills/ (gitignored, volume-mounted in docker); ENZO_INTEL_DIR relocates it
 * for tests. Writes are atomic (tmp file + rename) — a crash mid-write must
 * never truncate an investigation that holds hours of collected evidence.
 *
 * SECURITY NOTES (keep these true):
 *  - sanitizeBriefInput is the single validation gate every write passes
 *    through (HTTP routes). It caps every string: the brief, seed URLs, and
 *    user documents are model/user-authored text that gets injected into
 *    future prompts, so uncapped content is how an investigation could balloon
 *    past a provider's context or smuggle in unbounded payloads. Keep the caps.
 *  - ownerToken is the device id (x-enzo-owner), NOT the vault token and never
 *    a provider key.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type {
  Investigation, InvestigationBrief, InvestigationRun, UserDocument,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const INTEL_DIR = process.env.ENZO_INTEL_DIR
  ? path.resolve(process.env.ENZO_INTEL_DIR)
  : path.resolve(__dirname, 'data');
const INDEX_PATH = path.join(INTEL_DIR, 'index.json');

/** Keep growth bounded — an install that runs weekly refreshes for a year
 *  must not accumulate an unbounded file. */
export const CAPS = {
  name: 120,
  objective: 2000,
  scope: 1000,
  seedUrls: 8,
  seedUrlLen: 500,
  documents: 5,
  documentName: 120,
  documentText: 20_000,
  evidence: 400,
  runs: 10,
  steps: 120,
  questions: 12,
  entities: 120,
  relationships: 300,
} as const;

export const DEFAULT_LIMITS: InvestigationBrief['limits'] = {
  maxSearches: 8,
  maxPages: 10,
  maxLlmCalls: 24,
  timeBudgetMs: 240_000,
};

export const LIMIT_BOUNDS = {
  maxSearches: [0, 20],
  maxPages: [1, 30],
  maxLlmCalls: [0, 60],
  timeBudgetMs: [30_000, 600_000],
} as const;

export interface IndexSummary {
  id: string;
  name: string;
  objective: string;           // first 200 chars
  ownerToken?: string;
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
  runs: Array<Pick<InvestigationRun, 'id' | 'n' | 'phase' | 'startedAt' | 'finishedAt'>>;
}

interface IntelIndex { investigations: IndexSummary[] }
const EMPTY_INDEX: IntelIndex = { investigations: [] };

let indexCache: IntelIndex | null = null;

function loadIndex(): IntelIndex {
  if (indexCache) return indexCache;
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
      if (raw && Array.isArray(raw.investigations)) {
        indexCache = raw as IntelIndex;
        return indexCache;
      }
    }
  } catch (err) {
    console.error('[intelligence] Error reading index:', err);
  }
  indexCache = EMPTY_INDEX;
  return indexCache;
}

/** Atomic write: tmp + rename, so a crash mid-write leaves the old file. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function newInvestigationId(): string {
  return `inv_${crypto.randomBytes(4).toString('hex')}`;
}

export function listInvestigations(): IndexSummary[] {
  return loadIndex().investigations;
}

export function getInvestigation(id: string): Investigation | null {
  const norm = String(id || '').toLowerCase();
  if (!/^inv_[a-f0-9]{8}$/.test(norm)) return null;
  const file = path.join(INTEL_DIR, `${norm}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return sanitizeLoaded(raw);
  } catch (err) {
    console.error('[intelligence] Error reading investigation:', err);
    return null;
  }
}

export function saveInvestigation(inv: Investigation): Investigation {
  fs.mkdirSync(INTEL_DIR, { recursive: true });
  const trimmed = trimForCaps(inv);
  writeJsonAtomic(path.join(INTEL_DIR, `${inv.id}.json`), trimmed);

  const index = loadIndex();
  const summary: IndexSummary = {
    id: inv.id,
    name: inv.name,
    objective: inv.brief.objective.slice(0, 200),
    ...(inv.ownerToken ? { ownerToken: inv.ownerToken } : {}),
    evidenceCount: inv.evidence.length,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    runs: inv.runs.slice(-10).map((r) => ({
      id: r.id, n: r.n, phase: r.phase, startedAt: r.startedAt, finishedAt: r.finishedAt,
    })),
  };
  const at = index.investigations.findIndex((i) => i.id === inv.id);
  if (at >= 0) index.investigations[at] = summary;
  else index.investigations.unshift(summary);
  try {
    writeJsonAtomic(INDEX_PATH, index);
    indexCache = index;
  } catch (err) {
    console.error('[intelligence] Error writing index:', err);
  }
  return trimmed;
}

export function deleteInvestigation(id: string): boolean {
  const norm = String(id || '').toLowerCase();
  if (!/^inv_[a-f0-9]{8}$/.test(norm)) return false;
  const file = path.join(INTEL_DIR, `${norm}.json`);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); } catch { return false; }
  const index = loadIndex();
  const at = index.investigations.findIndex((i) => i.id === norm);
  if (at >= 0) {
    index.investigations.splice(at, 1);
    try { writeJsonAtomic(INDEX_PATH, index); indexCache = index; } catch { /* index lags, body is gone */ }
  }
  return true;
}

// ── Validation gate ───────────────────────────────────────────────────────────

function clamp(n: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function cleanUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > CAPS.seedUrlLen) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/** Clamp a per-run limits override (POST /run body) to the same bounds the
 *  brief gate uses. Exported so the run route can accept a limits override
 *  without ever persisting it onto the stored brief. */
export function sanitizeLimits(limitsIn: unknown): InvestigationBrief['limits'] {
  const l = (limitsIn ?? {}) as Record<string, unknown>;
  return {
    maxSearches: clamp(l.maxSearches, LIMIT_BOUNDS.maxSearches, DEFAULT_LIMITS.maxSearches),
    maxPages: clamp(l.maxPages, LIMIT_BOUNDS.maxPages, DEFAULT_LIMITS.maxPages),
    maxLlmCalls: clamp(l.maxLlmCalls, LIMIT_BOUNDS.maxLlmCalls, DEFAULT_LIMITS.maxLlmCalls),
    timeBudgetMs: clamp(l.timeBudgetMs, LIMIT_BOUNDS.timeBudgetMs, DEFAULT_LIMITS.timeBudgetMs),
  };
}

export interface BriefInput {
  name?: unknown;
  objective?: unknown;
  scope?: unknown;
  connectors?: unknown;
  seedUrls?: unknown;
  limits?: unknown;
  documents?: unknown;
}

/** Throws with a short human message on structurally invalid input; caps
 *  everything else. Used by create + patch routes. */
export function sanitizeBriefInput(body: BriefInput): {
  name: string;
  brief: InvestigationBrief;
  documents: UserDocument[];
} {
  const objective = String(body.objective ?? '').trim();
  if (!objective) throw new Error('objective is required');
  const connectorsIn = (body.connectors ?? {}) as Record<string, unknown>;
  const limitsIn = (body.limits ?? {}) as Record<string, unknown>;
  const docsIn = Array.isArray(body.documents) ? body.documents.slice(0, CAPS.documents) : [];

  const documents: UserDocument[] = docsIn.map((d: any) => ({
    name: String(d?.name ?? 'document').trim().slice(0, CAPS.documentName) || 'document',
    text: String(d?.text ?? '').trim().slice(0, CAPS.documentText),
  })).filter((d) => d.text.length > 0);

  const seedUrls = (Array.isArray(body.seedUrls) ? body.seedUrls : [])
    .map(cleanUrl).filter((u): u is string => !!u).slice(0, CAPS.seedUrls);

  const brief: InvestigationBrief = {
    objective: objective.slice(0, CAPS.objective),
    scope: String(body.scope ?? '').trim().slice(0, CAPS.scope),
    connectors: {
      webSearch: connectorsIn.webSearch !== false,
      websites: connectorsIn.websites !== false,
      github: connectorsIn.github === true,
      wikipedia: connectorsIn.wikipedia === true,
      documents: documents.length > 0,
    },
    seedUrls,
    limits: {
      maxSearches: clamp(limitsIn.maxSearches, LIMIT_BOUNDS.maxSearches, DEFAULT_LIMITS.maxSearches),
      maxPages: clamp(limitsIn.maxPages, LIMIT_BOUNDS.maxPages, DEFAULT_LIMITS.maxPages),
      maxLlmCalls: clamp(limitsIn.maxLlmCalls, LIMIT_BOUNDS.maxLlmCalls, DEFAULT_LIMITS.maxLlmCalls),
      timeBudgetMs: clamp(limitsIn.timeBudgetMs, LIMIT_BOUNDS.timeBudgetMs, DEFAULT_LIMITS.timeBudgetMs),
    },
  };

  const name = String(body.name ?? '').trim().slice(0, CAPS.name)
    || objective.slice(0, 60).replace(/\s+\S*$/, '') + (objective.length > 60 ? '…' : '');

  return { name, brief, documents };
}

/** Defense-in-depth for anything read back off disk (hand-edited file, older
 *  schema): coerce to the current shape so a malformed row can't crash a run
 *  or leak into the graph. */
function sanitizeLoaded(raw: any): Investigation {
  const inv = raw as Investigation;
  inv.evidence = Array.isArray(inv.evidence) ? inv.evidence.slice(-CAPS.evidence) : [];
  inv.runs = Array.isArray(inv.runs) ? inv.runs.slice(-CAPS.runs) : [];
  inv.questions = Array.isArray(inv.questions) ? inv.questions.slice(0, CAPS.questions) : [];
  inv.documents = Array.isArray(inv.documents) ? inv.documents.slice(0, CAPS.documents) : [];
  inv.brief = inv.brief && typeof inv.brief === 'object' ? inv.brief : {
    objective: String(inv.brief?.objective ?? ''), scope: '',
    connectors: { webSearch: true, websites: true, github: false, wikipedia: false, documents: false },
    seedUrls: [], limits: { ...DEFAULT_LIMITS },
  };
  return inv;
}

/** Enforce the caps on save (evidence ledger, run history, graph size). */
function trimForCaps(inv: Investigation): Investigation {
  if (inv.evidence.length > CAPS.evidence) inv.evidence = inv.evidence.slice(-CAPS.evidence);
  if (inv.runs.length > CAPS.runs) inv.runs = inv.runs.slice(-CAPS.runs);
  for (const r of inv.runs) {
    if (r.steps.length > CAPS.steps) r.steps = r.steps.slice(-CAPS.steps);
    if (r.entities.length > CAPS.entities) r.entities = r.entities.slice(0, CAPS.entities);
    if (r.relationships.length > CAPS.relationships) r.relationships = r.relationships.slice(0, CAPS.relationships);
  }
  return inv;
}
