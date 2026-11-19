#!/usr/bin/env node
/*
 * ENZO desktop launcher — the only "app code" the macOS .app and the Windows
 * install execute before the real server starts. Plain CommonJS, zero deps,
 * runs on the bundled Node runtime.
 *
 * Responsibilities, in order:
 *   1. Prepare the per-user data dir (state must live OUTSIDE the read-only
 *      app bundle: ~/Library/Application Support/ENZO on macOS,
 *      %APPDATA%\ENZO on Windows).
 *   2. Boot the bundled server: node --import tsx index.ts (cwd = the app dir
 *      so tsconfig paths, skills-bundled/ and synthetic-nature/dist resolve),
 *      starting at port 5200 (the docker variant's port) and retrying the next
 *      port if the current one is taken — the backend exits cleanly with
 *      EADDRINUSE, which is the retry signal. (A bind probe is NOT enough
 *      here: docker's port proxy can occupy a port in a way a localhost
 *      bind-probe misses, so trust the server, not the probe.)
 *   3. Wait for /api/health, then open the default browser at the server URL.
 *   4. Stay alive for the app's lifetime; relay SIGTERM/SIGINT to the server
 *      so closing the app (Dock → Quit, closing the console on Windows)
 *      actually stops it.
 *
 * Everything the server writes goes to <data>/enzo.log — the first place to
 * look when a desktop build misbehaves.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const os = require('os');
const path = require('path');

const APP_DIR = __dirname; // .../Contents/Resources/app (macOS) or <install>\app (Windows)
const RESOURCES_DIR = path.dirname(APP_DIR);
const IS_WIN = process.platform === 'win32';
// Theme edition of this bundle: "less" = the docker-variant theme set only,
// "full" = every theme. The packaging script writes edition.txt next to this
// file; both current builds (macOS DMG, Windows "less" exe) are the lite one,
// so a missing marker means "less". The backend forwards it as
// ENZO_DESKTOP_EDITION so the in-app updater downloads the SAME edition.
const EDITION = (() => {
  try {
    const raw = fs.readFileSync(path.join(APP_DIR, 'edition.txt'), 'utf8').trim().toLowerCase();
    return raw === 'full' ? 'full' : 'less';
  } catch { return 'less'; }
})();
const APP_VERSION = (() => {
  try { return require(path.join(APP_DIR, 'package.json')).version; } catch { return '?'; }
})();

const DATA_ROOT = process.env.ENZO_DESKTOP_HOME || (IS_WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ENZO')
  : path.join(os.homedir(), 'Library', 'Application Support', 'ENZO'));

const LOG_PATH = path.join(DATA_ROOT, 'enzo.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* log is best-effort */ }
  console.log(line);
};

/* ── 1. data dir ─────────────────────────────────────────────────────────── */

for (const dir of ['data', 'intelligence', 'neural', 'projects', 'skills']) {
  fs.mkdirSync(path.join(DATA_ROOT, dir), { recursive: true });
}
const MEMORY_PATH = path.join(DATA_ROOT, 'data', 'memory-store.json');
if (!fs.existsSync(MEMORY_PATH)) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify({ entries: [] }, null, 2));
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const nodeBin = IS_WIN
  ? path.join(RESOURCES_DIR, 'node-runtime', 'node.exe')
  : path.join(RESOURCES_DIR, 'node-runtime', 'bin', 'node');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 2+3. boot (with port-fallback), wait healthy, open browser ───────────── */

(async () => {
  const deadline = Date.now() + 120_000;
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production', // gates single-origin serving of synthetic-nature/dist
    ENZO_GOOGLE_AUTH: '0', // docker variant: provider-key onboarding, no Google OAuth
    ENZO_SELF_HOSTED: '1',
    ENZO_AUTO_INSTALL: '0', // the bundle ships complete node_modules
    ENZO_DESKTOP_HOME: DATA_ROOT, // marks this as a desktop install (self-update)
    ENZO_DESKTOP_EDITION: EDITION, // "less" | "full" — the updater must match it
    ENZO_DATA_DIR: path.join(DATA_ROOT, 'data'),
    ENZO_MEMORY_PATH: MEMORY_PATH,
    ENZO_INTEL_DIR: path.join(DATA_ROOT, 'intelligence'),
    ENZO_NEURAL_DIR: path.join(DATA_ROOT, 'neural'),
    ENZO_PROJECTS_DIR: path.join(DATA_ROOT, 'projects'),
    ENZO_SKILLS_DIR: path.join(DATA_ROOT, 'skills'),
  };

  let server = null;
  let PORT = 0;
  for (let port = 5200; port <= 5220 && !server; port++) {
    if (Date.now() > deadline) break;
    log(`starting server on port ${port} (data ${DATA_ROOT})`);
    const child = spawn(nodeBin, ['--import', 'tsx', 'index.ts'], {
      cwd: APP_DIR,
      env: { ...baseEnv, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const forward = (chunk) => {
      try { fs.appendFileSync(LOG_PATH, chunk); } catch { /* best-effort */ }
      process.stdout.write(chunk);
    };

    // Success signal = the child's OWN "listening on" line on its stdout —
    // authoritative (health probes would also get answered by whatever other
    // service holds the port, e.g. the docker dev container on :5001).
    const listening = new Promise((resolve) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        forward(Buffer.from(chunk));
        if (typeof chunk === 'string' && chunk.includes('listening on http://localhost:')) resolve(true);
      });
      child.stderr.on('data', (chunk) => forward(chunk));
      child.once('exit', () => resolve(false));
    });
    const ok = await Promise.race([
      listening,
      sleep(90_000).then(() => false),
    ]);

    if (ok) {
      server = child;
      PORT = port;
    } else {
      if (child.exitCode == null) child.kill('SIGTERM'); // stalled boot, not a port clash
      await sleep(300); // port taken (EADDRINUSE exit) → try the next one
    }
  }

  if (!server) {
    log('FATAL: no usable port in 5200-5220 or server never became healthy — see log above');
    process.exit(1);
  }

  fs.writeFileSync(path.join(DATA_ROOT, 'enzo.pid'), String(server.pid));

  const shutdown = (signal) => {
    log(`${signal} received — stopping server`);
    server.kill('SIGTERM');
    const hardExit = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    server.once('exit', () => { clearTimeout(hardExit); process.exit(0); });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  server.once('exit', (code) => {
    log(`server exited (code ${code})`);
    process.exit(code == null ? 1 : code);
  });

  const url = `http://localhost:${PORT}`;
  const opener = IS_WIN
    ? spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    : process.platform === 'darwin'
      ? spawn('open', [url], { detached: true, stdio: 'ignore' })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  opener.unref();
  log(`ready — ${url} opened in the browser`);
})().catch((err) => {
  log(`FATAL: ${err && err.stack || err}`);
  process.exit(1);
});
