/**
 * types.ts — the ENZO Intelligence data model.
 *
 * An Investigation is the persistent object; every run against it appends an
 * InvestigationRun (a full snapshot of the graph after that run) and new
 * Evidence rows into the investigation-wide ledger. The evidence ledger is
 * append-only with stable ids ("E1", "E2", …) so reports and analyst answers
 * can cite it across runs.
 *
 * SECURITY NOTES (keep these true):
 *  - An Investigation NEVER stores provider keys. Runs get keys per-request
 *    (BYOK headers / body / server env), hold them in memory for the run's
 *    duration, and drop them.
 *  - Everything inside SourceDoc.text is UNTRUSTED web content. It is treated
 *    as data everywhere: extraction prompts fence it, nothing fetched is ever
 *    executed, and the analyst/report prompts re-state that source text can
 *    contain injected instructions.
 */

export type EntityKind =
  | 'organization' | 'person' | 'product' | 'domain' | 'repository'
  | 'document' | 'event' | 'place' | 'other';

export type ClaimStatus = 'supported' | 'unverified' | 'disputed';
export type RelationshipStatus = 'supported' | 'hypothesis' | 'disputed';

export type ConnectorName = 'web_search' | 'website' | 'github' | 'wikipedia' | 'document';

export interface InvestigationBrief {
  /** Plain-English objective — what the user wants to know. */
  objective: string;
  /** Scope: constraints, what to include/exclude, lawful public-source note. */
  scope: string;
  connectors: {
    webSearch: boolean;
    websites: boolean;
    github: boolean;
    wikipedia: boolean;
    documents: boolean;
  };
  /** URLs to start from (official site, repo, filing…). */
  seedUrls: string[];
  /** Per-run budgets — enforced by the orchestrator, not the model. */
  limits: {
    maxSearches: number;
    maxPages: number;
    maxLlmCalls: number;
    timeBudgetMs: number;
  };
}

/** A document the user supplied at creation time (pasted text or a picked
 *  text file). Stored plain — it is the user's own material, not a secret. */
export interface UserDocument {
  name: string;
  text: string;
}

/** A fetched public source. One row per successful (or attempted) fetch. */
export interface SourceDoc {
  id: string;                    // 'src-1', stable within a run
  url: string;
  title: string;
  host: string;
  connector: ConnectorName;
  fetchedAt: number;
  /** sha256 of the normalized text — the change-detector for run diffs. */
  contentHash: string;
  /** Extracted readable text, capped (MAX_SOURCE_CHARS). */
  text: string;
  ok: boolean;
  error?: string;
  /** Best-effort publication date the source declared, if any. */
  publishedAt?: string;
}

/** One sourced claim. The atomic unit the whole product exists around. */
export interface Evidence {
  id: string;                    // 'E1'… stable across runs (append-only ledger)
  runId: string;                 // which run collected it
  sourceId: string;              // SourceDoc.id within that run
  url: string;
  host: string;
  connector: ConnectorName;
  claim: string;
  /** Verbatim supporting passage when we could verify it against the source
   *  text; quoteVerified=false means the extractor paraphrased. */
  quote: string;
  quoteVerified: boolean;
  subject: string;               // primary entity name the claim is about
  entities: string[];            // every entity name mentioned
  retrievedAt: number;
  sourceDate?: string;
  status: ClaimStatus;
  /** Confidence rationale / verification note from the verify phase. */
  note?: string;
}

export interface Entity {
  id: string;                    // 'ent-1'… stable across runs
  name: string;
  aliases: string[];
  kind: EntityKind;
  /** One-line evidence-linked summary (what the ledger says it is). */
  summary?: string;
  evidenceIds: string[];
}

export interface Relationship {
  id: string;
  from: string;                  // Entity.id
  to: string;                    // Entity.id
  label: string;                 // 'maintains', 'links to', 'employs'…
  status: RelationshipStatus;
  evidenceIds: string[];
}

export interface Discrepancy {
  id: string;
  topic: string;
  a: { claimId: string; says: string };
  b: { claimId: string; says: string };
  explanation: string;
  howToResolve: string;
}

/** Diff of a run against the previous run — "Investigate once. Keep knowing." */
export interface RunChanges {
  newEvidence: number;
  /** Evidence from the previous run whose source is gone or now fails. */
  missingSources: Array<{ url: string; note: string }>;
  /** Same URL fetched again, content hash differs. */
  changedSources: Array<{ url: string; note: string }>;
  summary: string;
}

export type RunPhase =
  | 'planning' | 'discovering' | 'extracting' | 'resolving'
  | 'verifying' | 'reporting' | 'done' | 'error' | 'cancelled';

export interface InvestigationRun {
  id: string;                    // 'run-1', 'run-2'…
  n: number;
  startedAt: number;
  finishedAt?: number;
  phase: RunPhase;
  /** Human-readable line for the UI while running. */
  step?: string;
  /** Audit log — every phase transition and notable action (capped). */
  steps: string[];
  /** Research questions the plan phase produced (also mirrored on the
   *  investigation when planOnly runs). */
  questions: string[];
  sources: SourceDoc[];
  /** Evidence ids this run ADDED to the ledger. */
  evidenceIds: string[];
  /** Full graph state after this run (entities/relationships are snapshots,
   *  not appends — the latest run's arrays are the current graph). */
  entities: Entity[];
  relationships: Relationship[];
  discrepancies: Discrepancy[];
  openQuestions: string[];
  /** Markdown report with [E#] citations; a mechanical source appendix is
   *  appended after the model's part. */
  report: string;
  changes?: RunChanges;
  stats: { searches: number; pages: number; llmCalls: number; wallMs: number };
  error?: string;
}

export interface Investigation {
  id: string;                    // 'inv_<hex8>'
  name: string;
  brief: InvestigationBrief;
  documents: UserDocument[];
  /** Research questions from the latest plan (plan-only or full run). */
  questions: string[];
  /** Append-only evidence ledger across all runs (capped, MAX_EVIDENCE). */
  evidence: Evidence[];
  runs: InvestigationRun[];      // oldest → newest, capped (MAX_RUNS)
  ownerToken?: string;           // x-enzo-owner device id bound at creation
  createdAt: number;
  updatedAt: number;
}

/** Per-request key set — memory-only, never persisted. */
export interface RunKeys {
  groq: string;
  exa: string;
}
