/**
 * Multi-file project host for coding mode.
 *
 * Coding replies are no longer limited to a single HTML page — ENZO can emit a
 * real project structure (index.html + css/styles.css + js/app.js + assets/…)
 * using ```file:path fences. This module writes those files to a local folder
 * (`generated-projects/<id>/`), serves them back under a stable URL the in-app
 * iframe renders, and exposes a manifest so the frontend can show a file tree.
 *
 * Files are stored on disk so they survive restarts and can be inspected by the
 * user; the same URL opens full-screen in a new tab.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  findBackendEntry,
  getRuntimeStatus,
  proxyRuntimeRequest,
  isBackendEntryRel,
  sanitizeServerForExpress5,
  stopRuntime,
} from '../projects/project-runtime.js';

const PROJECTS_DIR = path.join(process.cwd(), 'generated-projects');
const MAX_FILES = 60;
const MAX_FILE_BYTES = 3_000_000;

// File locking mechanism to prevent race conditions
const locks = new Map<string, Promise<void>>();

async function acquireLock(key: string): Promise<void> {
  while (locks.has(key)) {
    await locks.get(key);
  }
  let resolve: () => void;
  const promise = new Promise<void>((resolveFn) => {
    resolve = resolveFn;
  });
  locks.set(key, promise);
  return;
}

function releaseLock(key: string): void {
  locks.delete(key);
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  await acquireLock(key);
  try {
    return await fn();
  } finally {
    releaseLock(key);
  }
}

/**
 * Frontend entry candidates, most-preferred first. Models raised on the
 * Express+static convention often put the frontend in public/ even when told
 * otherwise — the host must still preview those projects.
 */
const INDEX_ENTRY_CANDIDATES = [
  'index.html',
  'public/index.html',
  'frontend/index.html',
  'client/index.html',
  'dist/index.html',
  'www/index.html',
  'app/index.html',
  'src/index.html',
];

function ensureRoot() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

/** Sanitize an id to [a-z0-9_-] and resolve a relative path inside it. */
function safeTarget(projectId: string, relPath: string): string | null {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || id.length > 64) return null;
  const base = path.join(PROJECTS_DIR, id);
  const target = path.resolve(base, relPath || '');
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function listFiles(projectId: string): { path: string; size: number }[] {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return [];
  const base = path.join(PROJECTS_DIR, id);
  if (!fs.existsSync(base)) return [];
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push({ path: `${prefix}${entry.name}`, size: fs.statSync(full).size });
    }
  };
  walk(base, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** True for runtime artifacts the model never authored and should never be
 *  re-emitted as project source: anything under a `data/` directory (the
 *  documented convention for generated-backend SQLite DBs) plus raw database /
 *  WAL / journal files anywhere. */
function isRuntimeArtifact(relPath: string): boolean {
  const segs = relPath.split('/');
  if (segs.some((s) => s === 'data')) return true;
  return /(\.db|\.sqlite|\.sqlite3|\.db-wal|-wal|-shm|\.journal)$/.test(relPath.toLowerCase());
}

/** Read a saved project's files from disk (used to hand "continue"-intent coding
 *  requests the AUTHORITATIVE current project state so the model extends the
 *  real files instead of restarting from scratch). Bounded to the same caps as
 *  saveProject (MAX_FILES / MAX_FILE_BYTES); oversized files are marked. Runtime
 *  artifacts (the `data/` DB directory, *.db / -wal / -shm) are excluded. */
export function readProjectFiles(projectId: string): { path: string; content: string }[] {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || id.length > 64) return [];
  const base = path.join(PROJECTS_DIR, id);
  if (!fs.existsSync(base)) return [];
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else {
        const rel = `${prefix}${entry.name}`;
        if (isRuntimeArtifact(rel)) continue;
        let content = '';
        try {
          const st = fs.statSync(full);
          content =
            st.size > MAX_FILE_BYTES
              ? `[ENZO: skipped — ${entry.name} exceeds the ${MAX_FILE_BYTES}-byte cap]`
              : fs.readFileSync(full, 'utf8');
        } catch {
          content = '[ENZO: unreadable file]';
        }
        out.push({ path: rel, content });
      }
    }
  };
  walk(base, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface SavedProject {
  id: string;
  title: string;
  url: string;
  files: { path: string; size: number }[];
  backend?: { entry: string; base: string };
  ownerToken?: string; // Vault session token of the project owner
}

/** Persist a { path: content } file map to disk and return the project handle.
 *
 * With `id` provided this is an UPSERT into the SAME project container (a
 * per-task workspace): emitted files replace their older copies
 * and everything else on disk is left untouched. We deliberately MERGE rather
 * than prune, because a "continue" turn re-emits ONLY the files it changed
 * (that is what the model is instructed to do) — pruning here would delete
 * the rest of the project and make the project vanish on the next turn.
 * ponytail: merge-only; if a full rebuild ever needs to delete dropped files,
 * add an explicit `fullSnapshot` flag on the caller and prune only then.
 */
export async function saveProject(files: Record<string, string>, title?: string, id?: string, ownerToken?: string): Promise<SavedProject> {
  // Use lock to prevent race conditions during project creation/upsert
  const lockKey = id ? `project:${id}` : 'project:create';
  return await withLock(lockKey, async () => {
    ensureRoot();
    const reuse = id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) && projectExists(id) ? id : null;
    const projectId = reuse || crypto.randomBytes(6).toString('hex');
    const base = path.join(PROJECTS_DIR, projectId);
    fs.mkdirSync(base, { recursive: true });

  const entries = Object.entries(files || {});
  let indexHtml = '';
  for (const [relPath, content] of entries) {
    const rel = String(relPath).replace(/^\/+/, '').replace(/\\/g, '/');
    if (!rel || rel.includes('..')) continue;
    const target = safeTarget(projectId, rel);
    if (!target) continue;
    if (rel === 'index.html' || rel.endsWith('/index.html')) indexHtml = rel;
    const bytes = Buffer.byteLength(String(content ?? ''), 'utf8');
    if (bytes > MAX_FILE_BYTES) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Backend entries are healed to Express 5 route syntax as they are written,
    // so projects work on first boot no matter which idiom the model used.
    let out = String(content ?? '');
    if (rel.endsWith('.js') && isBackendEntryRel(rel)) out = sanitizeServerForExpress5(out);
    fs.writeFileSync(target, out, 'utf8');
  }

  // Note: files present on disk but absent from this snapshot are intentionally
  // kept (merge-only upsert — see the doc comment). "continue" turns re-emit
  // only changed files, so pruning here would delete the rest of the project.

  // Guarantee an entry point so the project always renders — but only when the
  // container has none. A partial "continue" snapshot that re-emits just a JS
  // file must NOT clobber an index.html already on disk with an empty page.
  if (!indexHtml && !findIndexEntry(projectId)) {
    const target = safeTarget(projectId, 'index.html')!;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      '<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh">ENZO project</body></html>',
      'utf8',
    );
  }

  const backendEntry = findBackendEntry(projectId);
  const result: SavedProject = {
    id: projectId,
    title: title ? String(title).slice(0, 80) : 'ENZO Project',
    url: `/api/project/${projectId}/`,
    files: listFiles(projectId),
    ownerToken
  };
  if (backendEntry) {
    result.backend = { entry: backendEntry, base: `/api/project/${projectId}/backend` };
  }
  // Write manifest.json with ownerToken
  const manifestPath = path.join(base, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ownerToken, title: result.title, id: projectId }, null, 2));
  return result;
  });
}
function findIndexEntry(projectId: string): string | null {
  for (const rel of INDEX_ENTRY_CANDIDATES) {
    const target = safeTarget(projectId, rel);
    if (target && fs.existsSync(target) && fs.statSync(target).isFile()) return rel;
  }
  return null;
}

