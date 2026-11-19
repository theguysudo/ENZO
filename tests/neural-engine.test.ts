/**
 * neural-engine.test.ts — Phases 1, 2 and 4 acceptance criteria, offline.
 *
 * Covers: preference precedence (explicit > inferred, task override first),
 * owner isolation (store + real HTTP router), event allowlist, graph edge
 * validation, forget semantics (excluded from context AND future datasets),
 * context budget + unverified-claim labeling, and zero-cost routing
 * (paid/unknown/disabled routes rejected, quota stops before the limit).
 * Run: tsx tests/neural-engine.test.ts   (wired into `npm test`)
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

process.env.ENZO_NEURAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-neural-test-'));
// Deterministic catalog for zero-cost tests: groq/free-model is free, groq/paid-model is not.
process.env.ENZO_MODEL_CACHE = path.join(os.tmpdir(), `enzo-neural-cache-${Date.now()}.json`);
fs.writeFileSync(process.env.ENZO_MODEL_CACHE, JSON.stringify({ models: [
  { id: 'groq/openai/gpt-oss-20b', provider: 'groq', free: true, type: 'text' },
  { id: 'groq/paid-model', provider: 'groq', free: false, type: 'text' },
  { id: 'openrouter/free-a', provider: 'openrouter', free: true, type: 'text' },
  { id: 'openrouter/paid-b', provider: 'openrouter', free: false, type: 'text' },
]}));

let checks = 0;
const ok = (cond: boolean, label: string) => { checks++; assert.ok(cond, label); console.log(`  ✔ ${label}`); };

async function main() {
  const store = await import('../src/neural-engine/store.js');
  const service = await import('../src/neural-engine/service.js');
  const caps = await import('../src/neural-engine/capabilities.js');
  const { createNeuralEngineRouter } = await import('../src/neural-engine/router.js');

  const A = 'device-aaaaaaaa';
  const B = 'device-bbbbbbbb';

  console.log('— Phase 1: validation gates —');
  ok((() => { try { store.validOwnerId('../../etc/passwd'); return false; } catch { return true; } })() === false && !store.validOwnerId('../evil'), 'path-hostile owner ids rejected by charset gate');
  ok(!store.validOwnerId('short'), 'short owner ids rejected');
  ok((() => { try { store.sanitizeProfilePatch({ set: [{ dimension: 'depth', value: 'unlimited' }] }); return false; } catch { return true; } })(), 'invalid preference value rejected');
  ok((() => { try { store.sanitizeProfilePatch({ set: [{ dimension: 'mood', value: 'brief' }] }); return false; } catch { return true; } })(), 'unknown dimension rejected');
  ok((() => { try { store.sanitizeEventInput({ type: 'espionage', nodeId: 'nn_x' }); return false; } catch { return true; } })(), 'unknown event type rejected');
  ok((() => { try { store.sanitizeEventInput({ type: 'answer_chosen', detail: 'x'.repeat(20_000) }); return false; } catch { return true; } })(), 'oversized event payload rejected (detail itself is truncated to cap, not rejected)');

  console.log('— Phase 2: preference precedence (§4.2) —');
  const state = store.loadOwner(A);
  service.recordInferredPreference(state, 'depth', 'exhaustive', 'observation 1');
  let eff = service.effectivePreference(state.profile, 'depth');
  ok(eff.value === null, `single observation is NOT enough (got ${eff.value}) — inferred needs >= 2 samples`);
  service.recordInferredPreference(state, 'depth', 'exhaustive', 'observation 2');
  eff = service.effectivePreference(state.profile, 'depth');
  ok(eff.value === 'exhaustive' && eff.source === 'inferred' && eff.samples === 2, 'two observations → inferred preference with provenance');
  service.setExplicitPreference(state, 'depth', 'brief', 'user set it in the profile UI');
  eff = service.effectivePreference(state.profile, 'depth');
  ok(eff.value === 'brief' && eff.source === 'user_explicit', 'explicit preference overrides inferred');
  eff = service.effectivePreference(state.profile, 'depth', 'exhaustive');
  ok(eff.value === 'exhaustive' && eff.source === 'user_explicit', 'task override wins over saved explicit');
  ok(state.profile.trainingAllowed === false, 'training consent defaults OFF');

  console.log('— Phase 2: context assembly (§4.3) —');
  service.upsertNode(state, { type: 'topic', label: 'Vector databases', confidence: 0.9, verified: true });
  service.upsertNode(state, { type: 'claim', label: 'pgvector suits their prototype', confidence: 0.3, verified: false });
  service.upsertNode(state, { type: 'topic', label: 'Medieval beekeeping', confidence: 0.8, verified: true });
  const ctx = service.buildResearchContext(state, { query: 'compare vector databases for a prototype' });
  ok(ctx.length > 0 && ctx.length <= store.CAPS.contextChars, `context bounded (<= ${store.CAPS.contextChars}, got ${ctx.length})`);
  ok(ctx.includes('depth: brief (explicit)'), 'explicit preference rendered as explicit');
  ok(ctx.includes('learned, confidence') || ctx.includes('explicit'), 'preference provenance shown');
  ok(ctx.includes('Vector databases'), 'relevant graph node injected');
  ok(!ctx.includes('Medieval beekeeping'), 'irrelevant node NOT injected');
  ok(ctx.includes('UNVERIFIED'), 'unverified claims labeled as hypotheses');
  const emptyCtx = service.buildResearchContext(store.loadOwner(B), { query: 'anything' });
  ok(emptyCtx === '', 'empty profile → empty context (no-op injection)');

  console.log('— Phase 1: graph validation —');
  const n1 = service.upsertNode(state, { type: 'concept', label: 'RAG evaluation', confidence: 0.7, verified: false }).node;
  const n2 = service.upsertNode(state, { type: 'method', label: 'Ragas scoring', confidence: 0.7, verified: false }).node;
  ok((() => { try { store.sanitizeEdgeInput({ from: n1.id, relation: 'eats', to: n2.id }, state.nodes); return false; } catch { return true; } })(), 'unknown relation rejected');
  ok((() => { try { store.sanitizeEdgeInput({ from: 'nn_missing', relation: 'related_to', to: n2.id }, state.nodes); return false; } catch { return true; } })(), 'edge to unknown node rejected');
  ok((() => { try { store.sanitizeEdgeInput({ from: n1.id, relation: 'related_to', to: n1.id }, state.nodes); return false; } catch { return true; } })(), 'self-edge rejected');
  const edge = store.sanitizeEdgeInput({ from: n1.id, relation: 'follows_method', to: n2.id, confidence: 0.8 }, state.nodes);
  service.addEdge(state, edge, [n1.id]);
  ok(state.edges.some((e) => e.from === n1.id && e.relation === 'follows_method' && e.evidenceRefs.includes(n1.id)), 'valid edge stored with evidence refs');
  const merged = service.upsertNode(state, { type: 'concept', label: 'rag evaluation', confidence: 0.6, verified: false });
  ok(merged.merged && merged.node.id === n1.id, 'duplicate nodes merge by normalized value');

  console.log('— Phase 1: events + forget semantics (§6) —');
  const confirmed = service.applyEvent(state, { type: 'preference_confirmed', dimension: 'depth', value: 'exhaustive', detail: 'user says the learned preference is right' }, 'explicit');
  ok(!!confirmed, 'confirmation recorded');
  const before = service.effectivePreference(state.profile, 'depth').value;
  const corrected = service.applyEvent(state, { type: 'preference_corrected', dimension: 'depth', value: 'exhaustive', detail: 'user correction' }, 'explicit');
  ok(!!corrected && service.effectivePreference(state.profile, 'depth').value === 'exhaustive' && before !== 'exhaustive', 'correction sets explicit preference');
  const rejected = service.applyEvent(state, { type: 'source_rejected', nodeId: n2.id }, 'explicit');
  ok(!!rejected, 'source rejection applied');
  const ctxAfterReject = service.buildResearchContext(state, { query: 'ragas scoring evaluation' });
  ok(!ctxAfterReject.includes('Ragas scoring'), 'rejected source excluded from context');
  const forgotten = service.applyEvent(state, { type: 'memory_forgotten', nodeId: n1.id }, 'explicit');
  ok(!!forgotten, 'forget applied');
  const mapNodes = state.nodes.filter((n) => !n.excludedFromTraining);
  ok(!mapNodes.some((n) => n.id === n1.id), 'forgotten node excluded from active graph');
  ok(state.nodes.some((n) => n.id === n1.id && n.excludedFromTraining), 'forgotten node retained as history with training exclusion flag');
  const evCount = state.events.length;
  ok(evCount >= 4, `audit trail records events (${evCount})`);

  console.log('— Phase 1: owner isolation —');
  const stateB = store.loadOwner(B);
  service.setExplicitPreference(stateB, 'outputForm', 'table');
  store.saveOwner(stateB);
  ok(service.effectivePreference(store.loadOwner(A).profile, 'outputForm').value !== 'table', "owner B's preference invisible to owner A");
  store.saveOwner(state);
  const reloaded = store.loadOwner(A);
  ok(reloaded.events.length === state.events.length, 'owner A state persists + roundtrips');

  console.log('— Phase 4: zero-cost routing (§7) —');
  const paid = caps.assertRouteAllowed('groq/paid-model');
  ok(!paid.allowed && paid.reason.includes('not marked free'), 'paid model rejected with reason');
  const unknown = caps.assertRouteAllowed('skynet/terminator-9000');
  ok(!unknown.allowed && unknown.reason.includes('fail closed'), 'unknown provider fails closed');
  const unknownModel = caps.assertRouteAllowed('groq/never-heard-of-it');
  ok(!unknownModel.allowed, 'unknown model fails closed');
  const free = caps.assertRouteAllowed('groq/openai/gpt-oss-20b');
  ok(free.allowed, 'verified free model allowed');
  const training = caps.assertRouteAllowed('groq/openai/gpt-oss-20b', 'training');
  ok(!training.allowed && training.reason.includes('notebook'), 'no provider offers verified free training — rejected');
  const serve = caps.assertRouteAllowed('groq/openai/gpt-oss-20b', 'adapter_serve');
  ok(!serve.allowed, 'adapter serving disabled until per-model verification');
  const poll = caps.assertRouteAllowed('pollinations/some-model');
  ok(!poll.allowed, 'pollinations disabled in zero-cost mode (billing in terms)');
  ok(caps.ZERO_COST_MODE === true, 'ZERO_COST_MODE defaults ON');

  console.log('— Phase 4: quota safety —');
  const usage: any[] = [];
  for (let i = 0; i < 45; i++) caps.recordUsage(usage, 'openrouter/free-a');
  const q = caps.usageWithinQuota(usage, 'openrouter/free-a');
  ok(!q.ok && q.used < 50, `stops at 80% of the 50/day free limit (used ${q.used}) — before the official quota`);
  const qGroq = caps.usageWithinQuota(usage, 'groq/openai/gpt-oss-20b');
  ok(qGroq.ok, 'separate provider unaffected');

  console.log('— Phase 1: real HTTP router — owner scoping + gates —');
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(createNeuralEngineRouter({
    verifyVaultAccess: (_req, _res, next) => next(), // stubbed: ownership itself is under test
    rateLimit: () => (_req, _res, next) => next(),
  }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const call = async (method: string, p: string, owner: string | null, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(owner ? { 'x-enzo-owner': owner } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* */ }
    return { status: res.status, json };
  };

  const noOwner = await call('GET', '/api/neural-engine/profile', null);
  ok(noOwner.status === 400 && noOwner.json.error === 'owner_required', 'missing owner header rejected');
  const badOwner = await call('GET', '/api/neural-engine/profile', 'a');
  ok(badOwner.status === 400, 'malformed owner id rejected');
  const profileA = await call('GET', '/api/neural-engine/profile', A);
  ok(profileA.status === 200 && profileA.json.profile.preferences.depth['exhaustive']?.source === 'user_explicit', 'owner A sees own explicit prefs via API');
  const mapB = await call('GET', '/api/neural-engine/map', B);
  ok(mapB.status === 200 && JSON.stringify(mapB.json.nodes.map((n: any) => n.label)).length < JSON.stringify(['table']).length + 300, 'owner B map does not leak owner A nodes');
  ok(!JSON.stringify(mapB.json).includes('RAG evaluation'), "owner A's nodes absent from owner B's map");
  const patchB = await call('PATCH', '/api/neural-engine/profile', B, { set: [{ dimension: 'citationStyle', value: 'bibliography' }] });
  ok(patchB.status === 200 && patchB.json.changes.some((c: string) => c.includes('citationStyle')), 'profile PATCH applies explicit preference + audit');
  const patchBad = await call('PATCH', '/api/neural-engine/profile', B, { set: [{ dimension: 'citationStyle', value: 'chicago-manual-or-else' }] });
  ok(patchBad.status === 400, 'invalid preference value rejected over HTTP');
  const evBad = await call('POST', '/api/neural-engine/events', B, { type: 'preference_corrected', dimension: 'nope' });
  ok(evBad.status === 400, 'invalid event dimension rejected over HTTP');
  const nodeCreate = await call('POST', '/api/neural-engine/nodes', B, { type: 'question', label: 'Which pgvector index type?', confidence: 0.5 });
  ok(nodeCreate.status === 201 && nodeCreate.json.node.sourceEventId === undefined, 'node created for owner B');
  const edgeBad = await call('POST', '/api/neural-engine/edges', B, { from: nodeCreate.json.node.id, relation: 'supports', to: 'nn_doesnotexist' });
  ok(edgeBad.status === 400, 'edge referencing a foreign/unknown node rejected');
  const forgetA = await call('POST', '/api/neural-engine/forget', B, { nodeId: 'nn_nonexistent' });
  ok(forgetA.status === 400, 'forget of nonexistent node is a clean 400, not a crash');
  const ctxCall = await call('POST', '/api/neural-engine/context', B, { query: 'pgvector' });
  ok(ctxCall.status === 200 && ctxCall.json.chars <= store.CAPS.contextChars, 'context endpoint bounded');
  const capsSnap = await call('GET', '/api/providers/capabilities', B);
  ok(capsSnap.status === 200 && capsSnap.json.zeroCostMode === true && capsSnap.json.providers.length >= 8, 'capability snapshot served');
  const routeCheck = await call('POST', '/api/neural-engine/check-route', B, { modelId: 'openrouter/paid-b' });
  ok(routeCheck.status === 200 && routeCheck.json.route.allowed === false, 'paid route check rejected over HTTP');
  const reset = await call('DELETE', '/api/neural-engine/state', B);
  ok(reset.status === 200 && reset.json.deleted === true, 'owner can delete their entire neural state');
  const afterReset = await call('GET', '/api/neural-engine/profile', B);
  ok(afterReset.status === 200 && afterReset.json.profile.preferences.citationStyle?.['bibliography'] === undefined, 'state reset verified');

  console.log('— regressions: explicit wins, values are validated, inference is auditable —');
  // 1. An event carrying a value outside the dimension's allowed set must be
  //    rejected — the profile PATCH route already did this; the event route
  //    did not, so a bogus value could be stored and injected into the prompt.
  ok((() => { try { store.sanitizeEventInput({ type: 'preference_corrected', dimension: 'depth', value: 'totally-bogus' }); return false; } catch { return true; } })(),
    'event with an invalid preference value rejected');
  ok((() => { try { store.sanitizeEventInput({ type: 'preference_confirmed', dimension: 'depth', value: 'exhaustive' }); return false; } catch { return true; } })() === false,
    'event with a valid preference value accepted');
  // 2. An inference must never overwrite an explicit choice.
  const reg = store.loadOwner('device-regress01');
  service.setExplicitPreference(reg, 'depth', 'brief', 'the user said so');
  const returned = service.recordInferredPreference(reg, 'depth', 'brief', 'an observation');
  ok(returned.source === 'user_explicit' && returned.confidence === 1,
    'inference does not overwrite an explicit preference');
  // 3. Confirming a value the profile has never seen must actually set it
  //    (it used to report "Confirmed …" while changing nothing).
  const fresh = store.loadOwner('device-regress02');
  const confirmedNew = service.applyEvent(fresh, { type: 'preference_confirmed', dimension: 'citationStyle', value: 'footnotes' }, 'explicit');
  ok(!!confirmedNew && service.effectivePreference(fresh.profile, 'citationStyle').value === 'footnotes',
    'confirming an unknown value sets the preference instead of a silent no-op');
  // 4. Inferred learning must reach the audit trail (Learning History showed
  //    zero events after real research chats).
  const learned = store.loadOwner('device-regress03');
  const eventsBefore = learned.events.length;
  service.observeResearchTask(learned, { outputForm: 'detailed-report' });
  ok(learned.events.length > eventsBefore && learned.events.some((e: any) => e.signal === 'inferred'),
    'inferred learning is appended to the audit trail');
  // 5. Training consent is its own event type, not a borrowed dimension/value.
  ok((() => { try { store.sanitizeEventInput({ type: 'training_consent_changed', detail: 'Training consent GRANTED' }); return false; } catch { return true; } })() === false,
    'training-consent event type accepted');
  const consentPatch = await call('PATCH', '/api/neural-engine/profile', B, { trainingAllowed: true });
  const consentHistory = await call('GET', '/api/neural-engine/history?limit=50', B);
  const consentEvent = (consentHistory.json?.events || []).find((e: any) => e.type === 'training_consent_changed');
  ok(consentPatch.status === 200 && !!consentEvent && !consentEvent.dimension && !consentEvent.value,
    'training consent is recorded as its own event, not a borrowed dimension/value');

  await new Promise<void>((r) => server.close(() => r()));

  console.log(`\n✔ neural-engine.test.ts — ${checks} checks passed`);
}

main().catch((err) => {
  console.error('✗ neural-engine.test.ts failed:', err);
  process.exit(1);
});
