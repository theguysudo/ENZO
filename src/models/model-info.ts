/**
 * model-info.ts — per-model facts, sourced from the open web and cached a day.
 *
 * Owns: `getModelInfo` and `model-info-cache.json`.
 * Called by: index.ts (/api/model-info, behind a rate limit).
 *
 * Provider-agnostic on purpose: it searches by model name + provider rather than
 * reading any one vendor's catalog, so a model that appeared on OpenRouter,
 * NVIDIA or HuggingFace an hour ago gets a description without waiting for us to
 * add a per-vendor scraper. model-sync.ts is the other half of this story — it
 * owns the *list* of models; this owns the *prose* about one.
 *
 * ponytail: 24-hour TTL, whole-file cache, no negative caching. A model the web
 * knows nothing about is re-searched every day; add a miss marker if that shows
 * up in the logs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Groq } from 'groq-sdk';
import { searchWeb } from '../agent/search.js';

// Per-model deep info, web-sourced and refreshed daily. Works for models from
// ANY provider (OpenRouter/Groq/NVIDIA/HF/Pollinations/…) because it searches
// the open web by model name+provider rather than reading one vendor catalog.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'model-info-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000; // refresh daily

export interface ModelInfo {
  summary: string;        // 2-3 sentence specific overview
  architecture: string;   // params, dense/MoE, base family
  context: string;        // context window + max output if known
  strengths: string[];    // concrete, model-specific
  weaknesses: string[];   // concrete, model-specific
  bestFor: string[];      // ideal use-cases
  speed: string;          // latency/throughput characterization
  pricing: string;        // cost characterization
  benchmarks: string;     // notable eval numbers if any
  release: string;        // release/version timing
  sources: string[];      // URLs used
}

interface Entry { fetchedAt: number; info: ModelInfo }
type InfoCache = Record<string, Entry>;

function readCache(): InfoCache {
  try {
    if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as InfoCache;
  } catch { /* corrupt — rebuild */ }
  return {};
}

function writeCache(cache: InfoCache) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2)); }
  catch (err: any) { console.warn('[model-info] cache write failed:', err?.message); }
}

// Collapse in-flight requests for the same model so a burst of hovers = 1 search.
const inFlight = new Map<string, Promise<ModelInfo>>();

const EMPTY: ModelInfo = {
  summary: '', architecture: '', context: '', strengths: [], weaknesses: [],
  bestFor: [], speed: '', pricing: '', benchmarks: '', release: '', sources: [],
};

function extractSources(searchText: string): string[] {
  return [...searchText.matchAll(/Source:\s*(https?:\/\/\S+)/g)].map((m) => m[1]).slice(0, 5);
}

// When no LLM key is available, still surface the real web findings instead of
// an empty card: parse the search-result snippets directly.
function fallbackFromSearch(searchText: string, sources: string[]): ModelInfo {
  const blocks = searchText.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const snippets: string[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim());
    const body = lines.filter((l) => l && !l.startsWith('Source:') && !l.startsWith('- ')).join(' ');
    const title = lines.find((l) => l.startsWith('- '))?.slice(2) || '';
    const text = [title, body].filter(Boolean).join(' — ');
    if (text) snippets.push(text);
  }
  return {
    ...EMPTY,
    summary: snippets.slice(0, 3).join(' ').slice(0, 600),
    strengths: snippets.slice(0, 4).map((s) => s.slice(0, 160)),
    sources,
  };
}

export interface Keys { groq?: string; openrouter?: string; exa?: string }

const SYS_PROMPT =
  'You are an AI-model analyst. Using ONLY the web search results provided, write a ' +
  'SPECIFIC technical profile of the exact model named. Do not give generic filler that ' +
  'could apply to any LLM — cite concrete parameter counts, architecture (dense vs MoE), ' +
  'context window, benchmark scores, real strengths/weaknesses, and pricing when present in ' +
  'the sources. If a detail is not in the sources, use an empty string/array rather than ' +
  'inventing it. Return ONLY JSON matching: {"summary":string,"architecture":string,' +
  '"context":string,"strengths":string[],"weaknesses":string[],"bestFor":string[],' +
  '"speed":string,"pricing":string,"benchmarks":string,"release":string}';

