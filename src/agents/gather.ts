/**
 * gather.ts — the agent knowledge-sourcing engine.
 *
 * When a user describes a custom agent, this module finds domain material for
 * it, in trust order: (1) bundled vendored skills (offline, always safe),
 * (2) the user's already-learned skills, (3) the internet — GitHub repos found
 * via web search get cloned + distilled with the existing learnSkillFromRepo
 * machinery, (4) user-supplied URLs, fetched SSRF-guarded and distilled into
 * knowledge notes.
 *
 * SECURITY NOTES (keep these true):
 *  - Nothing gathered is ever executed. GitHub clones go through
 *    learnSkillFromRepo, which samples TEXT files only (see its SECURITY NOTE
 *    in skills.ts). URL fetches are read as text and distilled.
 *  - URL fetching is SSRF-guarded: https only, no private/reserved IPs, DNS
 *    re-checked on every redirect hop, hard 200KB cap.
 *  - Only github.com repo URLs are ever cloned (not gitlab/bitbucket, not
 *    arbitrary hosts) — the internet path clones from exactly one host.
 *
 * Every network touch is an injectable seam (`_search`, `_cloneAndDistill`,
 * `_fetchUrl`, `_distillNotes`) so tests run with zero network.
 */
import dns from 'dns';
import { promisify } from 'util';
import { listSkills, learnSkillFromRepo, type SkillEntry } from '../skills/skills.js';
import { loadBundledSkills } from '../skills/bundled-skills.js';
import { searchWebResults, type WebResult } from '../agent/search.js';

const dnsLookup = promisify(dns.lookup);

export type GatherSource = 'bundled' | 'learned' | 'github';

export interface GatherCandidate {
  id: string;           // skill id (bundled module name / learned id / owner-repo)
  name: string;
  description: string;
  source: GatherSource;
  sourceUrl?: string;
  instructions?: string; // bundled skills ship full instructions already
}

export interface GatherNote {
  note: string;   // ≤1500 chars, distilled
  source: string; // URL or 'pasted' it came from
}

export interface GatherResult {
  queries: string[];          // search queries actually used (internet path)
  bundled: GatherCandidate[];
  learned: GatherCandidate[];
  github: GatherCandidate[];
  knowledge: GatherNote[];
  warnings: string[];
}

export interface GatherOpts {
  groqKey?: string;
  exaKey?: string;
  internet?: boolean;        // opt-in: run web search + GitHub cloning
  urls?: string[];           // user-supplied URLs to distill (≤5)
  queries?: string[];        // override derived search queries
  _search?: (q: string) => Promise<WebResult[]>;
  _cloneAndDistill?: (repoUrl: string) => Promise<GatherCandidate | null>;
  _fetchUrl?: (url: string) => Promise<string>;
  _distillNotes?: (task: string, text: string, source: string) => Promise<string[]>;
}

// ── Matching (token overlap, same idea as buildSkillContext scoring) ────────

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','so','of','to','in','on','at','for','with',
  'from','by','is','are','was','were','be','been','being','it','its','this','that','these',
  'those','i','me','my','we','our','you','your','they','them','their','he','she','his','her',
  'not','no','do','does','did','have','has','had','can','could','will','would','should',
  'about','into','over','up','down','as','please','now','just','get','got','want',
  'need','like','still','there','here','what','why','how','when','where','who','which',
  'every','each','day','daily','check','keep','make','also','using','use',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) || [])
    .filter((t) => !STOPWORDS.has(t));
}

function scoreAgainst(tokens: string[], haystack: string): number {
  const hay = tokenize(haystack);
  if (!tokens.length || !hay.length) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (hay.some((h) => h === t || (t.length >= 5 && h.length >= 5 && (h.startsWith(t) || t.startsWith(h))))) hits++;
  }
  return hits + (hits / tokens.length);
}

/** Derive 2 search queries from a task description, mechanically (no LLM
 *  needed, deterministic, testable): a "best repo" query plus a "how-to"
 *  query over the most significant terms. */
export function deriveSearchQueries(task: string): string[] {
  const tokens = tokenize(task).slice(0, 8);
  if (!tokens.length) return [];
  const core = tokens.slice(0, 6).join(' ');
  return [
    `best github repository ${core}`,
    `${core} guide tutorial documentation`,
  ];
}

// ── Phase 1 + 2: local matching (offline, zero risk) ─────────────────────────

function matchBundled(task: string): GatherCandidate[] {
  const tokens = tokenize(task);
  if (!tokens.length) return [];
  return loadBundledSkills()
    .map((s) => ({
      c: {
        id: s.id,
        name: s.name,
        description: s.description,
        source: 'bundled' as GatherSource,
        instructions: s.instructions.slice(0, 3000),
      },
      score: scoreAgainst(tokens, `${s.name} ${s.keywords.join(' ')} ${s.description}`),
    }))
    .filter((x) => x.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c);
}

