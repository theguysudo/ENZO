/**
 * featureRoutes.ts — Google (Gmail + Calendar) OAuth connect flow for ENZO.
 *
 * Mounted from index.ts via `mountFeatureRoutes(app)`.
 *
 * NOTE: The actual capabilities (reading Gmail, listing/creating calendar
 * events, web/research, model-recommend, doc-assist, compare) are NOT REST
 * endpoints anymore — they are agent TOOLS in `agent-tools.ts`, driven by the
 * model inside /api/chat. This file only keeps the OAuth handshake the agent
 * points the user to when Google isn't connected yet:
 *
 *   GET  /api/gmail/auth-url   → the Google consent URL to open
 *   GET  /api/gmail/callback   → Google redirects here; we persist the tokens
 *   GET  /api/gmail/status     → { connected: boolean }
 *   POST /api/gmail/disconnect → forget the stored tokens
 *
 * Tokens are written to `.gmail-tokens.json` (cwd-relative, gitignored, and
 * AES-256-GCM sealed on disk by crypto-store.ts). The agent tools read that
 * same path through the same helpers.
 *
 * ponytail: ONE global token file, so a hosted instance has ONE Gmail identity
 * shared by every visitor — whoever connects last owns it. That is a schema
 * problem, not an encryption problem, and it is recorded in
 * docs/PROJECT_REPORT.md §7. Fine for self-hosted (the intended deployment);
 * per-user token rows are the upgrade path before this is multi-tenant.
 */
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { google } from 'googleapis';
import { writeSecretFile } from '../agent/crypto-store.js';

const app = express.Router();

const GMAIL_TOKENS_PATH = '.gmail-tokens.json';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
];

function gmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:5001/api/gmail/callback';
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ── OAuth CSRF state ─────────────────────────────────────────────────────────
// Without a state parameter, /api/gmail/callback accepts any `code` from anyone.
// An attacker sends the victim's browser to the callback carrying a code minted
// for the ATTACKER's Google account, and the server silently rebinds its Gmail
// identity to it — every later gmail_list / gmail_send tool call then runs
// against the attacker's mailbox. A single-use, expiring state closes that: only
// a browser that actually asked for a consent URL here can complete the exchange.
//
// ponytail: in-memory Map. A server restart mid-consent means the user clicks
// Connect again. Move it to disk (or Redis) only if this ever runs multi-instance.
const oauthState = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState(): string {
  const now = Date.now();
  for (const [k, expiry] of oauthState) if (expiry <= now) oauthState.delete(k);
  const state = crypto.randomBytes(32).toString('hex');
  oauthState.set(state, now + STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  const expiry = oauthState.get(state);
  oauthState.delete(state); // single-use whether or not it was still valid
  return Boolean(expiry && expiry > Date.now());
}

/**
 * Reject cross-site POSTs. A bare `fetch('/api/gmail/disconnect', {method:'POST'})`
 * from any page is a CORS "simple request": the browser blocks the *response* but
 * still *sends* it, so an attacker could disconnect the user's Google at will.
 * Requiring a custom header makes it non-simple, which forces a preflight — and
 * the CORS allowlist in index.ts fails that preflight for foreign origins, so the
 * request never arrives.
 *
 * Note this is deliberately NOT verifyVaultAccess: that guard needs a vault
 * session token, which can only be minted when the server's own .env holds the
 * same provider key as the browser. In BYOK mode it never can, so requiring it
 * here would break Connect Google for exactly the users it is meant to protect.
 */
function requireSameSite(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.headers['x-enzo-csrf']) {
    res.status(403).json({ error: 'missing_csrf_header' });
    return;
  }
  next();
}

/**
 * The Google consent URL, carrying a fresh single-use state.
 *
 * Exported because agent-tools.ts hands this same URL to the user when a Gmail
 * or Calendar tool fires while Google is not connected. It used to build its own
 * copy of the URL three times over — which, once the callback started checking
 * state, would have produced three URLs that always failed. One builder, one
 * state store, no drift.
 */
export function gmailConsentUrl(): string {
  return gmailClient().generateAuthUrl({
    access_type: 'offline',
    scope: GMAIL_SCOPES,
    include_granted_scopes: true,
    prompt: 'consent',
    state: issueState(),
  });
}

app.get('/api/gmail/auth-url', (_req, res) => {
  res.json({ url: gmailConsentUrl() });
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!state || !consumeState(state)) {
    console.error('[gmail/callback] rejected: missing, unknown or expired state');
    return res.status(400).json({ error: 'invalid_state' });
  }
  try {
    const oauth2Client = gmailClient();
    const { tokens } = await oauth2Client.getToken(code);
    // Persist locally, sealed (never expose the access token to the client UI).
    writeSecretFile(GMAIL_TOKENS_PATH, tokens);
    // Redirect to the Vite frontend (not the backend) — backend has no HTML to serve
    const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
    res.redirect(`${frontendOrigin}/?gmail=connected&s=7`);
  } catch (err: any) {
    console.error('[gmail/callback]', err);
    res.status(500).json({ error: String(err.message ?? err).slice(0, 300) });
  }
});

app.get('/api/gmail/status', (_req, res) => {
  res.json({ connected: fs.existsSync(GMAIL_TOKENS_PATH) });
});

app.post('/api/gmail/disconnect', requireSameSite, (_req, res) => {
  try { fs.unlinkSync(GMAIL_TOKENS_PATH); } catch {}
  res.json({ disconnected: true });
});

export function mountFeatureRoutes(app_: express.Application) {
  app_.use('/', app);
}
