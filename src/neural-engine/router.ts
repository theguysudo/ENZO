/**
 * router.ts — the Neural Engine HTTP surface (Phases 1–4).
 *
 * Mounted under /api/neural-engine (deliberately NOT /api/neural — that
 * prefix belongs to the custom-agents' self-trained attention layer, which
 * this system neither reuses nor rewrites).
 *
 * Identity: every route derives the owner from the vault-verified
 * x-enzo-owner header — never from the request body (the guide's "never
 * trust user-supplied userId", adapted to ENZO's device-id ownership model).
 * All routes sit behind injected verifyVaultAccess + rateLimit (they live
 * unexported in index.ts, same injection pattern as agentRoutes).
 *
 * Privacy: payloads are size-capped; nothing here logs event/pref contents;
 * GET /api/providers/capabilities serves server-verified metadata only.
 */
import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import {
  loadOwner, saveOwner, deleteOwner, resetOwnerCache,
  sanitizeProfilePatch, sanitizeNodeInput, sanitizeEdgeInput, sanitizeEventInput,
  validOwnerId, CAPS,
} from './store.js';
import {
  effectivePreferences, buildResearchContext, upsertNode, addEdge, applyEvent, appendEvent,
} from './service.js';
import { capabilitySnapshot, assertRouteAllowed, usageWithinQuota } from './capabilities.js';
import type { NeuralOwnerState, PrefDimension } from './types.js';

export interface NeuralRouteDeps {
  verifyVaultAccess: (req: Request, res: Response, next: NextFunction) => void;
  rateLimit: (bucket: string, maxPerMin: number) => (req: Request, res: Response, next: NextFunction) => void;
}