export function readProjectFile(projectId: string, relPath: string): string | null {
  const target = safeTarget(projectId, relPath);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return fs.readFileSync(target, 'utf8');
}

export function projectExists(projectId: string): boolean {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return !!id && fs.existsSync(path.join(PROJECTS_DIR, id));
}

/** Read project metadata including ownerToken from manifest.json */
export function readProjectMeta(projectId: string): { ownerToken?: string } | null {
  const id = String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id) return null;
  const manifestPath = path.join(PROJECTS_DIR, id, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { ownerToken: manifest.ownerToken };
  } catch {
    return null;
  }
}

/** Check if the request's vault token matches the project's owner token */
export function checkProjectOwnership(projectId: string, vaultToken: string | undefined): boolean {
  if (!vaultToken) return false;
  const meta = readProjectMeta(projectId);
  if (!meta?.ownerToken) return false; // Project has no owner token (legacy)
  return vaultToken === meta.ownerToken;
}

/** Middleware to enforce project ownership */
export function requireProjectOwnership(req: any, res: any, next: any) {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !projectExists(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const vaultToken = (req.headers['x-vault-token'] ?? '').toString().trim() || undefined;
  if (!checkProjectOwnership(id, vaultToken)) {
    res.status(403).json({ error: 'forbidden', message: 'You do not have access to this project' });
    return;
  }
  next();
}

/**
 * Inject a tiny bootstrap script into served index.html so the generated
 * frontend knows where to reach its backend. The same URL opens full-screen in
 * a new tab, so the base is always derivable from the request path; we also
 * expose it as a window global for convenience.
 */
function injectBackendBootstrap(projectId: string, html: string, hasBackend: boolean): string {
  if (!hasBackend) return html;
  const base = `/api/project/${projectId}/backend`;
  const script =
    `<!-- enzo:backend --><script>window.ENZO_BACKEND=${JSON.stringify(base)};</script>`;
  // Append after the opening <head> if present, else prepend.
  const headEnd = html.search(/<head[^>]*>/i);
  if (headEnd !== -1) {
    const afterTag = html.indexOf('>', headEnd) + 1;
    if (afterTag !== 0) {
      const origPrefix = html.slice(0, afterTag);
      return origPrefix + script + html.slice(afterTag);
    }
  }
  return script + html;
}

/** Best-effort Content-Type for common extensions. */
function contentTypeFor(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.md': return 'text/markdown; charset=utf-8';
    default: return 'text/plain; charset=utf-8';
  }
}