function matchLearned(task: string): GatherCandidate[] {
  const tokens = tokenize(task);
  if (!tokens.length) return [];
  return listSkills()
    .map((s) => ({
      c: {
        id: s.id,
        name: s.name,
        description: s.description,
        source: 'learned' as GatherSource,
        sourceUrl: s.sourceUrl,
      },
      score: scoreAgainst(tokens, `${s.name} ${s.keywords.join(' ')} ${s.description}`),
    }))
    .filter((x) => x.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.c);
}

// ── Phase 3: internet — search → github.com only → clone+distill ────────────

/** Extract a canonical `https://github.com/owner/repo` URL from a search
 *  result, or null. Deliberately strict: internet cloning happens for
 *  github.com and nothing else. */
export function githubRepoUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$|\?)/);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || owner.length < 2 || repo.length < 2) return null;
  // Skip obvious non-repo paths on github.com
  if (['settings', 'orgs', 'topics', 'features', 'marketplace', 'enterprise'].includes(owner.toLowerCase())) return null;
  return `https://github.com/${owner}/${repo}`;
}

async function gatherFromInternet(task: string, opts: GatherOpts, out: GatherResult): Promise<void> {
  const search = opts._search ?? ((q: string) => searchWebResults(q, 6, opts.exaKey));
  const queries = (opts.queries?.length ? opts.queries : deriveSearchQueries(task)).slice(0, 3);
  out.queries = queries;

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const q of queries) {
    if (candidates.length >= 3) break;
    let results: WebResult[] = [];
    try {
      results = await search(q);
    } catch (err: any) {
      out.warnings.push(`search failed: ${String(err?.message ?? err).slice(0, 120)}`);
      continue;
    }
    for (const r of results) {
      const repoUrl = githubRepoUrl(r.url);
      if (!repoUrl || seen.has(repoUrl)) continue;
      seen.add(repoUrl);
      candidates.push(repoUrl);
      if (candidates.length >= 3) break;
    }
  }

  for (const repoUrl of candidates) {
    try {
      const c = await cloneAndDistillDefault(repoUrl, opts);
      if (c) out.github.push(c);
    } catch (err: any) {
      out.warnings.push(`could not learn from ${repoUrl}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
}

/** Default clone+distill: the existing learnSkillFromRepo machinery (text-only
 *  sampling, nothing executed). A repo already in the skills store surfaces as
 *  a candidate pointing at the existing skill instead of failing. */
async function cloneAndDistillDefault(repoUrl: string, opts: GatherOpts): Promise<GatherCandidate | null> {
  const asCandidate = (s: SkillEntry): GatherCandidate => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: 'github',
    sourceUrl: s.sourceUrl,
  });
  const fn = opts._cloneAndDistill;
  if (fn) {
    return await fn(repoUrl);
  }
  try {
    const entry = await learnSkillFromRepo(repoUrl, { groqKey: opts.groqKey });
    return asCandidate(entry);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes('already learned')) {
      const id = repoUrl
        .replace(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//, '')
        .replace(/\.git$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9/]/g, '-');
      const existing = listSkills().find((s) => s.id === id);
      if (existing) return asCandidate(existing);
    }
    throw err;
  }
}

// ── Phase 4: user URLs — SSRF-guarded fetch → distilled notes ───────────────

const PRIVATE_IP = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i;
const MAX_URL_BYTES = 200 * 1024;

/** SSRF guard: https only, hostname must not be a private/reserved IP literal,
 *  and DNS must resolve to a public address. Throws on violation — callers
 *  turn it into a warning. */
async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'https:') throw new Error('https only');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('private host rejected');
  }
  if (PRIVATE_IP.test(host)) throw new Error('private IP rejected');
  // DNS resolution check (skip for tests pointing at fake hosts with an
  // injected _fetchUrl — the guard below only runs on the real fetch path).
  const addrs = await dnsLookup(host, { all: true }).catch(() => []);
  for (const a of addrs) {
    if (PRIVATE_IP.test(a.address) || a.address === '::1') throw new Error('host resolves to a private address');
  }
  return u;
}

/** Strip HTML to readable text (cheap regex pass — fetched pages are distilled
 *  right after, not displayed). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Real fetch: SSRF-guarded, redirects followed manually (max 3) with the
 *  guard re-applied to every hop, hard 200KB read cap. Exported so tests can
 *  exercise the guard directly. */
export async function fetchUrlGuarded(raw: string): Promise<string> {
  let current = raw;
  for (let hop = 0; hop < 3; hop++) {
    const u = await assertPublicHttpsUrl(current);
    const res = await fetch(u, {
      headers: { 'User-Agent': 'ENZO-Agent-Builder/1.0', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_URL_BYTES));
    const ct = res.headers.get('content-type') || '';
    return ct.includes('html') ? htmlToText(text) : text;
  }
  throw new Error('too many redirects');
}

/** Extractive fallback when no LLM key is available: first sentences of the
 *  strongest paragraphs, capped. */
function extractiveNotes(task: string, text: string, limit: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 40);
  const notes: string[] = [];
  for (const s of sentences) {
    if (notes.length >= limit) break;
    const n = s.trim().slice(0, 1500);
    if (n) notes.push(n);
  }
  return notes;
}

/** Distill fetched page text into ≤4 knowledge notes (≤1500 chars each) using
 *  the BYOK JSON chain (Groq → OpenRouter), falling back to extraction. */
async function distillNotesDefault(task: string, text: string, source: string, groqKey?: string): Promise<string[]> {
  const clean = text.slice(0, 12000);
  if (!clean.trim()) return [];

  const parse = (raw: string): string[] => {
    try {
      const j = JSON.parse(raw);
      const notes = Array.isArray(j.notes) ? j.notes : [];
      return notes.map((n: unknown) => String(n ?? '').trim().slice(0, 1500)).filter(Boolean).slice(0, 4);
    } catch {
      return [];
    }
  };

  const sys = `You distill reference pages into short knowledge notes for an AI agent. The agent's task: "${task}". Source: ${source}. From the page text below, extract 2-4 self-contained notes of facts, APIs, conventions, or procedures the agent will need. Each note must stand alone. Return ONLY JSON: {"notes": ["...", "..."]}\n\nPage text:\n${clean}`;

  const groq = groqKey || process.env.GROQ_API_KEY || '';
  if (groq) {
    try {
      const { Groq } = await import('groq-sdk');
      const client = new Groq({ apiKey: groq, timeout: 15000, maxRetries: 0 });
      const r = await client.chat.completions.create({
        model: 'openai/gpt-oss-20b', // live-verified json mode (2026-09-06) — llama-3.1-8b-instant delisted
        messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Distill into notes. JSON only.' }],
        temperature: 0.3,
        max_tokens: 1600, // reasoning model: ~600 reasoning tokens before the JSON
        response_format: { type: 'json_object' },
      });
      const notes = parse(r.choices[0]?.message?.content || '{}');
      if (notes.length) return notes;
    } catch (err: any) {
      console.error('[agents-gather] groq distill failed:', err?.message ?? err);
    }
  }
  const orKey = process.env.OPENROUTER_API_KEY || '';
  if (orKey) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'z-ai/glm-5.2:free', // meta-llama/llama-3.1-8b-instruct:free delisted
          messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Distill into notes. JSON only.' }],
          temperature: 0.3,
          max_tokens: 1600,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) {
        const j: any = await r.json();
        const notes = parse(j?.choices?.[0]?.message?.content || '{}');
        if (notes.length) return notes;
      }
    } catch (err: any) {
      console.error('[agents-gather] openrouter distill failed:', err?.message ?? err);
    }
  }
  return extractiveNotes(task, clean, 4);
}

