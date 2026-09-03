/**
 * Live code-preview host.
 *
 * Coding-mode replies sometimes contain a complete HTML document (a website,
 * dashboard, or tool) inside a ```html fence. ENZO registers that document
 * here and exposes a stable URL the frontend renders in an iframe side panel
 * — and that the same URL can be opened in a brand-new tab for a full-screen
 * view.
 *
 * Everything is in-memory and short-lived (TTL), so nothing sensitive ever
 * touches disk. Docs are served raw so external dependencies (CDN links,
 * inline scripts, images) work exactly as the model wrote them.
 *
 * Access model: the preview id IS the capability. Ids are 128-bit random
 * values, returned only to the creator over their own connection; the store
 * lives in memory only and entries expire after an hour. Possession of the
 * URL is therefore the read grant — the same model as a blob: URL or an
 * unlisted gist. Classic IDOR (sequential or predictable ids exposing other
 * users' data) does not apply: there is nothing to enumerate and no id to
 * guess. This has to be a credential-free grant because both consumers of
 * the URL — a sandboxed iframe and a plain browser tab — cannot attach
 * request headers.
 *
 * Destructive access is stricter: when the creator supplied a vault token at
 * registration, deleting the preview requires that same token (deletePreview).
 */

import { randomBytes } from 'crypto';

interface PreviewEntry {
  html: string;
  title: string;
  createdAt: number;
  ownerToken?: string;
}

const store = new Map<string, PreviewEntry>();
const PREVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour
const PREVIEW_MAX = 300;

export interface RegisteredPreview {
  id: string;
  url: string;
  title: string;
}

/** Drop expired + overflow entries so the map never grows without bound. */
function sweep() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) store.delete(id);
  }
  if (store.size > PREVIEW_MAX) {
    const oldest = [...store.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .map(([id]) => id)
      .slice(0, store.size - PREVIEW_MAX);
    for (const id of oldest) store.delete(id);
  }
}

export function registerPreview(html: string, title?: string, ownerToken?: string): RegisteredPreview {
  sweep();
  const id = randomBytes(16).toString('hex');
  store.set(id, {
    html: normalizePreviewHtml(html),
    title: title ? String(title).slice(0, 80) : 'ENZO Preview',
    createdAt: Date.now(),
    ownerToken,
  });
  return { id, url: `/api/preview/${id}`, title: title ? String(title).slice(0, 80) : 'ENZO Preview' };
}

export function getPreview(id: string): { html: string; title: string } | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > PREVIEW_TTL_MS) {
    store.delete(id);
    return null;
  }
  return { html: entry.html, title: entry.title };
}

export type DeletePreviewResult = 'deleted' | 'gone' | 'forbidden';

/**
 * Delete a preview early (before its TTL). Idempotent: an unknown or already
 * expired id reports 'gone', so a repeated delete from the projects drawer is
 * still a success. If the creator registered with a vault token, only that
 * token may delete; ownerless previews (creator was incognito / held no
 * provider keys) fall back to the capability model — holding the id already
 * grants read, so it grants delete too, and the worst case is freeing an
 * hour-long in-memory entry early.
 */
export function deletePreview(id: string, vaultToken: string | undefined): DeletePreviewResult {
  const entry = store.get(id);
  if (!entry) return 'gone';
  if (entry.ownerToken && vaultToken !== entry.ownerToken) return 'forbidden';
  store.delete(id);
  return 'deleted';
}

/** Wrap fragments in a minimal document so they render as a real page. */
export function normalizePreviewHtml(html: string): string {
  const trimmed = String(html || '').trim();
  if (!trimmed) return trimmed;
  if (/<!doctype html/i.test(trimmed) || /<html[\s>]/i.test(trimmed) || /<body[\s>]/i.test(trimmed)) {
    return trimmed;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ENZO Preview</title>
</head>
<body>
${trimmed}
</body>
</html>`;
}