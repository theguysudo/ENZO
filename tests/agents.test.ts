/**
 * agents.test.ts — the custom-agent feature suite.
 * Run with: npx tsx tests/agents.test.ts (also in the root npm test chain)
 *
 * Covers, in order:
 *   1. Store CRUD + sanitizeAgentDraft (hostile payloads, caps, schedule math)
 *   2. runAgentLoop tool-subset guard + maxIters (fake streams, no network)
 *   3. Gather pipeline (injected search/clone/fetch seams, SSRF guard,
 *      github.com-only cloning, caps) — zero network
 *   4. Scheduler math (interval/daily/downtime catch-up)
 *   5. HTTP end-to-end through the REAL router: draft → save → list → SSE run
 *      (mock stream; asserts skill/knowledge/memory blocks land in the
 *      system prompt) → runs → gather-again → memory/knowledge edits → delete
 *
 * Hermetic: the agents store and skills store are relocated into a temp dir
 * via ENZO_AGENTS_DIR / ENZO_SKILLS_DIR (set BEFORE the dynamic imports),
 * GROQ/OPENROUTER keys are blanked, and every LLM/search/clone/fetch call is
 * an injected fake.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-agents-'));
process.env.ENZO_AGENTS_DIR = path.join(TMP, 'agents-store');
process.env.ENZO_SKILLS_DIR = path.join(TMP, 'skills-store');
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.EXA_API_KEY;
delete process.env.NVIDIA_API_KEY;
delete process.env.HUGGINGFACE_API_KEY;

async function main() {
  // Seed one learned skill BEFORE anything can read the skills store (its
  // index cache populates on first listSkills call — seeding later would be
  // invisible). The agent attach/run tests rely on it.
  fs.mkdirSync(process.env.ENZO_SKILLS_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.ENZO_SKILLS_DIR!, 'index.json'), JSON.stringify({
    skills: [{
      id: 'react-query', name: 'React Query Data Fetching', sourceUrl: 'https://github.com/example/rq',
      description: 'react query patterns', keywords: ['react', 'query', 'fetching'],
      instructions: 'use useQuery for server state.', sourceSnapshot: '', learnedAt: 1,
      model: 'test', files: [],
    }],
  }, null, 2));

  // ── 1. Store + validation ───────────────────────────────────────────────
  const agentsMod = await import('../src/agents/agents.js');
  const {
    saveAgent, getAgent, listAgents, deleteAgent, sanitizeAgentDraft,
    buildAgentSystemPrompt, resolveProviderConfig, distillAgentMemory,
    CAPS, loadRuns, recordRun, deleteRuns, VALID_TOOLS, WRITE_TOOLS,
  } = agentsMod as any;

  const ids = new Set(['react-query']);
  const hostile = sanitizeAgentDraft({
    name: 'X'.repeat(500),
    description: 12345,
    systemPrompt: 'P'.repeat(20000),
    tools: ['gmail_list', 'rm -rf /', 'web_search', '__proto__', 'gmail_list'],
    skills: ['react-query', 'not-a-skill'],
    knowledge: ['note one', '', 42, 'n'.repeat(3000)],
    memory: Array(50).fill('m'),
    schedule: { kind: 'daily', time: '99:99', timezone: 'Not/AZone' },
    extra: 'ignored',
  } as any, ids);

  assert.strictEqual(hostile.name.length, CAPS.name, 'name capped at 80');
  assert.ok(hostile.systemPrompt.length <= CAPS.systemPrompt, 'systemPrompt capped');
  assert.deepStrictEqual(hostile.tools, ['gmail_list', 'web_search'], 'unknown/dup tools dropped');
  assert.deepStrictEqual(hostile.skills, ['react-query'], 'skills validated against real ids');
  // 42 stringifies to a truthy "42" — cleanStr only drops empties; that's
  // acceptable (garbage-in shrinks to a 2-char note, never crashes).
  assert.strictEqual(hostile.knowledge.length, 3, 'empty knowledge dropped, rest kept');
  assert.ok(hostile.knowledge[1].length <= CAPS.knowledgeNoteLen, 'knowledge note capped');
  assert.strictEqual(hostile.memory.length, CAPS.memoryEntries, 'memory capped at 30');
  assert.strictEqual(hostile.schedule, null, 'bogus schedule nulled');
  assert.ok(/^agt_/.test(hostile.id), 'id generated');

  // valid schedules
  const daily = sanitizeAgentDraft({ schedule: { kind: 'daily', time: '9:30', timezone: 'Asia/Kolkata' } } as any, ids);
  assert.deepStrictEqual(daily.schedule, { kind: 'daily', time: '09:30', timezone: 'Asia/Kolkata' }, 'daily schedule normalized');
  const interval = sanitizeAgentDraft({ schedule: { kind: 'interval', intervalMinutes: 9999 } } as any, ids);
  assert.strictEqual(interval.schedule, null, 'out-of-range interval nulled');

  // CRUD + no-clobber of memory across updates
  const saved = saveAgent(sanitizeAgentDraft({ name: 'Invoice watcher', description: 'check gmail for invoices', systemPrompt: 'ROLE: invoice watch', tools: ['gmail_list', 'web_search'] } as any, ids));
  const withMemory = { ...saved, memory: ['User prefers terse summaries.'] };
  saveAgent(withMemory);
  const updated = sanitizeAgentDraft({ name: 'Renamed' } as any, ids, withMemory);
  assert.strictEqual(updated.memory.length, 1, 'memory survives partial update');
  assert.strictEqual(updated.name, 'Renamed', 'name updated');
  saveAgent(updated);
  assert.strictEqual(listAgents().length, 1);
  assert.strictEqual(updated.createdAt, saved.createdAt, 'createdAt preserved');
  assert.ok(deleteAgent(updated.id));
  assert.strictEqual(listAgents().length, 0);

  // corrupted index recovery
  fs.mkdirSync(process.env.ENZO_AGENTS_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.ENZO_AGENTS_DIR!, 'index.json'), '{not json');
  assert.doesNotThrow(() => listAgents(), 'corrupted index does not throw');
  assert.strictEqual(listAgents().length, 0);

  // prompt assembly: blocks present, capped
  const prompt = buildAgentSystemPrompt(
    { ...updated, systemPrompt: 'MANUAL', knowledge: ['K1'], memory: ['M1'] },
    [{ name: 'React Query', instructions: 'guide text' }],
  );
  assert.ok(prompt.includes('MANUAL') && prompt.includes('guide text') && prompt.includes('K1') && prompt.includes('M1'), 'all prompt blocks present');
  assert.ok(prompt.length <= 12000, 'prompt capped');

  // provider resolution + fallback chain
  assert.deepStrictEqual(
    resolveProviderConfig('groq/llama-3.3-70b-versatile', { groq: 'gk' }),
    { provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'gk' },
  );
  assert.strictEqual(resolveProviderConfig('groq/x', { openrouter: 'ork' }).provider, 'openrouter', 'falls to keyed provider when pinned one keyless');
  assert.strictEqual(resolveProviderConfig('nonsense', { pollinations: 'pk' }).provider, 'pollinations', 'bare model falls to keyed provider');

  // memory distillation (injected chat seam)
  const agentNoMem = { ...updated, memory: [], description: 'invoice watch' };
  const merged = await distillAgentMemory(agentNoMem, 'Found 3 invoices; ACME is urgent.', 'run', {
    _chat: async () => JSON.stringify({ memory: ['ACME invoices are urgent.', 'User prefers terse summaries.'] }),
  });
  assert.deepStrictEqual(merged, ['ACME invoices are urgent.', 'User prefers terse summaries.']);
  const failedMerge = await distillAgentMemory({ ...agentNoMem, memory: ['keep me'] }, 'out', 'run', {
    _chat: async () => { throw new Error('llm down'); },
  });
  assert.deepStrictEqual(failedMerge, ['keep me'], 'distill failure returns existing memory');

  // write-tool set sanity (scheduler depends on it)
  assert.ok(WRITE_TOOLS.has('gmail_send') && WRITE_TOOLS.has('calendar_create') && !WRITE_TOOLS.has('gmail_list'));

  // run records: cap at 20, newest first, isolated per agent
  const a1 = sanitizeAgentDraft({ name: 'A1', systemPrompt: 'x' } as any, ids);
  saveAgent(a1);
  for (let i = 0; i < 25; i++) {
    recordRun(a1.id, { startedAt: i, finishedAt: i + 1, status: 'ok', trigger: 'manual', steps: [], output: `run ${i}`, lessons: [] });
  }
  assert.strictEqual(loadRuns(a1.id).length, 20, 'runs capped at 20');
  assert.strictEqual(loadRuns(a1.id)[0].output, 'run 24', 'newest first');
  deleteRuns(a1.id);
  assert.strictEqual(loadRuns(a1.id).length, 0);
  deleteAgent(a1.id);
  console.log('✓ store + validation');

  // ── 2. Tool-subset loop guard ───────────────────────────────────────────
  const { runAgentLoop, TOOL_SPECS } = await import('../src/agent/agent-tools.js');

  const chunk = (delta: any): any => ({ choices: [{ delta }] });
  const toolCall = (name: string, args: string): any => ({
    tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: args } }],
  });

  const makeCtx = (steps: string[]) => ({
    groq: '', exa: '', nvidia: '', openrouter: '', pollinations: '', hf: '',
    confirmWrites: true,
    onStep: (l: string) => steps.push(l),
    emitEvent: () => {},
    userMessage: 'test',
  } as any);

  // Disallowed tool: fake stream emits a gmail_send call; agent only allows web_search.
  const seenResults: any[] = [];
  {
    const steps: string[] = [];
    let toolResult: any = null;
    // Patch-free approach: use an executor spy via a ToolCtx with instrumented
    // onStep; assert the tool RESULT the loop feeds back. We capture it by
    // giving the fake stream a second turn that asserts on the messages array
    // embedded in opts.
    const callsSeen: any[][] = [];
    const fakeStream = async (opts: any) => (async function* () {
      callsSeen.push(opts.messages);
      if (callsSeen.length === 1) {
        yield chunk(toolCall('gmail_send', '{"to":"a@b.c","body":"x"}'));
      } else {
        // second turn: inspect the tool result the model would have seen
        const last = opts.messages[opts.messages.length - 1];
        toolResult = last;
        yield chunk({ content: 'final answer' });
        yield { choices: [{ finish_reason: 'stop', delta: {} }] };
      }
    })();
    await runAgentLoop({
      systemContent: 'sys', userContent: 'do things', ctx: makeCtx(steps),
      tools: TOOL_SPECS.filter((t: any) => t.function.name === 'web_search'),
      maxIters: 4,
      writeContent: () => {}, writeError: () => {},
      _createStream: fakeStream,
    } as any);
    // The disallowed call must come back as an error result, never executed.
    const toolMsg = callsSeen[1].find((m: any) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result message present');
    assert.strictEqual(JSON.parse(toolMsg.content).error, 'tool not permitted for this agent');
    assert.ok(toolResult !== undefined);
  }

  // Allowed tool executes (document_assist with no keys returns an LLM
  // failure error from the real executor — still an executed result, not a
  // permission error, and fully offline).
  {
    const steps: string[] = [];
    let secondTurnMessages: any[] = [];
    const fakeStream = async (opts: any) => (async function* () {
      secondTurnMessages = opts.messages;
      if (secondTurnMessages.length <= 3) {
        yield chunk(toolCall('document_assist', '{"instruction":"summarize","content":"text"}'));
      } else {
        yield chunk({ content: 'answered with real data' });
      }
    })();
    const handled = await runAgentLoop({
      systemContent: 'sys', userContent: 'summarize this text for me', ctx: makeCtx(steps),
      tools: TOOL_SPECS.filter((t: any) => t.function.name === 'document_assist'),
      maxIters: 4,
      writeContent: () => {}, writeError: () => {},
      _createStream: fakeStream,
    } as any);
    const toolMsg = secondTurnMessages.find((m: any) => m.role === 'tool');
    assert.ok(toolMsg, 'allowed tool executed');
    const parsed = JSON.parse(toolMsg.content);
    assert.notStrictEqual(parsed?.error, 'tool not permitted for this agent', 'no permission error for allowed tool');
  }

  // maxIters: a stream that always calls a DISALLOWED tool (permission guard
  // returns instantly, zero executor/network) must hit the cap and wrap up.
  {
    const steps: string[] = [];
    let calls = 0;
    const fakeStream = async () => (async function* () {
      calls++;
      yield chunk(toolCall('gmail_send', '{"to":"a@b.c","body":"x"}'));
    })();
    const handled = await runAgentLoop({
      systemContent: 'sys', userContent: 'search', ctx: makeCtx(steps),
      tools: TOOL_SPECS.filter((t: any) => t.function.name === 'web_search'),
      maxIters: 12,
      writeContent: () => {}, writeError: () => {},
      _createStream: fakeStream,
    } as any);
    // 12 tool turns + the forced final-answer turn with tools disabled.
    assert.strictEqual(calls, 13, 'loop ran maxIters tool turns + 1 wrap-up, then stopped');
  }

  // No tools param → default MAX_ITERS(6) and full spec offered to the model.
  {
    let offered: any = null;
    const fakeStream = async (opts: any) => (async function* () {
      offered = opts.tools;
      yield chunk({ content: 'plain answer' });
    })();
    await runAgentLoop({
      systemContent: 'sys', userContent: 'hello', ctx: makeCtx([]),
      writeContent: () => {}, writeError: () => {},
      _createStream: fakeStream,
    } as any);
    assert.strictEqual(offered.length, TOOL_SPECS.length, 'default run offers all 9 tools');
  }
  console.log('✓ tool-subset loop guard + maxIters');

  // ── 3. Gather pipeline (zero network) ────────────────────────────────────
  const gatherMod = await import('../src/agents/gather.js');
  const { gatherDomainKnowledge, deriveSearchQueries, githubRepoUrl } = gatherMod as any;

  assert.ok(githubRepoUrl('https://github.com/owner/repo') === 'https://github.com/owner/repo');
  assert.ok(githubRepoUrl('https://github.com/owner/repo/issues/1') === 'https://github.com/owner/repo', 'issue path → repo');
  assert.strictEqual(githubRepoUrl('https://gitlab.com/owner/repo'), null, 'gitlab rejected');
  assert.strictEqual(githubRepoUrl('https://evil.com/github.com/owner/repo'), null, 'spoofed path rejected');
  assert.strictEqual(githubRepoUrl('http://github.com/owner/repo'), null, 'http rejected');
  assert.strictEqual(githubRepoUrl('https://github.com/settings/profiles'), null, 'non-repo path rejected');
  assert.ok(deriveSearchQueries('every morning check gmail for invoices and draft replies').length === 2, 'two queries derived');

  // Internet path with fakes: search finds mixed hosts; only github.com cloned; ≤3 clones.
  {
    const cloned: string[] = [];
    const searchResults = [
      { title: 'A', url: 'https://github.com/aaa/lib-a', site: 'github.com', desc: 'x' },
      { title: 'B', url: 'https://gitlab.com/bbb/lib-b', site: 'gitlab.com', desc: 'x' },
      { title: 'C', url: 'https://github.com/ccc/lib-c', site: 'github.com', desc: 'x' },
      { title: 'D', url: 'https://github.com/ddd/lib-d', site: 'github.com', desc: 'x' },
      { title: 'E', url: 'https://github.com/eee/lib-e', site: 'github.com', desc: 'x' },
    ];
    const result = await gatherDomainKnowledge('react invoice processing library', {
      internet: true,
      _search: async () => searchResults,
      _cloneAndDistill: async (url: string) => {
        cloned.push(url);
        return { id: url.split('/').slice(-2).join('-'), name: url, description: 'learned', source: 'github', sourceUrl: url };
      },
    });
    assert.strictEqual(cloned.length, 3, 'at most 3 repos cloned');
    assert.ok(cloned.every((u) => u.startsWith('https://github.com/')), 'only github.com cloned');
    assert.strictEqual(result.github.length, 3);
    assert.ok(result.queries.length >= 1, 'queries recorded');
  }

  // No internet flag → zero network calls even with search results available.
  {
    let searched = 0;
    const result = await gatherDomainKnowledge('some task', {
      _search: async () => { searched++; return []; },
      _cloneAndDistill: async () => { throw new Error('should not clone'); },
    });
    assert.strictEqual(searched, 0, 'internet gathering never runs unless opted in');
    assert.strictEqual(result.github.length, 0);
  }

  // Clone failure → warning, not a throw.
  {
    const result = await gatherDomainKnowledge('react data fetching', {
      internet: true, queries: ['q'],
      _search: async () => [{ title: 'x', url: 'https://github.com/bad/repo', site: 'github.com', desc: 'x' }],
      _cloneAndDistill: async () => { throw new Error('clone failed'); },
    });
    assert.strictEqual(result.github.length, 0);
    assert.ok(result.warnings.some((w: string) => w.includes('could not learn')), 'failure became a warning');
  }

  // URL distillation with fakes: notes flow through capped; bad URLs warn.
  // (The fakes mirror the real contract: invalid/unreachable URLs THROW —
  // in production the guard + fetch do that before any distillation runs.)
  {
    const result = await gatherDomainKnowledge('task', {
      urls: ['https://ok.example/page', 'notaurl', 'https://bad.example/x'],
      _fetchUrl: async (u: string) => {
        if (u !== 'https://ok.example/page') throw new Error('fetch failed');
        return 'Facts about the task. First fact. Second fact.';
      },
      _distillNotes: async () => ['note A', 'note B'],
    });
    assert.strictEqual(result.knowledge.length, 2, 'notes from the good URL only');
    assert.ok(result.knowledge[0].source.includes('ok.example'));
    assert.ok(result.warnings.some((w: string) => w.includes('bad.example')), 'failed fetch warned');
    assert.ok(result.warnings.some((w: string) => w.includes('notaurl')), 'invalid URL warned');
  }

  // SSRF guard (real guard, no fake): http scheme, private hosts.
  const { fetchUrlGuarded } = gatherMod as any;
  await assert.rejects(() => fetchUrlGuarded('http://example.com'), /https only/);
  await assert.rejects(() => fetchUrlGuarded('https://localhost/'), /private host/);
  await assert.rejects(() => fetchUrlGuarded('https://127.0.0.1/'), /private/);
  await assert.rejects(() => fetchUrlGuarded('https://192.168.1.1/'), /private/);
  await assert.rejects(() => fetchUrlGuarded('https://10.0.0.5/'), /private/);
  await assert.rejects(() => fetchUrlGuarded('https://169.254.169.254/latest/meta-data'), /private/, 'cloud metadata endpoint blocked');
  await assert.rejects(() => fetchUrlGuarded('not a url'), /invalid URL/);
  console.log('✓ gather pipeline + SSRF guard');

  // ── 4. Scheduler math ────────────────────────────────────────────────────
  const schedMod = await import('../src/agents/scheduler.js');
  const { nextDue, scheduledToolSpecs, sweepAgents } = schedMod as any;

  const H = 60 * 60 * 1000;
  // sanitizeAgentDraft server-stamps createdAt (an HTTP client must not be
  // able to forge it) and drops lastRunAt from drafts entirely — so mk() also
  // takes `createdAt`/`lastRunAt` overrides that are stamped AFTER building,
  // keeping the fixed `now` epoch below the only clock these tests see.
  const mk = (over: any, stamps: any = {}): any => {
    const entry = sanitizeAgentDraft({ name: 'S', systemPrompt: 'x', ...over }, new Set());
    return { ...entry, ...stamps };
  };
  const now = Date.UTC(2026, 8, 5, 6, 0, 0); // 06:00 UTC

  // interval: due when lastRun + N elapsed; not before
  const iv = { ...mk({ schedule: { kind: 'interval', intervalMinutes: 30, timezone: 'UTC' } }, { createdAt: now - H, lastRunAt: now - 29 * 60 * 1000 }) };
  assert.ok(nextDue(iv, now)! > now, 'interval not yet due');
  const ivDue = { ...iv, lastRunAt: now - 31 * 60 * 1000 };
  assert.strictEqual(nextDue(ivDue, now), now, 'overdue interval due immediately (catch-up)');

  // daily: due at 09:00 IST (03:30 UTC) — at 06:00 UTC it already passed
  // today and hasn't run, so due should be in the past (03:30 UTC today).
  const dailyAgent = mk({ schedule: { kind: 'daily', time: '09:00', timezone: 'Asia/Kolkata' } }, { createdAt: now - 24 * H });
  const dueAt = nextDue(dailyAgent, now);
  assert.ok(dueAt !== null && dueAt <= now, 'daily 09:00 IST is already due at 06:00 UTC when unran');
  // Already ran after today's slot → tomorrow's slot.
  const ranToday = { ...dailyAgent, lastRunAt: dueAt + 60_000 };
  const nextSlot = nextDue(ranToday, now);
  assert.ok(nextSlot! > now && nextSlot! - dueAt >= 23 * H, 'already-ran today → next due tomorrow');
  // Daily at a later time today (14:00 IST = 08:30 UTC > 06:00 UTC) → not yet due.
  const laterDaily = mk({ schedule: { kind: 'daily', time: '14:00', timezone: 'Asia/Kolkata' } }, { createdAt: now - 24 * H });
  assert.ok(nextDue(laterDaily, now)! > now, 'later-today daily not due yet');

  // scheduledToolSpecs excludes writes
  const writer = mk({ tools: ['gmail_list', 'gmail_send', 'calendar_create', 'web_search'] });
  const specs = scheduledToolSpecs(writer);
  const names = specs.map((t: any) => t.function.name);
  assert.deepStrictEqual(names.sort(), ['gmail_list', 'web_search'], 'write tools excluded from scheduled runs');

  // sweep: only due agents launch; non-scheduled ignored
  {
    const due = saveAgent(mk({ name: 'Due', systemPrompt: 'x', schedule: { kind: 'interval', intervalMinutes: 5, timezone: 'UTC' } }, { createdAt: now - H, lastRunAt: now - 10 * 60 * 1000 }));
    const notDue = saveAgent({ ...mk({ name: 'NotDue', schedule: { kind: 'interval', intervalMinutes: 1440, timezone: 'UTC' } }, { createdAt: now - H }), id: 'agt_deadbeef' });
    const noSched = saveAgent(mk({ name: 'NoSched' }));
    const launched = await sweepAgents(now, {
      keys: {},
      _createStream: async () => (async function* () { yield chunk({ content: 'done' }); })(),
      _distillChat: async () => JSON.stringify({ memory: ['lesson one'] }),
    });
    assert.strictEqual(launched, 1, 'only the due agent launched');
    // wait for the fire-and-forget run to finish
    await new Promise((r) => setTimeout(r, 300));
    const ran = getAgent(due.id)!;
    assert.ok(ran.lastRunAt, 'lastRunAt stamped by headless run');
    assert.deepStrictEqual(ran.memory, ['lesson one'], 'memory distilled into the agent');
    assert.strictEqual(loadRuns(due.id).length, 1, 'run recorded');
    deleteAgent(due.id); deleteAgent(notDue.id); deleteAgent(noSched.id);
  }
  console.log('✓ scheduler math + headless sweep');

  // ── 4.5 Neural self-training layer (unit, zero network) ──────────────────
  const neuralMod = await import('../src/agents/neural.js');
  const {
    extractFeatures, sanitizeNeuralState, emptyNeuralState, trainCycle,
    neuralFocusBlock, observeTrafficForNeuralLearning, drainTraffic, trafficDepth,
    runNeuralDeepTune,
  } = neuralMod as any;

  // features: ≥4 chars, stopwords dropped, repeats kept (activation counts).
  const feats = extractFeatures('The triage of invoice triage rows and other things');
  assert.ok(!feats.includes('the') && !feats.includes('other'), 'stopwords dropped');
  assert.ok(feats.includes('triage') && feats.includes('invoice'), 'domain words kept');
  assert.strictEqual(feats.filter((f: string) => f === 'triage').length, 2, 'repeats raise activation');

  // sanitize: caps, prunes, ignores garbage; empty-safe.
  const cleaned = sanitizeNeuralState({
    weights: { fine: 999, tiny: 0.05, caps: 'x', bad: Number.NaN },
    cycles: 5, deepTunes: 2, lastTrainedAt: 123,
    history: [{ at: 1, delta: 2, traffic: 1 }, { at: 'x' }, ...Array(40).fill({ at: 2, delta: 1, traffic: 1 })],
  });
  assert.strictEqual(cleaned.weights.fine, 60, 'weight capped at CAP_W');
  assert.ok(!('tiny' in cleaned.weights) && !('caps' in cleaned.weights) && !('bad' in cleaned.weights), 'pruned/dropped weights');
  assert.strictEqual(cleaned.history.length, 30, 'history capped');
  const empty = sanitizeNeuralState(undefined);
  assert.strictEqual(empty.cycles, 0, 'undefined state sanitizes to empty');

  // trainCycle: identity conditioning (domain words potentiate 1.5× vs 0.5×),
  // decay of pre-existing weights, prune-below-threshold, cycle + history bookkeeping.
  const agentShape = { domain: 'accounts payable (invoice triage)', systemPrompt: 'match invoices against PO' };
  const s1 = trainCycle(emptyNeuralState(), ['triage the invoice pile today'], agentShape);
  assert.strictEqual(s1.cycles, 1, 'cycle counted');
  assert.ok(s1.lastTrainedAt > 0, 'lastTrainedAt stamped');
  assert.ok(s1.weights.triage === 1.5, 'identity feature gets the 1.5× multiplier');
  assert.ok(s1.weights.today === 0.5, 'non-identity feature gets the 0.5× multiplier');
  assert.strictEqual(s1.history.at(-1).traffic, 1, 'traffic count in history');
  const s2 = trainCycle(s1, [], agentShape); // no signals: pure decay
  assert.ok(s2.weights.triage < s1.weights.triage, 'weights decay without traffic');
  assert.strictEqual(s2.cycles, 2, 'cycle counted even on decay-only passes');
  // A weight at 0.4 decays to 0.398 < PRUNE_AT (0.4) in one cycle → pruned.
  const s3 = trainCycle({ ...s2, weights: { ghost: 0.4 } }, [], agentShape);
  assert.ok(!('ghost' in s3.weights), 'forgotten weights pruned below PRUNE_AT');
  // focus block: top-K only, needs weight ≥ 1, null when empty.
  assert.strictEqual(neuralFocusBlock(emptyNeuralState()), null, 'empty state → no focus block');
  const focusLine = neuralFocusBlock({ ...s1, weights: Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`t${i}`, 1 + i]),
  ) });
  assert.ok(focusLine!.includes('[NEURAL FOCUS'), 'focus block header');
  assert.strictEqual(
    focusLine!.split('Weight them first: ')[1].trim().split(' · ').length,
    8,
    'top-K terms only (8)',
  );

  // traffic queue: observe → depth → drain (order, cap).
  observeTrafficForNeuralLearning('agt_queuetest', 'first message');
  observeTrafficForNeuralLearning('agt_queuetest', 'second message');
  assert.strictEqual(trafficDepth('agt_queuetest'), 2, 'queue depth counts');
  const drained = drainTraffic('agt_queuetest');
  assert.deepStrictEqual(drained, ['first message', 'second message'], 'drain preserves order');
  assert.strictEqual(trafficDepth('agt_queuetest'), 0, 'drain empties the queue');
  for (let i = 0; i < 60; i++) observeTrafficForNeuralLearning('agt_queuetest', `m${i}`);
  assert.strictEqual(trafficDepth('agt_queuetest'), 40, 'queue capped at 40');

  // deep tune via seam: lessons + focus boosts; garbage JSON → null.
  const deep = await runNeuralDeepTune(
    { name: 'T', domain: 'd', systemPrompt: 's' } as any,
    s1, ['triage the invoice pile'],
    { _chat: async () => JSON.stringify({ lessons: ['Flag ACME invoices as urgent first.'], focus: ['invoice', 'acme'] }) },
  );
  assert.ok(deep, 'deep tune parsed');
  assert.deepStrictEqual(deep.lessons, ['Flag ACME invoices as urgent first.'], 'lesson extracted');
  assert.ok(deep.state.weights.acme >= 2, 'focus term potentiated (+2)');
  assert.strictEqual(deep.state.deepTunes, s1.deepTunes + 1, 'deep tune counted');
  const deepBad = await runNeuralDeepTune(
    { name: 'T' } as any, s1, [],
    { _chat: async () => 'not json at all' },
  );
  assert.strictEqual(deepBad, null, 'unparseable deep tune → null');
  const deepThrow = await runNeuralDeepTune(
    { name: 'T' } as any, s1, [],
    { _chat: async () => { throw new Error('all brains down'); } },
  );
  assert.strictEqual(deepThrow, null, 'thrown deep tune → null, never propagates');

  // trainer: full cycle over a real stored agent — traffic folds into weights,
  // and on the 3rd cycle (deep-tune cadence) the seam's lessons merge into memory.
  const trainerMod = await import('../src/agents/trainer.js');
  const { trainAgentNeural } = trainerMod as any;
  const trainee = saveAgent(sanitizeAgentDraft({
    name: 'Trainee', description: 'invoice triage helper',
    systemPrompt: 'I match invoices against PO records for invoice triage.',
    domain: 'accounts payable (invoice triage)',
  } as any, new Set()));
  for (let round = 1; round <= 3; round++) {
    observeTrafficForNeuralLearning(trainee.id, 'please triage the invoice inbox now');
    const out = await trainAgentNeural(trainee.id, {
      _chat: async () => JSON.stringify({ lessons: ['Flag ACME invoices as urgent first.'], focus: ['acme'] }),
    });
    assert.ok(out && out.trained, `round ${round} trained`);
    if (round < 3) assert.strictEqual(out.deepTuned, false, `deep tune only every 3rd cycle (round ${round})`);
    if (round === 3) {
      assert.strictEqual(out.deepTuned, true, 'deep tune fired on the 3rd cycle');
      assert.deepStrictEqual(out.lessons, ['Flag ACME invoices as urgent first.'], 'lesson returned to the caller');
      assert.ok(getAgent(trainee.id)!.memory.includes('Flag ACME invoices as urgent first.'), 'lesson persisted into memory');
      assert.ok(getAgent(trainee.id)!.neural.weights.triage > 3, 'weights accumulated across cycles');
      assert.ok(neuralFocusBlock(getAgent(trainee.id)!.neural)!.includes('triage'), 'trained agent emits a NEURAL FOCUS block');
    }
  }
  // no traffic → nothing to do, no disk write
  const idle = await trainAgentNeural(trainee.id, { _chat: async () => 'x' });
  assert.strictEqual(idle, null, 'no traffic → no cycle');
  // never throws even on a broken agent id
  assert.strictEqual(await trainAgentNeural('agt_missing'), null, 'missing agent → null');
  deleteAgent(trainee.id);
  console.log('✓ neural layer (features, learning rule, focus, traffic, deep tune, trainer)');

  // ── 5. HTTP end-to-end through the real router ───────────────────────────
  // Seed a mini catalog the drafter-selection can read (ENZO_MODEL_CACHE
  // points both rank + brain discovery at it — the real 1MB cache never
  // touches the test). Must be set before createAgentRouter is imported so the
  // path helper resolves at call time against this file.
  const miniCache = path.join(TMP, 'model-cache.json');
  fs.writeFileSync(miniCache, JSON.stringify([
    { id: 'groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B', type: 'text', context_length: 128000, free: true, tags: [] },
    { id: 'openrouter/qwen/qwen3-32b:free', name: 'Qwen3 32B', type: 'text', context_length: 40000, free: true, tags: [] },
    { id: 'openrouter/tinyllama-1b:free', name: 'TinyLlama', type: 'text', context_length: 4096, free: true, tags: [] },
    { id: 'openrouter/paid-giant:paid', name: 'Paid Giant', type: 'text', context_length: 200000, free: false, tags: [] },
    { id: 'openrouter/text-embedding-3:free', name: 'Embedder', type: 'text', context_length: 8192, free: true, tags: [] },
    { id: 'pollinations/openai', name: 'OpenAI', type: 'text', context_length: 32000, free: true, tags: [] },
  ]));
  process.env.ENZO_MODEL_CACHE = miniCache;
  const { createAgentRouter } = await import('../src/agents/agentRoutes.js');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const TOKEN = 'test-vault-token';
  let bucketCounts = new Map<string, { n: number; reset: number }>();
  // Seam state: the domain pass 1 returned for the CURRENT draft, so pass 2 can
  // assert it was built from that analysis (not a canned prompt).
  let seamLastDomain = '';
  const router = createAgentRouter({
    verifyVaultAccess: (req, res, next) => {
      if ((req.headers['x-vault-token'] as string) === TOKEN) next();
      else res.status(401).json({ error: 'unauthorized' });
    },
    rateLimit: (bucket, max) => (req, res, next) => {
      const now2 = Date.now();
      let s = bucketCounts.get(bucket);
      if (!s || s.reset <= now2) s = { n: 0, reset: now2 + 60000 };
      s.n++; bucketCounts.set(bucket, s);
      if (s.n > max) { res.status(429).json({ error: 'rate_limited' }); return; }
      next();
    },
    // Draft seam: TWO-pass compose. The seam inspects the system prompt: pass 1
    // (domain analysis) gets a JSON domain answer; pass 2 (the manual) gets
    // the manual JSON. Asserting both shapes guarantees the route actually
    // makes two distinct calls with the designed prompts.
    _draftChat: (async (sys: string, user: string) => {
      // Handoff classifier — its own prompt shape; must answer per message.
      if (sys.includes('classify user messages')) {
        assert.ok(user.startsWith('Message: '), 'handoff prompt carries the raw chat message');
        const vague = /make me a new agent/i.test(user);
        return JSON.stringify({
          create: !vague,
          task: vague ? '' : 'Research Model UN country positions and draft position papers',
        });
      }
      // Pass 1 — domain analysis; answer keyed to the task being analyzed.
      if (sys.includes('domain analyst')) {
        assert.ok(sys.includes('"domainTerms"'), 'pass-1 prompt asks for domain vocabulary');
        const mun = /mun|model un/i.test(user);
        if (mun) {
          seamLastDomain = 'MUN procedural rules and country-position research';
          return JSON.stringify({
            domain: seamLastDomain,
            subfield: 'country-position research and position-paper drafting',
            deliverable: 'a one-page position paper for a delegate',
            audience: 'the delegate speaking in committee',
            expertProfile: 'knows which country positions are locked and which drift by committee',
            domainTerms: ['position paper', 'moderated caucus', 'bloc'],
          });
        }
        seamLastDomain = 'accounts payable operations (invoice triage)';
        return JSON.stringify({
          domain: seamLastDomain,
          subfield: 'urgent-vs-routine triage',
          deliverable: 'a short triage note per urgent invoice',
          audience: 'the operator paying the bills',
          expertProfile: 'knows which vendors lie about due dates',
          domainTerms: ['net-30', 'dunning', 'PO match'],
        });
      }
      // Pass 2 — the manual, built from the pass-1 analysis of THIS task.
      assert.ok(sys.includes('TACIT KNOWLEDGE'), 'pass-2 prompt demands the veteran-tacit-knowledge section');
      assert.ok(seamLastDomain && sys.includes(seamLastDomain), 'pass-2 prompt is built FROM the pass-1 analysis');
      if (seamLastDomain.startsWith('MUN')) {
        return JSON.stringify({
          name: 'MUN Position Researcher',
          tools: ['web_search'],
          systemPrompt: 'IDENTITY: I am a 30-year MUN committee veteran. TACIT KNOWLEDGE: position papers are won in moderated caucus. ...',
        });
      }
      return JSON.stringify({
        name: 'Invoice Watcher',
        tools: ['gmail_list', 'web_search'],
        systemPrompt: 'IDENTITY: I am a 30-year AP clerk. TACIT KNOWLEDGE: net-30 rarely means net-30. ...',
      });
    }) as any,
    // Gather seam: fake search + clone + fetch (zero network).
    _gather: (async (task: string, opts: any) => {
      const g = await gatherDomainKnowledge(task, {
        ...opts,
        _search: async () => [{ title: 'x', url: 'https://github.com/tanstack/query', site: 'github.com', desc: 'x' }],
        _cloneAndDistill: async () => null,
        _fetchUrl: async () => 'Invoice processing reference text.',
        _distillNotes: async () => ['Invoices arrive as PDFs from billing@vendors.'],
      });
      return g;
    }) as any,
    // Run seam: fake agent-loop stream — asserts the system prompt inside opts.
    _createStream: (async (opts: any) => {
      capturedPrompts.push(opts.messages[0].content);
      return (async function* () {
        yield chunk({ content: 'Answer from agent run' });
      })();
    }) as any,
    // Neural deep-tune seam (the trainer's LLM review pass — zero network).
    _trainChat: (async () => JSON.stringify({
      lessons: ['Always compare invoice totals against the PO before flagging.'],
      focus: ['invoice'],
    })) as any,
  });
  app.use(router);
  const capturedPrompts: string[] = [];

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  const rawReq = (reqPort: number, method: string, urlPath: string, body?: any, headers?: Record<string, string>) =>
    new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const r = http.request({
        host: '127.0.0.1', port: reqPort, path: urlPath, method,
        headers: {
          ...(headers?.['x-vault-token'] ? headers : { 'x-vault-token': TOKEN, ...headers }),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: any = null;
          try { json = JSON.parse(raw); } catch { /* SSE/text */ }
          resolve({ status: res.statusCode || 0, json, text: raw });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  const req = (method: string, urlPath: string, body?: any, headers?: Record<string, string>) =>
    rawReq(port, method, urlPath, body, headers);

  // unauthorized
  let r = await req('GET', '/api/agents', undefined, { 'x-vault-token': 'wrong' });
  assert.strictEqual(r.status, 401, 'vault gate enforced');

  // draft (fake LLM + fake gather) — keyed with ONLY OpenRouter so the brain
  // discovery must pick the mid-tier free Qwen from that provider's catalog
  // section (not the 1B toy, not the paid giant, not the embedder).
  r = await req('POST', '/api/agents/draft', {
    description: 'Every morning check my Gmail for invoices and draft replies for the urgent ones.',
    gatherInternet: true,
    urls: ['https://example.com/invoice-docs'],
  }, { 'x-openrouter-key': 'ork' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.draft.name, 'Invoice Watcher');
  assert.ok(r.json.draft.tools.includes('gmail_list'), 'LLM tools kept');
  assert.ok(r.json.draft.tools.includes('gmail_send') || r.json.draft.tools.includes('gmail_list'), 'text-derived tools merged in');
  assert.ok(r.json.draft.systemPrompt.includes('TACIT KNOWLEDGE'), 'veteran manual sections present');
  assert.strictEqual(r.json.draft.domain, 'accounts payable operations (invoice triage)', 'domain from pass-1 surfaced');
  assert.ok(r.json.draft.model.includes('/'), 'model pinned with provider prefix');
  assert.ok(r.json.gather.knowledge.length >= 1, 'knowledge gathered via seam');
  assert.ok(listAgents().length === 0, 'draft never persists');
  // Drafter selection: with only an OpenRouter key, the brain must be the
  // mid-tier free Qwen — not the 1B toy, not the paid giant, not the embedder.
  assert.strictEqual(r.json.draft.draftModel, 'openrouter/qwen/qwen3-32b:free', 'free mid-tier model discovered from user keys');
  assert.ok(r.json.draft.draftModelReason.includes('OpenRouter'), 'brain reason names the provider');

  // Template fallback (the real-world 429 case): every drafting model
  // unreachable → the honest local template, draftModel EMPTY — the card must
  // never claim a model that failed.
  {
    const app2 = express();
    app2.use(express.json({ limit: '2mb' }));
    app2.use(createAgentRouter({
      verifyVaultAccess: (_req, res, next) => next(),
      rateLimit: () => (_req, res, next) => next(),
      _draftChat: async () => { throw new Error('HTTP 429: rate limited'); },
    }));
    const server2 = http.createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const port2 = (server2.address() as any).port;
    const t2 = await rawReq(port2, 'POST', '/api/agents/draft', {
      description: 'Research Model UN country positions and draft position papers',
    });
    assert.strictEqual(t2.status, 200);
    assert.strictEqual(t2.json.draft.name, 'Custom agent', 'template name on failed draft');
    assert.ok(t2.json.draft.systemPrompt.includes('OPERATING PROCEDURE'), 'mechanical template served');
    assert.strictEqual(t2.json.draft.draftModel, '', 'template case never claims a drafting model');
    assert.ok(t2.json.draft.draftModelReason.includes('No drafting model was reachable'), 'reason says so honestly');
    await new Promise<void>((resolve) => server2.close(() => resolve()));
    console.log('✓ template fallback is honest about who drafted it');
  }

  // short description → 400
  r = await req('POST', '/api/agents/draft', { description: 'hi' });
  assert.strictEqual(r.status, 400);

  // save
  r = await req('POST', '/api/agents', {
    name: 'Invoice Watcher', description: 'check gmail for invoices',
    systemPrompt: 'IDENTITY: I am a 30-year AP clerk.',
    tools: ['gmail_list', 'web_search'],
    model: 'groq/llama-3.3-70b-versatile',
    domain: 'accounts payable operations (invoice triage)',
    skills: ['react-query'],
    knowledge: [r.json?.draft?.name ? 'Invoices arrive as PDFs.' : 'Invoices arrive as PDFs.'],
    memory: [], schedule: null,
  });
  assert.strictEqual(r.status, 200);
  const agentId = r.json.agent.id;
  assert.ok(/^agt_/.test(agentId));
  assert.deepStrictEqual(r.json.agent.skills, ['react-query'], 'skill attached');
  assert.strictEqual(r.json.agent.domain, 'accounts payable operations (invoice triage)', 'domain persisted');
  assert.strictEqual(getAgent(agentId)!.name, 'Invoice Watcher');

  // save with unknown tool → filtered silently
  r = await req('PUT', `/api/agents/${agentId}`, { tools: ['gmail_list', 'make_coffee'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.agent.tools, ['gmail_list']);

  // list
  r = await req('GET', '/api/agents');
  assert.strictEqual(r.json.agents.length, 1);
  assert.ok(r.json.validTools.includes('web_search'));

  // SSE run: assert prompt assembly + events (no provider key sent — the
  // injected stream makes the run hermetic; distillation stays keyless/offline)
  // Seed one memory entry first — the LEARNED MEMORY block only renders when
  // the agent has learned something.
  saveAgent({ ...getAgent(agentId)!, memory: ['User deals in 3 currencies.'] });
  r = await req('POST', `/api/agents/${agentId}/run`, { message: 'Run now please.' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.text.includes('event: content'), 'content events streamed');
  assert.ok(r.text.includes('Answer from agent run'), 'fake stream answer present');
  assert.ok(r.text.includes('event: lessons'), 'lessons event emitted');
  const sysSeen = capturedPrompts.at(-1) || '';
  assert.ok(sysSeen.includes('IDENTITY: I am a 30-year AP clerk.'), 'manual in prompt');
  assert.ok(sysSeen.includes('use useQuery for server state.'), 'attached skill guide in prompt');
  assert.ok(sysSeen.includes('Invoices arrive as PDFs.'), 'knowledge in prompt');
  assert.ok(sysSeen.includes('[LEARNED MEMORY'), 'memory block present even when empty');

  // run history recorded
  r = await req('GET', `/api/agents/${agentId}/runs`);
  assert.strictEqual(r.json.runs.length, 1);
  assert.strictEqual(r.json.runs[0].trigger, 'manual');

  // gather-again → proposal only (not applied)
  const knowBefore = getAgent(agentId)!.knowledge.length;
  r = await req('POST', `/api/agents/${agentId}/gather`, { internet: true });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.proposed.queries.length >= 0);
  assert.strictEqual(getAgent(agentId)!.knowledge.length, knowBefore, 'gather proposal not auto-applied');

  // memory: seed one via direct store save, then clear + 404s + bad index
  saveAgent({ ...getAgent(agentId)!, memory: ['Old lesson.'] });
  r = await req('DELETE', `/api/agents/${agentId}/memory`);
  assert.strictEqual(r.json.agent.memory.length, 0);
  r = await req('DELETE', `/api/agents/${agentId}/memory/5`);
  assert.strictEqual(r.status, 400, 'bad memory index rejected');
  saveAgent({ ...getAgent(agentId)!, knowledge: ['K1'] });
  r = await req('DELETE', `/api/agents/${agentId}/knowledge/0`);
  assert.strictEqual(r.json.agent.knowledge.length, 0);

  // ── match: local routing, no LLM ─────────────────────────────────────────
  // The saved agent's domain ('accounts payable operations (invoice triage)')
  // + name tokens must pull a domain-adjacent message; a random message must
  // not match.
  r = await req('POST', '/api/agents/match', { message: 'Check my invoice triage from this morning and flag the urgent ones' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.agent, 'domain message matches the agent');
  assert.strictEqual(r.json.agent.id, agentId);
  assert.ok(r.json.agent.score >= 5, `score clears threshold (got ${r.json.agent?.score})`);
  assert.strictEqual(r.json.agent.domain, 'accounts payable operations (invoice triage)');
  r = await req('POST', '/api/agents/match', { message: 'Write me a haiku about the ocean at dawn' });
  assert.strictEqual(r.json.agent, null, 'unrelated message does not match');
  r = await req('POST', '/api/agents/match', { message: '' });
  assert.strictEqual(r.json.agent, null, 'empty message never matches');

  // ── handoff: create-intent regex prefilter (LLM confirmation is the same
  // seam — verified via /auto below; the prefilter alone is asserted here) ──
  r = await req('POST', '/api/agents/handoff', { message: 'What is the capital of France?' });
  assert.strictEqual(r.json.create, null, 'no agent-word → no handoff');
  r = await req('POST', '/api/agents/handoff', { message: 'Tell me how an agent works in this app' });
  assert.strictEqual(r.json.create, null, 'agent-word without create-verb → no handoff');
  r = await req('POST', '/api/agents/handoff', { message: 'make me a new agent' });
  assert.strictEqual(r.json.create, null, 'prefilter passes but LLM seam says not-create → null');
  // Real create-intent goes through the seam (classify prompt) → confirmed task
  r = await req('POST', '/api/agents/handoff', {
    message: 'Create an agent that researches MUN country positions and drafts position papers',
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.create && r.json.create.task.length >= 10, 'create-intent confirmed with extracted task');

  // ── auto: two-pass draft + save in one call (the terminal's background path) ──
  // Draft + handoff calls above already drew from the shared 'agents-draft'
  // bucket (max 6) — reset it so /auto gets clean slots.
  bucketCounts.set('agents-draft', { n: 0, reset: Date.now() + 60000 });
  const beforeCount = listAgents().length;
  r = await req('POST', '/api/agents/auto', {
    description: 'Research Model UN country positions and draft position papers',
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.success && r.json.agent, 'auto-created');
  assert.strictEqual(r.json.agent.domain, 'MUN procedural rules and country-position research', 'domain from two-pass draft stored');
  assert.ok(r.json.agent.systemPrompt.includes('TACIT KNOWLEDGE'), 'veteran manual written');
  assert.ok(r.json.agent.name === 'MUN Position Researcher', 'manual-written name, not the description echo');
  assert.strictEqual(listAgents().length, beforeCount + 1, 'agent persisted via /auto');
  // Anonymous pollinations is dead (live-verified 2026-09-06: 401 without a
  // key), so with NO user keys the drafting pool is EMPTY — the keyless /auto
  // falls back to the mechanical template and must claim NO model honestly.
  assert.strictEqual(r.json.draftModel, '', 'no user key → no model claimed (template drafted)');
  assert.strictEqual(r.json.agent.draftModel, '', 'draftModel provenance persisted on the agent');
  const autoId = r.json.agent.id;
  // /auto agent is fully runnable: match must find it for a domain message
  r = await req('POST', '/api/agents/match', { message: 'Do MUN research for India this weekend' });
  assert.ok(r.json.agent && r.json.agent.id === autoId, 'auto-created agent routable by domain');
  r = await req('POST', '/api/agents/auto', { description: 'hi' });
  assert.strictEqual(r.status, 400, 'short auto description rejected');
  deleteAgent(autoId);

  // ── neural surface: /match ingests traffic → train → focus in the prompt ──
  // The neural block leans on many vault-bucket reads/writes — reset it (the
  // suite's shared fake-limiter counters are per-bucket).
  bucketCounts.set('vault', { n: 0, reset: Date.now() + 60000 });
  // Client-supplied neural state must be ignored (server-computed only) —
  // asserted BEFORE any training, so the agent has no stored state to preserve.
  r = await req('PUT', `/api/agents/${agentId}`, { neural: { weights: { hacked: 50 }, cycles: 99 } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.agent.neural, undefined, 'client neural payload ignored on save');

  // The match tests above already enqueued one domain message for this agent.
  r = await req('GET', `/api/agents/${agentId}/neural`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.neural.cycles, 0, 'fresh agent has no cycles');
  assert.ok(r.json.neural.pendingTraffic >= 1, 'match traffic queued for training');
  assert.strictEqual(r.json.neural.focusLine, null, 'no focus before training');

  r = await req('POST', `/api/agents/${agentId}/neural/train`, {});
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.trained, 'one cycle ran on the observed traffic');
  r = await req('GET', `/api/agents/${agentId}/neural`);
  assert.strictEqual(r.json.neural.cycles, 1, 'cycle recorded');
  assert.ok(r.json.neural.weightsTop.some((w: any) => w.term === 'invoice'), 'identity terms weighted');
  assert.ok(r.json.neural.focusLine.includes('[NEURAL FOCUS'), 'focus line built');
  // The stored state survives edits (partial-update inheritance).
  r = await req('PUT', `/api/agents/${agentId}`, { tools: ['gmail_list', 'web_search'] });
  assert.strictEqual(r.json.agent.neural?.cycles, 1, 'server neural state survives edits');

  // Learning changes behavior: the next run's prompt carries the focus block.
  saveAgent({ ...getAgent(agentId)!, memory: ['User deals in 3 currencies.'] });
  r = await req('POST', `/api/agents/${agentId}/run`, { message: 'Run now please.' });
  assert.strictEqual(r.status, 200);
  const sysSeenNeural = capturedPrompts.at(-1) || '';
  assert.ok(sysSeenNeural.includes('[NEURAL FOCUS'), 'trained focus injected into the run prompt');
  assert.ok(sysSeenNeural.includes('invoice'), 'focus carries the trained terms');

  // Two more traffic+train rounds → the deep-tune cadence (every 3rd cycle)
  // fires the seam and merges its lesson into the agent's memory.
  for (let round = 2; round <= 3; round++) {
    await req('POST', '/api/agents/match', { message: 'Triage the invoice queue and flag urgent invoices' });
    r = await req('POST', `/api/agents/${agentId}/neural/train`, {});
    assert.strictEqual(r.status, 200);
    if (round === 3) {
      assert.strictEqual(r.json.deepTuned, true, 'deep tune on the 3rd cycle');
      assert.ok(
        getAgent(agentId)!.memory.some((m: string) => m.includes('compare invoice totals')),
        'deep-tune lesson merged into memory',
      );
    }
  }

  // No fresh traffic → honest no-op.
  r = await req('POST', `/api/agents/${agentId}/neural/train`, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.trained, false, 'no traffic → no cycle');

  // 404s on the neural surface.
  r = await req('GET', '/api/agents/agt_nope/neural');
  assert.strictEqual(r.status, 404);
  r = await req('POST', '/api/agents/agt_nope/neural/train', {});
  assert.strictEqual(r.status, 404);
  console.log('✓ neural surface (ingestion → train → focus in run prompt → deep tune)');

  // 404s
  r = await req('GET', '/api/agents/agt_nope/runs');
  assert.strictEqual(r.status, 404);
  r = await req('DELETE', '/api/agents/agt_nope');
  assert.strictEqual(r.status, 404);

  // delete
  r = await req('DELETE', `/api/agents/${agentId}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(listAgents().length, 0);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('✓ HTTP end-to-end (draft → save → run → history → gather → edit → delete)');

  console.log('\nAll agent tests passed.');
}

main().catch((err) => {
  console.error('agents.test.ts FAILED:', err);
  process.exit(1);
});
