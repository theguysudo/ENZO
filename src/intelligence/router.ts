/**
 * router.ts — the ENZO Intelligence HTTP + SSE surface.
 *
 * Endpoints (all behind verifyVaultAccess, mounted under /api/intelligence):
 *   GET    /investigations            list summaries
 *   POST   /investigations            create (sanitizeBriefInput gate)
 *   GET    /investigations/:id        full investigation
 *   PATCH  /investigations/:id        update brief/documents
 *   DELETE /investigations/:id        delete
 *   POST   /investigations/:id/run    SSE run (planOnly option = plan review)
 *   POST   /investigations/:id/cancel cancel a running investigation
 *   POST   /investigations/:id/analyst  Q&A over the evidence ledger (JSON)
 *   POST   /investigations/:id/explain  explain ONE graph entity + follow-ups (JSON)
 *
 * Auth follows the vault pattern: verifyVaultAccess injected at mount (it
 * lives unexported in index.ts). Ownership follows the project pattern: the
 * x-enzo-owner device id is bound at creation; mutations from a different
 * device are rejected. Provider keys are per-request (x-groq-key /
 * x-exa-key / providerKeys body, server-env fallback) and NEVER persisted.
 *
 * SSE contract: `event: phase` {phase,label}, `event: step` {text},
 * `event: done` {run}, `event: error` {text}, then res.end(). The run
 * continues server-side even if the client disconnects (state persists per
 * phase); a reconnecting client just GETs the investigation.
 */
import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import {
  listInvestigations, getInvestigation, saveInvestigation, deleteInvestigation,
  newInvestigationId, sanitizeBriefInput, sanitizeLimits,
} from './store.js';
import { runInvestigation, answerFromEvidence, explainEntity } from './orchestrator.js';
import type { Investigation, RunKeys } from './types.js';