function paramId(req: Request): string {
  const v = req.params?.id;
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function ownerOf(req: Request): string {
  const v = req.headers['x-enzo-owner'];
  return (Array.isArray(v) ? v[0] : v) as string || '';
}

/** Resolve + validate the owner or send the error response. */
function requireOwner(req: Request, res: Response): NeuralOwnerState | null {
  const owner = ownerOf(req);
  if (!owner || !validOwnerId(owner)) {
    res.status(400).json({ error: 'owner_required', message: 'x-enzo-owner device id required' });
    return null;
  }
  return loadOwner(owner);
}

export function createNeuralEngineRouter(deps: NeuralRouteDeps): Router {
  const router = express.Router();
  const { verifyVaultAccess, rateLimit } = deps;

  // ── Profile (§4) ───────────────────────────────────────────────────────────
  router.get('/api/neural-engine/profile', verifyVaultAccess, rateLimit('neural-read', 60), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    res.json({ profile: state.profile, effective: effectivePreferences(state.profile) });
  });

  router.patch('/api/neural-engine/profile', verifyVaultAccess, rateLimit('neural-write', 30), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    try {
      const patch = sanitizeProfilePatch(req.body);
      const changes: string[] = [];
      for (const s of patch.set ?? []) {
        applyEvent(state, { type: 'preference_corrected', dimension: s.dimension, value: s.value, detail: s.rationale }, 'explicit');
        changes.push(`${s.dimension} → ${s.value} (explicit)`);
      }
      for (const c of patch.clear ?? []) {
        applyEvent(state, { type: 'memory_forgotten', dimension: c.dimension, value: c.value }, 'explicit');
        changes.push(`cleared ${c.dimension}: ${c.value}`);
      }
      if (patch.trainingAllowed !== undefined) {
        // Training consent is its own explicit opt-in (Phase 5 gate) — recorded
        // as an audit event either way so the consent trail is inspectable.
        // It is NOT a preference dimension: the old code borrowed depth/value
        // as a slot, which put "trainingAllowed" into the audit trail as if
        // it were a research-depth value.
        state.profile.trainingAllowed = patch.trainingAllowed;
        appendEvent(state, {
          type: 'training_consent_changed',
          detail: patch.trainingAllowed
            ? 'Training consent GRANTED (Phase 5 dataset gate)'
            : 'Training consent revoked',
          signal: 'explicit',
          provenance: {},
        });
        changes.push(`trainingAllowed=${patch.trainingAllowed}`);
      }
      saveOwner(state);
      res.json({ profile: state.profile, effective: effectivePreferences(state.profile), changes });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  // ── Neural Map (§5) ────────────────────────────────────────────────────────
  router.get('/api/neural-engine/map', verifyVaultAccess, rateLimit('neural-read', 60), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    const type = paramId(req) || String(req.query.type ?? '');
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 120) || 120));
    const active = state.nodes.filter((n) => !n.excludedFromTraining && (!type || n.type === type));
    const activeIds = new Set(active.map((n) => n.id));
    const edges = state.edges
      .filter((e) => activeIds.has(e.from) && activeIds.has(e.to))
      .slice(-CAPS.edges)
      .slice(0, 400);
    res.json({
      nodes: active.slice(-limit),
      edges,
      sources: state.sources.slice(-60),
      stats: {
        totalNodes: state.nodes.length,
        activeNodes: active.length,
        edges: state.edges.length,
        verified: active.filter((n) => n.verified).length,
        events: state.events.length,
      },
    });
  });

  router.post('/api/neural-engine/nodes', verifyVaultAccess, rateLimit('neural-write', 30), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    try {
      const input = sanitizeNodeInput(req.body);
      const { node, merged } = upsertNode(state, input);
      saveOwner(state);
      res.status(merged ? 200 : 201).json({ node, merged });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.patch('/api/neural-engine/nodes/:id', verifyVaultAccess, rateLimit('neural-write', 30), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    const node = state.nodes.find((n) => n.id === paramId(req));
    if (!node) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body ?? {};
    if (body.label !== undefined) {
      const label = String(body.label).trim().slice(0, CAPS.label);
      if (label) node.label = label;
    }
    if (body.outdated !== undefined) node.outdated = body.outdated === true;
    node.lastSeenAt = Date.now();
    saveOwner(state);
    res.json({ node });
  });

  router.post('/api/neural-engine/edges', verifyVaultAccess, rateLimit('neural-write', 30), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    try {
      const input = sanitizeEdgeInput(req.body, state.nodes.filter((n) => !n.excludedFromTraining));
      const refs = Array.isArray(req.body?.evidenceRefs) ? req.body.evidenceRefs.map(String).slice(0, 8) : [];
      const edge = addEdge(state, input, refs);
      saveOwner(state);
      res.status(201).json({ edge });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  // ── Learning events + feedback controls (§6) ───────────────────────────────
  router.post('/api/neural-engine/events', verifyVaultAccess, rateLimit('neural-events', 40), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    try {
      const input = sanitizeEventInput(req.body);
      const applied = applyEvent(state, input, 'explicit');
      if (!applied) {
        res.status(400).json({ error: 'bad_request', message: 'event referenced unknown dimension/node or was a no-op' });
        return;
      }
      saveOwner(state);
      res.status(201).json({ event: applied.event, summary: applied.summary });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.post('/api/neural-engine/forget', verifyVaultAccess, rateLimit('neural-write', 20), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    try {
      const body = req.body ?? {};
      const input = sanitizeEventInput({ type: 'memory_forgotten', nodeId: body.nodeId, dimension: body.dimension, value: body.value, detail: body.detail });
      const applied = applyEvent(state, input, 'explicit');
      if (!applied) {
        res.status(400).json({ error: 'bad_request', message: 'nothing matched — pass nodeId and/or dimension+value' });
        return;
      }
      saveOwner(state);
      res.json({ forgotten: true, summary: applied.summary });
    } catch (err: any) {
      res.status(400).json({ error: 'bad_request', message: String(err?.message ?? err).slice(0, 200) });
    }
  });

  router.get('/api/neural-engine/history', verifyVaultAccess, rateLimit('neural-read', 60), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const events = [...state.events].reverse().slice(offset, offset + limit);
    res.json({ events, total: state.events.length });
  });

  // ── Context assembly preview (§4.3 — the same builder the chat path uses) ──
  router.post('/api/neural-engine/context', verifyVaultAccess, rateLimit('neural-read', 60), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    const query = String(req.body?.query ?? '').trim().slice(0, 2000);
    const overrides: Partial<Record<PrefDimension, string>> = {};
    if (req.body?.preferences && typeof req.body.preferences === 'object') {
      for (const [k, v] of Object.entries(req.body.preferences as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) overrides[k as PrefDimension] = v.trim().slice(0, 120);
      }
    }
    const context = buildResearchContext(state, { query, preferences: overrides });
    res.json({ context, chars: context.length, cap: CAPS.contextChars });
  });

  // ── Full reset (deletion control) ──────────────────────────────────────────
  router.delete('/api/neural-engine/state', verifyVaultAccess, rateLimit('neural-write', 5), (req, res) => {
    const owner = ownerOf(req);
    if (!owner || !validOwnerId(owner)) {
      res.status(400).json({ error: 'owner_required' });
      return;
    }
    res.json({ deleted: deleteOwner(owner) });
  });

  // ── Zero-cost provider registry (§7) ───────────────────────────────────────
  router.get('/api/providers/capabilities', verifyVaultAccess, rateLimit('neural-read', 30), (_req, res) => {
    res.json(capabilitySnapshot());
  });

  router.post('/api/neural-engine/check-route', verifyVaultAccess, rateLimit('neural-read', 60), (req, res) => {
    const state = requireOwner(req, res);
    if (!state) return;
    const modelId = String(req.body?.modelId ?? '').slice(0, 160);
    const operation = req.body?.operation === 'training' || req.body?.operation === 'adapter_serve'
      ? (req.body.operation as 'training' | 'adapter_serve')
      : 'inference';
    if (!modelId) {
      res.status(400).json({ error: 'bad_request', message: 'modelId required' });
      return;
    }
    const route = assertRouteAllowed(modelId, operation);
    const quota = usageWithinQuota(state.usage, modelId);
    res.json({ route, quota });
  });

  // Test seam — drop owner caches (never exposed in production flow).
  router.post('/api/neural-engine/_reset-cache', (_req, res) => {
    if (process.env.ENZO_E2E_SEAMS !== '1') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    resetOwnerCache();
    res.json({ ok: true });
  });

  return router;
}
