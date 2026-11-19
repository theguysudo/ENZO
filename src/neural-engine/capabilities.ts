/**
 * capabilities.ts — the free-only provider capability registry (Phase 4).
 *
 * Hard policy boundary, not a marketing claim: ZERO_COST_MODE (default ON)
 * rejects any route that is not SERVER-VERIFIED free for the requested
 * operation, fails closed on unknown/stale metadata, and never falls back
 * from a free route to a paid one.
 *
 * The metadata below encodes the zero-budget audit's verified facts (2026-10)
 * with evidence URLs. "Verified" means: a free tier exists, is documented at
 * the evidence URL, and its limits are recorded here — it does NOT mean
 * unlimited or permanent. Re-verify on the schedule; stale entries fail
 * closed (enabledInZeroCostMode=false) until refreshed.
 *
 * FREE-MODEL DISCOVERY: dynamic free flags come from the existing model cache
 * (src/models/model-cache.json, `free: true` per model — the same flag the
 * agent drafter already trusts). A model is inference-eligible in zero-cost
 * mode only when (a) its provider passes the static registry and (b) the
 * cache marks it free. Unknown provider/model → rejected (fail closed).
 *
 * BYOK CONFLICT (documented, not hidden): ENZO is bring-your-own-key — the
 * user's own paid keys are legitimate for /api/chat. The registry therefore
 * governs NEURAL ENGINE routing decisions (overlay model hints, capability
 * listings, Phase 5 training-gate checks). ENZO_STRICT_ZERO_COST=1 extends
 * enforcement to the capability catalog output (paid models omitted
 * entirely); it does not silently rewrite chat model selection — that would
 * be a behavior regression this module refuses to make quietly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ProviderCapability, ProviderUsage } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ZERO_COST_MODE = process.env.ZERO_COST_MODE !== '0'; // default ON
export const STRICT_ZERO_COST = process.env.ENZO_STRICT_ZERO_COST === '1';

const VERIFIED_AT = '2026-10-20';

/** Static per-provider facts from the zero-budget audit. Model-agnostic rows;
 *  model-level eligibility comes from the cache's free flag. */
const PROVIDER_FACTS: Record<string, {
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  dailyNeuronLimit?: number;
  requiresBillingMethod: boolean;
  productionEligibleOnFreeTier: boolean;
  privacyClass: ProviderCapability['privacyClass'];
  evidenceUrl: string;
  enabledInZeroCostMode: boolean;
  supportsExternalLoRA: boolean;
  supportsSFT: boolean;
  supportsDPO: boolean;
}> = {
  groq: {
    dailyRequestLimit: 14_400, // model-specific; conservative pooled ceiling, not a promise
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: true,
    privacyClass: 'restricted',
    evidenceUrl: 'https://groq.com/pricing/',
    enabledInZeroCostMode: true,
    supportsExternalLoRA: false, // enterprise-only serving; does NOT train adapters
    supportsSFT: false,
    supportsDPO: false,
  },
  openrouter: {
    dailyRequestLimit: 50,   // free variants: 20/min and 50/day below purchase threshold
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: true,
    privacyClass: 'restricted',
    evidenceUrl: 'https://openrouter.ai/pricing/',
    enabledInZeroCostMode: true,
    supportsExternalLoRA: false,
    supportsSFT: false,
    supportsDPO: false,
  },
  nvidia: {
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: false, // NIM dev access is R&D-only per NVIDIA docs
    privacyClass: 'restricted',
    evidenceUrl: 'https://docs.api.nvidia.com/nim/docs/product',
    enabledInZeroCostMode: true,         // inference for research/dev, never production claims
    supportsExternalLoRA: false,
    supportsSFT: false,
    supportsDPO: false,
  },
  llm7: {
    dailyTokenLimit: 100_000,
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: false, // educational/research service, no uptime promise
    privacyClass: 'unknown',
    evidenceUrl: 'https://github.com/chigwell/llm7.io/blob/main/TERMS.md',
    enabledInZeroCostMode: true,
    supportsExternalLoRA: false,
    supportsSFT: false,
    supportsDPO: false,
  },
  cloudflare: {
    dailyNeuronLimit: 10_000,
    requiresBillingMethod: false, // only allowlist models that work without one
    productionEligibleOnFreeTier: true,
    privacyClass: 'restricted',
    evidenceUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    enabledInZeroCostMode: true,
    supportsExternalLoRA: true,   // custom LoRA inference exists for supported models (capability-gated per model)
    supportsSFT: false,
    supportsDPO: false,
  },
  google: {
    dailyRequestLimit: 200, // model-specific free-tier limits; conservative pooled ceiling
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: true,
    privacyClass: 'public',  // free-tier data may be used to improve Google products — DISCLOSED in UI
    evidenceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    enabledInZeroCostMode: true,
    supportsExternalLoRA: false, // standard Gemini API tuning is NOT available on the free tier
    supportsSFT: false,
    supportsDPO: false,
  },
  huggingface: {
    requiresBillingMethod: false,
    productionEligibleOnFreeTier: false, // ~$0.10/mo inference credit — experimentation only
    privacyClass: 'unknown',
    evidenceUrl: 'https://huggingface.co/docs/inference-providers/en/pricing',
    enabledInZeroCostMode: true,         // as ecosystem/registry; not production capacity
    supportsExternalLoRA: false,
    supportsSFT: false,                  // TRL/PEFT are free SOFTWARE; compute is separate
    supportsDPO: false,
  },
  pollinations: {
    requiresBillingMethod: true, // current terms include paid Pollen; not reliably free
    productionEligibleOnFreeTier: false,
    privacyClass: 'unknown',
    evidenceUrl: 'https://enter.pollinations.ai/terms',
    enabledInZeroCostMode: false, // disabled by default in zero-cost mode (fail closed)
    supportsExternalLoRA: false,
    supportsSFT: false,
    supportsDPO: false,
  },
};