function parseInfo(raw: string, sources: string[]): ModelInfo {
  let p: Partial<ModelInfo> = {};
  try { p = JSON.parse(raw); } catch { /* keep empty */ }
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const str = (v: unknown): string => typeof v === 'string' ? v : '';
  return {
    summary: str(p.summary), architecture: str(p.architecture), context: str(p.context),
    strengths: arr(p.strengths), weaknesses: arr(p.weaknesses), bestFor: arr(p.bestFor),
    speed: str(p.speed), pricing: str(p.pricing), benchmarks: str(p.benchmarks),
    release: str(p.release), sources,
  };
}

// Synthesize via Groq if that key works, else via OpenRouter (OpenAI-compatible,
// and compulsory in this app so every user has one). Whichever is available.
async function synthesize(
  model: { id: string; name: string; provider: string },
  searchText: string,
  sources: string[],
  keys: Keys,
): Promise<ModelInfo> {
  const userMsg = `Model: "${model.name}" (id: ${model.id}, provider: ${model.provider}).\n\nWeb search results:\n${searchText.slice(0, 6000)}`;
  const messages = [
    { role: 'system' as const, content: SYS_PROMPT },
    { role: 'user' as const, content: userMsg },
  ];

  if (keys.groq) {
    try {
      const groq = new Groq({ apiKey: keys.groq });
      const c = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile', temperature: 0.2, max_tokens: 900,
        response_format: { type: 'json_object' }, messages,
      });
      return parseInfo(c.choices[0]?.message?.content ?? '{}', sources);
    } catch (err: any) {
      console.warn(`[model-info] Groq synth failed (${err?.message}); trying OpenRouter`);
    }
  }

  if (keys.openrouter) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.openrouter}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct', temperature: 0.2, max_tokens: 900,
        response_format: { type: 'json_object' }, messages,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseInfo(j.choices?.[0]?.message?.content ?? '{}', sources);
  }

  throw new Error('no LLM key available');
}

async function build(
  model: { id: string; name: string; provider: string },
  keys: Keys,
): Promise<ModelInfo> {
  const cleanName = model.name.replace(/[|<>]/g, ' ').trim();
  // Quote the exact model name so DDG/Bing rank the specific model, not the family homepage.
  const query = `"${cleanName}" model specifications parameters context window benchmark review ${model.provider}`;
  const searchText = await searchWeb(query, 8, keys.groq, keys.exa);
  if (!searchText.trim()) return EMPTY;
  const sources = extractSources(searchText);
  // Prefer LLM synthesis; if no key works, still return the raw web findings.
  if (keys.groq || keys.openrouter) {
    try {
      const info = await synthesize(model, searchText, sources, keys);
      if (info.summary || info.strengths.length) return info;
    } catch (err: any) {
      console.warn(`[model-info] synthesis failed (${err?.message}); using raw search`);
    }
  }
  return fallbackFromSearch(searchText, sources);
}

export async function getModelInfo(
  model: { id: string; name: string; provider: string },
  keys: Keys,
): Promise<ModelInfo> {
  const cache = readCache();
  const hit = cache[model.id];
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.info;

  const existing = inFlight.get(model.id);
  if (existing) return existing;

  const p = (async () => {
    try {
      const info = await build(model, keys);
      // Only persist a result that actually found something; keep stale-but-real over empty.
      if (info.summary || info.strengths.length) {
        const fresh = readCache();
        fresh[model.id] = { fetchedAt: Date.now(), info };
        writeCache(fresh);
        return info;
      }
      return hit?.info ?? info; // fall back to stale entry if the refresh came up empty
    } catch (err: any) {
      console.warn(`[model-info] ${model.id} failed:`, err?.message);
      return hit?.info ?? EMPTY;
    } finally {
      inFlight.delete(model.id);
    }
  })();
  inFlight.set(model.id, p);
  return p;
}
