/**
 * Project backend runtime for coding mode.
 *
 * Lets a generated multi-file project ship a REAL backend, not just static
 * files. If the project contains a backend entrypoint (`server.js` by
 * convention), ENZO spawns it as a child Node process on an ephemeral port and
 * proxies `/api/project/<id>/backend/*` → `http://127.0.0.1:<port>/*`.
 *
 * - Works on AWS: project folders live on disk (`generated-projects/`), so the
 *   runtime's SQLite/JSON files persist across ENZO restarts. Each machine
 *   runs its own children (single-instance deployment is the sane default).
 * - Dependency-free for the generated code: modules resolve via NODE_PATH into
 *   ENZO's own node_modules (express, cors, better-sqlite3, …), so the model
 *   only needs `require('express')` — no per-project npm install.
 * - CJS-only: NODE_PATH only affects `require()`, so backends use CommonJS.
 * - Lifecycle: lazy boot on first request, idle shutdown after a timeout,
 *   children killed on process exit, restart lazily on next request.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import http from 'http';

const PROJECTS_DIR = path.join(process.cwd(), 'generated-projects');

const NODE_PATH = [path.join(process.cwd(), 'node_modules')]
  .concat(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])
  .join(path.delimiter);

/** NODE_PATH handed to generated backends so they can `require('express')` etc. */
export function backendNodePath(): string {
  return NODE_PATH;
}

/**
 * The env a generated project's child process may see — the ONLY env it gets.
 * Generated code is written by an LLM and runs here as a real child process;
 * `{...process.env}` would hand it ENZO_MASTER_KEY, JWT_SECRET,
 * GOOGLE_CLIENT_SECRET and every provider key, and both callers stream the
 * child's stdout back to the browser (runtime bootLog; build-check log tail
 * in the repair context), so anything the child chose to print was directly
 * exfiltratable.
 *
 * Allowlist, not blocklist: the next secret someone adds to .env must not
 * become readable in here by default. Node drops undefined values, so the
 * optional entries below simply vanish when unset on the host.
 */
export function buildChildEnv(
  port: number,
  nodePath: string,
  projectId?: string,
  projectDir?: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,          // spawn('node') resolves the binary through it
    HOME: process.env.HOME,          // native deps (better-sqlite3) cache under $HOME
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    TZ: process.env.TZ,
    NODE_ENV: process.env.NODE_ENV,
    PORT: String(port),
    NODE_PATH: nodePath,
  };
  if (projectId) childEnv.ENZO_PROJECT_ID = projectId;
  if (projectDir) childEnv.ENZO_PROJECT_DIR = projectDir;
  return childEnv;
}

const BOOT_TIMEOUT_MS = Number(process.env.ENZO_PROJECT_RUNTIME_BOOT_MS || 7000);
const IDLE_TIMEOUT_MS = Number(process.env.ENZO_PROJECT_RUNTIME_IDLE_MS || 10 * 60 * 1000);

/** Candidate backend entries, most-preferred first. */
const BACKEND_ENTRIES = [
  'server.js',
  'server/server.js',
  'server/index.js',
  'api/server.js',
  'api/index.js',
  'backend.js',
];

/** True when a project-relative path is a backend entrypoint (or lives in one). */
export function isBackendEntryRel(rel: string): boolean {
  const r = String(rel || '').replace(/^\/+/, '');
  return BACKEND_ENTRIES.includes(r) || /^server\//.test(r) || /^api\//.test(r) || r === 'backend.js';
}

/**
 * Generated backends frequently use the Express 4 bare-wildcard route
 * (`app.get('*', …)`), which throws PathError under the Express 5 that
 * NODE_PATH actually resolves to. Rewrite those route patterns to the
 * Express 5 form before boot so the child can start. Idempotent.
 */
