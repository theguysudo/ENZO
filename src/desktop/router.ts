/**
 * router.ts — the desktop self-update HTTP surface.
 *
 *   GET  /api/desktop/update         → { current, latest, available, notify, asset… }
 *   POST /api/desktop/update/apply   → starts download + swap, returns status
 *   GET  /api/desktop/update/status  → live phase/progress of an apply in flight
 *
 * Auth: deliberately NOT the vault token. These routes are reachable only from
 * the loopback interface (the desktop app runs on the user's own machine) and
 * the feature has to work BEFORE any provider key is claimed — otherwise a
 * fresh install would never be told about an update. The routes are absent
 * entirely unless the process was started by desktop/launcher.js
 * (ENZO_DESKTOP_HOME), so docker/hosted deployments expose nothing here.
 */
import express, { type Router, type Request, type Response } from 'express';
import {
  checkForUpdate,
  startApply,
  applyStatus,
  exitAfterApply,
  isDesktopInstall,
} from './update.js';

function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.endsWith('127.0.0.1');
}

export function createDesktopRouter(): Router {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isDesktopInstall()) return res.status(404).json({ error: 'not a desktop install' });
    if (!isLoopback(req)) return res.status(403).json({ error: 'local requests only' });
    next();
  });

  router.get('/update', async (_req, res) => {
    try {
      const info = await checkForUpdate();
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'update check failed' });
    }
  });

  router.post('/update/apply', async (_req, res) => {
    try {
      const info = await checkForUpdate();
      if (!info.available) {
        return res.status(400).json({ error: 'no update available', status: applyStatus() });
      }
      const status = await startApply(info);
      if (status.phase === 'error') return res.status(500).json(status);
      res.json(status);
      // The bundle is about to be replaced — hand the rest to the helper.
      exitAfterApply();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'update failed' });
    }
  });

  router.get('/update/status', (_req, res) => {
    res.json(applyStatus());
  });

  return router;
}
