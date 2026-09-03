/**
 * search.ts — web search for the agent, with a keyless path that always works.
 *
 * Owns: `searchWeb` (formatted text for a prompt), `searchWebResults` (structured
 * `WebResult[]` for the UI), `shouldAutoSearch` (does this message need the web?).
 * Called by: index.ts (the chat routes), agent-tools.ts (the `web_search` tool),
 * research-engine.ts (deep research), model-info.ts (per-model facts).
 *
 * FOUR BACKENDS, TRIED IN ORDER, because the point is that search never hard-fails:
 * Exa (best results, needs a key) → DuckDuckGo HTML (keyless) → Bing RSS (keyless)
 * → Groq compound-mini (an LLM with its own browsing). Each is wrapped in its own
 * try/catch and falls through on empty as well as on throw, so one dead endpoint
 * degrades quality instead of breaking the feature.
 *
 * `shouldAutoSearch` is a keyword + temporal heuristic, not a classifier. It
 * deliberately ignores identity questions ("who are you") so the agent does not
 * search the web to describe itself.
 *
 * ponytail: HTML scraping (DuckDuckGo) breaks when their markup changes — that is
 * why it is third in line rather than first, and why the keyed path exists. If it
 * starts returning empty, check the `result__a` / `result__snippet` selectors.
 */
import Groq from 'groq-sdk';

export type WebResult = { title: string; url: string; site: string; desc: string };

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCorporateFooterJunk(title: string, url: string, desc: string, query: string): boolean {
  const t = title.toLowerCase();
  const u = url.toLowerCase();
  const d = desc.toLowerCase();
  const q = query.toLowerCase();

  if (q.includes('duckduckgo') || q.includes('bing') || q.includes('microsoft')) {
    return false;
  }

  const junkPatterns = [
    'duckduckgo privacy',
    'duckduckgo help',
    'about duckduckgo',
    'microsoft services agreement',
    'microsoft privacy statement',
    'bing terms of use',
    'cookies on bing',
    'duckduckgo is an independent',
    'privacy policy - duckduckgo',
    'duckduckgo feedback',
  ];

  for (const pattern of junkPatterns) {
    if (t.includes(pattern) || d.includes(pattern)) {
      return true;
    }
  }

  if (
    u.includes('duckduckgo.com/about') ||
    u.includes('duckduckgo.com/privacy') ||
    u.includes('duckduckgo.com/help') ||
    u.includes('microsoft.com/privacy') ||
    u.includes('bing.com/help')
  ) {
    return true;
  }

  return false;
}

function isResultRelevant(title: string, desc: string, query: string): boolean {
  const cleanTitle = title.toLowerCase();
  const cleanDesc = desc.toLowerCase();
  const cleanQuery = query.toLowerCase();

  const stopwords = new Set([
    'latest', 'news', 'recent', 'updates', 'today', 'find', 'research', 'search',
    'what', 'when', 'where', 'who', 'how', 'why', 'about', 'world', 'with', 'from',
    'give', 'speech', 'article', 'write', 'topic'
  ]);
  const keywords = cleanQuery
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !stopwords.has(w));

  if (keywords.length === 0) return true;

  let matchCount = 0;
  for (const kw of keywords) {
    if (cleanTitle.includes(kw) || cleanDesc.includes(kw)) {
      matchCount++;
    }
  }

  const threshold = Math.max(1, Math.floor(keywords.length * 0.2));
  return matchCount >= threshold;
}

export function shouldAutoSearch(message: string) {
  const t = message.trim();
  if (t.length < 4) return false;

  // Ignore self-referential / system identity queries
  if (/\b(which model|what model|who are you|what is your name|who made you|what model are you|what model is this|how do you work|what engine)\b/i.test(t)) {
    return false;
  }

  // Explicit web search keywords or current temporal queries
  return (
    /\b(latest|today|current news|weather|stock price|live score|who won|when did|search for|look up|google|search the web|internet|recent news|update on)\b/i.test(t) ||
    /\b(2025|2026)\b/.test(t)
  );
}

function todayDateString() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Clean search result text by removing markdown table syntax, HTML entities,
 * and other formatting artifacts that shouldn't appear in the final display.
 */