/** Failure reason carried to the UI — "disabled" must always say WHY. */
export interface RouteDecision {
  allowed: boolean;
  reason: string;
  capability?: ProviderCapability;
}

function modelCachePath(): string {
  return process.env.ENZO_MODEL_CACHE
    ? path.resolve(process.env.ENZO_MODEL_CACHE)
    : path.resolve(__dirname, '../models/model-cache.json');
}

export interface CacheModel {
  id: string;          // 'provider/model'
  provider: string;
  free?: boolean;
  type?: string;
}

/** Read + normalize the model cache (already the repo's shared catalog). */
export function loadModelCache(): CacheModel[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelCachePath(), 'utf-8'));
    const models: any[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.models) ? parsed.models : []);
    return models
      .filter((m) => typeof m?.id === 'string')
      .map((m) => ({ id: String(m.id), provider: String(m.provider ?? m.id.split('/')[0]).toLowerCase(), free: m.free === true, type: m.type }));
  } catch {
    return []; // cache unavailable → nothing is verifiable → fail closed
  }
}

function splitModelId(modelId: string): { providerId: string; bareId: string } {
  const at = modelId.indexOf('/');
  if (at <= 0) return { providerId: modelId.toLowerCase(), bareId: modelId };
  return { providerId: modelId.slice(0, at).toLowerCase(), bareId: modelId };
}

/** The one enforcement function. Fail-closed: unknown provider, unknown
 *  model, non-free model, billing-required provider, disabled provider —
 *  all rejected with a specific reason. Never throws. */
export function assertRouteAllowed(modelId: string, operation: 'inference' | 'adapter_serve' | 'training' = 'inference'): RouteDecision {
  if (!ZERO_COST_MODE) return { allowed: true, reason: 'zero-cost mode disabled by operator' };
  const { providerId, bareId } = splitModelId(String(modelId || ''));
  const facts = PROVIDER_FACTS[providerId];
  if (!facts) {
    return { allowed: false, reason: `provider "${providerId}" is not in the verified registry — fail closed` };
  }
  if (!facts.enabledInZeroCostMode) {
    return { allowed: false, reason: `${providerId} is disabled in zero-cost mode: ${facts.evidenceUrl}` };
  }
  if (facts.requiresBillingMethod) {
    return { allowed: false, reason: `${providerId} requires a billing method for this operation — never in zero-cost mode` };
  }
  if (operation === 'training') {
    return { allowed: false, reason: 'no provider in the registry offers verified free training — training runs in the user\'s own notebook (Phase 6)' };
  }
  if (operation === 'adapter_serve') {
    if (!facts.supportsExternalLoRA) {
      return { allowed: false, reason: `${providerId} does not support external LoRA serving on the free tier` };
    }
    return { allowed: false, reason: `${providerId} LoRA serving requires per-model compatibility verification (Phase 8) — disabled until then` };
  }
  // inference: model must be verified free by the shared cache
  const cache = loadModelCache();
  const model = cache.find((m) => m.id === String(modelId) || m.id === bareId);
  if (!model) {
    return { allowed: false, reason: `model "${modelId}" not found in the verified catalog — fail closed` };
  }
  if (!model.free) {
    return { allowed: false, reason: `model "${modelId}" is not marked free in the verified catalog` };
  }
  return {
    allowed: true,
    reason: `verified free route (${providerId}, model-level free flag; limits apply)`,
    capability: capabilityFor(providerId, modelId),
  };
}