export interface IntelligenceRouteDeps {
  verifyVaultAccess: (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (bucket: string, maxPerMin: number) => (req: Request, res: Response, next: NextFunction) => void;
}

/** Express 5 types route params as string | string[] — normalize once. */
function paramId(req: Request): string {
  const v = req.params?.id;
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function deviceOf(req: Request): string {
  const v = req.headers['x-enzo-owner'];
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function keysFromRequest(req: Request): RunKeys {
  const body = (req.body ?? {}) as Record<string, any>;
  const pk = (body.providerKeys ?? {}) as Record<string, string>;
  const header = (name: string): string => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v) as string || '';
  };
  return {
    groq: header('x-groq-key') || pk.groq || process.env.GROQ_API_KEY || '',
    exa: header('x-exa-key') || pk.exa || process.env.EXA_API_KEY || '',
  };
}

/** Runs in flight — one investigation runs at a time (in-process; the
 *  single-process store model is the whole repo's convention). */
const running = new Map<string, { cancel: boolean }>();

export function createIntelligenceRouter(deps: IntelligenceRouteDeps): Router {
  const router = express.Router();
  const { verifyVaultAccess, rateLimit } = deps;

  const ownedOr404 = (req: Request, res: Response): Investigation | null => {
    const inv = getInvestigation(paramId(req));
    if (!inv) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    if (inv.ownerToken && deviceOf(req) !== inv.ownerToken) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    return inv;
  };

  router.get('/api/intelligence/investigations', verifyVaultAccess, rateLimit('intel-list', 30), (_req, res) => {
    res.json({ investigations: listInvestigations() });
  });

  router.post('/api/intelligence/investigations', verifyVaultAccess, rateLimit('intel-create', 10), (req, res) => {
    try {
      const { name, brief, documents } = sanitizeBriefInput(req.body ?? {});
      const now = Date.now();
      const inv: Investigation = {
        id: newInvestigationId(),
        name,
        brief,
        documents,
        questions: [],
        evidence: [],
        runs: [],
        ...(deviceOf(req) ? { ownerToken: deviceOf(req) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      saveInvestigation(inv);
      res.status(201).json({ investigation: inv });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.get('/api/intelligence/investigations/:id', verifyVaultAccess, rateLimit('intel-get', 60), (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    res.json({ investigation: inv });
  });

  router.patch('/api/intelligence/investigations/:id', verifyVaultAccess, rateLimit('intel-create', 20), (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    if (running.has(inv.id)) {
      res.status(409).json({ error: 'already_running' });
      return;
    }
    try {
      const body = req.body ?? {};
      if (body.name !== undefined) {
        const name = String(body.name ?? '').trim().slice(0, 120);
        if (name) inv.name = name;
      }
      if (body.objective !== undefined || body.scope !== undefined || body.connectors !== undefined
        || body.seedUrls !== undefined || body.limits !== undefined) {
        const { brief, documents } = sanitizeBriefInput({
          objective: body.objective ?? inv.brief.objective,
          scope: body.scope ?? inv.brief.scope,
          connectors: body.connectors ?? inv.brief.connectors,
          seedUrls: body.seedUrls ?? inv.brief.seedUrls,
          limits: body.limits ?? inv.brief.limits,
          documents: body.documents ?? inv.documents,
        });
        inv.brief = brief;
        inv.documents = documents;
      } else if (body.documents !== undefined) {
        const { documents } = sanitizeBriefInput({ objective: inv.brief.objective, documents: body.documents });
        inv.documents = documents;
        inv.brief.connectors.documents = documents.length > 0;
      }
      inv.updatedAt = Date.now();
      saveInvestigation(inv);
      res.json({ investigation: inv });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.delete('/api/intelligence/investigations/:id', verifyVaultAccess, rateLimit('intel-create', 20), (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    running.delete(inv.id);
    res.json({ deleted: deleteInvestigation(inv.id) });
  });

  // ── SSE run ──────────────────────────────────────────────────────────────
  router.post('/api/intelligence/investigations/:id/run', verifyVaultAccess, rateLimit('intel-run', 6), async (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    if (running.has(inv.id)) {
      res.status(409).json({ error: 'already_running' });
      return;
    }
    const keys = keysFromRequest(req);
    if (!keys.groq) {
      res.status(400).json({ error: 'no_groq_key', message: 'A Groq key is required to run an investigation (add it in the Vault, or set GROQ_API_KEY on the server).' });
      return;
    }
    const planOnly = req.body?.planOnly === true;
    // Optional per-run limits override (e.g. the UI's current budget sliders).
    // Passed through runInvestigation as opts.limits — it is enforced for the
    // run but NEVER persisted, so a run (plan-only included) cannot rewrite
    // the investigation's saved brief limits.
    const limitsOverride = req.body?.limits ? sanitizeLimits(req.body.limits) : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    send('phase', { phase: 'planning', label: 'Planning' });

    const slot = { cancel: false };
    running.set(inv.id, slot);
    try {
      const done = await runInvestigation({ ...inv }, {
        planOnly,
        ...(limitsOverride ? { limits: limitsOverride } : {}),
        keys,
        onStep: (phase, line) => {
          send('phase', { phase, label: phase[0].toUpperCase() + phase.slice(1) });
          send('step', { text: line });
        },
        shouldStop: () => slot.cancel,
      });
      // runInvestigation worked on a shallow copy — write the finished run
      // back onto the stored investigation and persist.
      const stored = getInvestigation(inv.id);
      if (stored) {
        const finishedRun = done.runs[done.runs.length - 1];
        const at = stored.runs.findIndex((r) => r.id === finishedRun.id);
        if (at >= 0) stored.runs[at] = finishedRun;
        else stored.runs.push(finishedRun);
        if (planOnly) stored.questions = done.questions;
        stored.updatedAt = Date.now();
        saveInvestigation(stored);
        send('done', { run: finishedRun, investigation: stored });
      } else {
        send('error', { text: 'Investigation was deleted mid-run.' });
      }
    } catch (err: any) {
      send('error', { text: String(err?.message ?? err).slice(0, 300) });
    } finally {
      running.delete(inv.id);
      res.end();
    }
  });

  router.post('/api/intelligence/investigations/:id/cancel', verifyVaultAccess, rateLimit('intel-create', 30), (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    const slot = running.get(inv.id);
    if (!slot) {
      res.status(409).json({ error: 'not_running' });
      return;
    }
    slot.cancel = true;
    res.json({ cancelling: true });
  });

  router.post('/api/intelligence/investigations/:id/analyst', verifyVaultAccess, rateLimit('intel-analyst', 15), async (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    if (running.has(inv.id)) {
      res.status(409).json({ error: 'already_running' });
      return;
    }
    const question = String(req.body?.question ?? '').trim().slice(0, 800);
    if (!question) {
      res.status(400).json({ error: 'bad_request', message: 'question is required' });
      return;
    }
    if (!inv.evidence.length) {
      res.status(400).json({ error: 'no_evidence', message: 'Run the investigation first — the analyst answers from collected evidence only.' });
      return;
    }
    const keys = keysFromRequest(req);
    if (!keys.groq) {
      res.status(400).json({ error: 'no_groq_key', message: 'A Groq key is required for the analyst.' });
      return;
    }
    try {
      const answer = await answerFromEvidence(inv, question, { keys });
      res.json({ answer });
    } catch (err: any) {
      res.status(502).json({ error: 'model_error', message: String(err?.message ?? err).slice(0, 300) });
    }
  });

  router.post('/api/intelligence/investigations/:id/explain', verifyVaultAccess, rateLimit('intel-explain', 15), async (req, res) => {
    const inv = ownedOr404(req, res);
    if (!inv) return;
    if (running.has(inv.id)) {
      res.status(409).json({ error: 'already_running', message: 'The investigation is running — wait for it to finish before asking about a node.' });
      return;
    }
    const entityId = String(req.body?.entityId ?? '').trim().slice(0, 64);
    if (!entityId) {
      res.status(400).json({ error: 'bad_request', message: 'entityId is required' });
      return;
    }
    // A follow-up doubt is optional: without one this route explains the node.
    const question = String(req.body?.question ?? '').trim().slice(0, 800);
    if (!inv.evidence.length) {
      res.status(400).json({ error: 'no_evidence', message: 'Run the investigation first — the explainer works from collected evidence only.' });
      return;
    }
    const keys = keysFromRequest(req);
    if (!keys.groq) {
      res.status(400).json({ error: 'no_groq_key', message: 'A Groq key is required to explain a node.' });
      return;
    }
    try {
      const result = await explainEntity(inv, entityId, question, { keys });
      res.json(result);
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 300);
      // An unknown entity is the caller's mistake (404), not a model failure.
      if (/is not in this investigation's graph/.test(message)) {
        res.status(404).json({ error: 'not_found', message: 'That node is not in the investigation graph.' });
        return;
      }
      res.status(502).json({ error: 'model_error', message });
    }
  });

  return router;
}
