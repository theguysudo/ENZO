/**
 * connectors.ts — source connectors for investigations.
 *
 * Each connector turns one kind of public source into SourceDoc rows (or
 * candidate URLs for the website fetcher). Connectors are deliberately boring:
 * defined input → defined output, per-call timeouts, NEVER-THROW (a failed
 * source is recorded as a finding with ok:false, not a crashed run). Adding a
 * new source type later means adding a connector here, not redesigning the
 * pipeline.
 *
 * SECURITY NOTES (keep these true):
 *  - Arbitrary pages go through guardedFetch (fetcher.ts) — the strictest
 *    SSRF guard in the repo, re-validated per redirect hop.
 *  - GitHub access is READ-ONLY REST (api.github.com) with the install's
 *    public identity; no clone, no code execution, no tokens.
 *  - Wikipedia/Exa/Bing are fixed-host API calls, never URL-redirected into.
 */
import type { ConnectorName, RunKeys, SourceDoc, UserDocument } from './types.js';
import { guardedFetch, hashText, isJunkUrl } from './fetcher.js';
import { searchWebResults, type WebResult } from '../agent/search.js';

const API_TIMEOUT_MS = 12_000;

export interface ConnectorOutcome {
  sources: SourceDoc[];
  candidates: WebResult[];   // URLs worth fetching (search connector)
  searchesUsed: number;
  error?: string;
}

/** web_search — candidates only; the orchestrator fetches what it picks. */
export async function searchCandidates(query: string, exaKey: string, limit = 8): Promise<ConnectorOutcome> {
  try {
    const results = await searchWebResults(query, limit, exaKey);
    const candidates = results.filter((r) => r.url && !isJunkUrl(r.url));
    return { sources: [], candidates, searchesUsed: 1 };
  } catch (err: any) {
    return { sources: [], candidates: [], searchesUsed: 1, error: String(err?.message ?? err).slice(0, 120) };
  }
}

/** website — fetch one URL into a SourceDoc plus same-page links for the
 *  depth-1 crawl (assign ids via the callback). */
export async function fetchAsSource(
  url: string,
  connector: ConnectorName,
  newId: () => string,
): Promise<{ source: SourceDoc; links: string[] }> {
  const res = await guardedFetch(url);
  const source: SourceDoc = {
    id: newId(),
    url: res.url,
    title: res.title || hostOf(res.url) || url,
    host: hostOf(res.url),
    connector,
    fetchedAt: Date.now(),
    contentHash: res.ok ? res.contentHash : '',
    text: res.text,
    ok: res.ok,
    ...(res.error ? { error: res.error } : {}),
  };
  return { source, links: res.links };
}

/** github — public REST metadata + README for up to 3 repos. Repos come from
 *  investigation seed URLs; the search endpoint finds org repos by keyword. */
export async function githubSources(
  keywords: string,
  seedUrls: string[],
  newId: () => string,
): Promise<ConnectorOutcome> {
  const repos: string[] = [];
  for (const u of seedUrls) {
    const m = u.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$|\?)/);
    if (m && !['orgs', 'topics', 'features', 'marketplace', 'settings'].includes(m[1].toLowerCase())) {
      repos.push(`${m[1]}/${m[2]}`);
    }
  }
  if (repos.length < 3 && keywords.trim()) {
    try {
      const res = await apiJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(keywords.slice(0, 200))}&per_page=5&sort=stars`);
      for (const item of (res?.items ?? []) as any[]) {
        if (typeof item?.full_name === 'string' && !repos.includes(item.full_name)) repos.push(item.full_name);
        if (repos.length >= 3) break;
      }
    } catch (err: any) {
      return { sources: await repoSources(repos, newId), candidates: [], searchesUsed: 0, error: `github search: ${String(err?.message ?? err).slice(0, 100)}` };
    }
  }
  return { sources: await repoSources(repos.slice(0, 3), newId), candidates: [], searchesUsed: 0 };
}

async function repoSources(repos: string[], newId: () => string): Promise<SourceDoc[]> {
  const out: SourceDoc[] = [];
  for (const full of repos) {
    try {
      const meta = await apiJson(`https://api.github.com/repos/${full}`);
      let readme = '';
      try {
        const r = await fetch(`https://api.github.com/repos/${full}/readme`, {
          headers: { 'User-Agent': 'ENZO-Intelligence/1.0', Accept: 'application/vnd.github.raw' },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        if (r.ok) readme = (await r.text()).slice(0, 4000);
      } catch { /* readme is optional */ }
      const text = [
        `Repository: ${meta?.full_name ?? full}`,
        `Description: ${meta?.description ?? '(none)'}`,
        `Stars: ${meta?.stargazers_count ?? '?'} · Language: ${meta?.language ?? '?'} · License: ${meta?.license?.spdx_id ?? '?'} · Forks: ${meta?.forks_count ?? '?'}`,
        `Created: ${meta?.created_at ?? '?'} · Last push: ${meta?.pushed_at ?? '?'} · Open issues: ${meta?.open_issues_count ?? '?'}`,
        meta?.homepage ? `Homepage: ${meta.homepage}` : '',
        meta?.topics?.length ? `Topics: ${String(meta.topics).slice(0, 200)}` : '',
        readme ? `\nREADME (excerpt):\n${readme}` : '',
      ].filter(Boolean).join('\n');
      out.push({
        id: newId(),
        url: `https://github.com/${full}`,
        title: `${full} (GitHub)`,
        host: 'github.com',
        connector: 'github',
        fetchedAt: Date.now(),
        contentHash: hashText(text),
        text,
        ok: true,
        ...(meta?.created_at ? { publishedAt: String(meta.created_at).slice(0, 10) } : {}),
      });
    } catch (err: any) {
      out.push({
        id: newId(), url: `https://github.com/${full}`, title: full, host: 'github.com',
        connector: 'github', fetchedAt: Date.now(), contentHash: '', text: '', ok: false,
        error: String(err?.message ?? err).slice(0, 120),
      });
    }
  }
  return out;
}

