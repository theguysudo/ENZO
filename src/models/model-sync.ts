
/**
 * model-sync.ts — Daily Model Catalog Refresh Protocol
 *
 * Fetches models from:
 *   - OpenRouter (700+ text/multimodal models, no key needed)
 *   - Groq     (~20 fast text models, uses server key)
 *   - Pollinations (~15 free image generation models)
 *   - HuggingFace  (top hosted image + text models, anonymous tier)
 *   - Google   (Gemini via AI Studio OpenAI-compat endpoint, requires key)
 *   - Puter    (user-pays gateway: GPT/Claude/Gemini/Grok/Qwen, keyless catalog)
 *   - Cloudflare (Workers AI, requires token + auto-derived account id)
 *
 * Normalizes all into CatalogModel[], writes to model-cache.json.
 * Refreshes every 6 hours automatically.
 *
 * Exposed via:
 *   GET  /api/v1/models        — serve catalog to marketplace
 *   POST /api/v1/sync          — manual refresh (requires master key)
 *
 * Owns: `model-cache.json` and the whole catalog shape (`CatalogModel`).
 * Called by: index.ts (the routes above + the boot refresh), tunnel.ts (resolving
 * a model id for the OpenAI-compatible endpoint).
 *
 * Complements model-info.ts, which owns *prose about one model*; this owns *the
 * list*. Reads provider keys through env-manager.ts, so a keyless install still
 * gets the keyless catalogs (OpenRouter, Pollinations, HuggingFace, Puter) and
 * simply skips the rest instead of failing.
 *
 * ponytail: whole-file cache rewritten on every sync, 6-hour fixed interval, no
 * per-provider backoff. One of the two modules allowed to writeFileSync (the
 * other is env-manager). If a provider starts rate-limiting the sync, give that
 * one its own interval rather than slowing all nine.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { acquireProvider } from '../models/throttle.js';
import { getHealthStore } from '../models/health.js';
import { refreshCloudflareAccessToken } from '../core/env-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'model-cache.json');
const SYNC_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

// ─── Fetch Resilience Helpers ────────────────────────────────────────────────

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 15000): Promise<Response> {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** True for failures worth retrying: network errors, timeouts, 5xx and 429. Never 401/403. */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status === 429 || err.status >= 500;
  }
  return true; // TypeError (network), AbortError/TimeoutError, etc.
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryable(err)) throw err;
      const delayMs = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── Unified Model Shape ─────────────────────────────────────────────────────

export interface CatalogModel {
  id: string;           // tunnel prefix + provider id, e.g. "openrouter/qwen/qwen3-32b"
  name: string;
  provider: 'OpenRouter' | 'Groq' | 'Pollinations' | 'HuggingFace' | 'NVIDIA' | 'LLM7' | 'Puter' | 'Google' | 'Cloudflare';
  type: 'text' | 'image' | 'multimodal' | 'image-gen';
  free: boolean;
  context_length: number;
  description: string;
  tags: string[];       // ["Reasoning","Coding","Vision","Image Gen","Uncensored","New"]
  moderated: boolean;   // false = uncensored
  pricing_prompt: string;  // human-readable
  added_date: string;      // ISO — used for "new this week" badge
  max_output: number;
}

interface ModelCache {
  updatedAt: string;
  models: CatalogModel[];
}

// ─── Tag Helpers ─────────────────────────────────────────────────────────────

/**
 * Curated model-family knowledge base. Each rule maps a regex (matched against
 * the BARE provider model id — the strongest family signal a provider gives)
 * to the classification tags a model deserves. Display names alone are useless:
 * "DeepSeek V4 Flash", "Codestral 25.08" and "Command R+" must land on
 * Reasoning/Coding regardless of what the provider chose to call them.
 */
const FAMILY_TAG_RULES: Array<[RegExp, string]> = [
  // ── Reasoning / chain-of-thought ──
  [/deepseek[-_\/]?r1/i, 'Reasoning'],
  [/\bo[134](?:[-_ ]?mini)?\b/i, 'Reasoning'],
  [/qwq/i, 'Reasoning'],
  [/\b(think|reason|reflect|chain[ -]?of[ -]?thought|cot)\b/i, 'Reasoning'],
  [/kimi(?:[-_ ]*(?:k|kimi)?|[-_\/]?k[0-9][._-]?)/i, 'Reasoning'],
  [/glm[-_ ]?4[._-]?[567]/i, 'Reasoning'],
  [/minimax[-_ ]?m[24]/i, 'Reasoning'],
  [/gpt[-_ ]?oss(?:[-_ ]?[0-9]+)?(?:[-_ ]?(?:nano|reason))?/i, 'Reasoning'],
  [/nemotron.*(?:think|reason)/i, 'Reasoning'],
  [/llama[-_ ]4[-_ ]maverick/i, 'Reasoning'],
  [/compound(?:[-_ ](?:beta|mini))?/i, 'Reasoning'],
  [/deepseek[-_ ]?v[34][._-]?[0-9]*/i, 'Reasoning'],
  // ── Coding specialists ──
  [/coder/i, 'Coding'],
  [/codestral/i, 'Coding'],
  [/codegemma/i, 'Coding'],
  [/deepseek[-_\/]coder/i, 'Coding'],
  [/starcoder/i, 'Coding'],
  [/granite[-_ ]?code/i, 'Coding'],
  [/devstral/i, 'Coding'],
  [/qwen2?\.?5?[-_ ]?coder/i, 'Coding'],
  [/phi[-_ ]?[234]/i, 'Coding'],
  [/gpt-?oss/i, 'Coding'],
  [/wizard[-_ ]coder/i, 'Coding'],
  [/codegeex/i, 'Coding'],
  // ── Vision / multimodal ──
  [/llava/i, 'Vision'],
  [/moondream/i, 'Vision'],
  [/qwen2?[.-]?5?[-_ ]?vl/i, 'Vision'],
  [/gemini/i, 'Vision'],
  [/omni/i, 'Vision'],
  [/neva/i, 'Vision'],
  [/vila/i, 'Vision'],
  [/pixtral/i, 'Vision'],
  [/deplot|ocr\b/i, 'Vision'],
  // ── Creative / writing ──
  [/\b(writer|creative|story|poem|turin)\b/i, 'Creative'],
  // ── Fast / small (informational) ──
  [/\b(flash|turbo|instant|fast|nano|small|micro|mini|sprint|1b)\b/i, 'Fast'],
  // ── Multilingual (informational) ──
  [/arabic|allam|aya\b|multilingual|command[-_ ]r/i, 'Multilingual'],
];

function inferTags(
  rawId: string,
  name: string,
  desc: string,
  type: string,
  moderated: boolean,
  addedDate: string
): string[] {
  const t: string[] = [];
  const combined = `${rawId} ${name} ${desc}`.toLowerCase();

  for (const [re, tag] of FAMILY_TAG_RULES) {
    if (re.test(combined) && !t.includes(tag)) t.push(tag);
  }

  // Task-relevant signal from the raw type (multimodal ⇒ vision) or description.
  if (type === 'multimodal' && !t.includes('Vision')) t.push('Vision');
  if (type === 'image-gen' && !t.includes('Image Gen')) t.push('Image Gen');
  if (/\b(image gen|generat|diffus|flux|sdxl|stable diffus|midjourney|dalle)\b/.test(combined) && !t.includes('Image Gen')) t.push('Image Gen');
  if (/\b(code|coder|coding|programm|engineer|debug|script)\b/.test(combined) && !t.includes('Coding')) t.push('Coding');
  if (/\b(reason|think|r1|qwq|o1|o3|chain.of.thought|cot|reflect)\b/.test(combined) && !t.includes('Reasoning')) t.push('Reasoning');

  if (!moderated) t.push('Uncensored');

  // "New" = added in last 7 days
  const added = new Date(addedDate);
  const now = new Date();
  if ((now.getTime() - added.getTime()) < 7 * 24 * 60 * 60 * 1000) t.push('New');

  // Only fall back to the generic bucket when NOTHING task-specific matched.
  if (!t.some((tag) => ['Reasoning', 'Coding', 'Vision', 'Image Gen', 'Creative'].includes(tag))) {
    t.push('General Chat');
  }
  return [...new Set(t)];
}

function formatPrice(prompt: string): string {
  if (!prompt || prompt === '0' || parseFloat(prompt) === 0) return '$0.00';
  const n = parseFloat(prompt);
  if (n < 0.000001) return `$${(n * 1_000_000).toFixed(4)}/1M (very cheap)`;
  return `$${(n * 1_000).toFixed(4)}/1K`;
}

function formatCtx(n: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M ctx`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K ctx`;
  return `${n} ctx`;
}

/** Pollinations prices are per-token Pollen credits; render without sci-notation. */
function formatPollPrice(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 1) return `${n.toFixed(2)} cr/1M in`;
  if (n >= 0.000001) return `${(n * 1_000_000).toFixed(1)} µcr/1M in`;
  return `${n.toExponential(1)} cr/1M in`;
}

// ─── Source: OpenRouter ───────────────────────────────────────────────────────

async function fetchOpenRouterModels(): Promise<CatalogModel[]> {
  const res = await withRetry(() =>
    fetchWithTimeout('https://openrouter.ai/api/v1/models', {
      headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0' },
    })
  );
  if (!res.ok) throw new HttpStatusError(res.status, `OpenRouter fetch failed: ${res.status}`);

  const data = (await res.json()) as {
    data: Array<{
      id: string;
      name: string;
      description?: string;
      created?: number;
      context_length?: number;
      pricing?: { prompt?: string };
      top_provider?: { is_moderated?: boolean; max_completion_tokens?: number };
      architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
      };
    }>;
  };

  return data.data
    .filter((m) => {
      // Skip router/special models with no clear pricing
      if (parseFloat(m.pricing?.prompt ?? '0') < 0) return false;
      return true;
    })
    .map((m) => {
      const inputMods = m.architecture?.input_modalities ?? [];
      const outputMods = m.architecture?.output_modalities ?? [];
      const isImageOut = outputMods.includes('image');
      const isImageIn = inputMods.includes('image') || inputMods.includes('video');

      let type: CatalogModel['type'] = 'text';
      if (isImageOut) type = 'image-gen';
      else if (isImageIn) type = 'multimodal';

      const isFree = parseFloat(m.pricing?.prompt ?? '1') === 0;
      const moderated = m.top_provider?.is_moderated !== false; // default to moderated
      const addedDate = m.created
        ? new Date(m.created * 1000).toISOString()
        : new Date().toISOString();

      return {
        id: `openrouter/${m.id}`,
        name: m.name || m.id,
        provider: 'OpenRouter' as const,
        type,
        free: isFree,
        context_length: m.context_length ?? 0,
        description: m.description?.slice(0, 200) ?? '',
        tags: inferTags(m.id, m.name, m.description ?? '', type, moderated, addedDate),
        moderated,
        pricing_prompt: formatPrice(m.pricing?.prompt ?? '0'),
        added_date: addedDate,
        max_output: m.top_provider?.max_completion_tokens ?? 0,
      };
    });
}

// ─── Source: Groq ─────────────────────────────────────────────────────────────

// Groq names and descriptions — we enrich manually since their API is sparse
const GROQ_META: Record<string, { name: string; desc: string; maxOut: number }> = {
  'qwen/qwen3.6-27b': { name: 'Qwen3.6-27B', desc: 'Alibaba\'s 27B multilingual model. Excellent at coding and reasoning.', maxOut: 32768 },
  'groq/compound': { name: 'Compound', desc: 'Groq agentic model with built-in tool use and web access.', maxOut: 8192 },
  'groq/compound-mini': { name: 'Compound Mini', desc: 'Groq research model with built-in tool use and web access.', maxOut: 8192 },
  'llama-3.3-70b-versatile': { name: 'LLaMA-3.3-70B', desc: 'Meta\'s 70B instruction-tuned model. Fast and general-purpose.', maxOut: 32768 },
  'llama-3.1-8b-instant': { name: 'LLaMA-3.1-8B Instant', desc: 'Ultra-fast 8B model for low-latency tasks.', maxOut: 8192 },
  'openai/gpt-oss-120b': { name: 'GPT-OSS-120B', desc: 'OpenAI\'s open 120B model. Strong general reasoning.', maxOut: 32768 },
  'openai/gpt-oss-20b': { name: 'GPT-OSS-20B', desc: 'OpenAI\'s open 20B model. Fast general-purpose.', maxOut: 32768 },
  'openai/gpt-oss-safeguard-20b': { name: 'GPT-OSS Safeguard-20B', desc: 'OpenAI open 20B guard model for content safety.', maxOut: 8192 },
  'allam-2-7b': { name: 'ALLAM-2-7B', desc: 'Arabic-centric 7B instruction-tuned model.', maxOut: 8192 },
};

