/**
 * types.ts — the ENZO Neural Engine data model (Phases 1–4).
 *
 * Scope: private, per-owner research profile + knowledge graph + learning
 * events, and the zero-cost provider capability registry. Training entities
 * (training_example / training_job / adapter_artifact) are Phase 5+ — the
 * fields they need (consent_version, trainingAllowed, excludedFromTraining)
 * are defined HERE so consent gating exists before any dataset code does.
 *
 * Identity model (adapted from the guide, see the audit report): ENZO has no
 * user accounts — the authenticated owner is the vault-verified device id
 * (x-enzo-owner header), the same ownership pattern as Intelligence and
 * projects. Every record below is scoped by ownerId; "userId" in the guide
 * maps to ownerId everywhere.
 */

export const SCHEMA_VERSION = 1;

/** The 8 research-profile dimensions from the spec (§4.1). */
export const PREF_DIMENSIONS = [
  'depth', 'researchApproach', 'evidenceStandards', 'citationStyle',
  'outputForm', 'uncertainty', 'stoppingCriteria', 'visualization',
] as const;
export type PrefDimension = (typeof PREF_DIMENSIONS)[number];

/** Allowed values per dimension — anything else is rejected at the gate. */
export const PREF_VALUES: Record<PrefDimension, string[]> = {
  depth: ['brief', 'standard', 'exhaustive'],
  researchApproach: ['breadth-first', 'hypothesis-led', 'comparative', 'chronology-first'],
  evidenceStandards: ['primary-sources', 'peer-reviewed', 'official-docs', 'diverse-perspectives'],
  citationStyle: ['inline-citations', 'bibliography', 'source-notes'],
  outputForm: ['executive-summary', 'detailed-report', 'table', 'mind-map', 'annotated-bibliography'],
  uncertainty: ['caveats', 'counterarguments', 'confidence-labels'],
  stoppingCriteria: ['stop-at-convergence', 'keep-searching-counterevidence'],
  visualization: ['mind-map', 'timeline', 'matrix', 'causal-graph'],
};

export type PrefSource = 'user_explicit' | 'inferred';

/** One candidate value for a dimension, with its evidence trail. */
export interface PrefValue {
  value: string;
  source: PrefSource;
  /** 0..1 for inferred values; explicit values are always 1. */
  confidence: number;
  /** How many observations support it (inferred only). */
  samples: number;
  lastSeenAt: number;
  /** Why it was inferred / set (short, bounded — shown in the UI). */
  rationale?: string;
}

export interface ResearchProfile {
  /** dimension → candidate values (explicit and inferred coexist here;
   *  precedence is resolved at read time, never baked in). */
  preferences: Record<PrefDimension, Record<string, PrefValue>>;
  /** Bumped when consent terms change; stored on every derived artifact. */
  consentVersion: number;
  /** Separate consents: personalization is the baseline; training is Phase 5
   *  and requires its own explicit opt-in. */
  trainingAllowed: boolean;
  updatedAt: number;
}

export type NodeType = 'topic' | 'concept' | 'source' | 'claim' | 'method' | 'preference' | 'question' | 'finding';
export type EdgeRelation = 'supports' | 'contradicts' | 'related_to' | 'derived_from' | 'prefers' | 'follows_method' | 'supersedes';

export const NODE_TYPES: readonly NodeType[] = ['topic', 'concept', 'source', 'claim', 'method', 'preference', 'question', 'finding'];
export const EDGE_RELATIONS: readonly EdgeRelation[] = ['supports', 'contradicts', 'related_to', 'derived_from', 'prefers', 'follows_method', 'supersedes'];

export interface NeuralNode {
  id: string;                    // 'nn_<hex>'
  type: NodeType;
  label: string;                 // display label (user-editable)
  normalizedValue: string;       // dedupe key (lowercased, trimmed)
  confidence: number;            // 0..1 — unverified model guesses stay low
  verified: boolean;             // true only when evidence-backed
  sourceEventId?: string;
  sourceRecordId?: string;       // for source/claim nodes
  outdated?: boolean;            // marked stale, excluded from context
  excludedFromTraining?: boolean; // set by Forget — survives in history only
  createdAt: number;
  lastSeenAt: number;
}

export interface NeuralEdge {
  id: string;                    // 'ne_<hex>'
  from: string;                  // node id
  relation: EdgeRelation;
  to: string;                    // node id
  confidence: number;
  evidenceRefs: string[];        // node ids / event ids backing this edge
  createdAt: number;
}

export interface SourceRecord {
  id: string;                    // 'sr_<hex>'
  url: string;
  title: string;
  sourceType: string;            // 'web' | 'paper' | 'docs' | 'github' | 'user'
  retrievedAt: number;
  trustNotes?: string;
  contentHash?: string;
}

export const EVENT_TYPES = [
  'preference_confirmed', 'preference_corrected', 'source_rejected',
  'answer_chosen', 'memory_forgotten', 'training_consent_changed',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LearningEvent {
  id: string;                    // 'evt_<hex>'
  type: EventType;
  /** What the event touches: a dimension+value, a node id, or free detail. */
  dimension?: PrefDimension;
  value?: string;
  nodeId?: string;
  /** Bounded structured payload — sanitized, size-capped, never logged raw. */
  detail?: string;
  signal: 'explicit' | 'inferred';
  provenance: {
    modelId?: string;
    sessionId?: string;
    createdAt: number;
  };
}

/** Phase 4 — zero-cost provider capability (server-verified metadata only). */
export interface ProviderCapability {
  providerId: string;
  modelId: string;
  operation: 'inference' | 'adapter_serve' | 'training';
  freeTierVerified: boolean;
  evidenceUrl: string;
  lastVerifiedAt: string;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  dailyNeuronLimit?: number;
  supportsExternalLoRA: boolean;
  supportsSFT: boolean;
  supportsDPO: boolean;
  requiresBillingMethod: boolean;
  productionEligibleOnFreeTier: boolean;
  privacyClass: 'public' | 'restricted' | 'unknown';
  enabledInZeroCostMode: boolean;
}

/** Per-owner usage counter for quota safety (date-bucketed, in-process + persisted). */
export interface ProviderUsage {
  providerId: string;
  modelId: string;
  dateBucket: string;            // 'YYYY-MM-DD' UTC
  requestCount: number;
  quotaLimit?: number;
  lastVerifiedAt?: number;
}

/** The whole per-owner store file. */
export interface NeuralOwnerState {
  schemaVersion: number;
  ownerId: string;
  profile: ResearchProfile;
  nodes: NeuralNode[];
  edges: NeuralEdge[];
  events: LearningEvent[];
  sources: SourceRecord[];
  usage: ProviderUsage[];
  createdAt: number;
  updatedAt: number;
}
