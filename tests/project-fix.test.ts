/**
 * project-fix.test.ts — self-check for coding-mode project hosting.
 * Run with: npx tsx project-fix.test.ts
 *
 * Covers the two failure classes that broke full-stack previews:
 *   1. Express 4 wildcard routes (`app.get('*')`) crashing generated backends
 *      under ENZO's Express 5 — must be sanitized at save AND boot time.
 *   2. Frontends emitted under public/ (Express static convention) never
 *      previewing because only root index.html was served — must be
 *      discovered, redirected, and backend-bootstrapped wherever they live.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';

import { saveProject, projectRouter, readProjectFile } from '../src/projects/project.js';
import {
  sanitizeServerForExpress5,
  ensureRuntime,
  getRuntimeStatus,
  stopAllRuntimes,
} from '../src/projects/project-runtime.js';

async function get(port: number, urlPath: string, token?: string): Promise<{ status: number; location?: string; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, headers: token ? { 'x-vault-token': token } : {} }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            location: res.headers.location,
            type: res.headers['content-type'],
            body,
          }),
        );
      })
      .on('error', reject);
  });
}

async function main() {
  // ── 1. Sanitizer unit checks ─────────────────────────────────────────────
  assert.strictEqual(
    sanitizeServerForExpress5(`app.get('*', handler)`),
    `app.get('/{*splat}', handler)`,
    'single-quoted wildcard rewritten',
  );
  assert.strictEqual(
    sanitizeServerForExpress5(`router.use("*", mw)`),
    `router.use("/{*splat}", mw)`,
    'double-quoted use wildcard rewritten',
  );
  assert.strictEqual(
    sanitizeServerForExpress5(`app.get('/api/items', h)`),
    `app.get('/api/items', h)`,
    'normal routes untouched',
  );
  console.log('✔ sanitizer rewrites Express 4 wildcards, leaves valid routes alone');

  // ── 2. Fixture project: public/ frontend + wildcard backend ─────────────
  const serverJs = [
    `const express = require('express');`,
    `const app = express();`,
    `app.use(express.json());`,
    `app.get('/api/items', (_req, res) => res.json([{ id: 1 }]));`,
    `app.get('*', (_req, res) => res.json({ catch: true }));`,
    `app.listen(process.env.PORT || 3123, () => console.log('ready'));`,
  ].join('\n');
  const testToken = 'test-vault-token-12345';
  const saved = await saveProject(
    {
      'public/index.html':
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/styles.css"></head>' +
        '<body><main>LinkVault fixture</main></body></html>',
      'public/css/styles.css': 'body { color: #eee; }',
      'server.js': serverJs,
    },
    'project-fix fixture',
    undefined,
    testToken,
  );
  const base = path.join(process.cwd(), 'generated-projects', saved.id);

  const onDisk = fs.readFileSync(path.join(base, 'server.js'), 'utf8');
  assert.ok(!onDisk.includes(`app.get('*'`), 'saved server.js has no Express 4 wildcard');
  assert.ok(onDisk.includes(`/{*splat}`), 'saved server.js rewritten to Express 5 form');
  console.log('✔ saveProject sanitizes backend entries on write');

  // ── 3. HTTP serving: nested entry redirect + bootstrap injection ────────
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(projectRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;

  const root = await get(port, `/api/project/${saved.id}/`, saved.ownerToken);
  assert.strictEqual(root.status, 302, 'project root redirects when entry is nested');
  assert.strictEqual(root.location, `/api/project/${saved.id}/public/`, 'redirect points at entry dir');

  const page = await get(port, root.location!, saved.ownerToken);
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes('window.ENZO_BACKEND'), 'entry page gets backend bootstrap injected');
  assert.ok(page.body.includes(`/api/project/${saved.id}/backend`), 'bootstrap carries the proxy base');

  const css = await get(port, `/api/project/${saved.id}/public/css/styles.css`, saved.ownerToken);
  assert.strictEqual(css.status, 200, 'relative assets resolve from nested entry dir');
  assert.ok(String(css.type).includes('text/css'));
  console.log('✔ nested public/ frontend previews with working assets + backend base');

  // ── 4. Real runtime boot through the sanitized backend ──────────────────
  await ensureRuntime(saved.id);
  const status = getRuntimeStatus(saved.id);
  assert.strictEqual(status.backend, 'running', `runtime boots (got ${JSON.stringify(status)})`);

  const direct = await get((status as any).port, '/api/items');
  assert.strictEqual(direct.status, 200);
  assert.ok(direct.body.includes('"id": 1') || direct.body.includes('"id":1'), 'API serves JSON from SQLite-free route');

  // The proxy route is behind requireProjectOwnership, so it needs the token the
  // browser sends; the `direct` call above bypasses the router entirely.
  const proxied = await get(port, `/api/project/${saved.id}/backend/api/items`, saved.ownerToken);
  assert.strictEqual(proxied.status, 200, 'proxy path forwards to the runtime');
  console.log('✔ sanitized backend boots under Express 5 and answers through the proxy');

  // ── 5. Upsert MERGE: a "continue" save must not delete untouched files ──────
  // The infinite-rebuild bug: registerProject re-saved into the same container
  // but the old prune step deleted every file the new snapshot didn't re-emit.
  // A "continue" re-emits only changed files, so the rest of the project (and
  // its DB) vanished — the model then rebuilt from scratch, forever. Guard it.
  const proj = await saveProject(
    { 'index.html': '<h1>v1</h1>', 'js/app.js': 'console.log(1)', 'css/s.css': 'a{}' },
    'merge fixture',
  );
  const mergeBase = path.join(process.cwd(), 'generated-projects', proj.id);
  // Simulate a runtime-created DB file the model never authored.
  fs.mkdirSync(path.join(mergeBase, 'data'), { recursive: true });
  fs.writeFileSync(path.join(mergeBase, 'data', 'app.db'), 'SQLITE');
  // "continue" turn: re-emit ONLY the one file that changed.
  const after = await saveProject({ 'js/app.js': 'console.log(2)' }, 'merge fixture', proj.id);
  assert.strictEqual(after.id, proj.id, 'reused id upserts the same container');
  assert.strictEqual(readProjectFile(proj.id, 'index.html'), '<h1>v1</h1>', 'untouched file survives continue');
  assert.strictEqual(readProjectFile(proj.id, 'css/s.css'), 'a{}', 'untouched css survives continue');
  assert.strictEqual(readProjectFile(proj.id, 'js/app.js'), 'console.log(2)', 'changed file is updated');
  assert.ok(fs.existsSync(path.join(mergeBase, 'data', 'app.db')), 'runtime DB survives continue');
  fs.rmSync(mergeBase, { recursive: true, force: true });
  console.log('✔ upsert merges — "continue" keeps untouched files and the DB');

  // ── cleanup ──────────────────────────────────────────────────────────────
  stopAllRuntimes();
  srv.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('\nAll project-hosting checks passed.');
}

import net from 'net';
main().catch((e) => {
  console.error('FAILED:', e);
  stopAllRuntimes();
  process.exit(1);
});
