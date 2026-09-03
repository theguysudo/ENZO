/**
 * research-engine.ts — Autonomous research agent (Perplexity Deep Research style).
 *
 * The previous version was a FIXED PIPELINE: blind fan-out → mechanical scoring →
 * hope. This version is an AGENT LOOP. One LLM (the "research agent") controls the
 * tools and makes every judgment call itself:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  loop (until DONE or budget exhausted):                              │
 *   │                                                                      │
 *   │    state  → question, ledger of seen sources, evidence pool,         │
 *   │             running notes, remaining budgets (searches / reads /     │
 *   │             wall-clock time)                                         │
 *   │                                                                      │
 *   │    agent decides ONE action:                                         │
 *   │      SEARCH "query"     — fan out; returns 8 candidates w/ snippets  │
 *   │      READ   [i]         — pull FULL TEXT of source i (expensive,     │
 *   │                             agent chooses which are worth opening)   │
 *   │      KEEP   [i, note]   — promote source i to evidence pool          │
 *   │      DROP   [i]         — reject it (off-topic, junk, low value)     │
 *   │      NOTE   "text"      — record a finding/conclusion so far         │
 *   │      DONE   "summary"   — agent decides it has enough                │
 *   │                                                                      │
 *   │    engine executes → result is appended to state → next iteration    │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * Autonomy guarantees given to the agent:
 *   - It chooses its own search queries (no template list).
 *   - It sees a compact ledger (id/title/site/snippet/trust) and picks what
 *     to READ in full — full text is how it verifies claims.
 *   - KEEP/DROP is its judgment, informed by trust metadata we surface.
 *   - It sees the remaining time budget and can end early (DONE) the moment
 *     coverage is sufficient — or burn the full budget on hard questions.
 *
 * Safety rails (not judgment): URL validity, hard caps on calls/time, JSON
 * action parsing with environment feedback on invalid actions.
 */

import Groq from 'groq-sdk';
import { searchWebResults, type WebResult } from '../agent/search.js';

export interface ResearchSource extends WebResult {
  relevance: number;      // agent-assigned (0–10); 9+ for opened & verified
  credibility: number;    // heuristic shown TO the agent as trust metadata
  foundBy: string;        // which agent search surfaced it
  pass: 'seed' | 'read' | 'gap';
  kept: boolean;
  read: boolean;
  agentNote?: string;     // why the agent kept it
}

export interface ResearchReport {
  clusters: Array<{ label: string; sourceIndices: number[] }>;
  sources: ResearchSource[];
  context: string;
  stats: {
    totalPulled: number;
    totalKept: number;
    droppedJunk: number;
    droppedDuplicates: number;
    droppedIrrelevant: number;   // = agent DROP decisions
    passBreakdown: Record<'seed' | 'read' | 'gap', number>;
    searches: number;
    reads: number;
    iterations: number;
    agentNotes: string[];
    agentSummary: string;
    wallTimeMs: number;
  };
}

export interface EngineOptions {
  query: string;
  exaKey: string;
  groqKey: string;
  maxFinal?: number;            // cap on evidence pool for synthesis (default 40)
  maxTotal?: number;            // hard cap on ledger size (default 180)
  contentChars?: number;        // full-text chars fetched per READ (default 6000)
  /** Hard budgets — the agent can end itself earlier via DONE. */
  maxSearches?: number;         // default 22
  maxReads?: number;            // default 28
  maxIterations?: number;       // default 56 agent decisions
  timeBudgetMs?: number;        // default 210_000 (3.5 min)
  onStep?: (line: string) => void;
}

/* ── Trust heuristics — metadata shown TO the agent (it still decides) ── */
const AUTH_HOSTS = new Set([
  'reuters.com','apnews.com','bbc.com','bbc.co.uk','nytimes.com','wsj.com',
  'theguardian.com','nature.com','science.org','arxiv.org','dl.acm.org',
  'ieee.org','nist.gov','who.int','imf.org','worldbank.org','sec.gov',
  'developer.mozilla.org','github.blog',
]);

function credibilityScore(url: string, title: string): number {
  let s = 5;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (AUTH_HOSTS.has(h)) s += 4;
    if (/\.(gov|edu|ac\.uk|ac\.jp|int|org)$/.test(h)) s += 3;
    if (/\.(io|dev)$/.test(h)) s += 1;
    if (/blog|medium\.com|substack|wordpress/.test(h)) s -= 1;
    if (/pinterest|tiktok|reddit|quora|instagram/.test(h)) s -= 3;
    if (/docs?\.|reference|specification|manual/i.test(h)) s += 1;
  } catch { /* */ }
  if (title.length > 60) s += 0.5;
  return Math.max(0, Math.min(10, s));
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/* ── Exa primitives (agent tools) ─────────────────────────────────────── */
// Hard wall-clock timeout on every Exa call so a stalled upstream can never
// wedge the whole research loop (an open SSE would otherwise hang mid-stream).
const EXA_TIMEOUT_MS = 25_000;

function exaFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXA_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function exaSearchPreview(query: string, apiKey: string, num: number): Promise<WebResult[]> {
  const res = await exaFetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query, numResults: num, type: 'auto',
      contents: { highlights: { query, maxCharacters: 900 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa search ${res.status}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? [])
    .filter((r) => r.title && r.url && String(r.url).startsWith('http'))
    .map((r) => ({
      title: String(r.title),
      url: String(r.url),
      site: hostOf(String(r.url)),
      desc: ((r.highlights ?? []).join(' ') || r.text || '').slice(0, 900),
    }));
}

async function exaReadFull(url: string, apiKey: string, chars: number): Promise<string> {
  const res = await exaFetch('https://api.exa.ai/contents', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [url], text: { maxCharacters: chars }, highlights: { query: 'key information', maxCharacters: chars } }),
  });
  if (!res.ok) throw new Error(`Exa contents ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ text?: string }> };
  const t = data.results?.[0]?.text ?? '';
  if (!t) throw new Error('no text returned');
  return t.slice(0, chars);
}

/* ── Agent LLM call (70b for judgment, 8b fallback on rate-limit/failure) ── */
async function askAgent(groq: Groq, system: string, user: string): Promise<any> {
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  let lastErr: any = null;
  for (const model of models) {
    try {
      const r = await groq.chat.completions.create({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: 0.25,
        max_tokens: 700,
      });
      const raw = (r.choices[0]?.message?.content ?? '{}')
        .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      return JSON.parse(raw);
    } catch (e: any) {
      lastErr = e;
      // Retry with smaller model on any failure (rate limits included)
    }
  }
  throw lastErr;
}

/* ── The agent loop ───────────────────────────────────────────────────── */
export async function runDeepResearch(opts: EngineOptions): Promise<ResearchReport> {
  const {
    query, exaKey, groqKey,
    maxFinal = 40,
    maxTotal = 180,
    contentChars = 6000,
    maxSearches = 22,
    maxReads = 28,
    maxIterations = 56,
    timeBudgetMs = 210_000,
    onStep = () => {},
  } = opts;

  console.log('[research-engine] Exa key:', exaKey ? 'present' : 'MISSING');
  console.log('[research-engine] Groq key:', groqKey ? 'present' : 'MISSING');

  const groq = new Groq({ apiKey: groqKey });
  const startTime = Date.now();

  // ── Agent state ──
  const ledger: ResearchSource[] = [];           // everything it has SEEN
  const seenUrls = new Set<string>();
  const agentNotes: string[] = [];               // its running conclusions
  let searches = 0, reads = 0, iterations = 0;
  let droppedDupes = 0, droppedJunk = 0, agentDrops = 0;
  let done = false, agentSummary = '';
  let envFeedback = '';                          // error feedback for next iteration

  const evidence = () => ledger.filter((s) => s.kept);

  // What the agent sees — compact so its context stays small.
  function ledgerView(): string {
    if (ledger.length === 0) return '(ledger is empty — you must SEARCH first)';
    return ledger
      .map((s, i) => {
        const flags = [s.kept ? 'KEPT' : null, s.read ? 'READ' : null].filter(Boolean).join(',');
        const body = s.desc.slice(0, s.read ? 350 : 140).replace(/\s+/g, ' ');
        return `#${i} ${s.kept ? '✅' : '·'} "${s.title}" — ${s.site} (trust ${s.credibility.toFixed(1)}/10)${flags ? ` [${flags}]` : ''}\n    ${body}`;
      })
      .join('\n');
  }

  const AGENT_SYSTEM = `You are ENZO's autonomous research agent — a ReAct-style loop driver with full control over the web.

YOU HAVE TOOLS (respond with EXACTLY ONE JSON action per turn):
{"think":"why", "action":"search", "query":"specific query"}                          — fan out, returns 8 candidates (title/site/snippet). Cost: 1 search.
{"think":"why", "action":"read", "indices":[1]}                                       — open source #1, pull FULL TEXT. Expensive — only read what looks decisive. Cost: 1 read.
{"think":"why", "action":"keep", "indices":[1], "note":"what it proves"}              — promote to evidence pool. Usually KEEP after READ (or if snippet is already conclusive).
{"think":"why", "action":"drop", "indices":[1], "note":"why rejected"}                — reject: off-topic, junk, marketing fluff, paywalled summary.
{"think":"why", "action":"note", "note":"finding/conclusion so far"}                  — write down what the evidence so far actually establishes.
{"think":"why", "action":"done", "summary":"what the evidence collectively answers"}  — you have enough; stop the loop.

JUDGMENT POLICY (this is where you act like Perplexity, not a crawler):
- NEVER keep sources you haven't judged. Read the snippet; when a claim matters, READ the full text before KEEP.
- Prefer: primary docs, official statistics, .gov/.edu, standards bodies, peer-reviewed/arxiv, reputable press. Drop or ignore: corporate boilerplate pages, listicles, SEO farms, social media, paywalled teasers, "contact/privacy/terms" shells.
- Chase angles: latest + foundational + quantitative data + opposing view + real cases. If the ledger is heavy on one angle, search for the missing one instead of more of the same.
- If a search returns weak results, reformulate — don't drop the topic.
- Track what you've established via NOTE actions so you don't re-search it.
- Watch your budgets. When evidence covers the question from enough independent angles — target 40–50 KEPT sources (at least ~15 of them READ in full) for a raw-news/research brief; for a narrower question 12–30 is fine. Don't waste budget re-confirming what you noted.

OUTPUT: a single JSON object only.`;

  function agentState(): string {
    const timeLeft = Math.max(0, timeBudgetMs - (Date.now() - startTime));
    return `QUESTION: "${query}"

BUDGETS REMAINING: searches ${maxSearches - searches}/${maxSearches} · reads ${maxReads - reads}/${maxReads} · iterations ${maxIterations - iterations}/${maxIterations} · time ${(timeLeft / 1000).toFixed(0)}s

EVIDENCE POOL: ${evidence().length} sources kept${evidence().length ? ` (of ${ledger.length} seen; ${agentDrops} dropped)` : ''}.
${agentNotes.length ? '\nYOUR NOTES:\n' + agentNotes.map((n, i) => `  ${i + 1}. ${n}`).join('\n') : ''}

LEDGER:
${ledgerView()}
${envFeedback ? `\nENV: ${envFeedback}` : ''}

Take your next action (one JSON object).`;
  }

  // ── Source ingestion (shared by search tool) ──
  function ingest(results: WebResult[], foundBy: string): number[] {
    const newIds: number[] = [];
    for (const r of results) {
      if (ledger.length >= maxTotal) break;
      if (seenUrls.has(r.url)) { droppedDupes++; continue; }
      if (/\/(privacy|cookie|terms|cart|checkout|subscribe)|x\.com\/(status)|pinterest\./i.test(r.url)) { droppedJunk++; continue; }
      seenUrls.add(r.url);
      const id = ledger.length;
      ledger.push({
        ...r,
        relevance: 0,
        credibility: credibilityScore(r.url, r.title),
        foundBy, pass: 'seed', kept: false, read: false,
      });
      newIds.push(id);
      onStep(`🔍 [${ledger.length}] ${r.title} — ${r.site}\n${r.url}`);
    }
    return newIds;
  }

  onStep('▸ Agent taking control — it will decide where to search, what to read, what to keep…');

  while (!done && iterations < maxIterations && (Date.now() - startTime) < timeBudgetMs) {
    iterations++;

    let decision: any;
    try {
      decision = await askAgent(groq, AGENT_SYSTEM, agentState());
    } catch (e: any) {
      onStep(`⚠️ Agent call failed (${String(e?.message).slice(0, 60)}) — ending loop with current evidence`);
      agentSummary = agentSummary || 'Agent LLM unavailable; evidence collected up to the failure point.';
      break;
    }
    envFeedback = '';

    const think = typeof decision?.think === 'string' ? decision.think.trim() : '';
    const action = String(decision?.action ?? '').toLowerCase();
    if (think) onStep(`🧠 ${think.slice(0, 220)}`);

    switch (action) {
      case 'search': {
        const q = String(decision?.query ?? '').trim();
        if (!q) { envFeedback = 'Your "search" action needs a non-empty "query".'; break; }
        if (searches >= maxSearches) { envFeedback = 'Search budget exhausted. Use read/keep/drop/note/done only.'; break; }
        searches++;
        onStep(`▸ Agent searching: "${q.slice(0, 110)}"`);
        try {
          // Preferred: Exa (neural). If it fails/keys are bad/missing, fall
          // back to the free DuckDuckGo→Bing scraper chain so research never
          // starves on Exa availability.
          let hits: WebResult[] = [];
          try {
            hits = await exaSearchPreview(q, exaKey, 10);
            if (hits.length === 0) throw new Error('empty Exa response');
          } catch (exaErr: any) {
            if (exaKey) console.warn('[research-engine] Exa search failed, falling back to scraper:', exaErr?.message);
            hits = await searchWebResults(q, 10);
          }
          const ids = ingest(hits, q);
          envFeedback = ids.length > 0
            ? `Search returned ${hits.length} results; added as ${ids.map((i) => '#' + i).join(', ')}.`
            : `Search returned ${hits.length} results, but all were duplicates/junk of what you already saw. Try a different angle.`;
        } catch (e: any) {
          console.error('[research-engine] search action error:', e?.message);
          envFeedback = `Search failed: ${String(e?.message).slice(0, 80)}. Reformulate the query.`;
        }
        break;
      }

      case 'read': {
        const ids: number[] = Array.isArray(decision?.indices) ? decision.indices : [];
        const valid = ids.filter((i) => Number.isInteger(i) && i >= 0 && i < ledger.length);
        if (valid.length === 0) { envFeedback = `Invalid indices. Ledger has ${ledger.length} entries (#0..#${ledger.length - 1}).`; break; }
        if (reads >= maxReads) { envFeedback = 'Read budget exhausted. Judge from snippets now.'; break; }
        for (const i of valid.slice(0, 3)) { // cap 3 opens per turn
          if (reads >= maxReads) break;
          const s = ledger[i];
          if (s.read) { envFeedback = `#${i} is already READ.`; continue; }
          reads++;
          onStep(`  📖 Agent opened #${i} for full text: ${s.site}`);
          try {
            console.log('[research-engine] Calling exaReadFull for URL:', s.url);
            const full = await exaReadFull(s.url, exaKey, contentChars);
            console.log('[research-engine] exaReadFull returned', full.length, 'chars');
            s.desc = full;
            s.read = true;
            if (s.pass === 'seed') s.pass = 'read';
            envFeedback = `#${i} opened — full text (${full.length} chars) is now in the ledger entry.`;
          } catch (e: any) {
            console.error('[research-engine] exaReadFull error:', e?.message);
            envFeedback = `Could not read #${i}: ${String(e?.message).slice(0, 60)}. Judge from its snippet.`;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        break;
      }

      case 'keep': {
        const ids: number[] = Array.isArray(decision?.indices) ? decision.indices : [];
        const valid = ids.filter((i) => Number.isInteger(i) && i >= 0 && i < ledger.length);
        if (valid.length === 0) { envFeedback = `Invalid indices for keep.`; break; }
        const note = typeof decision?.note === 'string' ? decision.note.slice(0, 200) : '';
        for (const i of valid) {
          const s = ledger[i];
          if (s.kept) continue;
          s.kept = true;
          s.relevance = typeof decision?.relevance === 'number' ? decision.relevance : (s.read ? 9 : 7);
          if (note) s.agentNote = note;
          onStep(`  ✅ KEPT #${i}${note ? ` — "…${note.slice(0, 120)}"` : ''}`);
        }
        envFeedback = `Evidence pool is now ${evidence().length}.`;
        break;
      }

      case 'drop': {
        const ids: number[] = Array.isArray(decision?.indices) ? decision.indices : [];
        const valid = ids.filter((i) => Number.isInteger(i) && i >= 0 && i < ledger.length && !ledger[i].kept);
        const note = typeof decision?.note === 'string' ? decision.note.slice(0, 120) : '';
        for (const i of valid) {
          agentDrops++;
          onStep(`  ✗ DROPPED #${i} (${ledger[i].site})${note ? ` — ${note}` : ''}`);
          // Keep in ledger as "judged-rejected": not kept, relevance pinned to 0
          ledger[i].relevance = 0;
        }
        envFeedback = valid.length ? `Dropped ${valid.length}.` : 'Nothing dropped (invalid or already kept indices).';
        break;
      }

      case 'note': {
        const n = typeof decision?.note === 'string' ? decision.note.trim().slice(0, 300) : '';
        if (!n) { envFeedback = 'Empty note.'; break; }
        agentNotes.push(n);
        onStep(`  📝 NOTE: ${n.slice(0, 160)}`);
        envFeedback = 'Noted.';
        break;
      }

      case 'done': {
        done = true;
        agentSummary = String(decision?.summary ?? '').slice(0, 600);
        onStep(`▸ Agent called DONE${agentSummary ? `: "${agentSummary.slice(0, 180)}"` : '.'}`);
        break;
      }

      default:
        envFeedback = `Unknown action "${action}". Use search/read/keep/drop/note/done.`;
    }

    // Anti-spin: if the agent kept nothing and the iteration cap is close, nudge it.
    if (!done && iterations === Math.floor(maxIterations * 0.6) && evidence().length === 0) {
      envFeedback = 'REMINDER: you have kept 0 sources and iterations are running out. KEEP the best of what you have, then DONE.';
    }
  }

  if (!done) {
    onStep(`▸ Budget exhausted (${iterations} iterations / ${((Date.now() - startTime) / 1000).toFixed(0)}s) — forcing synthesis from ${evidence().length} kept sources.`);
  }
  if (!agentSummary) agentSummary = 'Evidence-gathering completed within budget.';

  /* ── Curate final pool: kept first (read → unread), drop what agent didn't vouch for ── */
  let finalPool = evidence()
    .sort((a, b) => (Number(b.read) - Number(a.read)) || (b.credibility - a.credibility));

  // If the agent under-kept (spammy DONE), backfill from undropped unread-but-plausible
  if (finalPool.length < Math.min(8, maxFinal)) {
    const backfill = ledger
      .filter((s) => !s.kept && s.relevance !== 0 && s.credibility >= 6)
      .sort((a, b) => b.credibility - a.credibility)
      .slice(0, 12 - finalPool.length);
    for (const s of backfill) { s.kept = true; s.relevance = Math.max(s.relevance, 6); }
    finalPool = [...finalPool, ...backfill];
    if (backfill.length) onStep(`▸ Agent under-kept — backfilled ${backfill.length} high-trust sources for the report.`);
  }

  if (finalPool.length > maxFinal) finalPool = finalPool.slice(0, maxFinal);

  /* ── Thematic clustering of the evidence the agent vouched for ── */
  onStep(`▸ Clustering ${finalPool.length} agent-vetted sources into report sections…`);
  let clusters: ResearchReport['clusters'] = [];
  try {
    const cl = await askAgent(groq,
      `You are a research report planner. Cluster the vetted sources into 4–7 thematic sections for the final report. Each cluster: short label + source indices. Return ONLY JSON: {"clusters":[{"label":"...","sourceIndices":[1,3,5]}]}`,
      `Question: "${query}"\n\nVetted sources:\n${finalPool.map((s, i) => `[${i + 1}] ${s.title} (${s.site})${s.agentNote ? ` — kept because: ${s.agentNote}` : ''}`).join('\n')}`);
    if (Array.isArray(cl?.clusters)) {
      clusters = cl.clusters
        .filter((c: any) => typeof c?.label === 'string' && Array.isArray(c?.sourceIndices))
        .map((c: any) => ({ label: String(c.label), sourceIndices: c.sourceIndices.filter((n: any) => typeof n === 'number') }));
    }
  } catch { /* fallback below */ }
  if (clusters.length === 0) clusters = [{ label: 'Findings', sourceIndices: finalPool.map((_, i) => i + 1) }];

  // Cap the synthesis context so 40-50 sources don't blow the writer model's
  // window: spread a fixed budget across the pool (min 1200 chars each).
  const MAX_CONTEXT_CHARS = 120_000;
  const perSourceChars = Math.min(contentChars, Math.max(1200, Math.floor(MAX_CONTEXT_CHARS / finalPool.length)));

  const context = finalPool
    .map((s, i) =>
      `[${i + 1}] ${s.title}\n    Domain: ${s.site}  ·  Trust ${s.credibility.toFixed(1)}/10  ·  ${s.read ? 'FULL TEXT read by agent' : 'snippet-verified'}${s.agentNote ? `\n    Agent's note: ${s.agentNote}` : ''}\n    URL: ${s.url}\n    ${s.desc.slice(0, perSourceChars)}`
    )
    .join('\n\n' + '─'.repeat(60) + '\n\n');

  onStep(`✦ Agent finished: ${finalPool.length} kept (${finalPool.filter((s) => s.read).length} read in full) · ${searches} searches · ${reads} full-reads · ${iterations} decisions · ${((Date.now() - startTime) / 1000).toFixed(0)}s — writing report…`);

  return {
    clusters,
    sources: finalPool,
    context,
    stats: {
      totalPulled: ledger.length,
      totalKept: finalPool.length,
      droppedJunk,
      droppedDuplicates: droppedDupes,
      droppedIrrelevant: agentDrops,
      passBreakdown: {
        seed: finalPool.filter((s) => s.pass === 'seed').length,
        read: finalPool.filter((s) => s.pass === 'read').length,
        gap: 0,
      },
      searches,
      reads,
      iterations,
      agentNotes,
      agentSummary,
      wallTimeMs: Date.now() - startTime,
    },
  };
}
