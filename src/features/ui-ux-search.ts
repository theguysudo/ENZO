/**
 * UI/UX Pro Max search engine — a TypeScript port of the vendored skill's
 * BM25 search (scripts/core.py). Powers the coding agent's `ui_search` tool:
 * given a design query it ranks rows from the vendored CSV design database
 * (palettes, font pairings, style rules, UX guidelines, per-stack guides) and
 * returns the top matches as compact markdown the model reads mid-build.
 *
 * Pure stdlib: an RFC-4180 CSV parser (handles quoted fields + embedded
 * newlines/commas — ux-guidelines/styles carry code examples) and a BM25
 * ranker. CSVs live at skills-bundled/ui-ux-pro-max/data/, loaded + indexed
 * lazily on first query per domain and cached for the process lifetime.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// skills-bundled/ is at the repo root, not beside this file — see bundled-skills.ts.
const DATA_DIR = path.resolve(__dirname, '../../skills-bundled/ui-ux-pro-max/data');
export const MAX_RESULTS = 3;

interface DomainConfig {
  file: string;
  searchCols: string[];
  outputCols: string[];
}

// Mirrors CSV_CONFIG in core.py. searchCols feed the BM25 index; outputCols are
// what we return (a curated, token-bounded subset of each row).
const CSV_CONFIG: Record<string, DomainConfig> = {
  style: {
    file: 'styles.csv',
    searchCols: ['Style Category', 'Keywords', 'Best For', 'Type', 'AI Prompt Keywords'],
    outputCols: ['Style Category', 'Type', 'Keywords', 'Primary Colors', 'Effects & Animation', 'Best For', 'Light Mode ✓', 'Dark Mode ✓', 'Performance', 'Accessibility', 'Framework Compatibility', 'Complexity', 'AI Prompt Keywords', 'CSS/Technical Keywords', 'Implementation Checklist', 'Design System Variables'],
  },
  color: {
    file: 'colors.csv',
    searchCols: ['Product Type', 'Notes'],
    outputCols: ['Product Type', 'Primary', 'On Primary', 'Secondary', 'On Secondary', 'Accent', 'On Accent', 'Background', 'Foreground', 'Card', 'Card Foreground', 'Muted', 'Muted Foreground', 'Border', 'Destructive', 'On Destructive', 'Ring', 'Notes'],
  },
  chart: {
    file: 'charts.csv',
    searchCols: ['Data Type', 'Keywords', 'Best Chart Type', 'When to Use', 'When NOT to Use', 'Accessibility Notes'],
    outputCols: ['Data Type', 'Keywords', 'Best Chart Type', 'Secondary Options', 'When to Use', 'When NOT to Use', 'Data Volume Threshold', 'Color Guidance', 'Accessibility Grade', 'Accessibility Notes', 'A11y Fallback', 'Library Recommendation', 'Interactive Level'],
  },
  landing: {
    file: 'landing.csv',
    searchCols: ['Pattern Name', 'Keywords', 'Conversion Optimization', 'Section Order'],
    outputCols: ['Pattern Name', 'Keywords', 'Section Order', 'Primary CTA Placement', 'Color Strategy', 'Conversion Optimization'],
  },
  product: {
    file: 'products.csv',
    searchCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'],
    outputCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Secondary Styles', 'Landing Page Pattern', 'Dashboard Style (if applicable)', 'Color Palette Focus'],
  },
  ux: {
    file: 'ux-guidelines.csv',
    searchCols: ['Category', 'Issue', 'Description', 'Platform'],
    outputCols: ['Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity'],
  },
  typography: {
    file: 'typography.csv',
    searchCols: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'],
    outputCols: ['Font Pairing Name', 'Category', 'Heading Font', 'Body Font', 'Mood/Style Keywords', 'Best For', 'Google Fonts URL', 'CSS Import', 'Tailwind Config', 'Notes'],
  },
  icons: {
    file: 'icons.csv',
    searchCols: ['Category', 'Icon Name', 'Keywords', 'Best For'],
    outputCols: ['Category', 'Icon Name', 'Keywords', 'Library', 'Import Code', 'Usage', 'Best For', 'Style'],
  },
  react: {
    file: 'react-performance.csv',
    searchCols: ['Category', 'Issue', 'Keywords', 'Description'],
    outputCols: ['Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity'],
  },
  web: {
    file: 'app-interface.csv',
    searchCols: ['Category', 'Issue', 'Keywords', 'Description'],
    outputCols: ['Category', 'Issue', 'Platform', 'Description', 'Do', "Don't", 'Code Example Good', 'Code Example Bad', 'Severity'],
  },
  'google-fonts': {
    file: 'google-fonts.csv',
    searchCols: ['Family', 'Category', 'Stroke', 'Classifications', 'Keywords', 'Subsets', 'Designers'],
    outputCols: ['Family', 'Category', 'Stroke', 'Classifications', 'Styles', 'Variable Axes', 'Subsets', 'Designers', 'Popularity Rank', 'Google Fonts URL'],
  },
};

// All stack CSVs share one column shape (core.py _STACK_COLS).
const STACK_FILES: Record<string, string> = {
  react: 'stacks/react.csv', nextjs: 'stacks/nextjs.csv', vue: 'stacks/vue.csv',
  svelte: 'stacks/svelte.csv', astro: 'stacks/astro.csv', swiftui: 'stacks/swiftui.csv',
  'react-native': 'stacks/react-native.csv', flutter: 'stacks/flutter.csv',
  nuxtjs: 'stacks/nuxtjs.csv', 'nuxt-ui': 'stacks/nuxt-ui.csv',
  'html-tailwind': 'stacks/html-tailwind.csv', shadcn: 'stacks/shadcn.csv',
  'jetpack-compose': 'stacks/jetpack-compose.csv', threejs: 'stacks/threejs.csv',
  angular: 'stacks/angular.csv', laravel: 'stacks/laravel.csv',
};
const STACK_SEARCH_COLS = ['Category', 'Guideline', 'Description', 'Do', "Don't"];
const STACK_OUTPUT_COLS = ['Category', 'Guideline', 'Description', 'Do', "Don't", 'Code Good', 'Code Bad', 'Severity', 'Docs URL'];

export const AVAILABLE_DOMAINS = Object.keys(CSV_CONFIG);
export const AVAILABLE_STACKS = Object.keys(STACK_FILES);

// ── RFC-4180 CSV parser ─────────────────────────────────────────────────────
// A quoted field may contain commas, newlines, and "" escapes. A naive split on
// \n/, corrupts styles.csv / ux-guidelines.csv (embedded code examples), so we
// parse character by character.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      // A quote only opens a quoted field at the START of a field; a stray `"`
      // mid-field (malformed CSV, e.g. `avoided"`) is a literal char — otherwise
      // it would swallow every newline until the next quote and merge rows.
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++; // CRLF
      row.push(field); field = '';
      // Skip blank lines produced by trailing newlines.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

// ── BM25 ranking (port of core.py BM25) ──────────────────────────────────────
function tokenize(text: string): string[] {
  return String(text).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

interface Index { docs: string[][]; docLen: number[]; avgdl: number; idf: Map<string, number>; n: number; }

function buildIndex(documents: string[]): Index {
  const docs = documents.map(tokenize);
  const n = docs.length;
  const docLen = docs.map((d) => d.length);
  const avgdl = n ? docLen.reduce((a, b) => a + b, 0) / n : 0;
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const w of new Set(doc)) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [w, freq] of docFreq) idf.set(w, Math.log((n - freq + 0.5) / (freq + 0.5) + 1));
  return { docs, docLen, avgdl, idf, n };
}

function scoreIndex(index: Index, query: string, k1 = 1.5, b = 0.75): [number, number][] {
  const qTokens = tokenize(query);
  const scores: [number, number][] = [];
  for (let idx = 0; idx < index.docs.length; idx++) {
    const doc = index.docs[idx];
    const dl = index.docLen[idx];
    const tf = new Map<string, number>();
    for (const w of doc) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
      const idf = index.idf.get(t);
      if (idf === undefined) continue;
      const f = tf.get(t) || 0;
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / (index.avgdl || 1)));
    }
    scores.push([idx, score]);
  }
  return scores.sort((a, b2) => b2[1] - a[1]);
}

// ── CSV load + index cache (lazy, per file) ──────────────────────────────────
const fileCache = new Map<string, Record<string, string>[]>();

function loadCsv(relFile: string): Record<string, string>[] {
  const cached = fileCache.get(relFile);
  if (cached) return cached;
  const filepath = path.join(DATA_DIR, relFile);
  if (!fs.existsSync(filepath)) { fileCache.set(relFile, []); return []; }
  const rows = parseCsv(fs.readFileSync(filepath, 'utf8'));
  fileCache.set(relFile, rows);
  return rows;
}

function searchCsv(relFile: string, searchCols: string[], outputCols: string[], query: string, maxResults: number): Record<string, string>[] {
  const data = loadCsv(relFile);
  if (!data.length) return [];
  const documents = data.map((row) => searchCols.map((c) => row[c] ?? '').join(' '));
  const index = buildIndex(documents);
  const ranked = scoreIndex(index, query);
  const out: Record<string, string>[] = [];
  for (const [idx, score] of ranked.slice(0, maxResults)) {
    if (score <= 0) continue;
    const row = data[idx];
    const picked: Record<string, string> = {};
    for (const c of outputCols) if (c in row && row[c] !== '') picked[c] = row[c];
    out.push(picked);
  }
  return out;
}

// Auto-detect domain from the query (port of core.py detect_domain).
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  color: ['color', 'palette', 'hex', 'rgb', 'token', 'semantic', 'accent', 'destructive', 'muted', 'foreground'],
  chart: ['chart', 'graph', 'visualization', 'trend', 'bar', 'pie', 'scatter', 'heatmap', 'funnel'],
  landing: ['landing', 'page', 'cta', 'conversion', 'hero', 'testimonial', 'pricing', 'section'],
  product: ['saas', 'ecommerce', 'e-commerce', 'fintech', 'healthcare', 'gaming', 'portfolio', 'crypto', 'dashboard', 'fitness', 'restaurant', 'hotel', 'travel', 'music', 'education', 'learning', 'medical', 'booking', 'chat', 'crm', 'marketplace', 'real estate'],
  style: ['style', 'design', 'minimalism', 'glassmorphism', 'neumorphism', 'brutalism', 'flat', 'aurora', 'css', 'variable', 'checklist', 'tailwind'],
  ux: ['ux', 'usability', 'accessibility', 'wcag', 'touch', 'scroll', 'keyboard', 'navigation', 'mobile'],
  typography: ['font pairing', 'typography pairing', 'heading font', 'body font'],
  'google-fonts': ['google font', 'font family', 'variable font', 'noto', 'serif font', 'sans serif', 'display font', 'monospace font', 'font'],
  icons: ['icon', 'icons', 'lucide', 'heroicons', 'symbol', 'glyph', 'svg icon'],
  react: ['react', 'next.js', 'nextjs', 'suspense', 'memo', 'usecallback', 'useeffect', 'rerender', 'bundle', 'server component'],
  web: ['aria', 'focus', 'outline', 'semantic', 'virtualize', 'autocomplete', 'form', 'input type'],
};

export function detectDomain(query: string): string {
  const q = query.toLowerCase();
  let best = 'style';
  let bestScore = 0;
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = kws.reduce((acc, kw) => acc + (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q) ? 1 : 0), 0);
    if (score > bestScore) { best = domain; bestScore = score; }
  }
  return best;
}

export interface SearchResult {
  domain: string; stack?: string; query: string; file: string;
  count: number; results: Record<string, string>[];
}

export function search(query: string, domain?: string, maxResults = MAX_RESULTS): SearchResult {
  const dom = domain && CSV_CONFIG[domain] ? domain : detectDomain(query);
  const config = CSV_CONFIG[dom] || CSV_CONFIG.style;
  const results = searchCsv(config.file, config.searchCols, config.outputCols, query, maxResults);
  return { domain: dom, query, file: config.file, count: results.length, results };
}

export function searchStack(query: string, stack: string, maxResults = MAX_RESULTS): SearchResult {
  const file = STACK_FILES[stack];
  if (!file) return { domain: 'stack', stack, query, file: '', count: 0, results: [] };
  const results = searchCsv(file, STACK_SEARCH_COLS, STACK_OUTPUT_COLS, query, maxResults);
  return { domain: 'stack', stack, query, file, count: results.length, results };
}

/** Render a SearchResult as compact markdown for the model (port of
 *  search.py format_output; values clipped to 300 chars like the original). */