// ── The entry point ──────────────────────────────────────────────────────────

/** Gather domain knowledge for a task description. Never throws — network
 *  failures and hostile inputs become `warnings`. */
export async function gatherDomainKnowledge(task: string, opts: GatherOpts = {}): Promise<GatherResult> {
  const safeTask = String(task || '').slice(0, 500);
  const out: GatherResult = {
    queries: [],
    bundled: matchBundled(safeTask),
    learned: matchLearned(safeTask),
    github: [],
    knowledge: [],
    warnings: [],
  };

  // Phase 3: internet (opt-in only — never automatic).
  if (opts.internet) {
    try {
      await gatherFromInternet(safeTask, opts, out);
    } catch (err: any) {
      out.warnings.push(`internet gather failed: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  // Phase 4: user URLs (≤5), each SSRF-guarded, size-capped, distilled.
  const urls = (opts.urls || []).map(String).filter(Boolean).slice(0, 5);
  for (const url of urls) {
    try {
      const fetcher = opts._fetchUrl ?? fetchUrlGuarded;
      const text = await fetcher(url);
      if (!text.trim()) {
        out.warnings.push(`no readable content at ${url}`);
        continue;
      }
      const distiller = opts._distillNotes ?? ((t: string, x: string, s: string) => distillNotesDefault(t, x, s, opts.groqKey));
      const notes = await distiller(safeTask, text, url);
      for (const n of notes) {
        if (out.knowledge.length >= 8) break;
        out.knowledge.push({ note: n.slice(0, 1500), source: url.slice(0, 300) });
      }
    } catch (err: any) {
      out.warnings.push(`could not read ${String(url).slice(0, 200)}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  return out;
}
