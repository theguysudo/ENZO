/**
 * ecosystem-tools.ts — the local "fetch anything" pipeline for chat.
 *
 * ENZO keeps every artifact (investigations, agents, skills, memory, projects,
 * neural profile) as JSON on local disk in the same process that serves chat.
 * So "fetching" from the ecosystem is a plain in-process read — no HTTP hop,
 * no network, no serialization round-trip: effectively gigabytes-per-second
 * for anything under a few MB. These tools expose that store to the agent loop
 * so the user can say "fetch my investigation and explain it" in plain chat.
 *
 * Rules:
 *  - READ-ONLY. Never mutate another module's store from here.
 *  - Ownership: investigations and the neural profile are per-device
 *    (x-enzo-owner). Anything owned is filtered to the caller's device id;
 *    without a device id, owned artifacts are hidden entirely.
 *  - Size-capped: every payload is truncated (MAX_PAYLOAD_BYTES) so a huge
 *    store can never blow the model context or the SSE frame.
 *  - Never throws: a missing/corrupt store reads as an empty result.
 */
import fs from 'fs';
import path from 'path';
import { listInvestigations, getInvestigation } from '../intelligence/store.js';
import { listAgents, getAgent } from '../agents/agents.js';
import { listSkills, getSkill } from '../skills/skills.js';
import { loadMemory } from '../core/memory.js';
import { loadOwner, validOwnerId } from '../neural-engine/store.js';

const MAX_PAYLOAD_BYTES = 96 * 1024;
const MAX_LIST_ITEMS = 40;

function cap<T>(obj: T): T {
  const s = JSON.stringify(obj);
  if (s.length <= MAX_PAYLOAD_BYTES) return obj;
  return { truncated: true, note: `payload exceeded ${MAX_PAYLOAD_BYTES} bytes — showing head`, preview: s.slice(0, MAX_PAYLOAD_BYTES) } as T;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export type EcosystemKind = 'investigation' | 'agent' | 'skill' | 'memory' | 'project' | 'neural';

/** What exists in this install, right now — counts + short summaries. */
export function ecosystemList(ownerId: string): Record<string, unknown> {
  const invs = safe(() => listInvestigations(), [])
    .filter((i) => !i.ownerToken || (ownerId && i.ownerToken === ownerId))
    .slice(0, MAX_LIST_ITEMS)
    .map((i) => ({ id: i.id, name: i.name, objective: i.objective.slice(0, 160), evidenceCount: i.evidenceCount, runs: i.runs.length, lastPhase: i.runs[i.runs.length - 1]?.phase }));
  const agents = safe(() => listAgents(), []).slice(0, MAX_LIST_ITEMS)
    .map((a: any) => ({ id: a.id, name: a.name, summary: String(a.summary ?? a.description ?? '').slice(0, 160) }));
  const skills = safe(() => listSkills(), []).slice(0, MAX_LIST_ITEMS)
    .map((s: any) => ({ id: s.id, name: s.name, summary: String(s.description ?? s.summary ?? '').slice(0, 160) }));
  const mem = safe(() => loadMemory(), null);
  const projectsDir = path.resolve(process.cwd(), 'generated-projects');
  const projects = safe(() => fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).slice(0, MAX_LIST_ITEMS), [] as string[]);
  const neural = ownerId && validOwnerId(ownerId)
    ? safe(() => { const p = loadOwner(ownerId) as any; return { dimensions: Object.keys(p?.preferences?.dimensions ?? p?.preferences ?? {}).length, nodes: p?.graph?.nodes?.length ?? 0 }; }, null)
    : null;
  return cap({
    investigations: { count: invs.length, items: invs },
    agents: { count: agents.length, items: agents },
    skills: { count: skills.length, items: skills },
    memory: mem ? { facts: Array.isArray((mem as any).facts) ? (mem as any).facts.length : 0, entries: Array.isArray((mem as any).entries) ? (mem as any).entries.length : 0 } : { count: 0 },
    projects: { count: projects.length, items: projects },
    neuralProfile: neural ?? { hidden: 'no device id — owned profile hidden' },
  });
}

