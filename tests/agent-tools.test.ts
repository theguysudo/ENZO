/**
 * agent-tools.test.ts — self-check for the agent loop (ponytail: one runnable
 * check for the non-trivial control flow). Run with: npx tsx agent-tools.test.ts
 *
 * Exercises the streaming tool-call accumulation + message-array contract
 * WITHOUT a live Groq key by injecting a fake stream factory.
 */
import assert from 'assert';
import { runAgentLoop, type ToolCtx } from '../src/agent/agent-tools.js';

async function fakeStreamFactory(script: AsyncIterable<any>[]) {
  let i = 0;
  return async function createStream() {
    if (i >= script.length) throw new Error('fake stream exhausted');
    return script[i++];
  };
}

function chunk(delta: any): any {
  return { choices: [{ delta }] };
}

async function main() {
  const emitted: string[] = [];
  const steps: string[] = [];
  const ctx: ToolCtx = {
    groq: 'test', exa: '', nvidia: '', openrouter: '', pollinations: '', hf: '',
    confirmWrites: true,
    onStep: (l) => steps.push(l),
    emitEvent: (event) => emitted.push(event),
    userMessage: '',
  };

  // Turn 1: tool call, name split across deltas + args split across deltas.
  // Sentinel name → executeTool's default branch (hermetic: no network/fs).
  const toolCallStream = (async function* () {
    yield chunk({});
    yield chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: '__test_', arguments: '' } }] });
    yield chunk({ tool_calls: [{ index: 0, function: { name: 'noop__', arguments: '{"query":' } }] });
    yield chunk({ tool_calls: [{ index: 0, function: { arguments: '"test query"}' } }] });
  })();

  // Turn 2 (post-tool): plain text answer.
  const finalStream = (async function* () {
    yield chunk({ content: 'Final an' });
    yield chunk({ content: 'swer here.' });
  })();

  const factory = await fakeStreamFactory([toolCallStream, finalStream]);
  const writes: string[] = [];

  const handled = await runAgentLoop({
    groqKey: 'test',
    systemContent: 'sys',
    userContent: 'user',
    ctx,
    writeContent: (t) => writes.push(t),
    writeError: (t) => { throw new Error(`writeError called: ${t}`); },
    _createStream: factory,
  });

  assert.strictEqual(handled, true, 'loop should report handled');

  // Tool name must be reassembled from the split deltas (__test_ + noop__).
  assert.ok(steps.some((s) => s.includes('__test_noop__')), `expected reassembled tool name in step, got: ${steps.join(', ')}`);
  assert.strictEqual(steps.length, 1, `expected exactly one tool step, got ${steps.length}`);

  // Final answer must reach the user (chunking-agnostic: the loop may buffer +
  // clean the full turn before writing, or stream per-delta — either is fine).
  assert.strictEqual(writes.join(''), 'Final answer here.', `final text mismatch: ${JSON.stringify(writes)}`);

  console.log('✓ agent-tools.test.ts: tool-call accumulation, step emission, final streaming all pass');

  // ── Continuation-on-truncation ─────────────────────────────────────────────
  // Turn 1: tools-off final answer hits max_tokens (finish_reason 'length')
  // mid-code-fence. The loop must append the partial text as an assistant turn,
  // push a [CONTINUATION] user turn, and re-invoke streamTurn to finish the
  // project instead of ending the reply mid-fence.
  const truncatedStream = (async function* () {
    yield chunk({ content: 'Here is the app:\n\n```html\n<html>...' });
    yield { choices: [{ delta: {}, finish_reason: 'length' }] };
  })();
  const resumedStream = (async function* () {
    yield chunk({ content: '</html>\n```\nAll done.' });
  })();
  const contFactory = await fakeStreamFactory([truncatedStream, resumedStream]);

  const contEmitted: string[] = [];
  const handledCoding = await runAgentLoop({
    groqKey: 'test',
    systemContent: 'sys',
    userContent: 'build me an app',
    ctx: { ...ctx, userMessage: 'build me an app' },
    writeContent: (t) => contEmitted.push(t),
    writeError: (t) => { throw new Error(`writeError called: ${t}`); },
    _createStream: contFactory,
    mode: 'coding',
    maxTokens: 1500,
  });
  assert.strictEqual(handledCoding, true, 'coding truncated reply should be handled after continuation');
  const fullText = contEmitted.join('');
  assert.ok(fullText.includes('</html>'), `expected continuation to close the fence, got: ${JSON.stringify(fullText.slice(0, 80))}`);

  console.log('✓ agent-tools.test.ts: auto-continuation closes truncated code fences');
}

main().catch((e) => {
  console.error('✗ agent-tools.test.ts FAILED:', e.message);
  process.exit(1);
});