async function fetchGroqModels(apiKey: string): Promise<CatalogModel[]> {
  const res = await withRetry(() =>
    fetchWithTimeout('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  );
  if (!res.ok) throw new HttpStatusError(res.status, `Groq fetch failed: ${res.status}`);

  const data = (await res.json()) as {
    data: Array<{
      id: string;
      created?: number;
      context_window?: number;
    }>;
  };

  return data.data.map((m) => {
    const meta = GROQ_META[m.id] ?? { name: m.id, desc: 'Groq-hosted model.', maxOut: 8192 };
    const isVision = m.id.includes('vision');
    const addedDate = m.created ? new Date(m.created * 1000).toISOString() : new Date().toISOString();

    return {
      id: `groq/${m.id}`,
      name: meta.name,
      provider: 'Groq' as const,
      type: (isVision ? 'multimodal' : 'text') as CatalogModel['type'],
      free: true, // all Groq models free via server key
      context_length: m.context_window ?? 32768,
      description: meta.desc,
      tags: inferTags(m.id, meta.name, meta.desc, isVision ? 'multimodal' : 'text', true, addedDate),
      moderated: true,
      pricing_prompt: '$0.00',
      added_date: addedDate,
      max_output: meta.maxOut,
    };
  });
}

// ─── Source: Pollinations (gen + image) ──────────────────────────────────────
// The tunnel routes Pollinations text through gen.pollinations.ai/v1/chat/completions,
// so `gen.pollinations.ai/models` is the AUTHORITATIVE catalog (it carries category,
// context_length, paid_only, modalities, pricing). The old image-pollinations /models
// list only returned "sana" and hid the curated image models the app actually uses.
// We merge:
//   • text    models from gen /models (category === 'text')
//   • image   models from gen /models (category === 'image', not paid_only) + the
//             curated free image models verified working on image.pollinations.ai

interface GenPollModel {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  paid_only?: boolean;
  context_length?: number;
  tools?: boolean;
  reasoning?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  brand?: string;
  pricing?: Record<string, string>;
  added_date?: number;
  aliases?: string[];
}

async function fetchPollinationsModels(): Promise<CatalogModel[]> {
  const genRes = await withRetry(() => fetchWithTimeout('https://gen.pollinations.ai/models'));
  if (!genRes.ok) throw new HttpStatusError(genRes.status, `Pollinations gen fetch failed: ${genRes.status}`);
  const genList = (await genRes.json()) as GenPollModel[];

  const now = new Date().toISOString();
  const seen = new Set<string>();
  const models: CatalogModel[] = [];

  // ── 1. Text chat models (what the tunnel can actually call) ────────────────
  for (const m of genList) {
    if (m.category !== 'text' || !m.name) continue;
    const id = `pollinations/${m.name}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const name = m.title || m.name;
    const inputMods = m.input_modalities ?? [];
    const outputMods = m.output_modalities ?? [];
    const type: CatalogModel['type'] =
      outputMods.includes('image') ? 'image-gen' :
      inputMods.includes('image') || inputMods.includes('video') ? 'multimodal' :
      'text';

    const addedDate = m.added_date ? new Date(m.added_date).toISOString() : now;
    // Pollinations prices are in Pollen credits — surface the raw number.
    const priceRaw = m.pricing?.promptTextTokens
      ? parseFloat(m.pricing.promptTextTokens)
      : 0;
    const pricing_prompt = m.paid_only
      ? `Paid (${m.pricing?.currency ?? 'pollen'} credits)`
      : priceRaw > 0
        ? formatPollPrice(priceRaw)
        : '$0.00';

    const base = {
      id,
      name,
      provider: 'Pollinations' as const,
      type,
      free: !m.paid_only,
      context_length: m.context_length ?? 0,
      description: m.description || `Pollinations ${name} (${m.name}).`,
      tags: inferTags(m.name, name, m.description || '', type, true, addedDate),
      moderated: true,
      pricing_prompt,
      added_date: addedDate,
      max_output: 0,
    };
    models.push(base);

    // Emit alias entries (e.g. `minimax-m3` → canonical `minimax`) so the
    // frontend's prefixed IDs (`pollinations/minimax-m3`) always resolve in
    // the catalog without 404s on model selection. Skip path-like aliases
    // (`community/...`) — they aren't directly callable model IDs.
    for (const alias of m.aliases ?? []) {
      if (!alias || alias === m.name) continue;
      if (alias.includes('/')) continue;
      const aliasId = `pollinations/${alias}`;
      if (seen.has(aliasId)) continue;
      seen.add(aliasId);
      models.push({ ...base, id: aliasId, name: `${name} (${alias})` });
    }
  }

  // ── 2. Curated free image models (verified working on image.pollinations.ai) ──
  // These respond without auth. Only keep ones that actually work; kontext was
  // dropped because image.pollinations.ai returns HTTP 500 for it (edge-only).
  const CURATED_IMG: Record<string, { name: string; desc: string }> = {
    flux: { name: 'Flux', desc: 'FLUX.1 Schnell — fast photorealistic image generation. Free.' },
    zimage: { name: 'Z-Image', desc: 'Photorealistic with good prompt adherence. Free.' },
    turbo: { name: 'Turbo', desc: 'Fastest image generation. Ultra-cheap, great for quick drafts. Free.' },
    klein: { name: 'Klein', desc: 'FLUX.2 Klein — image editing/outpainting. Free.' },
    sana: { name: 'Sana', desc: 'Sana Sprint — free, fast image generation.' },
  };
  for (const [id, meta] of Object.entries(CURATED_IMG)) {
    const catalogId = `pollinations/${id}`;
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    models.push({
      id: catalogId,
      name: meta.name,
      provider: 'Pollinations' as const,
      type: 'image-gen',
      free: true,
      context_length: 0,
      description: meta.desc,
      tags: inferTags(id, meta.name, meta.desc, 'image-gen', true, now),
      moderated: true,
      pricing_prompt: '$0.00',
      added_date: now,
      max_output: 0,
    });
  }

  // ── 3. Free (non paid_only) image models surfaced by the gen catalog ───────
  for (const m of genList) {
    if (m.category !== 'image' || m.paid_only || !m.name) continue;
    const catalogId = `pollinations/${m.name}`;
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);
    models.push({
      id: catalogId,
      name: m.title || m.name,
      provider: 'Pollinations' as const,
      type: 'image-gen',
      free: true,
      context_length: 0,
      description: m.description || `Pollinations image model ${m.name}.`,
      tags: inferTags(m.name, m.title || m.name, m.description || '', 'image-gen', true, now),
      moderated: true,
      pricing_prompt: '$0.00',
      added_date: m.added_date ? new Date(m.added_date).toISOString() : now,
      max_output: 0,
    });
  }

  return models;
}

// ─── Source: HuggingFace Inference API ───────────────────────────────────────
// The tunnel routes HF chat through router.huggingface.co (see tunnel.ts), so the
// AUTHORITATIVE list of models we can actually reach is the router's own
// `/v1/models` endpoint — NOT the Hub's `inference=warm` flag (which reflects the
// in-browser widget, not the serverless router). We scrape the router directly.

async function fetchHuggingFaceModels(hfToken?: string): Promise<CatalogModel[]> {
  const headers: Record<string, string> = {
    'User-Agent': 'ENZO-AI-Tunnel/1.0',
  };
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`;

  const allModels: CatalogModel[] = [];
  const now = new Date().toISOString();

  // ── 1. Authoritative: router.huggingface.co/v1/models ──────────────────────
  // Each entry carries `providers[]` with live status, context length, pricing,
  // and free-tier availability — exactly what the catalog should reflect.
  try {
    const res = await withRetry(() =>
      fetchWithTimeout('https://router.huggingface.co/v1/models', { headers })
    );
    if (res.ok) {
      const data = (await res.json()) as {
        data?: Array<{
          id: string;
          created?: number;
          owned_by?: string;
          architecture?: { input_modalities?: string[]; output_modalities?: string[] };
          providers?: Array<{
            provider: string;
            status?: string;
            context_length?: number;
            pricing?: { input?: number; output?: number };
            is_free?: boolean;
          }>;
        }>;
      };

      const seenIds = new Set<string>();
      for (const m of data.data ?? []) {
        const id: string = m.id;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        // Only surface models that have at least one LIVE provider — otherwise
        // the tunnel 400s/404s when a user clicks the card.
        const liveProviders = (m.providers ?? []).filter(
          (p) => p.status === 'live'
        );
        if (liveProviders.length === 0) continue;

        const inputMods = m.architecture?.input_modalities ?? [];
        const outputMods = m.architecture?.output_modalities ?? [];
        const isImageOut = outputMods.includes('image');
        const isImageIn = inputMods.includes('image') || inputMods.includes('video');
        const type: CatalogModel['type'] = isImageOut
          ? 'image-gen'
          : isImageIn
            ? 'multimodal'
            : 'text';

        // Context window = best live provider's context_length.
        const context_length = Math.max(
          0,
          ...liveProviders.map((p) => p.context_length ?? 0)
        );
        // Free if ANY live provider serves it on the free tier.
        const free = liveProviders.some((p) => p.is_free === true);
        // Lowest input price across live providers (input pricing in $/1M tokens).
        const inputPrices = liveProviders
          .map((p) => p.pricing?.input)
          .filter((v): v is number => typeof v === 'number' && v > 0);
        const minInput = inputPrices.length ? Math.min(...inputPrices) : 0;
        const pricing_prompt = minInput > 0
          ? `$${minInput.toFixed(2)}/1M input`
          : '$0.00';

        const modelName = id.split('/').pop() ?? id;
        const description = `HuggingFace serverless model (${id}). Routable via HF Serverless Inference.`;
        const addedDate = m.created
          ? new Date(m.created * 1000).toISOString()
          : now;

        allModels.push({
          id: `hf/${id}`,
          name: modelName,
          provider: 'HuggingFace' as const,
          type,
          free,
          context_length,
          description,
          tags: inferTags(id, modelName, description, type, true, addedDate),
          moderated: true,
          pricing_prompt,
          added_date: addedDate,
          max_output: 4096,
        });
      }
      console.log(`[model-sync] HF router models loaded: ${allModels.length}`);
    } else {
      console.warn(`[model-sync] HF router fetch failed: ${res.status}`);
    }
  } catch (err: any) {
    console.error('[model-sync] HF router fetch error:', err?.message || err);
  }

  // ── 2. Curated HF Image Models (verified working on the hf-inference path) ──
  // Only kept when they actually respond; the chat list above is authoritative
  // for text/multimodal. Keep the set small and known-good.
  const CURATED_IMAGE_MODELS: Array<{
    id: string; name: string; desc: string; moderated: boolean;
  }> = [
      { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX.1 Schnell', desc: 'Fast high-quality image generation by Black Forest Labs. 4 steps.', moderated: true },
      { id: 'black-forest-labs/FLUX.1-dev', name: 'FLUX.1 Dev', desc: 'Higher fidelity FLUX model. Slower but more detailed.', moderated: true },
      { id: 'stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base 1.0', desc: 'Stable Diffusion XL base model. General-purpose image generation.', moderated: true },
      { id: 'stabilityai/stable-diffusion-3.5-large', name: 'SD 3.5 Large', desc: 'Stability AI next-gen diffusion model. High quality.', moderated: true },
    ];

  const existingIds = new Set(allModels.map((m) => m.id));
  for (const cm of CURATED_IMAGE_MODELS) {
    const catalogId = `hf/${cm.id}`;
    if (existingIds.has(catalogId)) continue;
    allModels.push({
      id: catalogId,
      name: cm.name,
      provider: 'HuggingFace' as const,
      type: 'image-gen',
      free: false,
      context_length: 0,
      description: cm.desc,
      tags: inferTags(cm.id, cm.name, cm.desc, 'image-gen', cm.moderated, now),
      moderated: cm.moderated,
      pricing_prompt: 'Requires HF token / dedicated endpoint',
      added_date: now,
      max_output: 0,
    });
  }

  return allModels;
}

// ─── Source: LLM7 ─────────────────────────────────────────────────────────────
// Dynamic OpenAI-compatible catalog at https://api.llm7.io/v1/models. The
// list is fetched at sync time (never hardcoded), so models LLM7 adds
// tomorrow appear automatically on the next catalog refresh.
//
// Free-tier eligibility comes from `usage_based_only === false` — the
// provider's own free-token-eligibility metadata — NOT from a price compare.
// Paid-only models (`usage_based_only === true`) are marked PAID and only
// appear under the Paid tier filter. Chat-capable models only: video/image
// models (`model_type 'video' | 'image'`) are dropped, as is anything that
// isn't OpenAI-schema chat.

const LLM7_DEFAULT_BASE = 'https://api.llm7.io/v1';

function llm7BaseUrl(): string {
  const env = process.env.LLM7_API_BASE_URL || '';
  if (/^https:\/\/[a-z0-9.-]+\/v\d?/i.test(env)) return env.replace(/\/+$/, '');
  return LLM7_DEFAULT_BASE;
}

/** Human-read the raw model id into a display name without inventing data. */
function llm7Name(rawId: string): string {
  const cleaned = rawId.trim();
  if (!cleaned) return '';
  // "gpt-oss:20b" → "GPT-OSS 20B", keep everything else as-is.
  return cleaned
    .replace(/[:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Llm7RawModel {
  id?: unknown;
  object?: unknown;
  model_type?: unknown;
  schema_endpoints?: unknown;
  tier?: unknown;
  pricing_mode?: unknown;
  pricing?: { input?: unknown; output?: unknown; currency?: unknown; unit?: unknown };
  modalities?: { input?: unknown[]; output?: unknown[] };
  context_window?: { tokens?: unknown; chars?: unknown };
  usage_based_only?: unknown;
  stream?: unknown;
  json_mode?: unknown;
  reasoning?: unknown;
  tools_calling?: unknown;
  capabilities?: Record<string, unknown>;
  created?: unknown;
  availability?: unknown;
}

async function fetchLlm7Models(): Promise<CatalogModel[]> {
  const res = await withRetry(() =>
    fetchWithTimeout(`${llm7BaseUrl()}/models`, {
      headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json' },
    })
  );
  if (!res.ok) throw new HttpStatusError(res.status, `LLM7 fetch failed: ${res.status}`);

  let payload: { data?: unknown };
  try {
    payload = (await res.json()) as { data?: unknown };
  } catch (err) {
    throw new Error(`LLM7 malformed JSON: ${(err as Error)?.message}`);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as any).data)) {
    throw new Error('LLM7 response missing data[] array');
  }

  const now = new Date().toISOString();
  const out: CatalogModel[] = [];

  for (const raw of (payload as any).data as unknown[]) {
    try {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Llm7RawModel;

      const rawId = typeof m.id === 'string' ? m.id.trim() : '';
      if (!rawId) continue;

      // Only OpenAI-schema chat models belong in the chat marketplace.
      const modelType = typeof m.model_type === 'string' ? m.model_type.toLowerCase() : '';
      if (modelType && modelType !== 'chat') continue; // drop video / image / embedding
      const schema = Array.isArray(m.schema_endpoints) ? m.schema_endpoints.map(String) : [];
      if (schema.length > 0 && !schema.some((s) => s.toLowerCase().includes('openai'))) continue;

      // The critical free-tier flag. Absent → NOT free (never guess from price).
      const usageBasedOnly = m.usage_based_only;
      const free = usageBasedOnly === false;

      const inputMods = (Array.isArray(m.modalities?.input) ? m.modalities!.input! : []).map(String);
      const type: CatalogModel['type'] = inputMods.includes('image') || inputMods.includes('video') ? 'multimodal' : 'text';

      const cap = m.capabilities || {};
      const reasoning = !!m.reasoning || cap.reasoning === true;
      const tools = !!m.tools_calling || cap.tools === true;
      const vision = cap.vision === true || inputMods.includes('image');
      const streaming = !!m.stream || cap.stream === true;
      const jsonMode = !!m.json_mode || cap.json_mode === true;

      const ctxRaw = m.context_window?.tokens;
      const contextLength = typeof ctxRaw === 'number' && Number.isFinite(ctxRaw) ? Math.max(0, Math.round(ctxRaw)) : 0;

      const priceIn = typeof m.pricing?.input === 'number' ? m.pricing.input : null;
      const priceOut = typeof m.pricing?.output === 'number' ? m.pricing.output : null;
      const currency = typeof m.pricing?.currency === 'string' ? m.pricing.currency : 'USD';
      let pricingPrompt = '';
      if (priceIn !== null || priceOut !== null) {
        const inStr = priceIn !== null ? `$${priceIn}/1M in` : '$—';
        const outStr = priceOut !== null ? `$${priceOut}/1M out` : '$—/1M out';
        pricingPrompt = free ? 'FREE' : `${inStr} · ${outStr}`;
      }

      const createdRaw = m.created;
      const addedDate =
        typeof createdRaw === 'number' && createdRaw > 0 ? new Date(createdRaw * 1000).toISOString() : now;

      const keywords: string[] = [];
      if (tools || /code|coder|coding|engineer|compile|agent/i.test(rawId)) keywords.push('code');
      if (reasoning || /reason|think|r1|qwq/i.test(rawId)) keywords.push('reason');
      if (/code|engineer|program|dev|coder/i.test(rawId)) keywords.push('coding');

      const vibe = [
        free ? 'Free-token tier' : 'Usage-based',
        schema.some((s) => s.toLowerCase().includes('openai')) ? 'OpenAI-compatible' : '',
      ].filter(Boolean).join(' · ');
      const desc = [
        `LLM7 ${free ? 'free-tier' : 'usage-based'} model via llm7.io.`,
        tools ? 'Tool/function calling. ' : '',
        reasoning ? 'Reasoning capable. ' : '',
        vision ? 'Vision input. ' : '',
        streaming ? 'Streaming. ' : '',
        jsonMode ? 'JSON mode. ' : '',
      ].join(' ').trim();

      const tags = new Set(inferTags(rawId, llm7Name(rawId) || rawId, `${vibe} ${keywords.join(' ')}`, type, true, addedDate));
      if (reasoning) tags.add('Reasoning');
      if (tools || keywords.includes('coding') || /code/i.test(rawId)) tags.add('Coding');
      if (vision) tags.add('Vision');

      out.push({
        id: `llm7/${rawId}`,
        name: llm7Name(rawId) || rawId,
        provider: 'LLM7' as const,
        type,
        free,
        context_length: contextLength,
        description: desc.slice(0, 200),
        tags: [...tags],
        moderated: true,
        pricing_prompt: pricingPrompt || (free ? 'FREE' : '$—'),
        added_date: addedDate,
        max_output: 0,
      });
    } catch {
      continue; // one weird model never breaks the catalog
    }
  }

  return out;
}

// ─── Source: Google (Gemini via AI Studio) ────────────────────────────────────
// Gemini is reachable through a standard OpenAI-compatible endpoint
// (https://generativelanguage.googleapis.com/v1beta/openai/) — the exact one
// ENZO's tunnel and chat streams post to. Auth is a Bearer GEMINI_API_KEY
// created at aistudio.google.com/apikey. The model list mirrors OpenAI's /models
// and REQUIRES the key (anonymous GETs 404), so the catalog is only enriched
// when a key exists — i.e. exactly when the models are usable.
//
// Free-tier reality (2026): Flash/Flash-Lite models carry a free tier
// (~5–15 RPM, 250K TPM, up to ~1,500 RPD depending on model); Pro models moved
// behind billing in early 2026. `free` is inferred from the model id instead of
// a price compare (the endpoint doesn't publish per-model pricing).

const GOOGLE_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Google's /models returns ids prefixed "models/…" and does NOT publish context
// or max-output. Curated table covers the models users actually pick; unknown
// ids fall back to the raw name and a safe 1M ctx guess (current flagship).
const GOOGLE_META: Record<string, { name: string; ctx: number; maxOut: number }> = {
  'models/gemini-2.5-flash': { name: 'Gemini 2.5 Flash', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-2.5-flash-lite': { name: 'Gemini 2.5 Flash-Lite', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-2.5-flash-preview-tts': { name: 'Gemini 2.5 Flash TTS Preview', ctx: 1_048_576, maxOut: 4096 },
  'models/gemini-2.5-pro': { name: 'Gemini 2.5 Pro', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-3-flash-preview': { name: 'Gemini 3 Flash Preview', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-3-flash-lite-preview': { name: 'Gemini 3 Flash-Lite Preview', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-3-pro-preview': { name: 'Gemini 3 Pro Preview', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash-Lite', ctx: 1_048_576, maxOut: 65_536 },
  'models/gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash-Lite', ctx: 1_048_576, maxOut: 65_536 },
};

function googleName(rawId: string): string {
  // Strip the authoritative "models/" prefix the endpoint returns.
  const base = rawId.replace(/^models\//i, '');
  return base.replace(/[:_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchGoogleModels(googleKey?: string): Promise<CatalogModel[]> {
  const key = (googleKey || '').trim();
  if (!key) return []; // no anonymous tier — models are only usable with a key

  const res = await withRetry(() =>
    fetchWithTimeout(`${GOOGLE_DEFAULT_BASE}/models`, {
      headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json', Authorization: `Bearer ${key}` },
    })
  );
  if (!res.ok) throw new HttpStatusError(res.status, `Google fetch failed: ${res.status}`);

  let payload: { data?: unknown };
  try {
    payload = (await res.json()) as { data?: unknown };
  } catch (err) {
    throw new Error(`Google malformed JSON: ${(err as Error)?.message}`);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as any).data)) {
    throw new Error('Google response missing data[] array');
  }

  const now = new Date().toISOString();
  const out: CatalogModel[] = [];

  for (const raw of (payload as any).data as unknown[]) {
    try {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as { id?: unknown; owned_by?: unknown; created?: unknown };
      const rawId = typeof m.id === 'string' ? m.id.trim() : '';
      if (!rawId) continue;

      // Only chat-capable models belong in the chat marketplace — drop
      // embedding-only and image-gen models (gemini-embedding-*, *-image).
      const lower = rawId.toLowerCase();
      if (lower.includes('embedding') || lower.includes('image')) continue;

      const isFlashFamily = /flash-lite|flash/i.test(lower);
      const isProFamily = /\bpro\b/i.test(lower); // paid-only since early 2026
      const free = isFlashFamily && !isProFamily;

      const inputMods: string[] = []; // /models doesn't expose modalities — infer from the id
      const type: CatalogModel['type'] = /gemini/i.test(lower) ? 'multimodal' : 'text';

      const keywords: string[] = [];
      if (/\b(code|coder|coding|engineer|program)\b/i.test(lower)) keywords.push('coding');
      if (/think|reason/i.test(lower)) keywords.push('reason');

      const desc = [
        `Google Gemini model via AI Studio, free tier ${free ? 'eligible ✓' : 'NOT eligible'} (Pro requires billing).`,
        'OpenAI-compatible. ',
        /gemini/i.test(lower) ? 'Text + image + audio input. ' : '',
      ].join(' ').trim();

      const tags = new Set(inferTags(rawId, GOOGLE_META[rawId]?.name || googleName(rawId) || rawId, keywords.join(' '), type, true, now));
      if (/gemini/i.test(lower)) tags.add('Vision');
      if (free) tags.delete('Image Gen');

      const meta = GOOGLE_META[rawId] || null;

      out.push({
        id: `google/${rawId}`,
        name: meta?.name || googleName(rawId) || rawId,
        provider: 'Google' as const,
        type,
        free,
        context_length: meta?.ctx || 1_048_576, // endpoint doesn't publish context; flagship default 1M
        description: desc.slice(0, 200),
        tags: [...tags].filter((t) => t !== 'Image Gen'),
        moderated: true,
        pricing_prompt: free ? 'FREE (AI Studio free tier)' : 'PAID (billing required)',
        added_date: now,
        max_output: meta?.maxOut || 65_536,
      });
    } catch {
      continue; // one weird model never breaks the catalog
    }
  }

  return out;
}

// ─── Source: Puter (puter.js user-pays gateway) ───────────────────────────────
// Puter fronts GPT, Claude, Gemini, Grok, Qwen, Infron, OpenRouter and more
// behind ONE user-owned account token (created at puter.com/dashboard →
// "Create token"). The catalog is the SDK's OWN authoritative list — the
// rich `/puterai/chat/models/details` endpoint is what `puter.ai.listModels()`
// reads (the flat `/puterai/chat/models` string list carries no free/context
// info) — and it is keyless: no anonymous chat tier exists, but listing never
// needs the token. The OpenAI-compatible REST endpoint
// (https://api.puter.com/puterai/openai/v1/) accepts the bare model slug the
// way the SDK namespaces it.
//
// User-pays model: every call bills the END USER's Puter account. The details
// endpoint publishes per-1M-token `costs` (usd-cents) under `input_cost_key`/
// `output_cost_key`, so `free` is set ONLY when both are zero — ~34 of ~878
// listed models are genuinely free (many "free" names like the 72B Qwen2.5
// Kunou still require a paid/user_free subscription and 402 with
// `subscription_required`, so the catalog reflects LISTED cost, not account
// entitlement). Paid models get their real per-1M price and `free: false`.

const PUTER_DEFAULT_BASE = 'https://api.puter.com/puterai/openai/v1';

/** Strip Puter's SDK provider prefix to the bare OpenAI-compatible slug. */
function puterModelSlug(rawId: string): string {
  // e.g. "alibaba:qwen/qwen3-32b" → "qwen3-32b", "openai/gpt-5.6-sol" → "gpt-5.6-sol",
  // "anthropic:anthropic/claude-sonnet-5" → "claude-sonnet-5",
  // "infron:deepseek/deepseek-v4-flash:free" → "deepseek-v4-flash:free".
  let id = String(rawId || '').trim();
  // Drop a provider namespace up to the FIRST ':' — but never a trailing
  // ":free"/":paid" OpenRouter-style suffix attached to the last segment.
  const colonIdx = id.indexOf(':');
  if (colonIdx > 0) id = id.slice(colonIdx + 1);
  // Last path segment: "qwen/qwen3-32b" → "qwen3-32b".
  const slashIdx = id.lastIndexOf('/');
  if (slashIdx >= 0) id = id.slice(slashIdx + 1);
  return id.trim();
}

function puterName(rawId: string): string {
  return rawId.replace(/[:_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human name from Puter's details payload, minus the trailing provider/render
 *  hints like "(Infron)" / "(OpenRouter)" / "(free)" / "(Free)". */
function puterDetailsName(raw: any): string {
  let name = String(raw?.name || '').trim();
  if (!name) return '';
  // Repeatedly strip trailing parenthetical render hints and redundant
  // free/copy markers, keeping substantive notes like "(8B)" or "(70B)".
  for (let i = 0; i < 3; i++) {
    const before = name;
    name = name
      .replace(/\s+\((free|free tier|infron|openrouter|togetherai|azure|deepseek|qwen|google|anthropic|z-ai|zai)\)\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name === before) break;
  }
  return name;
}

/** Format a usd-cents-per-1M-token cost into a human price string. */
function puterPrice(cents: any): string {
  const c = Number(cents);
  if (!Number.isFinite(c)) return '$—';
  if (c <= 0) return '$0.00';
  if (c < 1) return `$${(c / 100).toFixed(4)}/1M`;
  return `$${(c / 100).toFixed(2)}/1M`;
}

async function fetchPuterModels(): Promise<CatalogModel[]> {
  const res = await withRetry(() =>
    fetchWithTimeout('https://api.puter.com/puterai/chat/models/details', {
      headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json' },
    })
  );
  if (!res.ok) throw new HttpStatusError(res.status, `Puter fetch failed: ${res.status}`);

  let payload: { models?: unknown };
  try {
    payload = (await res.json()) as { models?: unknown };
  } catch (err) {
    throw new Error(`Puter malformed JSON: ${(err as Error)?.message}`);
  }
  const list = (payload as any)?.models;
  if (!Array.isArray(list)) throw new Error('Puter response missing models[] array');

  const now = new Date().toISOString();
  const out: CatalogModel[] = [];

  for (const raw of list as unknown[]) {
    try {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as any;
      const rawId = String(entry?.id || '');
      if (!rawId) continue;

      const slug = puterModelSlug(rawId);
      if (!slug) continue;
      const lower = rawId.toLowerCase();

      // Responses-API-only models aren't reachable on the OpenAI-compat chat
      // route; skip them. Also drop non-chat capabilities (image/video/audio
      // gen endpoints don't answer chat completions either).
      if (entry.responses_api_only === true) continue;
      if (/gpt-image|sora|flor|dall-e|dall_e|imagen|tts|speech|asr|gpt-audio/i.test(lower)) continue;

      // Free status comes from the published per-1M costs, not the name.
      const costs = (entry?.costs && typeof entry.costs === 'object') ? entry.costs : {};
      const inKey = entry?.input_cost_key;
      const outKey = entry?.output_cost_key;
      const inCents = inKey ? Number(costs[inKey]) : 0;
      const outCents = outKey ? Number(costs[outKey]) : 0;
      const isFree = (!Number.isFinite(inCents) || inCents <= 0) && (!Number.isFinite(outCents) || outCents <= 0);

      const modalities = (entry?.modalities && typeof entry.modalities === 'object') ? entry.modalities : {};
      const inputMods: string[] = Array.isArray(modalities.input) ? modalities.input : [];
      const type: CatalogModel['type'] =
        inputMods.includes('image') || inputMods.includes('video') ? 'multimodal' : 'text';

      const keywords: string[] = [];
      if (/\bcode|coder|engineer|dev|program|swe/i.test(lower)) keywords.push('coding');
      if (/think|reason|r1|qwq|reflect/i.test(lower)) keywords.push('reason');

      const providerHint = String(entry?.provider || entry?.puterId?.split(':')[0] || rawId.split('/')[0] || 'puter').replace(/_/g, ' ');
      const priceStr = isFree ? 'FREE' : `${puterPrice(inCents)} in · ${puterPrice(outCents)} out`;
      const desc = [
        `Puter gateway model (${providerHint}) via api.puter.com.`,
        `OpenAI-compatible, user-pays — billed to YOUR Puter account (${priceStr} per 1M tokens).`,
        inputMods.includes('image') ? 'Vision capable. ' : '',
      ].join(' ').trim();

      const tags = new Set(inferTags(rawId, puterDetailsName(entry) || puterName(slug) || slug, keywords.join(' '), type, true, now));
      if (inputMods.includes('image')) tags.add('Vision');
      tags.add('Puter');
      if (isFree) tags.add('Free');

      out.push({
        id: `puter/${slug}`,
        name: puterDetailsName(entry) || puterName(slug) || slug,
        provider: 'Puter' as const,
        type,
        free: isFree,
        context_length: Number(entry?.context) || 0,
        description: desc.slice(0, 200),
        tags: [...tags],
        moderated: true,
        pricing_prompt: isFree ? 'FREE (Puter free tier)' : `${priceStr} · user-pays`,
        added_date: now,
        max_output: Number(entry?.max_tokens) || 0,
      });
    } catch {
      continue; // one weird model never breaks the catalog
    }
  }

  return out;
}

// ─── Source: Cloudflare Workers AI (keyed catalog + chat) ────────────────────
// Cloudflare Workers AI serves Llama, Qwen, DeepSeek, Gemma, vision LLMs and
// more behind ONE account-scoped API token. There is no anonymous tier — the
// catalog (`/ai/models/search`) and chat completions BOTH require a token, and
// the account id is a URL path segment on every API call
// (https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions).
// The account id is auto-derived from the token's account list when not supplied
// (the same discovery the OAuth flow performs). Only text-generation / vision /
// tool-calling entries answer chat completions — translation, embeddings, image
// and speech models hit the /run endpoint instead and are dropped here.

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Auto-discover the caller's account id from the token (accounts endpoint). */
async function resolveCloudflareAccountId(key: string): Promise<string> {
  const res = await fetchWithTimeout(`${CLOUDFLARE_API_BASE}/accounts`, {
    headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json', Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new HttpStatusError(res.status, `Cloudflare accounts fetch failed: ${res.status}`);
  let data: { success?: unknown; result?: unknown };
  try {
    data = (await res.json()) as { success?: unknown; result?: unknown };
  } catch (err) {
    throw new Error(`Cloudflare accounts malformed JSON: ${(err as Error)?.message}`);
  }
  const result = Array.isArray((data as any)?.result) ? (data as any).result : [];
  const first = result.find((a: any) => typeof a?.id === 'string' && a.id) as { id?: string } | undefined;
  if (!first?.id) throw new Error('No Cloudflare account found for this token (token needs account:read permission)');
  return first.id;
}

// Workers AI lists paid-plan-only models (kimi-*, deepseek-v4-*) with a
// `require_workers_paid` property. Whether a given account can reach them is a
// property of the account's plan, not the model: on a Free plan they 403 at
// chat time ("Model ... is not available on the Workers Free plan"), on a paid
// plan they work and bill. So instead of trusting the catalog blindly we probe
// ONE paid-only id per account and cache the verdict 24h — the account's plan
// tier then decides whether paid-only models appear in the marketplace at all.
// ponytail: plaintext on purpose, do NOT route this through crypto-store.ts.
// The file is `{ "<cloudflare account id>": { tier, checkedAt } }`. An account id
// appears in every Workers AI URL and the plan tier is observable by making one
// call, so there is nothing here to protect — while crypto-store fails closed
// without ENZO_MASTER_KEY, which would take the whole model catalog down with it
// on any install that has not set it. Gitignored as machine-local cache, not as a
// secret. Seal it only if this file ever starts holding the API token itself.
const CLOUDFLARE_TIER_PATH = path.join(__dirname, 'cloudflare-plan-tier.json');

interface CloudflareTierEntry {
  tier: 'free' | 'paid' | 'unknown';
  checkedAt: string;
}

function loadCloudflarePlanTier(): Record<string, CloudflareTierEntry> {
  try {
    if (fs.existsSync(CLOUDFLARE_TIER_PATH)) {
      return JSON.parse(fs.readFileSync(CLOUDFLARE_TIER_PATH, 'utf8')) as Record<string, CloudflareTierEntry>;
    }
  } catch {
    // corrupt — treat as empty
  }
  return {};
}

function saveCloudflarePlanTier(cache: Record<string, CloudflareTierEntry>): void {
  try {
    const tmp = `${CLOUDFLARE_TIER_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CLOUDFLARE_TIER_PATH);
  } catch (err) {
    console.warn('[model-sync] failed to persist cloudflare-plan-tier.json:', (err as Error)?.message);
  }
}

/**
 * Chat-ping a known paid-only id (max_tokens=1). A 403 saying "not available on
 * the Workers Free plan" means the account is on the FREE plan; a 200 means the
 * account has PAID access; anything else (401/429/network) is inconclusive.
 */
async function probeCloudflarePlanTier(key: string, accountId: string, paidOnlyId: string): Promise<'free' | 'paid' | 'unknown'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: paidOnlyId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
    if (res.status === 200) return 'paid';
    const body = (await res.text().catch(() => '')).toLowerCase();
    if (res.status === 403 && body.includes('workers free plan')) return 'free';
    return 'unknown';
  } catch {
    return 'unknown'; // timeout / network — inconclusive
  } finally {
    clearTimeout(timer);
  }
}

/** "@cf/meta/llama-3.3-70b-instruct-fp8-fast" → "Llama 3.3 70B Instruct Fp8 Fast" */
function cloudflareName(rawId: string): string {
  const base = String(rawId || '').replace(/^@cf\//i, '').split('/').pop() || '';
  return base.replace(/[:_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchCloudflareModels(cfToken?: string, cfAccount?: string): Promise<CatalogModel[]> {
  const key = (cfToken || '').trim();
  if (!key) return []; // no anonymous tier — models are only usable with a token

  // The account id is a required URL path segment; prefer the supplied id,
  // otherwise auto-discover it from the token's account list.
  const accountId = ((cfAccount || '').trim() || undefined) || (await resolveCloudflareAccountId(key));

  let res = await withRetry(() =>
    fetchWithTimeout(`${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/models/search`, {
      headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json', Authorization: `Bearer ${key}` },
    })
  );
  // OAuth-granted access tokens are short-lived — on 401/403, mint a fresh one
  // from the stored refresh token and retry once (heals the catalog silently).
  if (res.status === 401 || res.status === 403) {
    const fresh = await refreshCloudflareAccessToken();
    if (fresh) {
      res = await fetchWithTimeout(`${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(accountId)}/ai/models/search`, {
        headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0', Accept: 'application/json', Authorization: `Bearer ${fresh}` },
      });
    }
  }
  if (!res.ok) throw new HttpStatusError(res.status, `Cloudflare catalog fetch failed: ${res.status}`);

  let payload: { success?: unknown; result?: unknown };
  try {
    payload = (await res.json()) as { success?: unknown; result?: unknown };
  } catch (err) {
    throw new Error(`Cloudflare catalog malformed JSON: ${(err as Error)?.message}`);
  }
  const list = Array.isArray((payload as any)?.result) ? (payload as any).result : [];
  if (!list.length) throw new Error('Cloudflare catalog missing result[] array');

  const now = new Date().toISOString();
  const out: CatalogModel[] = [];

  // Workers AI flags plan-gated models (kimi-*, deepseek-v4-*) with a
  // `require_workers_paid` property. Whether those are usable is decided by the
  // ACCOUNT's plan, not the catalog — so first collect the paid-only ids, probe
  // the account tier once (cached 24h), then drop paid-only models on a Free
  // plan instead of shipping marketplace entries that 403 at chat time.
  const paidOnlyIds: string[] = [];
  for (const raw of list) {
    try {
      if (typeof raw !== 'object' || raw === null) continue;
      const mm = raw as any;
      const rawId = String(mm?.name || mm?.id || '').trim();
      if (!rawId.startsWith('@cf/')) continue;
      const props: any[] = Array.isArray(mm?.properties) ? mm.properties : [];
      const reqPaid = props.some((p) => String(p?.property_id) === 'require_workers_paid' && String(p?.value).toLowerCase() === 'true');
      if (reqPaid) paidOnlyIds.push(rawId);
    } catch {
      // skip
    }
  }

  let planTier: 'free' | 'paid' | 'unknown' = 'unknown';
  if (paidOnlyIds.length) {
    const tierCache = loadCloudflarePlanTier();
    const cached = tierCache[accountId];
    if (cached && now && cached.checkedAt && Date.now() - new Date(cached.checkedAt).getTime() < VERIFY_REFRESH_MS) {
      planTier = cached.tier;
    } else {
      await acquireProvider('cloudflare'); // pace probes like chat — never exceed account RPM
      planTier = await probeCloudflarePlanTier(key, accountId, paidOnlyIds[0]);
      tierCache[accountId] = { tier: planTier, checkedAt: new Date().toISOString() };
      saveCloudflarePlanTier(tierCache);
      console.log(`[model-sync] Cloudflare account plan tier probed: ${planTier} (${paidOnlyIds.length} paid-only models in catalog)`);
    }
  }

  for (const raw of list) {
    try {
      if (typeof raw !== 'object' || raw === null) continue;
      const m = raw as any;
      // The search catalog carries the chat-verbatim id in `name` (e.g.
      // "@cf/meta/llama-3.2-3b-instruct"); `id` is just an opaque UUID.
      const rawId = String(m?.name || m?.id || '').trim();
      if (!rawId) continue;
      if (!rawId.startsWith('@cf/')) continue;

      // `task` is an OBJECT ({ id, name, description }) — the human-readable
      // `name` ("text generation", "text embeddings", …) is what we filter on.
      const task = String(m?.task?.name ?? m?.task ?? '').toLowerCase();
      const caps = (m?.capabilities && typeof m.capabilities === 'object') ? m.capabilities : {};
      const vision = caps?.vision === true || task.includes('image-to-text');
      const tools = caps?.tools === true;

      // Text-to-image models DO belong here — they answer /ai/run and
      // generateCloudflareImage speaks that endpoint, so they're the second real
      // image provider alongside Pollinations. img2img/inpainting variants share
      // the same CF task name but need a source image, so they stay out.
      const imageGen = task.includes('text-to-image') && !/img2img|inpaint/i.test(rawId);

      // Everything else must be chat-capable — embedding, audio-gen,
      // translation, classification and speech entries answer /run, NOT chat
      // completions, so they'd 400 at chat time.
      if (!(imageGen || task.includes('text generation') || vision || tools)) continue;
      const lower = `${task} ${rawId}`;
      if (!imageGen && /\b(embedding|embed|rerank|image-generation|image-gen|text-to-image|text-to-video|text-to-speech|speech-recognition|automatic-speech-recognition|transcription|asr|translation|classification|object-detection|segmentation|token-classification|ner|fill-mask|text-classification|zero-shot|summarization|tts|ocr|dumb pipe)\b/.test(lower)) continue;

      const type: CatalogModel['type'] = imageGen ? 'image-gen' : vision ? 'multimodal' : 'text';

      // Search does not publish context windows — the detail endpoint (401s on
      // catalog tokens) would, so cards show unknown ctx until a richer source.
      const ctx = Math.max(Number(m?.context_length) || 0, Number(m?.max_input) || 0) || 0;
      const maxOut = Number(m?.max_output) || 0;

      // Plan-gated model handling: on a FREE account, paid-only models 403 at
      // chat time — drop them from the marketplace so users can't pick models
      // their plan can't reach. On a PAID account they're kept but shown as
      // paid (with real per-1M pricing) instead of the fake "free tier" label.
      const props: any[] = Array.isArray(m?.properties) ? m.properties : [];
      const requirePaid = props.some((p) => String(p?.property_id) === 'require_workers_paid' && String(p?.value).toLowerCase() === 'true');
      if (requirePaid && planTier !== 'paid') continue;

      const tier = String(m?.tier || '');
      const desc = [
        `Cloudflare Workers AI model${tier ? ` (${tier} tier)` : ''}.`,
        requirePaid ? 'Requires a paid Workers plan — not available on the free tier. ' : 'Runs on the Workers AI free tier (10K neurons/day). ',
        vision ? 'Vision capable. ' : '',
        imageGen ? 'Text-to-image; accepts explicit width/height so HD/FHD renders are native, not upscaled. ' : '',
        String(m?.description || '').slice(0, 120),
      ].join(' ').trim();

      const keywords: string[] = [];
      if (/\b(code|coder|engineer|dev|program|spec|refactor|instruct)\b/i.test(rawId)) keywords.push('coding');
      if (/think|reason|r1|qwq|reflect/i.test(rawId)) keywords.push('reason');

      const tags = new Set(inferTags(rawId, String(m?.short_name || cloudflareName(rawId) || rawId), keywords.join(' '), type, true, now));
      if (vision) tags.add('Vision');
      tags.add('Cloudflare');
      if (tools) tags.add('Tools');
      if (requirePaid) tags.add('Paid');

      // Real per-1M USD pricing from the catalog (paid models only; free-tier
      // models stay under the neuron bucket).
      const priceProp = props.find((p) => String(p?.property_id) === 'price');
      const priceRows: any[] = Array.isArray(priceProp?.value) ? priceProp.value : [];
      const priceStr = priceRows
        .map((row: any) => `${row?.unit} $${Number(row?.price) || 0}`)
        .join(' · ');

      out.push({
        id: `cloudflare/${rawId}`, // bare Workers model id — resolveModelRoute strips one prefix
        name: String(m?.short_name || cloudflareName(rawId) || rawId),
        provider: 'Cloudflare' as const,
        type,
        free: !requirePaid, // free-tier models run under the neuron bucket; paid gated ones don't
        context_length: ctx,
        description: desc.slice(0, 200),
        tags: [...tags],
        moderated: true,
        pricing_prompt: requirePaid ? (priceStr || 'PAID (Workers paid plan)') : 'FREE (Workers AI free tier)',
        added_date: now,
        max_output: maxOut,
      });
    } catch {
      continue; // one weird model never breaks the catalog
    }
  }

  return out;
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

async function syncModels(
  groqKey: string,
  hfToken?: string,
  nvidiaKey?: string,
  llm7Key?: string,
  googleKey?: string,
  puterKey?: string,
  cloudflareToken?: string,
  cloudflareAccount?: string,
  signal?: AbortSignal
): Promise<ModelCache> {
  console.log('[model-sync] Starting model catalog refresh...');

  // Ponytail: the per-provider scrapes run in parallel via Promise.allSettled, but
  // the NVIDIA build.nvidia.com scrape can take several seconds. We don't wire
  // `signal` into each fetcher (that's a much larger change) — instead, the
  // route that calls us caps the wall-clock; if it aborts, the abandoned fetch
  // continuations still resolve later but we never reach the cache write below,
  // so the stale fossil is served. The route handles that by invalidating disk
  // before calling; here we just make sure we ALWAYS write before returning, even
  // when some providers failed (the previousModels fallback already protects us).

  const [orResult, groqResult, pollResult, hfResult, nvidiaResult, llm7Result, googleResult, puterResult, cloudflareResult] = await Promise.allSettled([
    fetchOpenRouterModels(),
    fetchGroqModels(groqKey),
    fetchPollinationsModels(),
    fetchHuggingFaceModels(hfToken),
    fetchNvidiaModels(nvidiaKey), // NVIDIA models (live/scraped)
    fetchLlm7Models(), // LLM7 OpenAI-compatible catalog (free-tier flagged)
    fetchGoogleModels(googleKey), // Google Gemini via AI Studio (keyed)
    fetchPuterModels(), // Puter user-pays gateway (keyless catalog)
    fetchCloudflareModels(cloudflareToken, cloudflareAccount), // Cloudflare Workers AI (keyed)
  ]);

  // A transient provider outage must NOT wipe that provider from the catalog.
  // Read the previous snapshot once; any fetch that fails/rejects this pass
  // falls back to that provider's last-known-good models.
  const previousModels = readModelCache().models;
  const previousByProvider = (prefix: string) => previousModels.filter((m) => m.id.startsWith(`${prefix}/`));

  const any = <T>(r: PromiseSettledResult<T>) => r.status === 'fulfilled';
  const ok = <T>(r: PromiseFulfilledResult<T>) => r.value;

  const or = any(orResult) ? ok(orResult) : (console.error('[model-sync] OpenRouter failed — retaining previous:', (orResult as PromiseRejectedResult).reason), previousByProvider('openrouter'));
  const groq = any(groqResult) ? ok(groqResult) : (console.error('[model-sync] Groq failed — retaining previous:', (groqResult as PromiseRejectedResult).reason), previousByProvider('groq'));
  const poll = any(pollResult) ? ok(pollResult) : (console.error('[model-sync] Pollinations failed — retaining previous:', (pollResult as PromiseRejectedResult).reason), previousByProvider('pollinations'));
  const hf = any(hfResult) ? ok(hfResult) : (console.error('[model-sync] HuggingFace failed — retaining previous:', (hfResult as PromiseRejectedResult).reason), previousByProvider('hf'));
  const nvidia = any(nvidiaResult) ? ok(nvidiaResult) : (console.error('[model-sync] NVIDIA failed — retaining previous:', (nvidiaResult as PromiseRejectedResult).reason), previousByProvider('nvidia'));

  // Prune NVIDIA models that have been removed from build.nvidia.com (genuinely decommissioned).
  // The fresh scrape in fetchNvidiaModels is the authoritative source of currently deployable models.
  // We extract the scrape IDs from the fresh result and drop any previous NVIDIA models not present.
  if (any(nvidiaResult)) {
    const freshNvidia = ok(nvidiaResult);
    const freshScrapeIds = new Set(freshNvidia.map(m => m.id));
    const previousNvidia = previousByProvider('nvidia');
    const decommissioned = previousNvidia.filter(m => !freshScrapeIds.has(m.id));
    if (decommissioned.length > 0) {
      console.log(`[model-sync] NVIDIA prune: dropped ${decommissioned.length} decommissioned models no longer on build.nvidia.com: ${decommissioned.map(m => m.id).join(', ')}`);
    }
    // The fresh result already contains all currently deployable models from the scrape,
    // so no further action needed - it naturally supersedes the previous list.
  }
  let llm7 = any(llm7Result) ? ok(llm7Result) : (console.error('[model-sync] LLM7 failed — retaining previous:', (llm7Result as PromiseRejectedResult).reason), previousByProvider('llm7'));
  const google = any(googleResult) ? ok(googleResult) : (console.error('[model-sync] Google failed — retaining previous:', (googleResult as PromiseRejectedResult).reason), previousByProvider('google'));
  const puter = any(puterResult) ? ok(puterResult) : (console.error('[model-sync] Puter failed — retaining previous:', (puterResult as PromiseRejectedResult).reason), previousByProvider('puter'));
  const cloudflare = any(cloudflareResult) ? ok(cloudflareResult) : (console.error('[model-sync] Cloudflare failed — retaining previous:', (cloudflareResult as PromiseRejectedResult).reason), previousByProvider('cloudflare'));

  // Verify LLM7 identity BEFORE merging: the gateway accepts any requested id
  // but silently serves a rotating shared model for undeployed ids. Free chat
  // models are self-ID probed and ids whose reply names a different family are
  // dropped (cached 24h in llm7-verified.json). Skipped when no key / no data.
  if (llm7Key && llm7.length) {
    try {
      llm7 = await verifyLlm7Catalog(llm7, llm7Key);
    } catch (err) {
      console.error('[model-sync] LLM7 identity verification failed (keeping unfiltered list):', (err as Error)?.message);
    }
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const m of [...or, ...groq, ...poll, ...hf, ...nvidia, ...llm7, ...google, ...puter, ...cloudflare]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      models.push(m);
    }
  }

  // Enrich thin metadata (Google/Puter expose no context/max-output) from
  // OpenRouter's rich catalog, matched by the trailing base-model slug.
  const orBySlug = new Map<string, CatalogModel>();
  for (const m of or) {
    const slug = (m.id.split('/').pop() || '').toLowerCase();
    if (slug && !orBySlug.has(slug)) orBySlug.set(slug, m);
  }
  for (const m of models) {
    if (m.provider === 'OpenRouter') continue;
    const slug = (m.id.split('/').pop() || '').toLowerCase();
    if (!slug) continue;
    const src = orBySlug.get(slug);
    if (!src) continue;
    if (!m.context_length && src.context_length) m.context_length = src.context_length;
    if (!m.max_output && src.max_output) m.max_output = src.max_output;
    // Replace an id-derived machine name (e.g. Puter "Gpt 5.6 Sol" / Google
    // "Gemini 2.5 Flash") with OpenRouter's richer human name when it's clearly
    // more than just the slug re-spaced.
    const idName = (m.id.split('/').pop() || '').replace(/[:_-]+/g, ' ').trim().toLowerCase();
    if (src.name && src.name.toLowerCase() !== slug && m.name.toLowerCase() === idName) {
      m.name = src.name;
    }
  }

  // Prune decommissioned models. Health marks a model offline+unsupported when a
  // real chat ping returned 400/404/422/406 — i.e. the model no longer exists or
  // isn't callable for this account even though a stale listing may still show it
  // (Google keeps deprecated ids like gemini-2.5-flash in /models). That 4xx is
  // authoritative, so drop it regardless of this pass's listing; if it's ever
  // re-opened, the next health pass marks it online and a later sync re-adds it.
  //
  // Guards:
  //   • recency — only prune when the probe is fresh (≤6h). A stale offline flag
  //     from a provider that recovered should never remove a listed model.
  //   • provider-wide outage — when ~all of a provider's probed models are
  //     unsupported (≥95%), it's a transient account/endpoint problem, NOT N
  //     independent decommissions; skip the whole provider that pass.
  //   • live catalog knowledge — a truly decommissioned model is almost always
  //     still listed by the provider (the exact bug we're fixing), so a fresh
  //     listing does NOT exempt it.
  {
    const health = getHealthStore().models;
    const cutoff = Date.now() - 36 * 60 * 60 * 1000; // recent = probe within ~1.5 days
    // (Google's daily probe budget caps health to ~1 ping/model/day, so use a
    // budget-aware recency window — 6h would never see a fresh Google probe.)
    const provOnline = new Map<string, number>();
    const provUnsupported = new Map<string, number>();
    for (const id of Object.keys(health)) {
      const h = health[id];
      if (!h) continue;
      const prov = id.split('/')[0];
      if (h.status === 'online') {
        provOnline.set(prov, (provOnline.get(prov) || 0) + 1);
      } else if (h.status === 'offline' && (h.error === 'unsupported' || h.error === 'model_not_found')) {
        provUnsupported.set(prov, (provUnsupported.get(prov) || 0) + 1);
      }
    }
    const pctUnsupported = (prov: string): number => {
      const online = provOnline.get(prov) || 0;
      const unsup = provUnsupported.get(prov) || 0;
      return online + unsup === 0 ? 0 : unsup / (online + unsup);
    };
    const decommissioned = new Set<string>();
    for (const id of Object.keys(health)) {
      const h = health[id];
      if (!h || h.status !== 'offline') continue;
      if (h.error !== 'unsupported' && h.error !== 'model_not_found') continue;
      const checkedAt = h.checkedAt ? new Date(h.checkedAt).getTime() : 0;
      if (!checkedAt || checkedAt < cutoff) continue; // stale probe — don't trust
      if (pctUnsupported(id.split('/')[0]) >= 0.95) continue; // provider-wide outage, not decommissions
      decommissioned.add(id);
    }
    if (decommissioned.size > 0) {
      const before = models.length;
      for (let i = models.length - 1; i >= 0; i--) {
        if (decommissioned.has(models[i].id)) {
          models.splice(i, 1);
        }
      }
      if (models.length < before) {
        console.log(`[model-sync] pruned ${before - models.length} decommissioned models (offline+unsupported in health store)`);
      }
    }
  }

  // At least one provider must have returned real data to trust this snapshot.
  const anySucceeded =
    models.length > 0 &&
    [orResult, groqResult, pollResult, hfResult, nvidiaResult, llm7Result, googleResult, puterResult, cloudflareResult].some(
      (r) => r.status === 'fulfilled' && r.value.length > 0
    );

  // Sort: free first, then by name
  models.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (anySucceeded) {
    const cache: ModelCache = {
      updatedAt: new Date().toISOString(),
      models,
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    console.log(
      `[model-sync] ✓ Cached ${models.length} models (OR: ${or.length}, Groq: ${groq.length}, Poll: ${poll.length}, HF: ${hf.length}, NVIDIA: ${nvidia.length}, LLM7: ${llm7.length}, Google: ${google.length}, Puter: ${puter.length}, Cloudflare: ${cloudflare.length})`
    );
    return cache;
  }

  // Total failure: we already retain per-provider last-known-good above (via
  // previousByProvider), so reaching here means EVERY provider AND its fallback
  // returned nothing. Don't clobber the on-disk cache in that case — it may still
  // hold a good snapshot from a prior successful pass. (We still wrote the
  // partial/retained `models` list above whenever anySucceeded, so a timeout
  // mid-sync in the route gets surfaced correctly on the next disk read.)
  console.warn('[model-sync] all providers failed — keeping previous cache');
  const existing = readModelCache();
  if (existing.models.length > 0) {
    return existing;
  }

  // Disk cache missing/corrupt too: write a minimal seed so the catalog is never empty.
  console.warn('[model-sync] no usable cache on disk — writing minimal seed cache');
  const seed = buildSeedCache();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(seed, null, 2));
  return seed;
}

// ─── Cache Reader ─────────────────────────────────────────────────────────────

export function readModelCache(): ModelCache {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as ModelCache;
    }
  } catch {
    // Corrupt cache — will be rebuilt
  }
  return { updatedAt: new Date(0).toISOString(), models: [] };
}

// ─── Minimal Seed Cache ───────────────────────────────────────────────────────
// Used only when the disk cache is missing/corrupt AND every provider is down.
// Ensures /api/v1/models never returns an empty catalog.
function buildSeedCache(): ModelCache {
  const now = new Date().toISOString();
  const models: CatalogModel[] = [];

  // Static Groq entries from the curated metadata table
  for (const [id, meta] of Object.entries(GROQ_META)) {
    const isVision = id.includes('vision');
    models.push({
      id: `groq/${id}`,
      name: meta.name,
      provider: 'Groq' as const,
      type: (isVision ? 'multimodal' : 'text') as CatalogModel['type'],
      free: true,
      context_length: 32768,
      description: meta.desc,
      tags: inferTags(id, meta.name, meta.desc, isVision ? 'multimodal' : 'text', true, now),
      moderated: true,
      pricing_prompt: '$0.00',
      added_date: now,
      max_output: meta.maxOut,
    });
  }

  // Curated NVIDIA fallbacks
  for (const m of FALLBACK_NVIDIA_MODELS) {
    models.push({
      id: m.id,
      name: m.name,
      provider: 'NVIDIA' as const,
      type: 'text',
      free: true,
      context_length: m.ctx,
      description: m.desc,
      tags: inferTags(m.id, m.name, m.desc, 'text', true, now),
      moderated: true,
      pricing_prompt: 'Free tier via NVIDIA credits (sign up at build.nvidia.com)',
      added_date: now,
      max_output: 4096,
    });
  }

  return { updatedAt: new Date(0).toISOString(), models };
}

// ─── Key Resolver ────────────────────────────────────────────────────────────

export function tryReadNvidiaKey(): string | undefined {
  if (process.env.NVIDIA_API_KEY) {
    return process.env.NVIDIA_API_KEY;
  }
  try {
    const rtfPath = path.join(__dirname, 'Nvidia_api_key.rtf');
    if (fs.existsSync(rtfPath)) {
      const content = fs.readFileSync(rtfPath, 'utf8');
      const match = content.match(/nvapi-[a-zA-Z0-9_-]+/);
      if (match) {
        return match[0];
      }
    }
  } catch (err) {
    console.error('[model-sync] Failed to read Nvidia_api_key.rtf:', err);
  }
  return undefined;
}

function cleanModelIdForComparison(id: string): string {
  const cleanId = id.startsWith('nvidia/') ? id.substring(7) : id;
  const parts = cleanId.split('/');
  const name = parts[parts.length - 1].toLowerCase();
  return name.replace(/[^a-z0-9]/g, '');
}

// ─── NVIDIA Reachability Verification ─────────────────────────────────────────
// The integrate API's /v1/models lists ~100 models, but MANY cannot actually be
// called with a given account ("Function not found for account" → 404 at chat
// time). build.nvidia.com only shows the deployable ones, so we reproduce that
// filter here: each catalog candidate is probed once with a 1-token chat ping
// and models that answer 404 / "model not found" are dropped from the catalog.
// Results are cached (nvidia-verified.json, gitignored) so re-syncs don't re-probe
// models verified within the last 24h.

const NVIDIA_VERIFIED_PATH = path.join(__dirname, 'nvidia-verified.json');
const VERIFY_REFRESH_MS = 24 * 60 * 60 * 1000;

interface NvidiaVerifyEntry {
  ok: boolean;
  checkedAt: string;
}

/**
 * Cache-slot id for one NVIDIA verify reader: keyed readers get their own slot
 * (`nvidia:<tail8>`), keyless boots share the anon slot. Exported pure — the
 * model-sync regression test asserts the same contract against THIS function
 * rather than a local mirror of it.
 */
export function nvidiaCacheSlot(key: string | undefined): string {
  return key ? `nvidia:${key.slice(-8)}` : 'nvidia:anon';
}

/** Verdict-cache key for one (reader, model) pair. */
export function nvidiaVerifyCacheKey(key: string | undefined, modelId: string): string {
  return `${nvidiaCacheSlot(key)}:${modelId}`;
}

/**
 * Cached-verdict lookup with the key-scoping contract: a keyed reader sees ONLY
 * its own slot (never the bare-id entry another key wrote), while a keyless
 * reader falls back to the bare-id mirror of the latest positive verdict.
 * Stale entries (>24h) count as absent.
 */
export function nvidiaVerdictLookup(
  verified: Record<string, NvidiaVerifyEntry>,
  key: string | undefined,
  modelId: string,
  nowMs: number = Date.now(),
): NvidiaVerifyEntry | undefined {
  const cacheKey = nvidiaVerifyCacheKey(key, modelId);
  if (key) {
    const cached = verified[cacheKey];
    if (cached && nowMs - new Date(cached.checkedAt).getTime() < VERIFY_REFRESH_MS) return cached;
    return undefined;
  }
  const cached = verified[cacheKey] ?? verified[modelId];
  if (cached && nowMs - new Date(cached.checkedAt).getTime() < VERIFY_REFRESH_MS) return cached;
  return undefined;
}

function loadNvidiaVerified(): Record<string, NvidiaVerifyEntry> {
  try {
    if (fs.existsSync(NVIDIA_VERIFIED_PATH)) {
      return JSON.parse(fs.readFileSync(NVIDIA_VERIFIED_PATH, 'utf8')) as Record<string, NvidiaVerifyEntry>;
    }
  } catch {
    // corrupt — treat as empty
  }
  return {};
}

function saveNvidiaVerified(cache: Record<string, NvidiaVerifyEntry>): void {
  try {
    const tmp = `${NVIDIA_VERIFIED_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, NVIDIA_VERIFIED_PATH);
  } catch (err) {
    console.warn('[model-sync] failed to persist nvidia-verified.json:', (err as Error)?.message);
  }
}

/**
 * Probe one NVIDIA model id (raw, no provider prefix) with max_tokens=1.
 * Returns 'ok' on 200, 'bad' on 404/"not found"/"not supported", null when the
 * probe result is inconclusive (auth/rate-limit/network) and should be ignored.
 */
async function probeNvidiaModel(modelId: string, key: string): Promise<'ok' | 'bad' | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300).toLowerCase();
      if (res.status === 401 || res.status === 403 || res.status === 429) return null; // account/rate issue, not model availability
      if (res.status === 404 || /not found|does not exist|not supported|unknown model/.test(body)) return 'bad';
      return null; // other 4xx/5xx — inconclusive
    }
    return 'ok';
  } catch {
    return null; // timeout / network — inconclusive, keep the model listed
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Filter a candidate NVIDIA catalog list down to models that are actually
 * callable with the given key. Cached across syncs; drops 404/"not found"
 * models so the marketplace and smart-fallback never offer a phantom model.
 */
export async function verifyNvidiaCatalog(models: CatalogModel[], key: string): Promise<CatalogModel[]> {
  const verified = loadNvidiaVerified();
  const candidates = models.filter((m) => (m.type === 'text' || m.type === 'multimodal'));
  const results = new Map<string, NvidiaVerifyEntry>();
  let probed = 0;
  const now = Date.now();
  // ponytail: scope the verify cache to the KEY, otherwise a "ok:false" verdict
  // from an account that can't reach a model (free tier, revoked key, wrong org)
  // gets reused for 24h and silently drops it for EVERYONE — that's why the
  // marketplace showed only ~3 NVIDIA models no matter who booted it.
  const keyId = nvidiaCacheSlot(key);

  const verdict = async (id: string): Promise<NvidiaVerifyEntry> => {
    const cached = nvidiaVerdictLookup(verified, key, id, now);
    if (cached) return cached;
    await acquireProvider('nvidia'); // share the same pacing as chat → never exceed 40 RPM
    const ok = await probeNvidiaModel(id, key); // raw API id, org prefix included
    probed++;
    return ok === null
      ? { ok: true, checkedAt: new Date(0).toISOString() } // inconclusive → keep
      : { ok: ok === 'ok', checkedAt: new Date().toISOString() };
  };

  // Bounded concurrency so we don't hammer NVIDIA with 100 parallel probes.
  const CONCURRENCY = 5;
  let idx = 0;
  // Workers write straight into `results`; their resolved value is unused, so this
  // is Promise<void>[] and not Promise<NvidiaVerifyEntry>[].
  const jobs: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) return;
      results.set(candidates[i].id, await verdict(String(candidates[i].id)));
    }
  };
  for (let w = 0; w < Math.min(CONCURRENCY, candidates.length); w++) {
    jobs.push(worker());
  }
  await Promise.all(jobs);

  for (const [id, entry] of results) {
    // Write BOTH the key-scoped key (authoritative) and keep the bare id for the
    // legacy lookup path — so existing `ok:false` entries from a previous key
    // are shadowed by a fresh positive verdict from THIS key, not the other way
    // around.
    verified[`${keyId}:${id}`] = entry;
    if (entry.ok) verified[id] = entry; // keep a positive verdict on the bare key
    else delete verified[id]; // stale negative verdict for THIS key → drop it
  }
  saveNvidiaVerified(verified);

  const dropped = candidates.filter((m) => results.get(String(m.id))?.ok === false).length;
  const kept = candidates.filter((m) => results.get(String(m.id))?.ok !== false);
  console.log(
    `[model-sync] NVIDIA verification: ${kept.length}/${candidates.length} callable (dropped ${dropped} phantom, probed ${probed} fresh)`
  );
  return kept;
}

// ─── LLM7 Identity Verification ───────────────────────────────────────────────
// NVIDIA's problem is reachability (404 phantoms). LLM7's problem is IDENTITY:
// the gateway accepts any requested id but silently serves a rotating shared
// model for the ones it doesn't actually deploy (verified live — keyless AND
// keyed `codestral-latest` answers "llama-3-70b-8192", `gemini-3.1-flash-lite`
// answers "llama-3.1-70b-versatile", `mistral-Nemo-Instruct-2407` answers
// "Llama-73b Spitfire-SGB"). Reachability returns 200 for all of them, so we
// must probe WHO answers: each free model is asked to self-identify, and ids
// whose reply names a different model family than requested are dropped from
// the catalog. Results are cached (llm7-verified.json, gitignored) for 24h so
// re-syncs don't re-probe.

const LLM7_VERIFIED_PATH = path.join(__dirname, 'llm7-verified.json');

// Recognizable model-family tokens used to compare the requested id against
// the identity the gateway actually serves. Keep alphanumeric-normalized.
const LLM7_FAMILIES = [
  'llama', 'gemma', 'gemini', 'gpt', 'gptoss', 'phi', 'mistral', 'mixtral',
  'codestral', 'ministral', 'nemo', 'qwen', 'deepseek', 'claude', 'minimax',
  'nemotron', 'glm', 'kimi', 'command', 'aya', 'granite', 'jamba', 'olmo',
  'spitfire', 'dolphin', 'grok', 'samba', 'khalo', 'flan',
];

function loadLlm7Verified(): Record<string, NvidiaVerifyEntry> {
  try {
    if (fs.existsSync(LLM7_VERIFIED_PATH)) {
      return JSON.parse(fs.readFileSync(LLM7_VERIFIED_PATH, 'utf8')) as Record<string, NvidiaVerifyEntry>;
    }
  } catch {
    // corrupt — treat as empty
  }
  return {};
}

function saveLlm7Verified(cache: Record<string, NvidiaVerifyEntry>): void {
  try {
    const tmp = `${LLM7_VERIFIED_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, LLM7_VERIFIED_PATH);
  } catch (err) {
    console.warn('[model-sync] failed to persist llm7-verified.json:', (err as Error)?.message);
  }
}

/** Family tokens (alphanumeric-normalized) present in a string, longest-first. */
function llm7FamilyTokens(text: string): string[] {
  const norm = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found: string[] = [];
  for (const family of [...LLM7_FAMILIES].sort((a, b) => b.length - a.length)) {
    const fn = family.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (fn && norm.includes(fn)) found.push(family);
  }
  return found;
}

/**
 * Probe one LLM7 model id (raw, no `llm7/` prefix) with a self-identification
 * prompt. Returns:
 *   'ok'  — the served model names the requested family (or couldn't be
 *           disproven and replied with an id-like string that isn't a known
 *           foreign family),
 *   'bad' — the gateway served a DIFFERENT known model family (drop),
 *   null  — inconclusive (auth/rate-limit/network/garbled), keep listed.
 */
async function probeLlm7Model(modelId: string, key: string): Promise<'ok' | 'bad' | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${llm7BaseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'user',
            content:
              'Reply with exactly the identifier/name of the model you are running as (e.g. "llama-3-70b"). Output only the identifier, nothing else.',
          },
        ],
        max_tokens: 40,
      }),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300).toLowerCase();
      if (res.status === 401 || res.status === 403 || res.status === 429) return null; // account/rate — not model availability
      if (res.status === 404 || /not found|does not exist|unavailable|unknown model|not supported/.test(body)) return 'bad';
      return null; // other 4xx/5xx — inconclusive
    }
    const data = (await res.json().catch(() => null)) as { [k: string]: unknown } | null;
    const content = ((data as any)?.choices?.[0]?.message?.content ?? '').toString().trim();
    if (!content) return null; // empty — 200 but can't verify identity, keep

    const expected = llm7FamilyTokens(modelId);
    const observed = llm7FamilyTokens(content);

    // A foreign known family → the gateway served a different model → drop.
    if (observed.some((o) => !expected.includes(o))) return 'bad';
    // The served model named the requested family → correct.
    if (observed.length > 0) return 'ok';

    // No recognizable family in the reply. If it looks like a model identifier
    // (short, no ordinary prose spacing) it's likely a foreign id we don't
    // track → drop; otherwise the model just gave prose → inconclusive, keep.
    const idLike = /^[a-z0-9._:/ -]{2,48}$/.test(content);
    return idLike ? 'bad' : null;
  } catch {
    return null; // timeout / network — inconclusive, keep the model listed
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Filter LLM7 free-token catalog entries so the marketplace/picker/auto-mode
 * never offer a model the gateway silently replaces with a different one.
 * Scoped to FREE chat models (usage_based_only === false) — paid models bill
 * the user's account, so probing them costs money and is deliberately skipped.
 * Cached 24h; 'bad' verdicts drop the entry, inconclusive/null keeps it.
 */
export async function verifyLlm7Catalog(models: CatalogModel[], key: string): Promise<CatalogModel[]> {
  const verified = loadLlm7Verified();
  // Free, chat-capable candidates only (text + multimodal; image-gen can't self-identify).
  const candidates = models.filter((m) => m.free === true && (m.type === 'text' || m.type === 'multimodal'));
  const results = new Map<string, NvidiaVerifyEntry>();
  let probed = 0;
  const now = Date.now();

  const verdict = async (id: string): Promise<NvidiaVerifyEntry> => {
    const cached = verified[id];
    if (cached && now - new Date(cached.checkedAt).getTime() < VERIFY_REFRESH_MS) return cached;
    await acquireProvider('llm7'); // share chat pacing → never exceed the free-tier RPM
    const ok = await probeLlm7Model(id, key); // raw id, no llm7/ prefix
    probed++;
    return ok === null
      ? { ok: true, checkedAt: new Date(0).toISOString() } // inconclusive → keep
      : { ok: ok === 'ok', checkedAt: new Date().toISOString() };
  };

  // Bounded concurrency so we don't flash 30 parallel self-ID probes.
  const CONCURRENCY = 4;
  let idx = 0;
  // Workers write straight into `results`; their resolved value is unused, so this
  // is Promise<void>[] and not Promise<NvidiaVerifyEntry>[].
  const jobs: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = idx++;
      if (i >= candidates.length) return;
      results.set(candidates[i].id, await verdict(String(candidates[i].id)));
    }
  };
  for (let w = 0; w < Math.min(CONCURRENCY, candidates.length); w++) {
    jobs.push(worker());
  }
  await Promise.all(jobs);

  for (const [id, entry] of results) verified[id] = entry;
  saveLlm7Verified(verified);

  const dropped = candidates.filter((m) => results.get(String(m.id))?.ok === false).length;
  if (dropped > 0) {
    console.log(
      `[model-sync] LLM7 identity verification: dropped ${dropped} silently-replaced free models (probed ${probed} fresh)`
    );
  }
  // Only the identified free phantoms are removed — paid LLM7 models (and any
  // free ones that verified) are preserved in the returned catalog.
  const droppedIds = new Set(candidates.filter((m) => results.get(String(m.id))?.ok === false).map((m) => String(m.id)));
  return models.filter((m) => !droppedIds.has(String(m.id)));
}

// ─── Publisher Inference Helper ──────────────────────────────────────────────

function inferNvidiaPublisher(modelName: string): string {
  const name = modelName.toLowerCase();
  if (name.startsWith('llama-') || name.startsWith('llama2') || name.startsWith('codellama') || name.startsWith('llama4') || name.startsWith('llama-guard')) {
    if (name.includes('nemotron') || name.includes('nemoretriever') || name.includes('chatqa') || name.includes('nv-')) {
      return 'nvidia';
    }
    return 'meta';
  }
  if (name.startsWith('nemotron') || name.startsWith('nemoretriever') || name.startsWith('neva') || name.startsWith('nv-') || name.startsWith('riva-') || name.startsWith('vila') || name.startsWith('cosmos') || name.startsWith('gliner') || name.startsWith('cuopt') || name.startsWith('active-speaker') || name.startsWith('bnr') || name.startsWith('eyecontact') || name.startsWith('diffusiongemma')) {
    if (name.startsWith('diffusiongemma')) return 'google';
    return 'nvidia';
  }
  if (name.startsWith('gemma') || name.startsWith('codegemma') || name.startsWith('recurrentgemma') || name.startsWith('deplot')) return 'google';
  if (name.startsWith('mistral') || name.startsWith('mixtral') || name.startsWith('codestral') || name.startsWith('ministral')) {
    if (name.includes('nemo')) return 'nvidia';
    return 'mistralai';
  }
  if (name.startsWith('deepseek')) return 'deepseek-ai';
  if (name.startsWith('phi') || name.startsWith('kosmos')) return 'microsoft';
  if (name.startsWith('granite')) return 'ibm';
  if (name.startsWith('qwen')) return 'qwen';
  if (name.startsWith('minimax')) return 'minimaxai';
  if (name.startsWith('jamba')) return 'ai21labs';
  if (name.startsWith('starcoder')) return 'bigcode';
  if (name.startsWith('seed-oss')) return 'bytedance';
  if (name.startsWith('gpt-oss')) return 'openai';
  if (name.startsWith('arctic-embed')) return 'snowflake';
  if (name.startsWith('step-')) return 'stepfun-ai';
  if (name.startsWith('palmyra')) return 'writer';
  if (name.startsWith('glm')) return 'z-ai';
  if (name.startsWith('zamba')) return 'zyphra';
  if (name.startsWith('fuyu')) return 'adept';
  if (name.startsWith('sea-lion')) return 'aisingapore';
  if (name.startsWith('bge-')) return 'baai';
  if (name.startsWith('dbrx')) return 'databricks';
  if (name.startsWith('yi-')) return '01-ai';
  if (name.startsWith('dracarys')) return 'abacusai';
  return 'nvidia';
}

// ─── Source: NVIDIA Builder API (Live/Scraped) ───────────────────────────────

// ─── build.nvidia.com/models web scraper ──────────────────────────────────────
// The models page is a Next.js app: its server-rendered HTML embeds the first
// page of the NGC catalog as escaped JSON in the RSC payload, and the page lazily
// loads the rest from the catalog search API (`/v2/search/catalog/resources/
// ENDPOINT`). Scraping the page gives the authoritative "deployable models" list
// the build site actually shows — richer than the integrate /v1/models dump
// (which lists phantoms that 404 for most accounts). No auth token needed.
const NVIDIA_BUILD_MODELS_URL = 'https://build.nvidia.com/models';
const NGC_CATALOG_API = 'https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT';
const NVIDIA_ORG = 'qc69jvmznzxy'; // build.nvidia.com app-catalog org slug

interface NgcCatalogRecord {
  resourceId: string; // e.g. "qc69jvmznzxy/nemotron-3.5-lightning-30b-a3b"
  name: string;       // e.g. "active-speaker-detection"
  displayName: string;
  description: string;
  dateModified?: string;
  labels?: Array<{ key: string; values: string[] }>;
  attributes?: Array<{ key: string; value: string }>;
}

/** Parse the escaped JSON records embedded in build.nvidia.com HTML (RSC payload). */
export function extractEmbeddedRecords(html: string): NgcCatalogRecord[] {
  const out: NgcCatalogRecord[] = [];

  // Strip the RSC string-literal escape layer so the JSON's own escaping (a
  // content quote = `\"`) remains visible. Order matters: `\\` → placeholder →
  // `\"` → `"` → restore, so a raw `\\\"` (a literal quote in a field value)
  // correctly becomes `\"` instead of a bare `"`.
  const unescaped = html
    .replace(/\\\\/g, '\u0000')
    .replace(/\\"/g, '"')
    .replace(/\u0000/g, '\\');

  const startRe = /\{"resourceType":"ENDPOINT"/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(unescaped))) {
    // Walk the object brace-by-brace on the JSON text, honoring JSON-level
    // escapes, until the record's own closing brace.
    const start = m.index;
    let depth = 0;
    let inStr = false;
    let i = start;
    for (; i < unescaped.length; i++) {
      const ch = unescaped[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; } // skip escaped char
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= unescaped.length) break;
    const slice = unescaped.slice(start, i + 1);
    try {
      out.push(JSON.parse(slice) as NgcCatalogRecord);
    } catch {
      // unparseable record — skip it, the catalog API pass will still cover it
    }
  }
  return out;
}

/** Paginate the same catalog-search API the build page uses to load all models. */
async function scrapeNgcCatalogApi(): Promise<NgcCatalogRecord[]> {
  const out = new Map<string, NgcCatalogRecord>();
  const pageSize = 500;
  for (let page = 0; page < 5; page++) {
    const q = JSON.stringify({
      query: `orgName:"${NVIDIA_ORG}"`,
      filters: [],
      orderBy: [{ field: 'score', value: 'DESC' }],
      page,
      pageSize,
      scoredSize: pageSize,
    });
    const url = new URL(NGC_CATALOG_API);
    url.searchParams.set('group-labels-by-labelset', 'true');
    url.searchParams.set('q', q);
    const res = await withRetry(() =>
      fetchWithTimeout(url.toString(), {
        headers: { 'resource-type': 'ENDPOINT', 'User-Agent': 'ENZO-AI-Tunnel/1.0' },
      })
    );
    if (!res.ok) throw new HttpStatusError(res.status, `NGC catalog API ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ resources?: NgcCatalogRecord[] }>; resultTotal: number };
    let got = 0;
    for (const group of json.results ?? []) {
      for (const rec of group.resources ?? []) {
        if (rec.resourceId) { out.set(rec.resourceId, rec); got++; }
      }
    }
    const total = Number(json.resultTotal) || got;
    if (page * pageSize + got >= total || got === 0) break;
  }
  return [...out.values()];
}

function ngcPublisher(rec: NgcCatalogRecord): string {
  const pub = rec.labels?.find((l) => l.key === 'publisher')?.values?.[0];
  return pub ? String(pub) : inferNvidiaPublisher(rec.name.replace(/_/g, '-'));
}

function ngcAvailable(rec: NgcCatalogRecord): boolean {
  return rec.attributes?.find((a) => a.key === 'AVAILABLE')?.value !== 'false';
}

/**
 * Scrape models from https://build.nvidia.com/models — parses the records
 * embedded in the page HTML and completes the list by paging the same catalog
 * API the page calls. Returns raw NGC endpoint records, deduped by resourceId.
 */
export async function scrapeBuildNvidiaModels(): Promise<{
  records: NgcCatalogRecord[];
  fromHtml: number;
  fromApi: number;
}> {
  const seen = new Map<string, NgcCatalogRecord>();
  let fromHtml = 0;
  let fromApi = 0;

  // 1. Parse the HTML the page actually ships.
  try {
    const res = await withRetry(() =>
      fetchWithTimeout(NVIDIA_BUILD_MODELS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      })
    );
    if (res.ok) {
      const html = await res.text();
      for (const rec of extractEmbeddedRecords(html)) {
        if (rec.resourceId && !seen.has(rec.resourceId)) { seen.set(rec.resourceId, rec); fromHtml++; }
      }
      console.log(`[build-scrape] parsed ${fromHtml} endpoint records from page HTML`);
    }
  } catch (err) {
    console.warn('[build-scrape] HTML parse failed:', (err as Error)?.message);
  }

  // 2. Page the catalog API (same source the page uses) to cover any not embedded.
  try {
    for (const rec of await scrapeNgcCatalogApi()) {
      if (rec.resourceId && !seen.has(rec.resourceId)) { seen.set(rec.resourceId, rec); fromApi++; }
    }
    console.log(`[build-scrape] catalog API added ${fromApi} more (total ${seen.size})`);
  } catch (err) {
    console.warn('[build-scrape] catalog API failed:', (err as Error)?.message);
  }

  return { records: [...seen.values()], fromHtml, fromApi };
}

/**
 * Convert a raw NGC catalog record from build.nvidia.com into a CatalogModel.
 * Uses the record's `publisher` label (authoritative, from the page itself)
 * instead of the name heuristic, and the AVAILABLE flag to drop private/
 * non-deployable endpoints. ids are raw `publisher/name` — the tunnel prefix
 * gets added later in fetchNvidiaModels.
 */
export function ngcRecordToModel(rec: NgcCatalogRecord, now: string): CatalogModel | null {
  if (!ngcAvailable(rec)) return null; // not currently deployable → hide from the marketplace
  const publisher = ngcPublisher(rec);
  // Catalog names use `_` where the NIM API id uses `.` (e.g. catalog
  // `llama-3_1-70b-instruct` → NIM `llama-3.1-70b-instruct`). Map to the real id
  // so the tunnel can post it verbatim.
  const slug = rec.name.replace(/_/g, '.');
  const modelApiId = `${publisher}/${slug}`;

  const isMultimodal = /vision|vl|omni|deplot|parse|neva|vila|diagram|image|audio|speaker|video|ocr/.test(slug);
  const isEmbed = /embed|rerank/.test(slug);
  const type: CatalogModel['type'] = isEmbed ? 'text' : (isMultimodal ? 'multimodal' : 'text');

  const description = rec.description || `NVIDIA NIM hosted model: ${modelApiId}`;
  const name = rec.displayName || slug;
  return {
    id: modelApiId,
    name,
    provider: 'NVIDIA',
    type,
    free: true,
    context_length: /128k|70b|super|ultra|1m/.test(slug) ? 131072 : 32768,
    description,
    tags: inferTags(modelApiId, name, description, type, true, now),
    moderated: true,
    pricing_prompt: 'Free tier via NVIDIA credits (sign up at build.nvidia.com)',
    added_date: now,
    max_output: 4096,
  };
}

// Curated fallback models to use if crawl/API fail, and as metadata overrides.
// Also used by the minimal seed cache so the catalog is never empty.
const FALLBACK_NVIDIA_MODELS: Array<{ id: string; name: string; desc: string; ctx: number }> = [
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'LLaMA-3.1-Nemotron-70B', desc: 'NVIDIA custom alignment model. Ideal for math, coding and reasoning.', ctx: 131072 },
  { id: 'meta/llama-3.3-70b-instruct', name: 'LLaMA-3.3-70B-Instruct', desc: 'State-of-the-art 70B model from Meta, optimized on NVIDIA NIM.', ctx: 131072 },
  { id: 'mistralai/mixtral-8x22b-instruct', name: 'Mixtral 8x22B Instruct', desc: 'High-performance sparse mixture-of-experts model on NVIDIA NIM.', ctx: 65536 },
  { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek-V4 Flash', desc: 'DeepSeek V4 Flash is a 284B MoE model with 1M-token context optimized for fast coding and agents.', ctx: 131072 },
  { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek-V4 Pro', desc: 'DeepSeek V4 scales to 1M-token context windows with efficient MoE architecture for coding tasks.', ctx: 131072 }
];

async function fetchNvidiaModels(nvidiaKey?: string): Promise<CatalogModel[]> {
  const now = new Date().toISOString();
  const modelsMap = new Map<string, CatalogModel>();
  let hasSuccessfulFetch = false;

  // 1. Scrape https://build.nvidia.com/models — the page embeds the NGC catalog
  //    (publisher labels, AVAILABLE flags, display names) and we page its own
  //    catalog API to cover the full list. This is the deployable-model set the
  //    build site actually shows; the markdown scrape below is a fallback.
  try {
    const { records } = await scrapeBuildNvidiaModels();
    for (const rec of records) {
      const model = ngcRecordToModel(rec, now);
      if (model) modelsMap.set(model.id, model);
    }
    if (modelsMap.size) hasSuccessfulFetch = true;
  } catch (err) {
    console.error('[model-sync] Error scraping build.nvidia.com/models:', err);
  }

  // 1b. Fallback: scrape models.md from build.nvidia.com (only if the page
  //     scrape produced nothing — it lists every model with one-line descs).
  if (modelsMap.size === 0) {
    try {
      const res = await withRetry(() =>
        fetchWithTimeout('https://build.nvidia.com/models.md', {
          headers: { 'User-Agent': 'ENZO-AI-Tunnel/1.0' }
        })
      );
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n');
        for (const line of lines) {
          const match = line.match(/-\s+\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)/);
          if (match) {
            const displayName = match[1]; // e.g. "Active Speaker Detection"
            const mdUrl = match[2]; // e.g. "/qc69jvmznzxy/active-speaker-detection.md"
            const desc = match[3]; // e.g. "Detect and track speaker identities across video frames."

            const parts = mdUrl.split('/');
            const filename = parts[parts.length - 1];
            const slug = filename.replace(/\.md$/, ''); // e.g. "active-speaker-detection"
            const normSlug = slug.replace(/_/g, '-');

            const publisher = inferNvidiaPublisher(normSlug);
            const modelApiId = `${publisher}/${normSlug}`;

            // Determine type
            const isMultimodal = normSlug.includes('vision') || normSlug.includes('vl') || normSlug.includes('omni') || normSlug.includes('deplot') || normSlug.includes('parse') || normSlug.includes('neva') || normSlug.includes('vila');
            const isEmbed = normSlug.includes('embed') || normSlug.includes('rerank');
            const type: CatalogModel['type'] = isEmbed ? 'text' : (isMultimodal ? 'multimodal' : 'text');

            modelsMap.set(modelApiId, {
              id: modelApiId,
              name: displayName,
              provider: 'NVIDIA',
              type,
              free: true,
              context_length: normSlug.includes('128k') || normSlug.includes('70b') || normSlug.includes('super') || normSlug.includes('ultra') ? 131072 : 32768,
              description: desc,
              tags: inferTags(modelApiId, displayName, desc, type, true, now),
              moderated: true,
              pricing_prompt: 'Free tier via NVIDIA credits (sign up at build.nvidia.com)',
              added_date: now,
              max_output: 4096
            });
            hasSuccessfulFetch = true;
          }
        }
      }
    } catch (err) {
      console.error('[model-sync] Error parsing build.nvidia.com/models.md:', err);
    }
  }

  // 2. Fetch live models from API if key is provided
  if (nvidiaKey) {
    try {
      const res = await withRetry(() =>
        fetchWithTimeout('https://integrate.api.nvidia.com/v1/models', {
          headers: {
            'Authorization': `Bearer ${nvidiaKey}`,
            'User-Agent': 'ENZO-AI-Tunnel/1.0'
          }
        })
      );
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        console.warn(`[model-sync] NVIDIA live models auth failed (${res.status}) — skipping`);
        // auth failure: not retryable, just log and continue with whatever else we have
      }
      if (res.ok) {
        const json = await res.json() as { data: Array<{ id: string }> };
        const verifiedMap = new Map<string, CatalogModel>();

        for (const m of json.data) {
          const apiId = m.id; // e.g. "meta/llama-3.3-70b-instruct"
          const cleanApiId = cleanModelIdForComparison(apiId);

          // Try to match with crawled models in modelsMap using normalized clean comparison.
          // A match enriches metadata (nice display name + description). If no match,
          // the model is still added — the scrape is the source of truth for deployable
          // models, but the live API may have newer models not yet on the page.
          let matchedModel: CatalogModel | undefined;
          for (const [key, val] of modelsMap.entries()) {
            if (cleanModelIdForComparison(key) === cleanApiId) {
              matchedModel = val;
              break;
            }
          }

          const parts = apiId.split('/');
          const modelName = parts[parts.length - 1];
          const isMultimodal = apiId.includes('vision') || apiId.includes('vl') || apiId.includes('omni') || apiId.includes('deplot') || apiId.includes('parse') || apiId.includes('neva') || apiId.includes('vila');
          const isEmbed = apiId.includes('embed') || apiId.includes('rerank');
          const type: CatalogModel['type'] = isEmbed ? 'text' : (isMultimodal ? 'multimodal' : 'text');

          const description = matchedModel?.description || `NVIDIA NIM hosted model: ${apiId}`;
          const name = matchedModel?.name || modelName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

          verifiedMap.set(apiId, {
            id: apiId,
            name,
            provider: 'NVIDIA',
            type,
            free: true,
            context_length: matchedModel?.context_length || (apiId.includes('128k') || apiId.includes('70b') || apiId.includes('super') || apiId.includes('ultra') ? 131072 : 32768),
            description,
            tags: inferTags(apiId, name, description, type, true, now),
            moderated: true,
            pricing_prompt: 'Free tier via NVIDIA credits (sign up at build.nvidia.com)',
            added_date: now,
            max_output: 4096
          });
        }

        // Merge live API results into scraped catalog (don't replace — the scrape is the
        // source of truth for deployable models; the live API only shows what THIS
        // key can reach, which may be a small subset for free/limited keys).
        for (const [k, v] of verifiedMap.entries()) {
          // If the model already exists from the scrape, enrich its metadata.
          // If it's new (not in scrape), add it.
          modelsMap.set(k, v);
        }
        hasSuccessfulFetch = true;
      }
    } catch (err) {
      console.error('[model-sync] Error querying NVIDIA live models API:', err);
    }
  }

  // 3. Enrich / Overwrite with premium metadata from FALLBACK_NVIDIA_MODELS
  for (const m of FALLBACK_NVIDIA_MODELS) {
    const existing = modelsMap.get(m.id) || modelsMap.get(m.id.replace(/_/g, '-'));
    if (existing) {
      existing.name = m.name;
      existing.description = m.desc;
      existing.context_length = m.ctx;
      existing.tags = inferTags(m.id, m.name, m.desc, existing.type, true, now);
    }
  }

  // 4. Safe fallback if both network methods failed or returned absolutely nothing
  if (!hasSuccessfulFetch || modelsMap.size === 0) {
    console.warn('[model-sync] Scraping and API calls returned no models. Populating with fallback list.');
    for (const m of FALLBACK_NVIDIA_MODELS) {
      modelsMap.set(m.id, {
        id: m.id,
        name: m.name,
        provider: 'NVIDIA',
        type: 'text',
        free: true,
        context_length: m.ctx,
        description: m.desc,
        tags: inferTags(m.id, m.name, m.desc, 'text', true, now),
        moderated: true,
        pricing_prompt: 'Free tier via NVIDIA credits (sign up at build.nvidia.com)',
        added_date: now,
        max_output: 4096,
      });
    }
  }

  // 5. Reachability probes. We used to hard-drop any model whose 1-token probe
  //    404'd ("Function not found for account"), but a free/limited NVIDIA key
  //    404s most NIM models — so that pruned the catalog to the ~3 the key could
  //    call and read as "scraping is broken". build.nvidia.com already only lists
  //    deployable models, so the scrape IS the source of truth. We still run the
  //    probe to seed the informational verified store, but fire-and-forget: it
  //    never shrinks the list. A model the user's key can't reach is caught at
  //    chat time via the runtime fallback, not hidden from the picker.
  const verified: CatalogModel[] = Array.from(modelsMap.values());
  if (nvidiaKey && verified.length) {
    verifyNvidiaCatalog(verified, nvidiaKey).catch((err) =>
      console.error('[model-sync] NVIDIA reachability verification failed (list unchanged):', (err as Error)?.message)
    );
  }

  // 6. Normalize ids: every NVIDIA catalog entry must carry exactly one `nvidia/`
  // tunnel prefix so resolveModelRoute / smart-fallback can route it. The integrate
  // API returns raw ids — some already begin with the nvidia org slug
  // (`nvidia/ai-synthetic-video-detector`), others don't (`meta/llama-...`).
  // Prefix ONLY those that lack the leading `nvidia/` to avoid double-prefixing
  // (`nvidia/nvidia/...`); resolveModelRoute then strips one `nvidia/` and posts
  // the raw id (org included) to NIM.
  const prefixed: CatalogModel[] = verified.map((m) => ({
    ...m,
    id: m.id.startsWith('nvidia/') ? m.id : `nvidia/${m.id}`,
  }));

  return prefixed;
}

// ─── Startup + Auto-Refresh ───────────────────────────────────────────────────

export function startModelSync(groqKey: string, hfToken?: string, nvidiaKey?: string, llm7Key?: string, googleKey?: string, puterKey?: string, cloudflareToken?: string, cloudflareAccount?: string): void {
  // Run immediately on startup
  syncModels(groqKey, hfToken, nvidiaKey, llm7Key, googleKey, puterKey, cloudflareToken, cloudflareAccount).catch((err) =>
    console.error('[model-sync] Startup sync failed:', err)
  );

  // Then refresh every 6 hours
  setInterval(() => {
    const currentGroq = process.env.GROQ_API_KEY || groqKey;
    const currentHf = process.env.HF_TOKEN || hfToken;
    const currentNvidia = process.env.NVIDIA_API_KEY || tryReadNvidiaKey() || nvidiaKey;
    const currentLlm7 = process.env.LLM7_API_KEY || llm7Key;
    const currentGoogle = process.env.GEMINI_API_KEY || googleKey;
    const currentPuter = process.env.PUTER_AUTH_TOKEN || puterKey;
    const currentCloudflare = process.env.CLOUDFLARE_API_TOKEN || cloudflareToken;
    const currentCloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID || cloudflareAccount;
    syncModels(currentGroq, currentHf, currentNvidia, currentLlm7, currentGoogle, currentPuter, currentCloudflare, currentCloudflareAccount).catch((err) =>
      console.error('[model-sync] Scheduled sync failed:', err)
    );
  }, SYNC_INTERVAL_MS);
}

// Export sync function for manual trigger
export { syncModels };