const EXPRESS4_WILDCARD_RE =
  /((?:app|router|api)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(\s*)(['"])\*\2(\s*,)/g;

export function sanitizeServerForExpress5(code: string): string {
  return String(code || '').replace(
    EXPRESS4_WILDCARD_RE,
    (_m, head: string, quote: string, rest: string) => `${head}${quote}/{*splat}${quote}${rest}`,
  );
}

interface Runtime {
  id: string;
  entry: string;
  port: number;
  state: 'starting' | 'running' | 'failed';
  error?: string;
  child?: ChildProcess;
  bootLog: string[];
  startedAt: number;
  lastActivity: number;
  idleTimer?: NodeJS.Timeout;
}

const runtimes = new Map<string, Runtime>();

function projectBase(id: string): string | null {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe.length > 64) return null;
  const base = path.join(PROJECTS_DIR, safe);
  return base && fs.existsSync(base) ? base : null;
}

/** Find the backend entrypoint file for a project, or null if it has none. */
export function findBackendEntry(projectId: string): string | null {
  const base = projectBase(projectId);
  if (!base) return null;
  for (const rel of BACKEND_ENTRIES) {
    if (fs.existsSync(path.join(base, rel))) return rel;
  }
  return null;
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForListening(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      if (Date.now() > deadline) {
        reject(new Error(`backend did not listen on :${port} within ${timeoutMs}ms`));
        return;
      }
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.setTimeout(400);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('timeout', () => sock.destroy());
      sock.once('error', () => {
        sock.destroy();
        setTimeout(probe, 120);
      });
    };
    probe();
  });
}

function armIdleShutdown(rt: Runtime): void {
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  rt.idleTimer = setTimeout(() => {
    const stale = runtimes.get(rt.id);
    if (stale) {
      killRuntime(rt.id, 'idle timeout');
    }
  }, IDLE_TIMEOUT_MS);
  rt.idleTimer.unref?.();
}

