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
import { saveVaultKeysToEnv } from '../core/env-manager.js';
import { persistClaimedKey } from '../core/vault-boot.js';
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
  // Docker variant gap found in v1.1.0 live testing: with no client
  // configured, generateAuthUrl still returns a URL — one with an EMPTY
  // client_id, which Google renders as a dead-end error page. Say so
  // plainly instead; the frontend points the operator at the onboarding
  // step that collects their own client.
  if (!(process.env.GOOGLE_CLIENT_ID || '').trim() || !(process.env.GOOGLE_CLIENT_SECRET || '').trim()) {
    res.status(503).json({ error: 'oauth_client_not_configured', detail: 'Set your Google OAuth client (onboarding, last step) to connect Gmail/Calendar on this instance.' });
    return;
  }
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

// ── Bring-your-own OAuth client (docker variant) ────────────────────────────
// The self-hosted operator's OWN Google app for the Gmail/Calendar connect
// flow. Same BYO philosophy as the provider keys: the operator creates an
// OAuth client in Google Cloud Console, pastes the id/secret here, and the
// consent flow runs against THEIR app — ENZO's verification status never
// enters the picture. saveVaultKeysToEnv writes .env AND updates process.env
// in memory, and gmailClient() reads process.env live, so a saved client
// heals /api/gmail/auth-url without a container restart.
//
// The save is gated on the vault session token (verifyVaultAccess, injected
// at mount): on a fresh instance only the operator who claimed it holds one,
// so a visitor can't repoint the shared OAuth client at their own app. The
// status echo never returns the secret — only whether the client is set.
app.get('/api/gmail/oauth-client', (req, res) => {
  // The redirect URI the operator must whitelist in Google Console. Derived
  // from how THIS request reached the server (X-Forwarded-Proto/Host behind
  // the nginx sidecar, req.secure on bare https) so a duckdns deployment
  // shows its own URL, localhost shows localhost. The GMAIL_REDIRECT_URI env
  // override wins when set — an operator who pinned it knows better.
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http') || 'http').split(',')[0].trim()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  const derived = host ? `${proto}://${host}/api/gmail/callback` : (process.env.GMAIL_REDIRECT_URI || '')
  const redirectUri = process.env.GMAIL_REDIRECT_URI || derived
  res.json({
    configured: Boolean((process.env.GOOGLE_CLIENT_ID || '').trim() && (process.env.GOOGLE_CLIENT_SECRET || '').trim()),
    redirectUri,
  });
});

app.post('/api/gmail/oauth-client', (req, res) => {
  // Docker variant only (ENZO_GOOGLE_AUTH=0, set by the Dockerfile). On the
  // hosted instance GOOGLE_CLIENT_ID is the SITE's Google sign-in client —
  // a visitor rewriting it via this endpoint would break hosted sign-in, so
  // the endpoint refuses to exist there.
  if (process.env.ENZO_GOOGLE_AUTH !== '0') {
    res.status(404).json({ error: 'oauth_client_save_disabled' });
    return;
  }
  // Injected by index.ts at boot (app.locals) so this module never imports
  // index.ts back. Read at request time — mount order doesn't matter.
  const verify = ((req.app as any).locals?.verifyVaultAccess) as
    | ((req: express.Request, res: express.Response, next: express.NextFunction) => void)
    | undefined;
  if (!verify) {
    res.status(501).json({ error: 'oauth_client_save_unavailable' });
    return;
  }
  verify(req, res, () => {
    try {
      const { clientId, clientSecret } = req.body || {};
      const id = String(clientId ?? '').trim();
      const secret = String(clientSecret ?? '').trim();
      // Google OAuth client ids look like
      // <digits>-<random>.apps.googleusercontent.com; secrets are ~24-35
      // chars. Loose validation — reject empties and obvious pastes of the
      // wrong field, never block a legitimate format change by Google.
      if (!id || !/^[0-9]+-[a-z0-9._-]+\.apps\.googleusercontent\.com$/i.test(id)) {
        res.status(400).json({ error: 'invalid_client_id', detail: 'expected format: <number>-<hash>.apps.googleusercontent.com' });
        return;
      }
      if (!secret || /[\n\r]/.test(secret)) {
        res.status(400).json({ error: 'invalid_client_secret' });
        return;
      }
      const { updated } = saveVaultKeysToEnv({ gmailClientId: id, gmailClientSecret: secret });
      // Also seal into the operator-key store (enzo-memory volume) so the
      // client survives a container recreation — same durability the
      // first-key claim gives provider keys. Restore is env-empty-only, so
      // a compose-env pre-seed still wins on purpose.
      persistClaimedKey('gmailClientId', id);
      persistClaimedKey('gmailClientSecret', secret);
      console.log(`[gmail/oauth-client] operator set their own Google OAuth client (${id.slice(0, 12)}…) — Gmail connect now runs against it`);
      res.json({ success: true, updated });
    } catch (err: any) {
      console.error('[gmail/oauth-client] save error:', err?.message || err);
      res.status(500).json({ error: 'oauth_client_save_failed', detail: String(err?.message ?? err).slice(0, 300) });
    }
  });
});

export function mountFeatureRoutes(app_: express.Application) {
  app_.use('/', app);
}
