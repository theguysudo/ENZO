/**
 * intelligence.test.ts — offline tests for the ENZO Intelligence module.
 * Zero network: the SSRF guard is exercised on hostile URL literals, and the
 * pipeline runs with every seam injected (fake askJson + fake fetch/search).
 * Run: tsx tests/intelligence.test.ts   (also wired into `npm test`)
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Investigation } from '../src/intelligence/types.js';

process.env.ENZO_INTEL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-intel-test-'));

let checks = 0;
const ok = (cond: boolean, label: string) => { checks++; assert.ok(cond, label); console.log(`  ✔ ${label}`); };

async function main() {
  const { assertPublicUrl, hashText, stripHtml, isJunkUrl } = await import('../src/intelligence/fetcher.js');
  const { normalizeEntityName, runInvestigation, diffRuns, answerFromEvidence, explainEntity } = await import('../src/intelligence/orchestrator.js');
  const {
    sanitizeBriefInput, getInvestigation, saveInvestigation, listInvestigations,
    deleteInvestigation, newInvestigationId, CAPS,
  } = await import('../src/intelligence/store.js');
  const { crawlableLinks, canonicalUrl } = await import('../src/intelligence/connectors.js');

  console.log('— sanitizeBriefInput (validation gate) —');
  ok((() => { try { sanitizeBriefInput({ objective: '' }); return false; } catch { return true; } })(), 'empty objective rejected');
  const gate = sanitizeBriefInput({
    objective: 'Investigate NovaGrid AI using public sources',
    scope: 'x'.repeat(5000),
    seedUrls: ['https://novagrid.example.com/about', 'ftp://bad', 'http://user:pass@x/', 'not a url'],
    limits: { maxSearches: 999, maxPages: 0, maxLlmCalls: -5, timeBudgetMs: 99999999 },
    documents: Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, text: `text ${i}` })),
  });
  ok(gate.brief.scope.length <= CAPS.scope, 'scope capped');
  ok(gate.brief.seedUrls.length === 1, 'bad seed URLs dropped, good kept');
  ok(gate.brief.limits.maxSearches === 20 && gate.brief.limits.maxPages === 1 && gate.brief.limits.maxLlmCalls === 0, 'limits clamped to bounds');
  ok(gate.documents.length === CAPS.documents, 'documents capped');

  console.log('— store roundtrip —');
  const inv = {
    id: newInvestigationId(),
    name: 'NovaGrid',
    brief: gate.brief,
    documents: gate.documents,
    questions: [],
    evidence: [],
    runs: [],
    ownerToken: 'device-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Investigation;
  saveInvestigation(inv);
  ok(listInvestigations().length === 1, 'index lists the investigation');
  const loaded = getInvestigation(inv.id);
  ok(!!loaded && loaded.brief.objective.startsWith('Investigate NovaGrid'), 'roundtrip preserves brief');
  ok(getInvestigation('../../etc/passwd') === null, 'path traversal rejected');
  ok(getInvestigation('inv_zzzzzzzz') === null, 'unknown id → null');
  ok(deleteInvestigation(inv.id) && !getInvestigation(inv.id), 'delete removes body + index entry');

  console.log('— SSRF guard (hostile URL literals) —');
  const hostile = [
    'http://127.0.0.1/x', 'http://10.0.0.4/', 'http://172.16.1.1/', 'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://localhost:5173/',
    'ftp://example.com/', 'file:///etc/passwd', 'http://user:pass@example.com/',
    'http://metadata.google.internal/computeMetadata/v1/', 'https://box.internal/admin',
  ];
  const rejects = async (h: string): Promise<boolean> => {
    try { await assertPublicUrl(h); return false; } catch { return true; }
  };
  for (const h of hostile) {
    ok(await rejects(h), `rejected: ${h}`);
  }
  // dns-lookup path is exercised only where the host resolves; a guaranteed-
  // public host would hit the network, so the resolution branch is covered by
  // the fetch path in the smoke run, not here.

  console.log('— text helpers —');
  ok(stripHtml('<p>Hello & <b>world</b><script>evil()</script></p>') === 'Hello & world', 'stripHtml removes tags/scripts + decodes entities');
  ok(hashText('a b c') === hashText('a  b\nc'), 'content hash is whitespace-invariant');
  ok(isJunkUrl('https://x.com/privacy') && !isJunkUrl('https://x.com/about'), 'junk URL filter');
  ok(crawlableLinks(['https://site.com/a', 'https://other.com/b', 'https://site.com/a#frag'], 'https://site.com/').length === 1, 'crawl links: same-host only, deduped');
  ok(canonicalUrl('https://Site.com/A/') === 'site.com/a', 'canonicalUrl lowercases + strips trailing slash');

  console.log('— entity normalization —');
  ok(normalizeEntityName('NovaGrid AI, Inc.') === normalizeEntityName('novagrid'), 'suffix stripping merges aliases');
  ok(normalizeEntityName('The NovaGrid Foundation') !== normalizeEntityName('OtherCorp Ltd'), 'distinct names stay distinct');

  console.log('— full pipeline with seams (offline) —');
  const pages: Record<string, { text: string; title: string }> = {
    'https://novagrid.example.com/': {
      title: 'NovaGrid AI — Official site',
      text: 'NovaGrid AI was founded in 2023 by Priya Raman and Alex Chen. Our flagship product NovaGrid Core launched in March 2025. NovaGrid Core is a grid-orchestration engine for energy providers. NovaGrid AI maintains the open-source repository novagrid/core.',
    },
    'https://novagrid.example.com/product': {
      title: 'NovaGrid Core — Product page',
      text: 'NovaGrid Core became generally available in June 2025, according to the release announcement. The product serves 40 utility customers as of August 2026, with deployments across North America and Europe. The page describes a grid-orchestration engine that balances distributed energy resources in real time and integrates with existing SCADA systems.',
    },
    'https://news.example.org/novagrid-launch': {
      title: 'Independent coverage of the NovaGrid Core launch',
      text: 'Trade press reported that public availability of NovaGrid Core began in June 2025, later than the March 2025 date the company website claims for the launch event. The delay between the launch event and general availability was confirmed by two distributors who began stocking the product in the third quarter. Industry analysts noted that the announcement drew attention from utility operators evaluating grid-orchestration platforms.',
    },
  };
  const searchQs: string[] = [];
  const fakeInv = {
    id: newInvestigationId(),
    name: 'NovaGrid test',
    brief: {
      objective: 'Investigate the fictional company NovaGrid AI: products, leadership, and public claims.',
      scope: 'Public sources only.',
      connectors: { webSearch: true, websites: true, github: false, wikipedia: false, documents: false },
      seedUrls: ['https://novagrid.example.com/'],
      limits: { maxSearches: 3, maxPages: 5, maxLlmCalls: 24, timeBudgetMs: 60_000 },
    },
    documents: [],
    questions: [],
    evidence: [],
    runs: [],
    ownerToken: 'device-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Investigation;
  saveInvestigation(fakeInv);

  let llmCalls = 0;
  const claimsFor = (user: string): any[] => {
    if (user.includes('news.example.org')) {
      return [{ claim: 'Public availability of NovaGrid Core began June 2025 per trade press.', quote: 'public availability of NovaGrid Core began in June 2025', subject: 'NovaGrid Core', entities: ['NovaGrid Core', 'NovaGrid AI'], sourceDate: '2025-06-02' }];
    }
    if (user.includes('/product')) {
      return [{ claim: 'NovaGrid Core became generally available in June 2025 per the release announcement.', quote: 'became generally available in June 2025', subject: 'NovaGrid Core', entities: ['NovaGrid Core', 'NovaGrid AI'], sourceDate: '' }];
    }
    return [
      { claim: 'NovaGrid AI was founded in 2023 by Priya Raman and Alex Chen.', quote: 'founded in 2023 by Priya Raman and Alex Chen', subject: 'NovaGrid AI', entities: ['NovaGrid AI', 'Priya Raman', 'Alex Chen'], sourceDate: '' },
      { claim: 'NovaGrid Core launched in March 2025 per the company site.', quote: 'flagship product NovaGrid Core launched in March 2025', subject: 'NovaGrid Core', entities: ['NovaGrid Core', 'NovaGrid AI'], sourceDate: '' },
    ];
  };
  const askSeam = async (_g: any, system: string, user: string): Promise<any> => { llmCalls++; return canned(system, user); };
  const canned = (system: string, user = ''): any => {
    if (system.includes('investigation planner')) return { questions: ['Q1: web presence?', 'Q2: launch dates?'] };
    if (system.includes('claims extractor')) return { claims: claimsFor(user) };
    if (system.includes('entity resolver')) {
      return { entities: [{ name: 'NovaGrid AI', aliases: ['NovaGrid'], kind: 'organization', summary: 'Energy-grid startup.' }, { name: 'NovaGrid Core', aliases: [], kind: 'product', summary: 'Grid-orchestration engine.' }] };
    }
    if (system.includes('relationship analyst')) {
      return { relationships: [{ from: 'ent-2', to: 'ent-1', label: 'published', status: 'supported', evidenceIds: ['E1', 'E2'] }] };
    }
    if (system.includes('verification analyst')) {
      return {
        assessments: [
          { claimId: 'E1', status: 'supported', note: 'founding stated on the official site' },
          { claimId: 'E2', status: 'disputed', note: 'March launch conflicts with the independently dated June availability' },
          { claimId: 'E4', status: 'supported', note: 'independently dated' },
        ],
        discrepancies: [{ topic: 'launch date', claimA: 'E2', claimB: 'E4', explanation: 'March vs June 2025', howToResolve: 'check the release announcement' }],
        openQuestions: ['Which customers use NovaGrid Core?'],
      };
    }
    if (system.includes('report writer')) return '## Executive summary\nNovaGrid Core launched [E1] but public availability began June 2025 [E2].\n## Findings\n- Launch date discrepancy [E1][E2].';
    if (system.includes('entity analyst')) return '## What it is\nNovaGrid Core is the grid-orchestration engine of NovaGrid AI [E1].\n## What the evidence shows\n- The company site dates the launch to March 2025 [E1].';
    if (system.includes('answering a question about ONE entity')) return 'NovaGrid AI was founded in 2023 by Priya Raman and Alex Chen [E1].';
    if (system.includes('analyst')) return 'The trade press dates availability to June 2025 [E2]; the company site says March 2025 [E1].';
    return {};
  };

  const run1 = await runInvestigation(fakeInv, {
    keys: { groq: 'test', exa: '' },
    _askJson: askSeam as any,
    _search: (async (q: string) => {
      searchQs.push(q);
      return {
        sources: [],
        candidates: [
          { title: 'Independent coverage', url: 'https://news.example.org/novagrid-launch', site: 'news.example.org', desc: '' },
          { title: 'junk', url: 'https://x.com/privacy', site: 'x.com', desc: '' },
        ],
        searchesUsed: 1,
      };
    }) as any,
    _fetchUrl: (async (url: string, _c: any, newId: () => string) => {
      const page = pages[url];
      const text = page?.text ?? '';
      return {
        source: {
          id: newId(), url, title: page?.title ?? url, host: new URL(url).hostname,
          connector: 'website', fetchedAt: Date.now(), contentHash: text ? hashText(text) : '',
          text, ok: !!page, ...(page ? {} : { error: 'not found' }),
        },
        links: url.endsWith('/product') ? [] : ['https://novagrid.example.com/product'],
      };
    }) as any,
  });
  const r1 = run1.runs[0];
  ok(r1.phase === 'done', `run 1 completes (phase=${r1.phase} err=${r1.error ?? '-'})`);
  ok(r1.questions.length === 2, 'plan produced questions');
  ok(run1.questions.length === 2, 'questions mirrored to investigation');
  ok(r1.sources.length === 3, `3 sources (seed + crawled link + search hit), got ${r1.sources.length}`);
  ok(run1.evidence.length === 4, `4 evidence rows (2 claims × 2 sources), got ${run1.evidence.length}`);
  ok(run1.evidence.every((e) => e.quoteVerified), 'all quotes machine-verified against source text');
  ok(r1.entities.length >= 2 && r1.entities.some((e) => e.name === 'NovaGrid AI'), 'entities resolved + consolidated');
  ok(r1.relationships.length >= 1, 'relationships proposed');
  ok(r1.discrepancies.length === 1 && r1.discrepancies[0].a.claimId === 'E2', 'discrepancy extracted with valid claim refs');
  ok(run1.evidence.find((e) => e.id === 'E2')?.status === 'disputed', 'verify pass applied statuses');
  ok(r1.openQuestions.length === 1, 'open questions captured');
  ok(r1.report.includes('## Sources') && r1.report.includes('novagrid.example.com'), 'mechanical bibliography appended');
  ok(r1.changes === undefined, 'run 1 has no diff (no previous run)');

  // ── Run 2: changed + missing source detection ──
  const run2Inv = getInvestigation(fakeInv.id)!;
  const changedPages: Record<string, { text: string; title: string }> = {
    'https://novagrid.example.com/': { title: 'NovaGrid AI — Official site', text: 'NovaGrid AI was founded in 2023 by Priya Raman and Alex Chen. Our flagship product NovaGrid Core launched in March 2025. NovaGrid Core is a grid-orchestration engine. NovaGrid AI now serves 12 countries.' },
    // product page intentionally absent → attempted? no: search returns nothing → never attempted → NOT a change
  };
  const askSeam2 = async (_g: any, system: string): Promise<any> => {
    if (system.includes('claims extractor')) {
      return { claims: [{ claim: 'NovaGrid AI now serves 12 countries per its site.', quote: 'serves 12 countries', subject: 'NovaGrid AI', entities: ['NovaGrid AI'], sourceDate: '' }] };
    }
    if (system.includes('investigation planner')) return { questions: ['Q1?'] };
    if (system.includes('verification analyst')) return { assessments: [{ claimId: 'E5', status: 'unverified', note: 'single source' }], discrepancies: [], openQuestions: [] };
    if (system.includes('entity resolver')) return { entities: [{ name: 'NovaGrid AI', aliases: [], kind: 'organization', summary: '' }] };
    if (system.includes('relationship analyst')) return { relationships: [] };
    if (system.includes('report writer')) return '## Executive summary\nOne new fact.';
    return {};
  };
  const run2 = await runInvestigation(run2Inv, {
    keys: { groq: 'test', exa: '' },
    _askJson: askSeam2 as any,
    _search: (async () => ({ sources: [], candidates: [], searchesUsed: 1 })) as any,
    _fetchUrl: (async (url: string, _c: any, newId: () => string) => {
      const page = changedPages[url] ?? pages[url];
      const text = page?.text ?? '';
      return {
        source: {
          id: newId(), url, title: page?.title ?? url, host: new URL(url).hostname,
          connector: 'website', fetchedAt: Date.now(), contentHash: text ? hashText(text) : '',
          text, ok: !!page, ...(page ? {} : { error: 'HTTP 404' }),
        },
        links: [],
      };
    }) as any,
  });
  const r2 = run2.runs[1];
  ok(r2.phase === 'done', `run 2 completes (phase=${r2.phase})`);
  ok(!!r2.changes && r2.changes.newEvidence === 1, `run 2 counts 1 new claim (got ${r2.changes?.newEvidence})`);
  ok(r2.changes!.changedSources.some((c) => c.url === 'https://novagrid.example.com/'), 'changed source detected via content hash');
  // The news article was never re-attempted (search returned nothing) — it must
  // NOT be reported missing: a source not re-checked is not a change.
  ok(r2.changes!.missingSources.length === 0, 'unrechecked source not falsely reported missing');
  ok(run2.evidence.length === 5, 'evidence ledger append-only across runs');

  console.log('— diffRuns edge —');
  ok(diffRuns(null, r2) === undefined, 'no previous run → no diff');

  console.log('— cancellation —');
  const run3Inv = getInvestigation(fakeInv.id)!;
  const cancelled = await runInvestigation(run3Inv, {
    keys: { groq: 'test', exa: '' },
    _askJson: askSeam as any,
    _search: (async () => ({ sources: [], candidates: [], searchesUsed: 1 })) as any,
    shouldStop: () => true,   // cancel at the first checkpoint (after plan)
  });
  ok(cancelled.runs[cancelled.runs.length - 1].phase === 'cancelled', 'cancel flag ends the run with partial state preserved');

  console.log('— regression: runs never rewrite stored brief limits —');
  const regInv = getInvestigation(fakeInv.id)!;
  const savedLimits = JSON.stringify(regInv.brief.limits);
  // planOnly run: used to persist maxLlmCalls=2 (the plan clamp) onto the brief.
  await runInvestigation(regInv, {
    keys: { groq: 'test', exa: '' }, planOnly: true,
    _askJson: askSeam as any,
    _search: (async () => ({ sources: [], candidates: [], searchesUsed: 1 })) as any,
  });
  const afterPlan = getInvestigation(fakeInv.id)!;
  ok(JSON.stringify(afterPlan.brief.limits) === savedLimits, 'plan-only run does not persist clamped limits');
  // per-run limits override: enforced for the run, not written back.
  const overInv = getInvestigation(fakeInv.id)!;
  const over = await runInvestigation(overInv, {
    keys: { groq: 'test', exa: '' },
    limits: { maxSearches: 1, maxPages: 5, maxLlmCalls: 30, timeBudgetMs: 60_000 },
    _askJson: askSeam as any,
    _search: (async () => ({ sources: [], candidates: [], searchesUsed: 1 })) as any,
    _fetchUrl: (async (url: string, _c: any, newId: () => string) => ({
      source: { id: newId(), url, title: url, host: new URL(url).hostname, connector: 'website', fetchedAt: Date.now(), contentHash: '', text: pages[url]?.text ?? '', ok: !!pages[url] },
      links: [],
    })) as any,
  });
  const lastRun = over.runs[over.runs.length - 1];
  ok(lastRun.stats.llmCalls <= 30 && lastRun.phase === 'done', `limits override honored for the run (llmCalls=${lastRun.stats.llmCalls})`);
  ok(JSON.stringify(getInvestigation(fakeInv.id)!.brief.limits) === savedLimits, 'limits override not persisted onto the brief');

  console.log('— regression: small LLM budget still extracts evidence —');
  const tinyInv: Investigation = {
    id: newInvestigationId(), name: 'tiny', 
    brief: {
      objective: 'Tiny budget run', scope: '',
      connectors: { webSearch: true, websites: true, github: false, wikipedia: false, documents: false },
      seedUrls: ['https://novagrid.example.com/'],
      limits: { maxSearches: 1, maxPages: 2, maxLlmCalls: 4, timeBudgetMs: 60_000 },
    },
    documents: [], questions: [], evidence: [], runs: [], createdAt: Date.now(), updatedAt: Date.now(),
  } as Investigation;
  saveInvestigation(tinyInv);
  const tiny = await runInvestigation(tinyInv, {
    keys: { groq: 'test', exa: '' },
    _askJson: askSeam as any,
    _search: (async () => ({ sources: [], candidates: [], searchesUsed: 1 })) as any,
    _fetchUrl: (async (url: string, _c: any, newId: () => string) => ({
      source: { id: newId(), url, title: 'NovaGrid AI — Official site', host: 'novagrid.example.com', connector: 'website', fetchedAt: Date.now(), contentHash: 'x', text: pages['https://novagrid.example.com/'].text, ok: true },
      links: [],
    })) as any,
  });
  const tinyRun = tiny.runs[0];
  ok(tinyRun.phase === 'done' && tiny.evidence.length >= 1, `maxLlmCalls=4 still yields evidence (got ${tiny.evidence.length}, phase=${tinyRun.phase})`);
  ok(tinyRun.entities.length >= 1, `graph not empty on small budget (entities=${tinyRun.entities.length})`);

  console.log('— analyst (budget-capped, offline) —');
  const analInv = getInvestigation(fakeInv.id)!;
  const answer = await answerFromEvidence(analInv, 'When did NovaGrid Core become available?', { keys: { groq: 'test', exa: '' }, _askText: askSeam as any });
  ok(answer.includes('[E2]') || answer.includes('[E1]'), 'analyst answer cites evidence ids');

  console.log('— entity explainer (offline) —');
  const explainInv = getInvestigation(fakeInv.id)!;
  // The graph is a run snapshot and the last run may be a plan-only run (no
  // entities) — find the run that actually owns the entity, newest first.
  let graphEnt: any = null;
  for (let i = explainInv.runs.length - 1; i >= 0 && !graphEnt; i--) {
    graphEnt = explainInv.runs[i].entities.find((e) => e.name === 'NovaGrid Core') ?? null;
  }
  ok(!!graphEnt, 'the graph has an entity to explain');
  let explainUser = '';
  let followUser = '';
  const captureSeam = async (_g: any, system: string, user: string): Promise<string> => {
    if (system.includes('entity analyst')) explainUser = user;
    if (system.includes('answering a question about ONE entity')) followUser = user;
    return canned(system, user);
  };
  const explained = await explainEntity(explainInv, graphEnt!.id, '', { keys: { groq: 'test', exa: '' }, _askText: captureSeam as any });
  ok(explained.explanation.includes('[E1]') || explained.explanation.includes('[E2]'), 'the node explanation cites evidence ids');
  ok(explained.entity?.name === 'NovaGrid Core', 'the explanation carries the entity identity');
  ok(explained.evidenceIds.length > 0, 'the explanation links its evidence ids');
  ok(explainUser.includes('NovaGrid Core'), 'the explain prompt names the entity');
  ok(/\[E\d+\]/.test(explainUser), 'the explain prompt carries the evidence rows');
  const followed = await explainEntity(explainInv, graphEnt!.id, 'Who made it?', { keys: { groq: 'test', exa: '' }, _askText: captureSeam as any });
  ok(!!followed.answer && followed.answer.includes('[E'), 'the follow-up doubt is answered with citations');
  ok(followed.answer !== explained.explanation, 'a follow-up returns an answer, not the explanation');
  ok(followUser.includes('Who made it?'), 'the follow-up question reaches the model');
  let threw = false;
  try {
    await explainEntity(explainInv, 'ent-does-not-exist', '', { keys: { groq: 'test', exa: '' }, _askText: captureSeam as any });
  } catch { threw = true; }
  ok(threw, 'an unknown entity id is rejected instead of explained');

  console.log('— ownership + caps sanity —');
  ok(CAPS.evidence === 400 && CAPS.runs === 10, 'caps hold the growth bound');

  console.log(`\n✔ intelligence.test.ts — ${checks} checks passed`);
}

main().catch((err) => {
  console.error('✗ intelligence.test.ts failed:', err);
  process.exit(1);
});