function capabilityFor(providerId: string, modelId: string): ProviderCapability {
  const f = PROVIDER_FACTS[providerId];
  return {
    providerId,
    modelId,
    operation: 'inference',
    freeTierVerified: f.enabledInZeroCostMode && !f.requiresBillingMethod,
    evidenceUrl: f.evidenceUrl,
    lastVerifiedAt: VERIFIED_AT,
    ...(f.dailyRequestLimit ? { dailyRequestLimit: f.dailyRequestLimit } : {}),
    ...(f.dailyTokenLimit ? { dailyTokenLimit: f.dailyTokenLimit } : {}),
    ...(f.dailyNeuronLimit ? { dailyNeuronLimit: f.dailyNeuronLimit } : {}),
    supportsExternalLoRA: f.supportsExternalLoRA,
    supportsSFT: f.supportsSFT,
    supportsDPO: f.supportsDPO,
    requiresBillingMethod: f.requiresBillingMethod,
    productionEligibleOnFreeTier: f.productionEligibleOnFreeTier,
    privacyClass: f.privacyClass,
    enabledInZeroCostMode: f.enabledInZeroCostMode,
  };
}

/** Registry snapshot for the UI. STRICT mode omits paid models entirely;
 *  default mode lists everything the cache knows with an explicit paid flag. */
export function capabilitySnapshot(): {
  zeroCostMode: boolean;
  providers: Array<ProviderCapability & { paidModels: number; freeModels: number }>;
  generatedAt: string;
} {
  const cache = loadModelCache();
  const byProvider = new Map<string, { free: number; paid: number }>();
  for (const m of cache) {
    const key = m.provider || splitModelId(m.id).providerId;
    const slot = byProvider.get(key) ?? { free: 0, paid: 0 };
    if (m.free) slot.free++; else slot.paid++;
    byProvider.set(key, slot);
  }
  const providers = Object.keys(PROVIDER_FACTS).map((providerId) => {
    const counts = byProvider.get(providerId) ?? { free: 0, paid: 0 };
    const cap = capabilityFor(providerId, `${providerId}/*`);
    return { ...cap, freeModels: counts.free, paidModels: STRICT_ZERO_COST && ZERO_COST_MODE ? 0 : counts.paid };
  });
  return { zeroCostMode: ZERO_COST_MODE, providers, generatedAt: new Date().toISOString() };
}

// ── Per-owner quota metering (stop BEFORE the published quota) ───────────────

const QUOTA_SAFETY_MARGIN = 0.8; // act at 80% of the recorded limit

export function usageWithinQuota(usage: ProviderUsage[], modelId: string): { ok: boolean; reason: string; used: number; limit?: number } {
  const { providerId } = splitModelId(modelId);
  const facts = PROVIDER_FACTS[providerId];
  const limit = facts?.dailyRequestLimit;
  const bucket = new Date().toISOString().slice(0, 10);
  const used = usage.filter((u) => u.dateBucket === bucket && splitModelId(u.modelId).providerId === providerId)
    .reduce((s, u) => s + u.requestCount, 0);
  if (!limit) return { ok: true, reason: 'no request limit recorded for this provider', used };
  if (used >= Math.floor(limit * QUOTA_SAFETY_MARGIN)) {
    return { ok: false, reason: `${providerId} free-tier request budget nearly exhausted for today (${used}/${limit}) — stopped before the official quota`, used, limit };
  }
  return { ok: true, reason: `${used}/${limit} today`, used, limit };
}

export function recordUsage(usage: ProviderUsage[], modelId: string): void {
  const bucket = new Date().toISOString().slice(0, 10);
  const existing = usage.find((u) => u.dateBucket === bucket && u.modelId === modelId);
  if (existing) {
    existing.requestCount += 1;
    existing.lastVerifiedAt = Date.now();
  } else {
    const { providerId } = splitModelId(modelId);
    const facts = PROVIDER_FACTS[providerId];
    usage.push({
      providerId,
      modelId,
      dateBucket: bucket,
      requestCount: 1,
      ...(facts?.dailyRequestLimit ? { quotaLimit: facts.dailyRequestLimit } : {}),
      lastVerifiedAt: Date.now(),
    });
  }
}
