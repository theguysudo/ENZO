/**
 * fetcher.ts — the SSRF-guarded page fetcher for investigations.
 *
 * An investigation fetches URLs it DISCOVERED on the public web, which makes
 * every fetch a potential SSRF vector: a hostile page can plant
 * "https://internal-service.local/admin" or a cloud-metadata link and wait for
 * the crawler to walk into it. The guard here is the strictest in the repo
 * (gather.ts guards user URLs; this one guards attacker-chosen URLs):
 *
 *  - http/https only, no credentials in the URL, default ports only
 *  - hostname must not be a private/reserved literal AND must resolve to a
 *    public address — re-checked on EVERY redirect hop
 *  - manual redirects (max 4), each hop re-validated
 *  - 15s hard timeout, 400KB read cap, html/text/json content types only
 *
 * Residual risk: a DNS-rebinding TOCTOU window exists between dns.lookup and
 * fetch's own resolution (documented, standard for this class of guard).
 * Fetched content is treated as untrusted data everywhere downstream.
 */
import dns from 'dns';
import { promisify } from 'util';
import crypto from 'crypto';

const dnsLookup = promisify(dns.lookup);

const MAX_BYTES = 400 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_SOURCE_CHARS = 24_000;

const PRIVATE_HOSTNAME = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const PRIVATE_IPV6 = /^(::1|f[cd][0-9a-f]{2}:|fe80:)/i;
const PRIVATE_HOST_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

export interface GuardedFetch {
  ok: boolean;
  url: string;          // final URL after redirects
  status: number;
  title: string;
  text: string;         // readable text (html stripped), capped
  html: string;         // raw body (capped) — for link extraction
  links: string[];      // absolute http(s) links found in the page
  contentHash: string;  // sha256 of the normalized text
  contentType: string;
  error?: string;
}

/** Public-url assertion. Exported for tests. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) URLs are fetched');
  if (u.username || u.password) throw new Error('URL credentials rejected');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('non-default port rejected');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) && !host.startsWith('[')) throw new Error('malformed hostname rejected');
  if (PRIVATE_HOST_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('private host rejected');
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTNAME.test(bare) || PRIVATE_IPV6.test(bare)) throw new Error('private IP rejected');
  const addrs = await dnsLookup(bare, { all: true }).catch(() => [] as dns.LookupAddress[]);
  if (!addrs.length) throw new Error('host does not resolve');
  for (const a of addrs) {
    if (PRIVATE_HOSTNAME.test(a.address) || PRIVATE_IPV6.test(a.address)) {
      throw new Error('host resolves to a private address');
    }
  }
  return u;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 300) : '';
}

/** Absolute http(s) links in a page, same page only, junk-filtered upstream. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*["']([^"'#\s]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 40) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
      out.push(abs.toString());
    } catch { /* skip */ }
  }
  return out;
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

/** The one fetch primitive investigations use. Never throws — the caller gets
 *  ok:false + a short error instead (a failed source is a finding, not a bug). */
export async function guardedFetch(raw: string): Promise<GuardedFetch> {
  let current = raw;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = await assertPublicUrl(current);
      const res = await fetch(u, {
        headers: {
          'User-Agent': 'ENZO-Intelligence/1.0 (+public-source research; contact the site operator via the repo)',
          Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, u).toString();
        continue;
      }
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        return fail(raw, res.status, `HTTP ${res.status}`, contentType);
      }
      if (!/text\/html|text\/plain|application\/json|text\/markdown|xml/i.test(contentType) && contentType) {
        return fail(raw, res.status, `unsupported content-type: ${contentType.slice(0, 60)}`, contentType);
      }
      const buf = await res.arrayBuffer();
      const capped = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
      const body = new TextDecoder('utf-8', { fatal: false }).decode(capped);
      const isHtml = contentType.includes('html') || (!contentType && /^\s*<(!doctype|html)/i.test(body));
      const text = isHtml ? stripHtml(body) : body;
      return {
        ok: true,
        url: u.toString(),
        status: res.status,
        title: isHtml ? extractTitle(body) : '',
        text: text.slice(0, MAX_SOURCE_CHARS),
        html: isHtml ? body.slice(0, MAX_BYTES) : '',
        links: isHtml ? extractLinks(body, u.toString()) : [],
        contentHash: hashText(text),
        contentType,
      };
    }
    return fail(raw, 0, 'too many redirects');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    return fail(raw, 0, msg.includes('TimeoutError') || msg.includes('timeout') ? 'fetch timed out' : msg.slice(0, 160));
  }
}

function fail(url: string, status: number, error: string, contentType = ''): GuardedFetch {
  return { ok: false, url, status, title: '', text: '', html: '', links: [], contentHash: '', contentType, error };
}

/** URL junk filter shared by search results and crawled links. */
export function isJunkUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true;
  if (/\/(privacy|cookie|terms|cart|checkout|subscribe|signin|signup|login|register)(\/|$|\?)/i.test(url)) return true;
  if (/x\.com\/(status)|pinterest\.|tiktok\.|instagram\.|facebook\.com\/(sharer|dialog)|linkedin\.com\/(share|uas)/i.test(url)) return true;
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|zip|gz|tar|dmg|exe|mp4|mp3|pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(url)) return true;
  return false;
}
