/**
 * project-idor.test.ts — cross-account access control on generated projects.
 * Run with: npx tsx tests/project-idor.test.ts
 *
 * The original version of this file used mocha's describe/it globals and the
 * supertest package — neither is installed — and asserted DELETEs against
 * routes never registered on its app, so it could not run at all. This rewrite
 * uses the same tsx + node:assert + raw http style as the rest of the suite
 * and mounts the REAL projectRouter, so the ownership middleware that guards
 * production traffic is what's actually under test.
 *
 * Hermetic: PROJECTS_DIR is resolved from process.cwd() at import time, so we
 * chdir into a temp dir BEFORE importing project.ts — nothing touches the
 * repo's real generated-projects/ folder.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

// PROJECTS_DIR is resolved from process.cwd() at project.ts import time, so we
// must chdir into a temp dir BEFORE the dynamic import inside main() below —
// nothing touches the repo's real generated-projects/ folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-idor-'));
process.chdir(TMP);

function req(
  port: number,
  method: 'GET' | 'DELETE' | 'POST',
  urlPath: string,
  token?: string,
  body?: object,
): Promise<{ status: number; json: any; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(token ? { 'x-vault-token': token } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* non-JSON body is fine */
          }
          resolve({ status: res.statusCode || 0, json, body: raw });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  // Import AFTER the chdir above so PROJECTS_DIR lands in the temp dir.
  const { saveProject, projectExists, checkProjectOwnership, projectRouter } = await import(
    '../src/projects/project.js'
  );
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(projectRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as import('net').AddressInfo).port;

  try {
    // ── 1. Cross-account read: one vault token must not read another's project ──
    const alice = 'vault-token-alice';
    const bob = 'vault-token-bob';
    const p1 = await saveProject({ 'index.html': '<h1>Project 1</h1>' }, 'P1', undefined, alice);
    const p2 = await saveProject({ 'index.html': '<h1>Project 2</h1>' }, 'P2', undefined, bob);
    assert.ok(p1.id && p2.id, 'both projects saved');

    const bobReadsAlice = await req(port, 'GET', `/api/project/${p1.id}/manifest`, bob);
    assert.strictEqual(bobReadsAlice.status, 403, 'Bob cannot open Alice project');
    const aliceReadsBob = await req(port, 'GET', `/api/project/${p2.id}/manifest`, alice);
    assert.strictEqual(aliceReadsBob.status, 403, 'Alice cannot open Bob project');
    const noTokenReads = await req(port, 'GET', `/api/project/${p1.id}/manifest`);
    assert.strictEqual(noTokenReads.status, 403, 'anonymous cannot open a project');
    const aliceReadsOwn = await req(port, 'GET', `/api/project/${p1.id}/manifest`, alice);
    assert.strictEqual(aliceReadsOwn.status, 200, 'owner can open own project');
    assert.ok(Array.isArray(aliceReadsOwn.json.files), 'owner gets the file list');
    console.log('✔ cross-account reads blocked (403), owner reads succeed (200)');

    // ── 2. Unauthorized delete: wrong token cannot destroy another user's work ──
    const p3 = await saveProject({ 'index.html': '<h1>Deletion Test</h1>' }, 'P3', undefined, alice);
    const bobDeletes = await req(port, 'DELETE', `/api/project/${p3.id}`, bob);
    assert.strictEqual(bobDeletes.status, 403, 'delete with wrong token is forbidden');
    assert.ok(projectExists(p3.id), 'project survives unauthorized delete attempt');

    const noTokenDeletes = await req(port, 'DELETE', `/api/project/${p3.id}`);
    assert.strictEqual(noTokenDeletes.status, 403, 'anonymous delete is forbidden');
    assert.ok(projectExists(p3.id), 'project survives anonymous delete attempt');

    const aliceDeletes = await req(port, 'DELETE', `/api/project/${p3.id}`, alice);
    assert.strictEqual(aliceDeletes.status, 200, 'owner delete succeeds');
    assert.ok(!projectExists(p3.id), 'project removed after owner delete');
    const gone = await req(port, 'DELETE', `/api/project/${p3.id}`, alice);
    assert.strictEqual(gone.status, 404, 'deleting a removed project 404s');
    console.log('✔ unauthorized deletes blocked, owner delete works, gone project 404s');

    // ── 3. Ownership predicate itself: exact token, wrong token, missing token ──
    assert.strictEqual(checkProjectOwnership(p1.id, alice), true, 'correct token owns');
    assert.strictEqual(checkProjectOwnership(p1.id, bob), false, 'wrong token rejected');
    assert.strictEqual(checkProjectOwnership(p1.id, undefined), false, 'missing token rejected');
    assert.strictEqual(checkProjectOwnership('does-not-exist', alice), false, 'unknown project rejected');
    console.log('✔ checkProjectOwnership: exact match only, no token / unknown id fail closed');
  } finally {
    srv.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log('\nAll project IDOR checks passed.');
}

main().catch((e) => {
  console.error('FAILED:', e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