/** wikipedia — encyclopedic grounding for the objective (search + extract). */
export async function wikipediaSources(query: string, newId: () => string): Promise<ConnectorOutcome> {
  try {
    const search = await apiJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=2&srsearch=${encodeURIComponent(query.slice(0, 250))}`);
    const hits: any[] = search?.query?.search ?? [];
    const sources: SourceDoc[] = [];
    for (const hit of hits.slice(0, 2)) {
      const title = String(hit?.title ?? '');
      if (!title) continue;
      try {
        const ex = await apiJson(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&titles=${encodeURIComponent(title)}`);
        const pages = ex?.query?.pages ?? {};
        const extract = String(Object.values(pages)[0]?.['extract'] ?? '');
        if (!extract) continue;
        const text = `${title}\n${extract.slice(0, 12_000)}`;
        sources.push({
          id: newId(),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          title: `${title} (Wikipedia)`,
          host: 'en.wikipedia.org',
          connector: 'wikipedia',
          fetchedAt: Date.now(),
          contentHash: hashText(text),
          text,
          ok: true,
        });
      } catch { /* per-hit failure is fine */ }
    }
    if (!sources.length) return { sources: [], candidates: [], searchesUsed: 0, error: 'wikipedia: no usable extract' };
    return { sources, candidates: [], searchesUsed: 0 };
  } catch (err: any) {
    return { sources: [], candidates: [], searchesUsed: 0, error: `wikipedia: ${String(err?.message ?? err).slice(0, 100)}` };
  }
}

/** document — the user's own material becomes first-class sources. */
export function documentSources(docs: UserDocument[], newId: () => string): ConnectorOutcome {
  return {
    sources: docs.map((d) => {
      const text = `${d.name}\n\n${d.text}`;
      return {
        id: newId(),
        url: `document:${d.name}`,
        title: d.name,
        host: '(user document)',
        connector: 'document' as ConnectorName,
        fetchedAt: Date.now(),
        contentHash: hashText(text),
        text: d.text.slice(0, 24_000),
        ok: true,
      };
    }),
    candidates: [],
    searchesUsed: 0,
  };
}

async function apiJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ENZO-Intelligence/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 60); }
}

/** Same-host, non-junk links worth crawling one level deep. */
export function crawlableLinks(links: string[], originUrl: string): string[] {
  let host = '';
  try { host = new URL(originUrl).hostname.replace(/^www\./, ''); } catch { return []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of links) {
    if (isJunkUrl(l)) continue;
    try {
      const u = new URL(l);
      if (u.hostname.replace(/^www\./, '') !== host) continue;
      u.hash = '';
      const norm = u.toString();
      if (norm.replace(/\/$/, '') === originUrl.replace(/\/$/, '')) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
      if (out.length >= 3) break;
    } catch { /* skip */ }
  }
  return out;
}

/** Normalize a URL for dedupe (strip hash + trailing slash, unify host). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s.toLowerCase().replace(/^https?:\/\//, '');
  } catch { return url.toLowerCase(); }
}
