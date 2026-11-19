/**
 * attribution.ts — app attribution headers for ALL outbound provider API calls.
 *
 * OpenRouter (and similar aggregators) rank/list apps by these headers, and it
 * is the passive-credit/visibility mechanism for ENZO: every call we make to
 * any provider (OpenRouter, Groq, NVIDIA, HF, Google, Exa, LLM7, Puter,
 * Cloudflare, Pollinations) carries the same identity. 'HTTP-Referer' is used
 * instead of 'Referer' because the bare header is forbidden in browsers — the
 * HTTP- prefixed custom header is what OpenRouter actually reads and is safe
 * to send from both server and browser code.
 */
export const APP_REFERER = 'https://github.com/theguysudo/ENZO'
export const APP_TITLE = 'ENZO'

/** Spread into any fetch headers object: `{ ...attributionHeaders(), ... }`. */
export function attributionHeaders(): Record<string, string> {
  return { 'HTTP-Referer': APP_REFERER, 'X-Title': APP_TITLE }
}
