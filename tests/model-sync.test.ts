/**
 * model-sync.test.ts — NVIDIA verify-cache key scoping, tested against the
 * REAL module. Run: `npx tsx tests/model-sync.test.ts`
 *
 * Guards the regression where an "ok:false" verdict from API key A reused its
 * 24h cache for API key B (and for keyless boots) and silently dropped every
 * model A couldn't reach — the cause of the marketplace showing only ~3 NVIDIA
 * models no matter who booted it. The fix: keyed readers scope strictly to
 * their own cache slot; only keyless/anon readers fall back to the bare-id
 * mirror. The contract lives in model-sync.ts's exported helpers — this file
 * imports them, so a regression in the real code fails here.
 */
import assert from 'assert';
import { nvidiaCacheSlot, nvidiaVerifyCacheKey, nvidiaVerdictLookup } from '../src/models/model-sync.js';

function main(): void {
  const keyA = 'sk-nv-aaaaaaaaaaaaaaaa';
  const keyB = 'sk-nv-bbbbbbbbbbbbbbbb';
  const modelId = 'meta/llama-3.3-70b-instruct';

  const store: Record<string, { ok: boolean; checkedAt: string }> = {};
  const nowIso = new Date().toISOString();

  // key A probes, model is unreachable for A
  store[nvidiaVerifyCacheKey(keyA, modelId)] = { ok: false, checkedAt: nowIso };
  store[modelId] = { ok: false, checkedAt: nowIso }; // legacy bare-id mirror

  // 1. key B must NOT inherit key A's verdict via the bare-id fallback
  const bEntry = nvidiaVerdictLookup(store, keyB, modelId);
  assert.strictEqual(bEntry, undefined, 'key B must not inherit key A\'s verdict');

  // 2. keyless reader DOES see the bare-id entry (legacy contract preserved)
  const anonEntry = nvidiaVerdictLookup(store, undefined, modelId);
  assert.strictEqual(anonEntry?.ok, false, 'keyless reader must see the bare-id mirror');

  // 3. a positive verdict under key B clears the stale bare-id negative and
  //    surfaces for keyless readers (mirror of the write path in verifyNvidiaCatalog)
  const positive = { ok: true, checkedAt: nowIso };
  store[nvidiaVerifyCacheKey(keyB, modelId)] = positive;
  if (positive.ok) store[modelId] = positive;
  else delete store[modelId];

  assert.strictEqual(store[modelId]?.ok, true, 'positive verdict must clear stale bare-id negative');
  const anonAfter = nvidiaVerdictLookup(store, undefined, modelId);
  assert.strictEqual(anonAfter?.ok, true, 'keyless reader must pick up the cleared positive');

  // 4. stale entries (>24h) count as absent for keyed and keyless readers alike
  const staleIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  store[nvidiaVerifyCacheKey(keyA, modelId)] = { ok: false, checkedAt: staleIso };
  assert.strictEqual(nvidiaVerdictLookup(store, keyA, modelId), undefined, 'stale keyed verdict is absent');
  store[modelId] = { ok: false, checkedAt: staleIso };
  assert.strictEqual(nvidiaVerdictLookup(store, undefined, modelId), undefined, 'stale bare-id verdict is absent');

  // 5. slot/key derivation is total on its inputs
  assert.strictEqual(nvidiaCacheSlot(undefined), 'nvidia:anon');
  assert.strictEqual(nvidiaCacheSlot(''), 'nvidia:anon');
  assert.strictEqual(nvidiaCacheSlot('sk-nv-abcdef1234567890'), 'nvidia:34567890');
  assert.strictEqual(nvidiaVerifyCacheKey(undefined, 'x'), 'nvidia:anon:x');
  assert.strictEqual(nvidiaVerifyCacheKey('sk-nv-abcdef1234567890', 'm'), 'nvidia:34567890:m');

  console.log('model-sync.test.ts: all assertions passed (against real model-sync.ts)');
}

try {
  main();
} catch (e) {
  console.error('model-sync.test.ts FAILED:', (e as Error)?.message);
  process.exit(1);
}