function cleanSearchText(text: string): string {
  if (!text) return '';
  
  let cleaned = text;
  
  // Remove markdown table syntax: |---|, | :--- |, | --- |, etc.
  cleaned = cleaned.replace(/\|[\s\-:|]+\|/g, '');
  
  // Remove markdown table row separators: | ... | ... |
  cleaned = cleaned.replace(/^\s*\|.*\|\s*$/gm, '');
  
  // Remove markdown table header separators
  cleaned = cleaned.replace(/\|[-:|]+\|/g, '');
  
  // Remove leading/trailing pipes from lines
  cleaned = cleaned.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  
  // Remove HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&bull;/g, '•');
  
  // Remove markdown table rows that are just separators
  cleaned = cleaned.replace(/^\s*\|[\s\-:|]*\|\s*$/gm, '');
  
  // Clean up multiple consecutive newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

async function searchBingRss(query: string, limit: number): Promise<string> {
  // Append today's date so Bing surfaces current-day results
  const dateTag = todayDateString();
  const fullQuery = /today|latest|news|current|now/i.test(query)
    ? `${query} ${dateTag}`
    : query;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(fullQuery)}&format=rss&freshness=Day`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!res.ok) throw new Error(`Bing RSS ${res.status}`);
  const xml = await res.text();

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const results: string[] = [];

  for (const [, block] of items) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    if (!titleMatch || !linkMatch) continue;

    const rawUrl = decodeHtml(linkMatch[1]);
    if (!rawUrl.startsWith('http')) continue;

    const title = decodeHtml(titleMatch[1]);
    const desc = descMatch ? decodeHtml(descMatch[1]).slice(0, 600) : '';

    results.push(`- ${title}\n  ${desc}\n  Source: ${rawUrl}`);
    if (results.length >= limit) break;
  }
  return cleanSearchText(results.join('\n\n'));
}

async function searchViaGroq(query: string, groqApiKey: string): Promise<string> {
  const groq = new Groq({ apiKey: groqApiKey });
  const completion = await groq.chat.completions.create({
    model: 'compound-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are a web search assistant. Search the web for the user query and return ONLY a ' +
          'detailed bullet list of results. Format each as:\n' +
          '- [title or key fact]\n  [detailed snippet — at least 2-3 sentences with specific facts, dates, numbers]\n  Source: [URL if available]\n\n' +
          'No preamble, no commentary — just the search results list. Prioritize depth over brevity.',
      },
      { role: 'user', content: `Search the web for: ${query}` },
    ],
    max_tokens: 1800,
  });
  return cleanSearchText(completion.choices[0]?.message?.content?.trim() || '');
}

// DuckDuckGo HTML endpoint — keyless, no rate-limit key needed. Primary free
// fallback so search works even with no Exa/Groq credentials.
async function searchDuckDuckGo(query: string, limit: number): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();

  // Each result: <a class="result__a" href="URL">TITLE</a> ... <a class="result__snippet">SNIPPET</a>
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [...html.matchAll(titleRe)];
  const snippets = [...html.matchAll(snippetRe)];

  const results: string[] = [];
  for (let i = 0; i < titles.length && results.length < limit; i++) {
    let href = decodeHtml(titles[i][1]);
    // DDG wraps links as /l/?uddg=<encoded-real-url> — unwrap it
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (!href.startsWith('http')) continue;
    const title = decodeHtml(titles[i][2]);
    const desc = snippets[i] ? decodeHtml(snippets[i][1]).slice(0, 600) : '';
    results.push(`- ${title}\n  ${desc}\n  Source: ${href}`);
  }
  return cleanSearchText(results.join('\n\n'));
}

async function searchExa(query: string, apiKey: string, limit: number): Promise<string> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query, numResults: limit, type: 'auto',
      contents: { highlights: { query, maxCharacters: 1000 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string }> };
  const lines: string[] = [];
  for (const r of data.results ?? []) {
    if (!r.title || !r.url) continue;
    const snippet = r.highlights?.join(' ') || (r.text ?? '');
    lines.push(`- ${r.title}\n  ${snippet.slice(0, 1000)}\n  Source: ${r.url}`);
  }
  return cleanSearchText(lines.join('\n\n'));
}

export async function searchWeb(query: string, limit = 8, groqApiKey?: string, exaApiKey?: string): Promise<string> {
  // Exa: highest quality neural search — primary when key is available
  if (exaApiKey) {
    try {
      const results = await searchExa(query, exaApiKey, limit);
      if (results) return cleanSearchText(results);
    } catch (err: any) {
      console.error('[search] Exa search failed:', err.message);
      console.log(`-> Exa search failed (${err.message}); trying Bing RSS`);
    }
  }

  // DuckDuckGo HTML: keyless free search, ranks specific pages well — primary fallback
  try {
    const results = await searchDuckDuckGo(query, limit);
    if (results) return cleanSearchText(results);
  } catch (err: any) {
    console.log(`-> DuckDuckGo failed (${err.message}); trying Bing RSS`);
  }

  // Bing RSS: free, unlimited — secondary fallback
  try {
    const results = await searchBingRss(query, limit);
    if (results) return cleanSearchText(results);
  } catch (err: any) {
    console.log(`-> Bing RSS failed (${err.message}); falling back to compound-mini`);
  }

  // Last resort: Groq compound-mini with built-in internet access
  if (!groqApiKey) return '';
  try {
    const results = await searchViaGroq(query, groqApiKey);
    return cleanSearchText(results);
  } catch (err: any) {
    console.error('-> Groq search fallback failed:', err.message);
    return '';
  }
}

// Returns structured WebResult[] — used by the Express /api/web-search handler
async function searchExaResults(query: string, apiKey: string, limit: number): Promise<WebResult[]> {
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query, numResults: limit, type: 'auto',
      contents: { highlights: { query, maxCharacters: 450 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string }> };
  return (data.results ?? [])
    .filter((r) => r.title && r.url && r.url.startsWith('http'))
    .map((r) => {
      let site = r.url!;
      try { site = new URL(r.url!).hostname.replace(/^www\./, ''); } catch { /* keep */ }
      const desc = r.highlights?.join(' ') || (r.text ?? '');
      return { title: r.title!, url: r.url!, site, desc: desc.slice(0, 450) };
    });
}

async function searchBingRssResults(query: string, limit: number): Promise<WebResult[]> {
  const dateTag = todayDateString();
  const fullQuery = /today|latest|news|current|now/i.test(query) ? `${query} ${dateTag}` : query;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(fullQuery)}&format=rss&freshness=Day`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    },
  });
  if (!res.ok) throw new Error(`Bing RSS ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const results: WebResult[] = [];
  for (const [, block] of items) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);
    if (!titleMatch || !linkMatch) continue;
    const rawUrl = decodeHtml(linkMatch[1]);
    if (!rawUrl.startsWith('http')) continue;
    let site = rawUrl;
    try { site = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    const title = decodeHtml(titleMatch[1]);
    const desc = descMatch ? decodeHtml(descMatch[1]).slice(0, 400) : '';
    if (isCorporateFooterJunk(title, rawUrl, desc, query)) continue;
    if (!isResultRelevant(title, desc, query)) continue;

    results.push({ title, url: rawUrl, site, desc });
    if (results.length >= limit) break;
  }
  return results;
}

export async function searchWebResults(query: string, limit = 6, exaApiKey?: string): Promise<WebResult[]> {
  if (exaApiKey) {
    try {
      const results = await searchExaResults(query, exaApiKey, limit);
      if (results.length > 0) return results;
    } catch (err: any) {
      console.error('[search] Exa search results failed:', err.message);
      console.log(`-> Exa search failed (${err.message}); trying DuckDuckGo`);
    }
  }
  // DuckDuckGo: keyless, ranks specific pages well — primary fallback when no Exa
  try {
    const results = await searchDuckDuckGoResults(query, limit);
    if (results.length > 0) return results;
  } catch (err: any) {
    console.log(`-> DuckDuckGo failed (${err.message}); trying Bing RSS`);
  }
  try {
    return await searchBingRssResults(query, limit);
  } catch (err: any) {
    console.log(`-> Bing RSS failed (${err.message})`);
  }
  return [];
}

// Structured DuckDuckGo results (keyless) for the WebResult[] pipeline.
async function searchDuckDuckGoResults(query: string, limit: number): Promise<WebResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const results: WebResult[] = [];
  for (let i = 0; i < titles.length && results.length < limit; i++) {
    let href = decodeHtml(titles[i][1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (!href.startsWith('http')) continue;
    let site = href;
    try { site = new URL(href).hostname.replace(/^www\./, ''); } catch { /* keep */ }
    const title = decodeHtml(titles[i][2]);
    const desc = snippets[i] ? decodeHtml(snippets[i][1]).slice(0, 450) : '';
    if (isCorporateFooterJunk(title, href, desc, query)) continue;
    if (!isResultRelevant(title, desc, query)) continue;

    results.push({ title, url: href, site, desc });
  }
  return results;
}
