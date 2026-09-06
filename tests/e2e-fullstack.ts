/**
 * e2e-fullstack.ts — the real-server end-to-end run (NOT part of `npm test`).
 *
 * Boots the ACTUAL index.ts (every route, the real vault master-key auth,
 * the real rate limiter, the real SSE streams, the real scheduler + neural
 * trainer boot) with the scripted LLM fixtures from src/e2e-seams.ts, then
 * drives the complete agent-builder journey the way the frontend does:
 *
 *   draft → review → save → run (SSE) → match → handoff → auto → neural
 *
 * A second instance runs with ENZO_E2E_BROKEN=1 — the LLM is down — and
 * proves the draft lands on the honest local template (empty draftModel,
 * honest reason), never a crash.
 *
 * Run:  npx tsx tests/e2e-fullstack.ts
 * Needs: nothing (hermetic tmp state dirs, master key auth, fake keys only).
 *
 * Why standalone: booting index.ts triggers the live model-catalog sync
 * (network, by design), which would make the hermetic `npm test` chain
 * flaky. This script is the on-demand full-system pass.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 5099;
const BROKEN_PORT = 5098;
const MASTER = 'e2e-fullstack-master-key';
const AUTH = { Authorization: `Bearer ${MASTER}` };

let failed = 0;
const ok = (cond: unknown, label: string, detail?: string) => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

function mkState(tag: string) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `enzo-e2e-${tag}-`));
  return {
    data: path.join(base, 'data'),
    agents: path.join(base, 'agents'),
    skills: path.join(base, 'skills'),
  };
}

interface Child {
  proc: ReturnType<typeof spawn>;
  logPath: string;
  stop: () => Promise<void>;
}

function bootServer(port: number, state: ReturnType<typeof mkState>, broken: boolean): Promise<Child> {
  const logPath = path.join(os.tmpdir(), `enzo-e2e-${port}.log`);
  const log = fs.openSync(logPath, 'w');
  // Minimal child env: this machine's real provider keys must NEVER reach the
  // fixture instance — the fixtures are hermetic by construction.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ENZO_MASTER_KEY: MASTER,
    ENZO_DATA_DIR: state.data,
    ENZO_AGENTS_DIR: state.agents,
    ENZO_SKILLS_DIR: state.skills,
    ENZO_MODEL_CACHE: path.join(state.data, 'model-cache.json'),
    ENZO_E2E_SEAMS: '1',
    ...(broken ? { ENZO_E2E_BROKEN: '1' } : {}),
    NODE_ENV: 'production',
    PORT: String(port),
  };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ENZO_') || /_API_KEY|_TOKEN|_SECRET/.test(k)) delete env[k];
    else if (env[k] === undefined) void 0;
  }
  // start from a scrubbed base (never inherit provider keys/secrets)
  const scrubbed: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const proc = spawn('npm', ['exec', 'tsx', 'index.ts'], {
    cwd: ROOT,
    env: { ...scrubbed, ...env },
    detached: true,
    stdio: ['ignore', log, log],
  });
  const stop = () =>
    new Promise<void>((resolve) => {
      try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ }
      try { fs.closeSync(log); } catch { /* */ }
      setTimeout(resolve, 800);
    });
  const t0 = Date.now();
  return (async () => {
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}) — log: ${logPath}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return { proc, logPath, stop };
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 60_000) {
        await stop();
        throw new Error(`server did not become healthy in 60s — log: ${logPath}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
}

async function req(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { ...AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE/text */ }
  return { status: r.status, json, text };
}

function parseSSE(text: string) {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    const evLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    let data: any = dataLine.slice(6);
    try { data = JSON.parse(data); } catch { /* leave raw */ }
    events.push({ event: evLine ? evLine.slice(7).trim() : 'message', data });
  }
  return events;
}

const INVOICE_TASK = 'Every morning check my Gmail for invoices and draft replies for the urgent ones.';
const MUN_TASK = 'Research Model UN country positions and draft position papers for my delegation.';

async function main() {
  const state = mkState('happy');
  console.log(`[e2e] booting real server (seam fixtures) on :${PORT} …`);
  const server = await bootServer(PORT, state, false);
  console.log('[e2e] server healthy — running the journey\n');

  try {
    // ── 0. auth gate ──────────────────────────────────────────────────────
    console.log('[0] vault gate');
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/agents`, { method: 'GET' });
      ok(r.status === 401, 'agents blocked without auth');
      const bad = await req(PORT, 'GET', '/api/agents', undefined, { Authorization: 'Bearer wrong' });
      ok(bad.status === 401, 'agents blocked with wrong master key');
    }

    // ── 1. draft: two-pass composition through the real route ────────────
    console.log('\n[1] /api/agents/draft — two-pass draft');
    let draft: any;
    {
      const short = await req(PORT, 'POST', '/api/agents/draft', { description: 'hi' });
      ok(short.status === 400, 'short description rejected');

      const r = await req(PORT, 'POST', '/api/agents/draft', { description: INVOICE_TASK });
      ok(r.status === 200, 'draft 200');
      draft = r.json?.draft;
      ok(draft?.name === 'Invoice Watcher', 'LLM-named agent', JSON.stringify(draft?.name));
      ok(String(draft?.systemPrompt || '').includes('TACIT KNOWLEDGE'), 'veteran manual sections present');
      ok(String(draft?.systemPrompt || '').length > 400, 'manual has real substance');
      ok(draft?.domain === 'accounts payable operations (invoice triage)', 'pass-1 domain surfaced', JSON.stringify(draft?.domain));
      ok(Array.isArray(draft?.tools) && draft.tools.length > 0, 'dynamic tools present');
      ok(draft?.draftModel === '', 'seam draft claims no live model (honest)');
    }

    // ── 2. save + list + edit ──────────────────────────────────────────────
    console.log('\n[2] save → list → edit');
    let agentId = '';
    {
      const r = await req(PORT, 'POST', '/api/agents', {
        name: draft.name,
        description: INVOICE_TASK,
        systemPrompt: draft.systemPrompt,
        tools: draft.tools,
        model: draft.model,
        domain: draft.domain,
      });
      ok(r.status === 200 && r.json?.agent?.id, 'saved');
      agentId = r.json?.agent?.id;

      const list = await req(PORT, 'GET', '/api/agents');
      ok(Array.isArray(list.json?.agents) && list.json.agents.some((a: any) => a.id === agentId), 'listed');

      const put = await req(PORT, 'PUT', `/api/agents/${agentId}`, { description: 'check gmail for invoices + reply drafts' });
      ok(put.status === 200 && /reply drafts/.test(put.json?.agent?.description || ''), 'edit persists');

      const hostile = await req(PORT, 'PUT', `/api/agents/${agentId}`, {
        neural: { weights: { hacked: 50 }, cycles: 99 },
      });
      ok(hostile.status === 200 && hostile.json?.agent?.neural === undefined, 'client neural payload ignored (server-computed only)');
    }

    // ── 3. run: SSE stream with tool step + answer + lessons ──────────────
    console.log('\n[3] /api/agents/:id/run — SSE');
    {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/agents/${agentId}/run`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Triage this morning\'s invoice emails' }),
      });
      ok(r.status === 200, 'run 200');
      const events = parseSSE(await r.text());
      const search = events.filter((e) => e.event === 'search');
      const content = events.filter((e) => e.event === 'message' || e.event === 'content' || (e.event === 'data'));
      ok(search.length >= 1, 'search step event streamed', JSON.stringify(events.map((e) => e.event)));
      const joined = content.map((e) => String((e.data?.text ?? e.data?.content ?? '') )).join('');
      ok(joined.includes('veteran'), 'answer streams', JSON.stringify(joined.slice(0, 120)));
      const lessons = events.find((e) => e.event === 'lessons');
      ok(lessons, 'lessons event closes the stream');

      const hist = await req(PORT, 'GET', `/api/agents/${agentId}/runs`);
      ok(Array.isArray(hist.json?.runs) && hist.json.runs.length >= 1, 'run recorded in history');
      ok(hist.json.runs[0]?.output?.includes('veteran') || hist.json.runs[0]?.status === 'ok', 'history captured the run');
    }

    // ── 4. match: local routing (+ traffic ingestion for the neural layer)
    console.log('\n[4] /api/agents/match — routing + traffic');
    {
      const hit = await req(PORT, 'POST', '/api/agents/match', { message: 'Check my invoice triage from this morning and flag the urgent ones' });
      ok(hit.json?.agent?.id === agentId, 'domain message matches');
      const miss = await req(PORT, 'POST', '/api/agents/match', { message: 'Write me a haiku about the ocean at dawn' });
      ok(miss.json?.agent === null, 'unrelated message does not match');
    }

    // ── 5. handoff: chat-intent classification ────────────────────────────
    console.log('\n[5] /api/agents/handoff');
    {
      const no = await req(PORT, 'POST', '/api/agents/handoff', { message: 'What is the capital of France?' });
      ok(no.json?.create === null, 'non-agent message → null');
      const yes = await req(PORT, 'POST', '/api/agents/handoff', { message: 'Create an agent that researches MUN country positions and drafts position papers' });
      ok(yes.json?.create?.task?.length >= 10, 'create-intent confirmed with task', JSON.stringify(yes.json));
    }

    // ── 6. auto: one-call draft + save (the terminal background path) ─────
    console.log('\n[6] /api/agents/auto');
    let autoId = '';
    {
      const before = (await req(PORT, 'GET', '/api/agents')).json?.agents.length;
      const r = await req(PORT, 'POST', '/api/agents/auto', { description: MUN_TASK });
      ok(r.status === 200 && r.json?.agent, 'auto-created');
      autoId = r.json?.agent?.id;
      ok(r.json?.agent?.domain === 'MUN procedural rules and country-position research', 'two-pass domain stored');
      ok(String(r.json?.agent?.systemPrompt || '').includes('TACIT KNOWLEDGE'), 'veteran manual written');
      const after = (await req(PORT, 'GET', '/api/agents')).json?.agents.length;
      ok(after === before + 1, 'agent persisted');
      const routable = await req(PORT, 'POST', '/api/agents/match', { message: 'Do MUN research for India this weekend' });
      ok(routable.json?.agent?.id === autoId, 'auto agent routable by domain');
    }

    // ── 7. neural: surface + interactive train (deep-tune via seam) ───────
    console.log('\n[7] neural surface');
    {
      const surface = await req(PORT, 'GET', `/api/agents/${agentId}/neural`);
      ok(surface.status === 200, 'neural surface 200');

      // Deep-tune fires on every 3rd cycle, and each train consumes the
      // queued traffic — so three match→train rounds drive cycles 1→3, and
      // the 3rd carries the seam's deep-tune lesson.
      let trainJson: any = null;
      for (let round = 1; round <= 3; round++) {
        await req(PORT, 'POST', '/api/agents/match', { message: 'Check my invoice triage from this morning and flag the urgent ones' });
        const t = await req(PORT, 'POST', `/api/agents/${agentId}/neural/train`);
        ok(t.status === 200 && t.json?.trained === true, `training cycle ${round} ran on fresh traffic`, JSON.stringify(t.json).slice(0, 200));
        trainJson = t.json;
      }
      ok(Array.isArray(trainJson?.lessons) && trainJson.lessons.length >= 1, 'deep-tune lesson proposed on the 3rd cycle');

      const after = await req(PORT, 'GET', `/api/agents/${agentId}/neural`);
      ok((after.json?.neural?.cycles ?? 0) >= 3, 'cycles persisted');
      ok(Array.isArray(after.json?.neural?.weightsTop) && after.json.neural.weightsTop.length > 0, 'weights visible');
      ok(String(after.json?.neural?.focusLine || '').includes('NEURAL FOCUS'), 'focus line present');

      const memoryHasLesson = (await req(PORT, 'GET', '/api/agents'))
        .json?.agents?.find((a: any) => a.id === agentId)?.memory;
      ok(
        Array.isArray(memoryHasLesson) && memoryHasLesson.some((m: string) => /primary source/i.test(m)),
        'lesson merged into editable memory',
      );
    }

    // ── 8. delete ─────────────────────────────────────────────────────────
    console.log('\n[8] cleanup');
    {
      const d1 = await req(PORT, 'DELETE', `/api/agents/${autoId}`);
      const d2 = await req(PORT, 'DELETE', `/api/agents/${agentId}`);
      ok(d1.status === 200 && d2.status === 200, 'agents deleted');
      const list = await req(PORT, 'GET', '/api/agents');
      ok(list.json?.agents.length === 0, 'store empty after delete');
    }
  } finally {
    await server.stop();
  }

  // ── broken-LLM instance: the honest template fallback ──────────────────
  console.log(`\n[e2e] booting broken-LLM instance on :${BROKEN_PORT} …`);
  const brokenState = mkState('broken');
  const brokenServer = await bootServer(BROKEN_PORT, brokenState, true);
  try {
    console.log('[B] draft with the LLM down — honest template path');
    const r = await req(BROKEN_PORT, 'POST', '/api/agents/draft', { description: INVOICE_TASK });
    ok(r.status === 200, 'draft still 200 (never a crash)');
    ok(r.json?.draft?.name === 'Custom agent', 'template name');
    ok(String(r.json?.draft?.systemPrompt || '').includes('OPERATING PROCEDURE'), 'mechanical template served');
    ok(r.json?.draft?.draftModel === '', 'template claims NO model (honest)');
    ok(/No drafting model was reachable/.test(r.json?.draft?.draftModelReason || ''), 'reason says so plainly');

    const run = await req(BROKEN_PORT, 'GET', '/api/agents');
    ok(run.json?.agents?.length === 0, 'draft never persists');
  } finally {
    await brokenServer.stop();
  }

  console.log(failed === 0 ? '\n✅ fullstack e2e: ALL PASS' : `\n❌ fullstack e2e: ${failed} FAILURE(S)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[e2e] fatal:', err);
  process.exit(1);
});
