/**
 * modelPeer.test.ts — self-check for the switch-button recommender's local half.
 *
 * The bug this guards: the terminal recommended `llama-3.3-70b` regardless of
 * what the user was running. A regression here is silent (you still get *a*
 * model, just the wrong-sized one), so it leaves a runnable check behind.
 *
 * Run: `npm test` from the repo root. Lives under synthetic-nature/ but runs on
 * the backend's tsx — modelPeer.ts has no React and no `import.meta.env`, so
 * node loads it as-is (same arrangement as keyVault.test.ts).
 */
import assert from 'assert';
import { modelPower, closestPeer, type PeerModel } from './modelPeer.js';

const m = (id: string, extra: Partial<PeerModel> = {}): PeerModel => ({
  id,
  name: id.split('/').pop() || id,
  type: 'text',
  free: true,
  context_length: 8192,
  ...extra,
});

// 1. Param count is read out of the id, whatever the separator.
assert.strictEqual(modelPower(m('groq/llama-3.3-70b-versatile')), 70);
assert.strictEqual(modelPower(m('groq/llama-3.1-8b-instant')), 8);
assert.strictEqual(modelPower(m('openrouter/qwen/qwen3-235B-a22b')), 235);

// 2. No size in the name → context stands in, clamped to the param-ish range.
assert.strictEqual(modelPower(m('google/gemini-2.5-pro', { context_length: 1_000_000 })), 120);
assert.strictEqual(modelPower(m('pollinations/openai', { context_length: 0 })), 4);

const pool = [
  m('groq/llama-3.1-8b-instant'),
  m('groq/llama-3.3-70b-versatile'),
  m('openrouter/qwen/qwen3-235b-a22b'),
  m('hf/FLUX.1-dev', { type: 'image-gen' }),
];

// 3. The regression itself: someone on an 8B model must NOT be sent to the 70B.
assert.strictEqual(
  closestPeer(pool, m('cloudflare/@cf/meta/llama-3.2-3b-instruct'))?.id,
  'groq/llama-3.1-8b-instant',
  'a small model must be replaced by a small model',
);

// 4. …and someone on a big model must not be downgraded to the 8B.
assert.strictEqual(
  closestPeer(pool, m('openrouter/deepseek/deepseek-v3-250b'))?.id,
  'openrouter/qwen/qwen3-235b-a22b',
  'a large model must be replaced by a large model',
);

// 5. Never recommend the model already in use, and never an image model as a peer.
const noSelf = closestPeer(pool, pool[1]);
assert.notStrictEqual(noSelf?.id, 'groq/llama-3.3-70b-versatile', 'must not suggest the current model');
assert.ok(
  !pool.filter((p) => p.type === 'image-gen').some((p) => p.id === noSelf?.id),
  'image models are not chat peers',
);

// 6. Equal power → online wins, then free.
const tied = [
  m('a/llama-3.3-70b', { health: { status: 'offline' } }),
  m('b/llama-3.3-70b', { health: { status: 'online' }, free: false }),
];
assert.strictEqual(closestPeer(tied, m('c/llama-3.3-70b'))?.id, 'b/llama-3.3-70b', 'ties break on health');

// 7. An empty pool is a no-recommendation, not a crash.
assert.strictEqual(closestPeer([], m('groq/llama-3.1-8b-instant')), undefined);

console.log('modelPeer.test.ts: all assertions passed');