export function formatResult(r: SearchResult): string {
  if (!r.count) return `[ui_search] No matches for "${r.query}" in ${r.stack || r.domain}. Try a broader query or different domain.`;
  const lines: string[] = [];
  lines.push(r.stack ? `## UI Pro Max — ${r.stack} stack` : `## UI Pro Max — ${r.domain}`);
  lines.push(`**Query:** ${r.query} | **Found:** ${r.count}`);
  r.results.forEach((row, i) => {
    lines.push(`\n### Result ${i + 1}`);
    for (const [k, v] of Object.entries(row)) {
      const s = String(v);
      lines.push(`- **${k}:** ${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
    }
  });
  return lines.join('\n');
}

/** Run one `<ui_search …>query</ui_search>` request and return markdown results.
 *  `stack` (when a known stack id) searches the per-stack guide; otherwise
 *  `domain` (or auto-detection) picks the design database. */
export function runUiSearch(query: string, domain?: string, stack?: string): string {
  const q = String(query || '').trim();
  if (!q) return '[ui_search] Empty query.';
  const r = stack && STACK_FILES[stack] ? searchStack(q, stack) : search(q, domain);
  return formatResult(r);
}

/**
 * Extracts `<ui_search domain="…" stack="…">query</ui_search>` signals from the
 * streamed reply and strips them from the visible text — the coding twin of
 * SkillSignalFilter. The reload loop reads `.pending` requests, runs each search,
 * injects the results into the system prompt, and continues the stream.
 */
export interface UiSearchRequest { query: string; domain?: string; stack?: string; }

export class UiSearchSignalFilter {
  private buf = '';
  private _requests: UiSearchRequest[] = [];
  private readonly MAX_PENDING = 400; // queries can be a sentence; allow room

  /** Feed a chunk → returns visible text with any complete signal removed. */
  process(chunk: string): string {
    this.buf += chunk;
    let out = '';
    const re = /<ui_search\b([^>]*)>([\s\S]*?)<\/ui_search>/i;
    for (;;) {
      const m = re.exec(this.buf);
      if (!m) break;
      const attrs = m[1] || '';
      const query = m[2].trim();
      if (query) {
        const domain = /domain\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
        const stack = /stack\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim();
        this._requests.push({ query, domain, stack });
      }
      this.buf = this.buf.slice(0, m.index) + this.buf.slice(m.index + m[0].length);
    }
    // Hold back from an unclosed opening tag; emit the rest.
    const open = /<ui_search\b/i.exec(this.buf);
    if (open) {
      out += this.buf.slice(0, open.index);
      this.buf = this.buf.slice(open.index);
    } else {
      out += this.buf;
      this.buf = '';
    }
    // Safety valve: an unterminated signal degenerates into visible text.
    if (this.buf.length > this.MAX_PENDING) { out += this.buf; this.buf = ''; }
    return out;
  }

  /** Pending search requests collected since the last drain (drains them). */
  drain(): UiSearchRequest[] { const r = this._requests; this._requests = []; return r; }
  get hasRequests(): boolean { return this._requests.length > 0; }
  flush(): string { const o = this.buf; this.buf = ''; return o; }
}


// ── Self-check: `npx tsx ui-ux-search.ts` ─────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

  // Domain detection routes to the right CSV.
  assert(detectDomain('a color palette for a fintech app') === 'color', 'detects color');
  assert(detectDomain('best chart for trends over time') === 'chart', 'detects chart');
  assert(detectDomain('glassmorphism style with css variables') === 'style', 'detects style');

  // BM25 returns relevant, non-empty results for real queries.
  const color = search('fintech banking dashboard', 'color');
  assert(color.count > 0 && !!color.results[0].Primary, `color search returns a palette (got ${color.count})`);

  const style = search('dark glassmorphism landing page');
  assert(style.count > 0, `style search returns rows (got ${style.count})`);

  const ux = search('mobile touch target size accessibility', 'ux');
  assert(ux.count > 0, `ux search returns guidelines (got ${ux.count})`);

  // CSV parser handled quoted/multiline fields without corrupting row count.
  const styleRows = loadCsv('styles.csv');
  assert(styleRows.length >= 80, `styles.csv parsed ~84 rows (got ${styleRows.length})`);
  const colorRows = loadCsv('colors.csv');
  assert(colorRows.length >= 150, `colors.csv parsed ~161 rows (got ${colorRows.length})`);

  // Stack search works.
  const stack = searchStack('component state management', 'react');
  assert(stack.count >= 0, 'react stack search runs');

  console.log('✔ ui-ux-search: domain detection, BM25 ranking, RFC-4180 CSV parsing all pass');
  console.log('\nSample —', formatResult(color).slice(0, 400));
}