export const projectRouter = Router();

// Save a project: { files: { "path/name.ext": "content" }, title?, id? }.
// Passing `id` upserts into that same container (streaming re-registrations
// and "continue" turns keep ONE stable project instead of spawning clones).
projectRouter.post('/api/project/save', async (req: any, res: any) => {
  const files = req.body?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    res.status(400).json({ error: 'bad_request', message: 'Missing files object' });
    return;
  }
  const fileEntries = Object.entries(files).filter(
    ([, content]) => typeof content === 'string',
  ) as [string, string][];
  if (fileEntries.length === 0) {
    res.status(400).json({ error: 'bad_request', message: 'No file contents provided' });
    return;
  }
  if (fileEntries.length > MAX_FILES) {
    res.status(413).json({ error: 'too_large', message: `Project exceeds ${MAX_FILES} files` });
    return;
  }
  const requestedId = String(req.body?.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  // Extract vault token from headers for project ownership
  const ownerToken = (req.headers['x-vault-token'] ?? '').toString().trim() || undefined;
  const project = await saveProject(Object.fromEntries(fileEntries), req.body?.title, requestedId || undefined, ownerToken);
  res.json(project);
});

// Delete a project container: stop its backend runtime, remove all files.
// The workspace persists until the user explicitly deletes it.
projectRouter.delete('/api/project/:id', requireProjectOwnership, async (req: any, res: any) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !projectExists(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    await stopRuntime(id);
  } catch {
    /* runtime may not be running */
  }
  fs.rmSync(path.join(PROJECTS_DIR, id), { recursive: true, force: true });
  res.json({ deleted: id });
});

// Project manifest: { id, title, files }
projectRouter.get('/api/project/:id/manifest', requireProjectOwnership, (req: any, res: any) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !projectExists(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    id,
    title: 'ENZO Project',
    files: listFiles(id),
    url: `/api/project/${id}/`,
    backend: getRuntimeStatus(id),
  });
});

function serveIndex(id: string, res: any) {
  const entry = id ? findIndexEntry(id) : null;
  if (!entry) {
    res.status(404).type('text/plain').send('Project not found. Ask ENZO to regenerate the code.');
    return;
  }
  // A nested entry (e.g. public/index.html) must be served from its own
  // directory so relative css/ and js/ references resolve — redirect rather
  // than serving it at the root URL.
  if (entry !== 'index.html') {
    const dir = entry.slice(0, entry.length - 'index.html'.length);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, `/api/project/${id}/${dir}`);
    return;
  }
  const html = readProjectFile(id, entry);
  if (!html) {
    res.status(404).type('text/plain').send('Project not found. Ask ENZO to regenerate the code.');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(injectBackendBootstrap(id, html, !!findBackendEntry(id)));
}

// Serve the project index (entry point).
projectRouter.get('/api/project/:id', requireProjectOwnership, (req: any, res: any) => {
  serveIndex(String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, ''), res);
});
projectRouter.get('/api/project/:id/', requireProjectOwnership, (req: any, res: any) => {
  serveIndex(String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, ''), res);
});

// Reverse-proxy any method/path to the project's spawned backend runtime.
// The frontend calls window.ENZO_BACKEND + "/api/…" and we forward it.
projectRouter.all('/api/project/:id/backend/*proxy', requireProjectOwnership, async (req: any, res: any) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !projectExists(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rel = Array.isArray(req.params.proxy) ? req.params.proxy.join('/') : String(req.params.proxy || '');
  try {
    await proxyRuntimeRequest(id, '/' + rel, req, res);
  } catch (e: any) {
    res.status(502).json({ error: 'backend_error', message: e?.message || String(e) });
  }
});
projectRouter.all('/api/project/:id/backend', requireProjectOwnership, async (req: any, res: any) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !projectExists(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    await proxyRuntimeRequest(id, '/', req, res);
  } catch (e: any) {
    res.status(502).json({ error: 'backend_error', message: e?.message || String(e) });
  }
});

// Serve any file inside the project (relative paths resolve CSS/JS/images).
projectRouter.get('/api/project/:id/*splat', requireProjectOwnership, (req: any, res: any) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  let rel = Array.isArray(req.params.splat) ? req.params.splat.join('/') : String(req.params.splat || '');
  if (rel.endsWith('/')) rel += 'index.html'; // directory URL → its index page
  const content = id && rel ? readProjectFile(id, rel) : null;
  if (content === null) {
    res.status(404).type('text/plain').send('File not found in project.');
    return;
  }
  res.setHeader('Content-Type', contentTypeFor(rel));
  res.setHeader('Cache-Control', 'no-store');
  // The entry page may legitimately live in a subfolder (public/index.html);
  // it still needs the backend bootstrap injected wherever it is served from.
  const entry = findIndexEntry(id);
  if (entry && rel === entry) {
    res.send(injectBackendBootstrap(id, content, !!findBackendEntry(id)));
    return;
  }
  res.send(content);
  });