/** Fetch one artifact (or the latest report of one) — capped, owner-filtered. */
export function ecosystemFetch(kind: EcosystemKind, query: string, opts: { report?: boolean; evidence?: boolean }, ownerId: string): Record<string, unknown> {
  const q = String(query || '').trim().toLowerCase();
  const findInv = () => {
    const list = safe(() => listInvestigations(), [])
      .filter((i) => !i.ownerToken || (ownerId && i.ownerToken === ownerId));
    if (!q) return list[0] ?? null;
    return list.find((i) => i.id.toLowerCase() === q || i.name.toLowerCase().includes(q) || i.objective.toLowerCase().includes(q)) ?? null;
  };
  switch (kind) {
    case 'investigation': {
      const sum = findInv();
      if (!sum) return { error: 'no investigation matched', hint: 'call ecosystem_list first to see ids/names' };
      const inv = safe(() => getInvestigation(sum.id), null);
      if (!inv) return { error: 'investigation not found on disk' };
      const last = inv.runs[inv.runs.length - 1];
      if (opts.report) {
        return cap({
          id: inv.id, name: inv.name, objective: inv.brief.objective,
          questions: inv.questions, latestRun: last ? { n: last.n, phase: last.phase, stats: last.stats, changes: last.changes } : null,
          report: last?.report ?? '(no report yet — run the investigation first)',
          openQuestions: last?.openQuestions ?? [],
          discrepancies: last?.discrepancies ?? [],
        });
      }
      const ledger = inv.evidence.slice(-40).map((e) => ({ id: e.id, status: e.status, host: e.host, claim: e.claim.slice(0, 300), quoteVerified: e.quoteVerified }));
      return cap({
        id: inv.id, name: inv.name, objective: inv.brief.objective, scope: inv.brief.scope,
        questions: inv.questions, runs: inv.runs.map((r) => ({ n: r.n, phase: r.phase, stats: r.stats })),
        entities: last?.entities?.slice(0, 30).map((e) => ({ id: e.id, name: e.name, kind: e.kind, summary: e.summary })) ?? [],
        relationships: last?.relationships?.slice(0, 40) ?? [],
        ...(opts.evidence ? { evidenceLedger: ledger } : {}),
        report: last?.report?.slice(0, 4000) ?? '',
      });
    }
    case 'agent': {
      const list = safe(() => listAgents(), []);
      const hit = !q ? list[0] : list.find((a: any) => String(a.id).toLowerCase() === q || String(a.name ?? '').toLowerCase().includes(q));
      if (!hit) return { error: 'no agent matched', agents: list.map((a: any) => ({ id: a.id, name: a.name })) };
      return cap((safe(() => getAgent(String(hit.id)), null) ?? { error: 'agent not found' }) as Record<string, unknown>);
    }
    case 'skill': {
      const list = safe(() => listSkills(), []);
      const hit = !q ? list[0] : list.find((s: any) => String(s.id).toLowerCase() === q || String(s.name ?? '').toLowerCase().includes(q));
      if (!hit) return { error: 'no skill matched', skills: list.map((s: any) => ({ id: s.id, name: s.name })) };
      return cap((safe(() => getSkill(String(hit.id)), null) ?? { error: 'skill not found' }) as Record<string, unknown>);
    }
    case 'memory': {
      const mem = safe(() => loadMemory(), null);
      if (!mem) return { error: 'memory store unavailable' };
      const m = mem as any;
      return cap({ facts: Array.isArray(m.facts) ? m.facts.slice(-50) : [], entries: Array.isArray(m.entries) ? m.entries.slice(-30) : (Array.isArray(m.memories) ? m.memories.slice(-30) : []) });
    }
    case 'project': {
      const dir = path.resolve(process.cwd(), 'generated-projects');
      const names = safe(() => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name), [] as string[]);
      const hit = !q ? names[0] : names.find((n) => n.toLowerCase().includes(q));
      if (!hit) return { error: 'no project matched', projects: names };
      const files = safe(() => fs.readdirSync(path.join(dir, hit)).slice(0, 30), [] as string[]);
      return cap({ project: hit, files });
    }
    case 'neural': {
      if (!ownerId || !validOwnerId(ownerId)) return { error: 'neural profile is per-device — no x-enzo-owner id on this request' };
      const p = safe(() => loadOwner(ownerId), null) as any;
      if (!p) return { error: 'no neural profile for this device yet' };
      const prefs = p?.preferences?.dimensions ?? p?.preferences ?? {};
      return cap({
        dimensions: Object.entries(prefs).slice(0, 20).map(([k, v]: [string, any]) => ({ name: k, value: v?.value ?? v, provenance: v?.provenance })),
        nodes: p?.graph?.nodes?.slice(0, 30) ?? [],
        events: p?.events?.slice(-10) ?? [],
      });
    }
    default:
      return { error: `unknown kind: ${kind}` };
  }
}