function killRuntime(id: string, reason: string): void {
  const rt = runtimes.get(id);
  if (!rt) return;
  if (rt.idleTimer) clearTimeout(rt.idleTimer);
  runtimes.delete(id);
  if (!rt.child) return;
  console.log(`[project-runtime] stopping ${id} (${reason})`);
  try {
    rt.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  // Hard-kill fallback if SIGTERM hangs.
  const hard = setTimeout(() => {
    try {
      rt.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 3000);
  hard.unref?.();
}

/**
 * Ensure the project's backend is running. Boots lazily if stopped. Returns
 * the runtime, or null when the project has no backend entry.
 */
export async function ensureRuntime(projectId: string): Promise<Runtime | null> {
  const existing = runtimes.get(projectId);
  if (existing && (existing.state === 'running' || existing.state === 'starting')) {
    existing.lastActivity = Date.now();
    armIdleShutdown(existing);
    if (existing.state === 'starting') {
      // Wait for it to finish booting.
      await waitForListening(existing.port, BOOT_TIMEOUT_MS).catch(() => undefined);
    }
    return existing;
  }

  const entry = findBackendEntry(projectId);
  if (!entry) return null;
  const base = projectBase(projectId)!;

  // Heal Express 4 wildcards from projects saved before the sanitizer existed
  // (and any path that bypassed saveProject). Safe to run on every boot.
  try {
    const entryFile = path.join(base, entry);
    const code = fs.readFileSync(entryFile, 'utf8');
    const fixed = sanitizeServerForExpress5(code);
    if (fixed !== code) {
      fs.writeFileSync(entryFile, fixed, 'utf8');
      console.log(`[project-runtime] ${projectId} sanitized Express 4 wildcard routes in ${entry}`);
    }
  } catch {
    /* non-fatal: boot attempt continues with the file as-is */
  }

  const port = await getFreePort();

  const rt: Runtime = {
    id: projectId,
    entry,
    port,
    state: 'starting',
    bootLog: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
  };
  runtimes.set(projectId, rt);
  armIdleShutdown(rt);

  // Generated project code gets exactly the env buildChildEnv allows — nothing
  // else from this process. See the comment there for why.
  const childEnv = buildChildEnv(port, NODE_PATH, projectId, base);

  const child = spawn('node', [entry], {
    cwd: base,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rt.child = child;

  child.stdout?.on('data', (d) => {
    const line = String(d).slice(0, 2000);
    rt.bootLog.push(line);
    if (rt.bootLog.length > 40) rt.bootLog.shift();
  });
  child.stderr?.on('data', (d) => {
    const line = String(d).slice(0, 2000);
    rt.bootLog.push(line);
    if (rt.bootLog.length > 40) rt.bootLog.shift();
  });

  child.once('exit', (code, signal) => {
    if (runtimes.get(projectId) === rt) {
      const log = rt.bootLog.join('').trim() || 'no output';
      if (rt.state === 'starting') {
        rt.state = 'failed';
        rt.error = `backend exited during boot (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n${log.slice(-400)}`;
        console.error(`[project-runtime] ${projectId} boot failed:\n${rt.error}`);
      } else {
        // Crashed after running — mark dead; next request re-boots.
        killRuntime(projectId, `exited code=${code ?? signal ?? '?'}`);
      }
    }
  });

  try {
    await waitForListening(port, BOOT_TIMEOUT_MS);
    rt.state = 'running';
    console.log(`[project-runtime] ${projectId} running on 127.0.0.1:${port} (entry ${entry})`);
    return rt;
  } catch (e) {
    child.kill('SIGKILL');
    rt.state = 'failed';
    rt.error = e instanceof Error ? e.message : String(e);
    console.error(`[project-runtime] ${projectId} boot failed: ${rt.error}`);
    return rt;
  }
}

export function getRuntimeStatus(projectId: string) {
  const rt = runtimes.get(projectId);
  const entry = findBackendEntry(projectId);
  if (!entry) return { backend: 'none' as const };
  if (!rt) return { backend: 'stopped' as const, entry };
  return {
    backend: rt.state,
    entry: rt.entry,
    port: rt.state === 'running' ? rt.port : undefined,
    startedAt: rt.state === 'running' ? rt.startedAt : undefined,
    error: rt.error,
  };
}

/** Proxy a request for `/api/project/<id>/backend/<segments>` to the runtime. */
export async function proxyRuntimeRequest(
  projectId: string,
  suffixPath: string,
  req: http.IncomingMessage & { body?: unknown },
  res: http.ServerResponse,
): Promise<void> {
  const rt = await ensureRuntime(projectId);
  if (!rt) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'no_backend', message: 'This project has no backend.' }));
    return;
  }
  if (rt.state !== 'running') {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'backend_unavailable',
        message: rt.error || 'Backend failed to start.',
      }),
    );
    return;
  }

  rt.lastActivity = Date.now();
  armIdleShutdown(rt);

  const urlPath = suffixPath || '/';
  let body: Buffer | string | null = null;
  if (req.readableEnded && !req.body) {
    // Body already consumed/absent — nothing to forward (GET/HEAD).
  } else if (req.body !== undefined && req.body !== null) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }
  const outgoing = http.request(
    {
      host: '127.0.0.1',
      port: rt.port,
      method: req.method,
      path: urlPath,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${rt.port}`,
        ...(body !== null ? { 'content-length': Buffer.byteLength(body, 'utf8') } : {}),
      },
      timeout: 30000,
    },
    (upstream) => {
      res.statusCode = upstream.statusCode || 502;
      for (const [k, v] of Object.entries(upstream.headers)) {
        if (!v) continue;
        // Never forward connection-specific headers across a proxy boundary.
        if (['connection', 'transfer-encoding', 'keep-alive', 'upgrade'].includes(k)) continue;
        res.setHeader(k, v as string | string[]);
      }
      upstream.on('data', (c) => res.write(c));
      upstream.on('end', () => res.end());
      upstream.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
    },
  );
  outgoing.on('error', () => {
    if (!res.writableEnded) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'backend_unreachable' }));
    }
  });
  outgoing.setTimeout(30000, () => outgoing.destroy());
  if (body !== null) {
    outgoing.end(body);
    return;
  }
  if (req.readableEnded || req.method === 'GET' || req.method === 'HEAD') {
    // No body to forward and the request already completed upstream.
    outgoing.end();
    return;
  }
  req.on('data', (c) => {
    try {
      outgoing.write(c);
    } catch {
      /* ignore */
    }
  });
  req.on('end', () => outgoing.end());
  req.on('error', () => {
    try {
      outgoing.destroy();
    } catch {
      /* ignore */
    }
  });
}

/** Stop one project's runtime (used when its container is deleted). */
export async function stopRuntime(projectId: string): Promise<void> {
  killRuntime(String(projectId || '').replace(/[^a-zA-Z0-9_-]/g, ''), 'project deleted');
}

/** Stop every runtime (invoked on process shutdown). */
export function stopAllRuntimes(): void {
  for (const id of [...runtimes.keys()]) {
    killRuntime(id, 'server shutdown');
  }
  runtimes.clear();
}