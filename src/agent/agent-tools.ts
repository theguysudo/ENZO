/**
 * agent-tools.ts — the real tool-calling agent for ENZO.
 *
 * This replaces the fake "/api/agent/run" endpoint (which merely told the model
 * to reply with the string "HIT /api/..."). Here the model is given real tools
 * via Groq function-calling; it decides which to call, we execute them
 * server-side, feed results back, and loop until it answers.
 *
 * Invoked from /api/chat (index.ts) when Groq is the active provider and the
 * mode is a text mode. Every other path in /api/chat is untouched.
 *
 * Tool executors reuse the logic Kimi already wrote in featureRoutes.ts — the
 * Gmail/Calendar/cookbook/compare/docs code is fine, it was only wired wrong
 * (as standalone tabs). Here the bodies are lifted and return plain objects
 * instead of writing to an Express `res` (the response is already an open SSE
 * stream by the time tools run).
 */
import { Groq } from 'groq-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import { searchWeb } from '../agent/search.js';
import { runDeepResearch } from '../agent/research-engine.js';
import { gmailConsentUrl } from '../features/featureRoutes.js';
import { readSecretFile, writeSecretFile, deleteSecretFile } from '../agent/crypto-store.js';

// Simple in-memory cache for pending email drafts (confirmation flow)
// Key: hash of draft content, Value: { to, subject, body, expires }
const pendingDrafts = new Map<string, { to: string; subject: string; body: string; expires: number }>();

function getDraftKey(to: string, subject: string, body: string): string {
  return crypto.createHash('sha256').update(`${to}|${subject}|${body}`).digest('hex').slice(0, 16);
}

function storePendingDraft(to: string, subject: string, body: string): string {
  const key = getDraftKey(to, subject, body);
  pendingDrafts.set(key, { to, subject, body, expires: Date.now() + 10 * 60 * 1000 }); // 10 min TTL
  return key;
}

function getPendingDraft(to: string, subject: string, body: string): { to: string; subject: string; body: string } | null {
  const key = getDraftKey(to, subject, body);
  const draft = pendingDrafts.get(key);
  if (draft && draft.expires > Date.now()) {
    return { to: draft.to, subject: draft.subject, body: draft.body };
  }
  pendingDrafts.delete(key);
  return null;
}

function clearPendingDraft(to: string, subject: string, body: string): void {
  const key = getDraftKey(to, subject, body);
  pendingDrafts.delete(key);
}

export function findMatchingDraft(userMessage: string): { to: string; subject: string; body: string } | null {
  // Look for a draft that matches the user's confirmation intent
  // Simple heuristic: if user says "yes", "send", "confirm" and there's a recent draft
  const confirmKeywords = ['yes', 'send it', 'confirmed', 'send', 'go ahead', 'proceed', 'confirm'];
  const lowerMsg = userMessage.toLowerCase();
  const isConfirmation = confirmKeywords.some(kw => lowerMsg.includes(kw));
  
  if (!isConfirmation) return null;
  
  // Return the most recent draft (first one in cache)
  for (const [, draft] of pendingDrafts) {
    if (draft.expires > Date.now()) {
      return { to: draft.to, subject: draft.subject, body: draft.body };
    }
  }
  return null;
}

// ── Context handed to every tool ────────────────────────────────────────────
export interface ToolCtx {
  groq: string;
  exa: string;
  nvidia: string;
  openrouter: string;
  pollinations: string;
  hf: string;
  /** When true, gmail_send / calendar_create refuse unless the call carries
   *  confirm:true — the "auto reads, confirm writes" policy. */
  confirmWrites: boolean;
  /** Emit a user-visible progress line (wired to writeSearchStatus). */
  onStep: (line: string) => void;
  /** Emit a structured agent event on its own SSE channel (live document
   *  drafts, comparison tables, auth-requirement cards). */
  emitEvent: (event: string, payload: Record<string, unknown>) => void;
  /** The raw user message — parsed for [ATTACHED FILE: ...] blocks so
   *  document_work can edit an attached document without the model having
   *  to echo its full contents back into a tool call. */
  userMessage: string;
  /** Web search setting: true = enabled (auto-detect), false = disabled */
  webSearch?: boolean;
  /** True when this request already ran the OAuth-deferred loop: the user
   *  clicked "Connect Google" and the pending action is being re-run. Tools
   *  must then fail hard instead of bouncing back to the consent screen. */
  resumeAfterConnect?: boolean;
  /** IANA timezone string from the client (e.g. "Asia/Kolkata"). Used for calendar events. */
  userTimezone?: string;
}

type FeatureKeys = {
  groq?: string;
  openrouter?: string;
  nvidia?: string;
  hf?: string;
  pollinations?: string;
};

const LLM_TIMEOUT_MS = 12_000;
const GMAIL_TOKENS_PATH = '.gmail-tokens.json'; // bare, cwd-relative — MUST match the OAuth callback

// ── Shared LLM fallback (ported from featureRoutes.resolveChat) ─────────────
// Used by the compare_models and document_assist tools. Groq → NVIDIA →
// OpenRouter, small models, low load.
async function resolveChat(keys: FeatureKeys, sys: string, userMsgs: any[]): Promise<string> {
  const groq = keys.groq || process.env.GROQ_API_KEY;
  const nvidia = keys.nvidia || process.env.NVIDIA_API_KEY;
  const openrouter = keys.openrouter || process.env.OPENROUTER_API_KEY;
  const models = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
  const errors: string[] = [];

  if (groq) {
    const client = new Groq({ apiKey: groq, maxRetries: 0, timeout: LLM_TIMEOUT_MS });
    for (const model of models) {
      try {
        const r = await client.chat.completions.create({
          model,
          messages: [{ role: 'system', content: sys }, ...userMsgs] as any,
          temperature: 0.6,
          max_tokens: 700,
        });
        const t = r?.choices?.[0]?.message?.content;
        if (t) return t;
      } catch (err: any) {
        errors.push(`groq/${model}: ${String(err?.message ?? err).slice(0, 60)}`);
        if (String(err?.status).startsWith('4')) break;
      }
    }
  }
  if (nvidia) {
    try {
      const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${nvidia}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta/llama-3.1-8b-instruct',
          messages: [{ role: 'system', content: sys }, ...userMsgs],
          temperature: 0.6,
          max_tokens: 700,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as any;
        const t = j?.choices?.[0]?.message?.content;
        if (t) return t;
      } else errors.push(`nvidia: ${r.status}`);
    } catch (err: any) {
      errors.push(`nvidia: ${String(err?.message ?? err).slice(0, 60)}`);
    }
  }
  if (openrouter) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openrouter}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{ role: 'system', content: sys }, ...userMsgs],
          temperature: 0.6,
          max_tokens: 700,
        }),
      });
      if (r.ok) {
        const j = (await r.json()) as any;
        const t = j?.choices?.[0]?.message?.content;
        if (t) return t;
      } else errors.push(`openrouter: ${r.status}`);
    } catch (err: any) {
      errors.push(`openrouter: ${String(err?.message ?? err).slice(0, 60)}`);
    }
  }
  throw new Error(`LLM providers failed: ${errors.join(' | ')}`);
}

// ── Google auth ──────────────────────────────────────────────────────────────
// The consent URL and its CSRF state both live in featureRoutes.ts, which owns
// the /api/gmail/callback that validates them. Building a second copy here is how
// you end up with a URL whose state the callback has never heard of.
function gmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:5001/api/gmail/callback';
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Returns an authed OAuth2 client, or a { not_connected } sentinel with the
 *  URL the user must click to connect Gmail/Calendar. */
async function loadGoogleAuth(): Promise<{ client: any } | { not_connected: true; authUrl: string; message: string }> {
  if (!fs.existsSync(GMAIL_TOKENS_PATH)) {
    return {
      not_connected: true,
      authUrl: gmailConsentUrl(),
      message: 'Gmail/Calendar is not connected yet. Ask the user to open this URL to connect their Google account, then retry.',
    };
  }
  const tokens = readSecretFile<any>(GMAIL_TOKENS_PATH);
  if (!tokens) {
    return {
      not_connected: true,
      authUrl: gmailConsentUrl(),
      message: 'Gmail/Calendar tokens could not be read. Ask the user to reconnect their Google account via this URL.',
    };
  }
  const oauth2Client = gmailClient();
  oauth2Client.setCredentials(tokens);

  if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
    console.log('[gmail] Access token expired, refreshing...');
    if (!tokens.refresh_token) {
      console.error('[gmail] No refresh token available - re-authentication required');
      // Remove invalid tokens so next call triggers re-auth
      deleteSecretFile(GMAIL_TOKENS_PATH);
      return {
        not_connected: true,
        authUrl: gmailConsentUrl(),
        message: 'Gmail access token expired and no refresh token available. Please re-authenticate by opening this URL.',
      };
    }
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      const mergedTokens = { ...tokens, ...credentials };
      writeSecretFile(GMAIL_TOKENS_PATH, mergedTokens);
      oauth2Client.setCredentials(mergedTokens);
      console.log('[gmail] Token refreshed and saved');
    } catch (err: any) {
      console.error('[gmail] Token refresh failed:', err.message);
      // On refresh failure, clear tokens and require re-auth
      deleteSecretFile(GMAIL_TOKENS_PATH);
      return {
        not_connected: true,
        authUrl: gmailConsentUrl(),
        message: 'Gmail token refresh failed. Please re-authenticate by opening this URL.',
      };
    }
  }

  return { client: oauth2Client };
}

// ── Catalog (ported from featureRoutes.getCatalog) ──────────────────────────
function getCatalog(): any[] {
  const cachePath = path.join(process.cwd(), 'model-cache.json');
  if (!fs.existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return Array.isArray(raw) ? raw : raw.models || [];
  } catch {
    return [];
  }
}

// ── Tool executors ──────────────────────────────────────────────────────────

async function toolWebSearch(args: any, ctx: ToolCtx) {
  const query = String(args?.query || '').trim();
  if (!query) return { error: 'query is required' };
  const count = Math.min(Math.max(Number(args?.count) || 5, 1), 10);
  console.log('[agent-tools] toolWebSearch called, Exa key:', ctx.exa ? 'present' : 'MISSING');
  const results = await searchWeb(query, count, ctx.groq, ctx.exa || undefined);
  return { query, results: results || 'No results found.' };
}

async function toolDeepResearch(args: any, ctx: ToolCtx) {
  const query = String(args?.query || '').trim();
  if (!query) return { error: 'query is required' };
  if (!ctx.exa) return { error: 'Deep research needs an Exa key (Vault → exa). Use web_search instead.' };
  console.log('[agent-tools] toolDeepResearch called, Exa key:', ctx.exa ? 'present' : 'MISSING');
  const report = await runDeepResearch({
    query,
    exaKey: ctx.exa,
    groqKey: ctx.groq || process.env.GROQ_API_KEY || '',
    onStep: (line) => ctx.onStep(line),
  });
  return {
    query,
    report: report.context.slice(0, 8000),
    sourceCount: report.sources.length,
  };
}

function formatDateTime(dateInput: string | number | undefined, userTz: string): { local: string; iso: string } {
  let ms = typeof dateInput === 'number' ? dateInput : Number(dateInput);
  if (isNaN(ms) || ms <= 0) {
    if (typeof dateInput === 'string' && dateInput.trim()) {
      ms = Date.parse(dateInput);
    }
  }
  if (isNaN(ms) || ms <= 0) {
    ms = Date.now();
  }
  const dateObj = new Date(ms);
  const iso = dateObj.toISOString();
  
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: userTz || 'Asia/Kolkata',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(dateObj);
    return { local: formatted, iso };
  } catch {
    return { local: dateObj.toLocaleString('en-US', { hour12: true }), iso };
  }
}

async function toolGmailList(args: any, ctx: ToolCtx) {
  const auth = await loadGoogleAuth();
  if ('not_connected' in auth) return auth;
  const gmail = google.gmail({ version: 'v1', auth: auth.client });
  const maxResults = Math.min(Math.max(Number(args?.maxResults) || 20, 1), 50);
  const q = typeof args?.query === 'string' && args.query.trim() ? args.query : undefined;
  const userTz = ctx.userTimezone || 'Asia/Kolkata';

  const list = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    ...(q ? { q } : {}),
  });
  const ids = (list.data.messages || []).map((m: any) => m.id!).filter(Boolean);
  const messages = await Promise.all(
    ids.map(async (id) => {
      try {
        const m = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = m.data.payload?.headers || [];
        const hdr = (n: string) => {
          const target = n.toLowerCase();
          return headers.find((h: any) => h.name?.toLowerCase() === target)?.value as string | undefined;
        };
        const rawDate = hdr('date');
        const internalMs = m.data.internalDate;
        const dt = formatDateTime(internalMs || rawDate, userTz);

        return {
          id: m.data.id!,
          from: hdr('from') || 'unknown',
          subject: hdr('subject') || '(no subject)',
          date: dt.local, // e.g. "Sat, Aug 8, 2026, 6:52:33 PM IST"
          dateIso: dt.iso,
          snippet: (m.data.snippet || '').slice(0, 250),
          unread: (m.data.labelIds || []).includes('UNREAD'),
        };
      } catch {
        return null;
      }
    })
  );
  const validMessages = messages.filter(Boolean);
  return {
    count: validMessages.length,
    messages: validMessages,
    fetchedAt: new Date().toISOString(),
    userTimezone: userTz,
  };
}

async function toolGmailSend(args: any, ctx: ToolCtx) {
  const to = String(args?.to || '').trim();
  const subject = String(args?.subject || 'Re:').trim();
  const body = String(args?.body || '').trim();
  if (!to || !body) return { error: 'to and body are required' };

  // Check for auto-confirmation from user message (e.g., "yes, send it")
  const userMsg = ctx.userMessage || '';
  const matchedDraft = findMatchingDraft(userMsg);
  const isAutoConfirm = matchedDraft && matchedDraft.to === to && matchedDraft.subject === subject && matchedDraft.body === body;

  // Confirm-writes gate: never send unless the user has approved (model passes confirm:true)
  // OR user message indicates confirmation and matches a pending draft.
  if (ctx.confirmWrites && args?.confirm !== true && !isAutoConfirm) {
    const key = storePendingDraft(to, subject, body);
    return {
      status: 'needs_confirmation',
      proposed: { to, subject, body },
      message: 'DRAFT CREATED — NOT SENT YET. Show this draft to the user and ask for explicit confirmation. When they confirm (e.g., "yes", "send it", "confirmed"), you MUST call gmail_send AGAIN with the EXACT SAME to/subject/body PLUS confirm:true. Do NOT respond with text — call the tool immediately.',
    };
  }

  // Clear the pending draft since we're sending
  clearPendingDraft(to, subject, body);

  const auth = await loadGoogleAuth();
  if ('not_connected' in auth) return auth;
  const gmail = google.gmail({ version: 'v1', auth: auth.client });
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { sent: true, id: result.data.id, to, subject };
}

async function toolCalendarList(args: any, ctx: ToolCtx) {
  const auth = await loadGoogleAuth();
  if ('not_connected' in auth) return auth;
  const calendar = google.calendar({ version: 'v3', auth: auth.client });
  const maxResults = Math.min(Math.max(Number(args?.limit) || 20, 1), 50);
  const tz = ctx.userTimezone || args?.timezone || 'Asia/Kolkata';
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    maxResults,
    orderBy: 'startTime',
    timeMin: new Date().toISOString(),
    singleEvents: true,
    timeZone: tz,
  });
  const events = (data.items || []).map((ev: any) => {
    const startStr = ev.start?.dateTime || ev.start?.date;
    const endStr = ev.end?.dateTime || ev.end?.date;
    const startFormatted = startStr ? formatDateTime(startStr, tz).local : '';
    const endFormatted = endStr ? formatDateTime(endStr, tz).local : '';

    return {
      id: ev.id!,
      summary: ev.summary || '(busy)',
      start: startFormatted || startStr,
      end: endFormatted || endStr,
      startIso: startStr,
      endIso: endStr,
      location: ev.location || '',
      notes: ev.description || '',
    };
  });
  return { count: events.length, events, now: formatDateTime(Date.now(), tz).local, timezone: tz };
}

async function toolCalendarCreate(args: any, ctx: ToolCtx) {
  const summary = String(args?.summary || '').trim();
  const start = String(args?.start || '').trim();
  const end = String(args?.end || '').trim();
  if (!summary || !start || !end) return { error: 'summary, start, end (ISO datetimes) are required' };

  if (ctx.confirmWrites && args?.confirm !== true) {
    return {
      status: 'needs_confirmation',
      proposed: { summary, start, end, description: args?.description || '' },
      message: 'Event ready. Show it to the user and ask them to approve. Only after they say yes, call calendar_create again with the same fields plus confirm:true.',
    };
  }

  const auth = await loadGoogleAuth();
  if ('not_connected' in auth) return auth;
  const calendar = google.calendar({ version: 'v3', auth: auth.client });
  const tz = (ctx as any).userTimezone || args?.timezone || 'UTC';
  const result = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description: String(args?.description || ''),
      location: String(args?.location || ''),
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
    },
  });
  return {
    created: true,
    event: { id: result.data.id, summary: result.data.summary, start: result.data.start?.dateTime, end: result.data.end?.dateTime },
  };
}

function toolRecommendModel(args: any, _ctx: ToolCtx) {
  const useCase = String(args?.useCase || 'coding');
  const ramGb = Number(args?.ramGb) || 16;
  const catalog = getCatalog();
  const textRank = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('instruct') || n.includes('llama-3.3')) return 99;
    if (n.includes('-70b-') || n.includes('70b-instruct')) return 95;
    if (n.includes('-7b-') || n.includes('8b-instruct') || n.includes('qwen')) return 85;
    return 50;
  };
  const fits = (m: any) => (parseInt(m.parameters || '0', 10) || 0) <= ramGb * 1.1;
  const recommendations = catalog
    .filter((m: any) => ['groq', 'openrouter', 'nvidia'].includes((m.provider || '').toLowerCase()))
    .filter(fits)
    .map((m: any) => ({
      ...m,
      fitScore: textRank(m.id + ' ' + (m.name || '')) * (useCase === 'reasoning' ? 1.2 : 1),
    }))
    .sort((a: any, b: any) => b.fitScore - a.fitScore)
    .slice(0, 6)
    .map((m: any) => ({ modelId: m.id, name: m.name, provider: m.provider, notes: m.description || '' }));
  return { useCase, ramGb, recommendations };
}

async function toolCompareModels(args: any, ctx: ToolCtx) {
  const prompt = String(args?.prompt || '').trim();
  const modelA = String(args?.modelA || 'Model A');
  const modelB = String(args?.modelB || 'Model B');
  if (!prompt) return { error: 'prompt is required' };
  const keys: FeatureKeys = { groq: ctx.groq, openrouter: ctx.openrouter, nvidia: ctx.nvidia };
  const sys = 'You are one of two AI models being compared. Answer the prompt as well as you can.';
  const [a, b] = await Promise.all([
    resolveChat(keys, sys, [{ role: 'user', content: `(${modelA}) ${prompt}` }]).catch((e) => `[failed: ${e.message}]`),
    resolveChat(keys, sys, [{ role: 'user', content: `(${modelB}) ${prompt}` }]).catch((e) => `[failed: ${e.message}]`),
  ]);
  return { modelA, modelB, answerA: a, answerB: b };
}

async function toolDocumentAssist(args: any, ctx: ToolCtx) {
  const instruction = String(args?.instruction || 'rewrite');
  const content = String(args?.content || '').trim();
  if (!content) return { error: 'content is required' };
  const sysMap: Record<string, string> = {
    rewrite: 'Rewrite the following text as compelling, clear writing. Output only the rewritten text.',
    summarize: 'Summarize the following in 3 concise bullets. Output only the bullets.',
    continue: 'Continue writing in the same style. Output only the continuation.',
    proofread: 'Fix grammar and spelling. Output only the corrected text.',
  };
  const sys = sysMap[instruction] || sysMap.rewrite;
  const keys: FeatureKeys = { groq: ctx.groq, openrouter: ctx.openrouter, nvidia: ctx.nvidia };
  const text = await resolveChat(keys, sys, [{ role: 'user', content: content.slice(0, 4000) }]);
  return { instruction, result: text };
}

// ── Tool specs (OpenAI / Groq function-calling schema) ──────────────────────
export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current information, facts, news, prices, or anything the model does not know. Returns snippets with sources.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          count: { type: 'number', description: 'How many results (1-10, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Run a thorough multi-source research pass on a topic and return a synthesized evidence report. Slower than web_search — use only for genuinely research-heavy questions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The research question' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gmail_list',
      description: "List the user's recent Gmail messages (sender, subject, date, snippet, unread flag). Use a Gmail search query to filter, e.g. 'is:unread', 'from:recruiter', 'newer_than:7d'.",
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'How many messages (1-40, default 15)' },
          query: { type: 'string', description: "Optional Gmail search query, e.g. 'is:unread from:jobs'" },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gmail_send',
      description: "Send an email from the user's Gmail. WRITE ACTION: unless the user has already approved, this returns needs_confirmation with a draft — show the draft, get explicit approval, then call again with confirm:true.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Subject line' },
          body: { type: 'string', description: 'Plain-text email body' },
          confirm: { type: 'boolean', description: 'Set true ONLY after the user explicitly approved sending this exact email.' },
        },
        required: ['to', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_list',
      description: "List the user's upcoming Google Calendar events (summary, start, end). Includes the current time so you can reason about availability.",
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'How many events (1-50, default 15)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_create',
      description: 'Create a Google Calendar event. WRITE ACTION: unless the user has already approved, this returns needs_confirmation — show the proposed event, get approval, then call again with confirm:true. Times are ISO 8601 (e.g. 2026-08-10T15:00:00Z).',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start: { type: 'string', description: 'Start datetime, ISO 8601' },
          end: { type: 'string', description: 'End datetime, ISO 8601' },
          description: { type: 'string', description: 'Optional event notes' },
          confirm: { type: 'boolean', description: 'Set true ONLY after the user approved this event.' },
        },
        required: ['summary', 'start', 'end'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recommend_model',
      description: "Recommend AI models from ENZO's catalog for a use case and hardware budget.",
      parameters: {
        type: 'object',
        properties: {
          useCase: { type: 'string', description: 'e.g. coding, reasoning, chat, writing' },
          ramGb: { type: 'number', description: 'Available system RAM in GB' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_models',
      description: 'Ask two models the same prompt and return both answers for side-by-side comparison.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt to give both models' },
          modelA: { type: 'string', description: 'Label/name for model A' },
          modelB: { type: 'string', description: 'Label/name for model B' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'document_assist',
      description: 'Transform a piece of text: rewrite, summarize, continue, or proofread.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', enum: ['rewrite', 'summarize', 'continue', 'proofread'] },
          content: { type: 'string', description: 'The text to work on' },
        },
        required: ['instruction', 'content'],
      },
    },
  },
];

const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  deep_research: 'Researching in depth',
  gmail_list: 'Reading Gmail',
  gmail_send: 'Preparing email',
  calendar_list: 'Checking calendar',
  calendar_create: 'Preparing calendar event',
  recommend_model: 'Recommending models',
  compare_models: 'Comparing models',
  document_assist: 'Editing text',
};

// ── Dispatcher — never throws; a failing tool returns an { error } object ────
export async function executeTool(name: string, args: any, ctx: ToolCtx): Promise<any> {
  try {
    switch (name) {
      case 'web_search': return await toolWebSearch(args, ctx);
      case 'deep_research': return await toolDeepResearch(args, ctx);
      case 'gmail_list': return await toolGmailList(args, ctx);
      case 'gmail_send': return await toolGmailSend(args, ctx);
      case 'calendar_list': return await toolCalendarList(args, ctx);
      case 'calendar_create': return await toolCalendarCreate(args, ctx);
      case 'recommend_model': return toolRecommendModel(args, ctx);
      case 'compare_models': return await toolCompareModels(args, ctx);
      case 'document_assist': return await toolDocumentAssist(args, ctx);
      default: return { error: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: String(err?.message ?? err).slice(0, 300) };
  }
}

// ── The agent loop ───────────────────────────────────────────────────────────
const MAX_ITERS = 6;
// Prefer Groq 70b (reliable, fast, user key usually present). Falls back via caller's groqKey.
const LOOP_MODEL = 'llama-3.3-70b-versatile';

const TOOL_USE_HINT = `

You are ENZO, an agent with REAL executable tools that access LIVE data. CRITICAL RULES:
1. NEVER describe what you are about to do or pretend to call a tool — actually CALL it via the function-calling mechanism.
2. NEVER say "checking...", "retrieving...", "I will use the tool", "Please wait", or similar filler text. Just call the tool immediately.
3. NEVER ask the user "Would you like me to...?" before calling a read-only tool (gmail_list, web_search, calendar_list). Just call it.
4. If Gmail/Calendar is connected (system prompt will say so), call gmail_list / calendar_list directly — they return REAL data, never fabricate results.
5. gmail_list returns real emails from the user's inbox with real senders, subjects, dates and snippets. Report exactly what the tool returns — NEVER invent email content.
6. calendar_list returns real upcoming events. Report exactly what the tool returns — NEVER invent events.
7. WRITE TOOLS (gmail_send, calendar_create):
   - First call returns {status: "needs_confirmation", proposed: {...}} — show the draft, ask user to confirm.
   - When user confirms ("yes", "send it", "confirmed"), call the SAME tool AGAIN with IDENTICAL parameters PLUS confirm:true.
   - Do NOT respond with text — CALL THE TOOL IMMEDIATELY with confirm:true.
8. Chain tools when needed. Answer directly and concisely using ONLY real data from tool results.
9. ALWAYS report dates and times using the exact 12-hour AM/PM local date string provided in the 'date' field of gmail_list / calendar_list (e.g. 'Sat, Aug 8, 2026, 6:52:33 PM IST'). ALWAYS include AM/PM.

WRONG: "I will use the gmail_list tool to fetch your emails. The latest email is from Jane..."
RIGHT: [call gmail_list tool immediately, then report EXACTLY what the tool returned]

WRONG (after draft): "Okay, I'll send it now..." (without calling tool)
RIGHT (after user confirms): [call gmail_send again with confirm:true]`;

function safeParse(s: string): any {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

export interface ProviderConfig {
  provider: string; // 'groq' | 'openrouter' | 'nvidia' | 'hf' | 'pollinations' | 'llm7' | 'google' | 'puter'
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export async function* fetchOpenAIStream(
  providerConfig: ProviderConfig,
  opts: { model: string; messages: any[]; tools?: any[]; tool_choice?: string; temperature?: number; max_tokens?: number }
): AsyncIterable<any> {
  const { provider, apiKey, baseUrl } = providerConfig;
  let url = '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] = 'https://enzo-unified.local';
    headers['X-Title'] = 'ENZO Unified AI';
  } else if (provider === 'nvidia') {
    url = `${baseUrl || 'https://integrate.api.nvidia.com/v1'}/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'hf') {
    url = 'https://router.huggingface.co/v1/chat/completions';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'pollinations') {
    url = `${baseUrl || 'https://gen.pollinations.ai'}/v1/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'llm7') {
    url = `${baseUrl || (process.env.LLM7_API_BASE_URL || 'https://api.llm7.io/v1')}/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'google') {
    // Google Gemini — OpenAI-compatible endpoint. Keyed: no anonymous chat tier.
    url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'puter') {
    // Puter user-pays gateway — OpenAI-compatible base.
    url = `${baseUrl || 'https://api.puter.com/puterai/openai/v1'}/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'cloudflare') {
    // Cloudflare Workers AI — keyed only (no anonymous tier), account id in path.
    url = `${baseUrl || `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID || ''}/ai/v1`}/chat/completions`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    // Default: Groq
    url = 'https://api.groq.com/openai/v1/chat/completions';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const payload: any = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 1500,
  };

  if (opts.tools && opts.tools.length > 0) {
    payload.tools = opts.tools;
    payload.tool_choice = opts.tool_choice ?? 'auto';
  }

  console.log(`[agent-loop] Stream turn via provider=[${provider}] model=[${opts.model}]`);

  // Idle timeout: if the provider stops sending bytes for 45s, abort so a
  // wedged/hung connection can never leave the SSE stream stuck mid-response.
  const controller = new AbortController();
  const IDLE_TIMEOUT_MS = 45_000;
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    // If the model does not support tool calling (e.g. compound-beta-mini or legacy models),
    // retry the request without tools so the turn completes as plain text.
    if (opts.tools && opts.tools.length > 0 && (errorText.includes('tool calling') || errorText.includes('not supported') || errorText.includes('tools'))) {
      console.log(`[agent-loop] Model ${opts.model} does not support native tools. Retrying turn with tools disabled.`);
      return fetchOpenAIStream(providerConfig, { ...opts, tools: undefined, tool_choice: undefined });
    }
    throw new Error(`[${provider}/${opts.model}] API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  if (!response.body) {
    throw new Error(`[${provider}/${opts.model}] Empty response body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  resetIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const chunk = JSON.parse(jsonStr);
          yield chunk;
        } catch {
          // Skip invalid JSON lines
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

export interface AgentLoopArgs {
  providerConfig?: ProviderConfig;
  groqKey?: string;
  systemContent: string;
  userContent: string;
  history?: any[];
  ctx: ToolCtx;
  writeContent: (t: string) => void;
  writeError: (t: string) => void;
  // Optional continuation controls (coding/long-output integrity). When the
  // final-answer turn ends on a max_tokens cut or an unfinished code fence,
  // the agent loop re-invokes the turn with a [CONTINUATION] instruction
  // instead of ending the response mid-project.
  mode?: string;
  maxTokens?: number;
  maxContinuations?: number;
  // ponytail: test seam — inject a fake stream factory so the tool-call
  // accumulation loop can be exercised without a live key.
  _createStream?: (opts: any) => Promise<AsyncIterable<any>>;
}

/** True when `text` is an unfinished multi-file project: a code-fence opener
 *  (```file:…, ```html, …) has no matching bare-closer line. */
function replyLooksTruncated(text: string): boolean {
  if (!text) return false;
  const openers = (text.match(/^```[^`\s][^\n]*$/gm) || []).length;
  const closers = (text.match(/^```\s*$/gm) || []).length;
  return openers > closers;
}

/** Known tool names — used to gate XML/text tool-call parsing so arbitrary
 *  markup the model happens to emit is never executed as a tool. */
const KNOWN_TOOLS = new Set([
  'web_search', 'deep_research',
  'gmail_list', 'gmail_send',
  'calendar_list', 'calendar_create',
  'recommend_model', 'compare_models', 'document_assist',
]);

/** Extract `<key>value</key>` pairs from an XML argument block (Qwen-style
 *  text tool calling). Handles strings, numbers, and booleans. */
function parseXmlArgs(xml: string): Record<string, any> {
  const args: Record<string, any> = {};
  const tagRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(xml)) !== null) {
    const key = m[1].trim();
    if (key === 'tool' || key === 'name' || key === 'arguments' || key === 'parameters') continue;
    let val: any = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val !== '' && !isNaN(Number(val))) {
      val = Number(val);
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    }
    args[key] = val;
  }
  return args;
}

function parseTextToolCalls(content: string): any[] {
  const toolCalls: any[] = [];
  if (!content) return toolCalls;

  // 0. Match `call: tool_name(args)` format (model's native text tool calling)
  const callRegex = /`call:\s*([a-zA-Z0-9_]+)\s*\(([^)]*)\)`/gs;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(content)) !== null) {
    const name = match[1];
    const argsStr = match[2].trim();
    let argsObj: Record<string, any> = {};
    if (argsStr) {
      // Parse simple key=value pairs
      const argPairs = argsStr.split(',').map(s => s.trim());
      for (const pair of argPairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          const key = pair.slice(0, eqIdx).trim();
          const raw = pair.slice(eqIdx + 1).trim();
          // Remove surrounding quotes
          const bare =
            (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
              ? raw.slice(1, -1)
              : raw;
          // Try to parse numbers/booleans, so tool args arrive typed rather than stringly.
          // `val` is a union because that coercion is the whole point — do not narrow it
          // to string, or numeric/boolean tool arguments silently arrive as text.
          let val: string | number | boolean = bare;
          if (!isNaN(Number(bare)) && bare !== '') {
            val = Number(bare);
          } else if (bare === 'true') {
            val = true;
          } else if (bare === 'false') {
            val = false;
          }
          argsObj[key] = val;
        }
      }
    }
    toolCalls.push({
      id: `call_${crypto.randomBytes(4).toString('hex')}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(argsObj) },
    });
  }

  // 1. Match <function=tool_name>{"arg": "val"}</function>
  const funcRegex = /<function(?:=|\s+name=["'])?([a-zA-Z0-9_]+)["']?\s*>(.*?)<\/function>/gs;
  let fMatch: RegExpExecArray | null;
  while ((fMatch = funcRegex.exec(content)) !== null) {
    toolCalls.push({
      id: `call_${crypto.randomBytes(4).toString('hex')}`,
      type: 'function',
      function: { name: fMatch[1], arguments: fMatch[2].trim() },
    });
  }

  // 2. Match DSML <｜DSML｜invoke name="tool_name"> ... </｜DSML｜invoke>
  const dsmlRegex = /<｜DSML｜invoke\s+name=["']([a-zA-Z0-9_]+)["']>(.*?)<\/｜DSML｜invoke>/gs;
  let dsmlMatch: RegExpExecArray | null;
  while ((dsmlMatch = dsmlRegex.exec(content)) !== null) {
    const name = dsmlMatch[1];
    const body = dsmlMatch[2];
    const argsObj: Record<string, any> = {};
    const paramRegex = /<｜DSML｜parameter\s+name=["']([a-zA-Z0-9_]+)["'][^>]*>(.*?)<\/｜DSML｜parameter>/gs;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      argsObj[pMatch[1]] = pMatch[2].trim();
    }
    toolCalls.push({
      id: `call_${crypto.randomBytes(4).toString('hex')}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(argsObj) },
    });
  }

  // 3. Qwen-style XML tool calls: <web_search><query>...</query></web_search>,
  //    <search><query>...</query></search>, <tool><name>web_search</name>
  //    <parameters>...</parameters></tool>. Groq's Llama/Qwen models frequently
  //    emit this format instead of native JSON tool_calls — without this parse
  //    the raw XML leaks into the user-visible stream and the search never runs.
  const xmlToolRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let xMatch: RegExpExecArray | null;
  while ((xMatch = xmlToolRegex.exec(content)) !== null) {
    const outerTag = xMatch[1].trim().toLowerCase();
    const inner = xMatch[2];
    let name = outerTag;
    let argsObj: Record<string, any> = {};

    if (outerTag === 'tool' || outerTag === 'tool_call') {
      // <tool><name>web_search</name><parameters>...</parameters></tool>
      const nameMatch = inner.match(/<name\b[^>]*>([^<]+)<\/name>/i);
      if (nameMatch) name = nameMatch[1].trim().toLowerCase();
      const paramsMatch = inner.match(/<parameters\b[^>]*>([\s\S]*?)<\/parameters>/i);
      argsObj = parseXmlArgs(paramsMatch ? paramsMatch[1] : inner);
    } else {
      if (!KNOWN_TOOLS.has(outerTag)) continue; // not a tool — skip
      argsObj = parseXmlArgs(inner);
    }

    if (!KNOWN_TOOLS.has(name)) continue;

    // web_search needs a query; if the model only emitted a bare tag body, use it.
    if (name === 'web_search' && !argsObj.query) {
      const plain = inner.replace(/<[^>]+>/g, '').trim();
      if (plain) argsObj.query = plain;
    }

    toolCalls.push({
      id: `call_${crypto.randomBytes(4).toString('hex')}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(argsObj) },
    });
  }

  return toolCalls;
}

function cleanTextForUser(content: string): string {
  if (!content) return '';
  // Strip Qwen-style XML tool blocks (<web_search>...</web_search> etc.) and
  // any narration that got attached around them, so tool scaffolding never
  // reaches the user-visible stream.
  const toolBlock = /<(web_search|deep_research|gmail_list|gmail_send|calendar_list|calendar_create|recommend_model|compare_models|document_assist|tool_call|search|tool)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  let cleaned = content
    .replace(/<function(?:=|\s+name=["'])?[^>]+>.*?<\/function>/gs, '')
    .replace(/<｜DSML｜invoke[^>]*>.*?<\/｜DSML｜invoke>/gs, '')
    .replace(/<｜DSML｜tool_calls>.*?<\/｜DSML｜tool_calls>/gs, '')
    .replace(/<think>.*?<\/think>/gs, '')
    .replace(toolBlock, '')
    .replace(/<\/?(web_search|deep_research|tool_call|query|search|results)\b[^>]*>/gi, '');
  // Strip a leading research narration paragraph ("I'll research the recent
  // protests in Jharkhand... Let me gather verified information from multiple
  // sources.") that some models prefix before actually synthesizing.
  cleaned = cleaned
    .replace(/^\s*I['’]ll research[^\n]*\n+/i, '')
    .replace(/^\s*(?:Let me|I'll|I will)\s+(?:research|gather|compile|verify)[^\n]*\n+/i, '');
  return cleaned.trim();
}

/**
 * Detect if the model's text output is narrating tool usage instead of calling tools.
 * Returns true if the text looks like hallucinated tool narration.
 */
function isHallucinatedToolNarration(text: string): boolean {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();
  const HALLUCINATION_PATTERNS = [
    /i('ll| will) (use|call|check|search|fetch|retrieve|look up|access|pull up|draft|compose|prepare|write|create|send|reply|format)/i,
    /let me (search|check|look|fetch|retrieve|access|pull|use|draft|compose|prepare|write|create|format)/i,
    /please wait/i,
    /(i'?m|i am) (going to|about to) (draft|compose|prepare|write|send|check|search|create|format)/i,
    /(i'?ll|i will) (now|go ahead and) /i,
    /(here'?s|here is) (the|your) (draft|email|plan)/i,
    /(drafting|composing|preparing|writing|creating|formatting|sending)\s+(the|your|an?|it)/i,
    /show (it |you )?(to you |the draft )?for (confirmation|approval|review)/i,
    /checking\s*(your|the|gmail|inbox|calendar|email)/i,
    /searching\s*(your|the|for)/i,
    /retrieving\s*(your|the|email|mail)/i,
    /i('ll| will) need to (check|search|access|use)/i,
    /using the (gmail_list|gmail_send|calendar_list|web_search|calendar_create) tool/i,
    /i can (use|call) the (gmail|calendar|web_search)/i,
    /to find .* i (can|will|need to) (use|call|search|check)/i,
    /unfortunately,? without/i,
    /steps to find/i,
    // Research-style narration: the model announces intent instead of calling
    // the web_search / deep_research tool. e.g. "I'll research the recent
    // protests in Jharkhand..." / "Let me gather verified information from
    // multiple sources." / "I'll compile a comprehensive report for your news
    // coverage."
    /i('ll| will) research\b/i,
    /let me (research|gather|compile|verify|look into|investigate)/i,
    /gather (verified|credible|reliable|comprehensive|multiple) (information|sources|data)/i,
    /compile a (comprehensive|detailed|full|thorough) report/i,
    /for your (news|report|coverage|research)/i,
    /i('ll| will) (also|then) (research|search|gather|compile|verify)/i,
  ];
  return HALLUCINATION_PATTERNS.some(p => p.test(lower));
}

/**
 * Detect if the user message requires a tool call (email, calendar, search).
 */
function requiresToolCall(userContent: string): boolean {
  if (!userContent) return false;
  const lower = userContent.toLowerCase();
  const TOOL_INTENT_PATTERNS = [
    /\b(check|read|show|list|get|fetch|open|access|see)\b.*\b(mail|email|inbox|gmail)\b/i,
    /\b(mail|email|inbox|gmail)\b.*\b(check|read|show|list|get|fetch|open|access|see)\b/i,
    /\blatest\b.*\b(mail|email)\b/i,
    /\b(mail|email)\b.*\blatest\b/i,
    /\b(unread|new)\b.*\b(mail|email)\b/i,
    /\b(send|compose|draft|write|reply|forward)\b.*\b(mail|email)\b/i,
    /\b(email|mail|send|write|draft|compose|forward)\b.*\bto\b.*\b(boss|manager|team|recruiter|client|colleague|him|her|them|@)\b/i,
    /\b(format|turn|make|write|compose|put)\b.*\b(as|into|in (the )?form of)\b.*\b(email|mail)\b/i,
    /\b(calendar|schedule|event|meeting|appointment)\b/i,
    /\bwhat time\b.*\b(mail|email|got|received)\b/i,
    /\b(before|after|since|from)\b.*\b(mail|email)\b/i,
    /\bsearch\b.*\b(web|internet|online|google)\b/i,
    /\bwhat('s| is)\b.*\b(weather|news|price|stock|latest)\b/i,
  ];
  if (TOOL_INTENT_PATTERNS.some(p => p.test(lower))) return true;

  // Composing/sending an email: a recipient address or an explicit "subject:"
  // line together with any mail context strongly implies gmail_send.
  const hasEmailAddress = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(userContent);
  const hasSubjectLine = /\bsubject\s*[-:]/i.test(lower);
  const mailContext = /\b(mail|email|inbox|gmail|send|reply|draft|compose|boss|recruiter|forward)\b/i.test(lower);
  if ((hasEmailAddress || hasSubjectLine) && mailContext) return true;

  return false;
}

/**
 * Runs the tool-calling loop, streaming every assistant turn's text to the
 * client as it arrives (tool-call turns usually have no text). Tool steps are
 * surfaced via ctx.onStep.
 *
 * @returns true  — the loop handled the turn (answer streamed).
 *          false — the very first model call failed before any output; the
 *                  caller should fall through to its normal (non-agent) path.
 */
export async function runAgentLoop(a: AgentLoopArgs): Promise<boolean> {
  const pConfig: ProviderConfig = a.providerConfig || {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    apiKey: a.groqKey || process.env.GROQ_API_KEY || '',
  };

  const messages: any[] = [
    { role: 'system', content: a.systemContent + TOOL_USE_HINT },
    ...(Array.isArray(a.history) ? a.history : []),
    { role: 'user', content: a.userContent },
  ];

  let wroteAnything = false;
  const userNeedsTool = requiresToolCall(a.userContent);
  const turnMaxTokens = a.maxTokens ?? 1500;
  const maxContinuations = a.maxContinuations ?? 6;

  // Stream one assistant turn; accumulate text and native/text-based tool calls.
  async function streamTurn(withTools: boolean, isFinal: boolean = false, forceToolChoice: boolean = false): Promise<{ content: string; toolCalls: any[]; truncated: boolean }> {
    const availableTools = TOOL_SPECS;
    const opts = {
      model: pConfig.model,
      messages,
      ...(withTools ? {
        tools: availableTools as any,
        tool_choice: forceToolChoice ? 'required' : 'auto',
      } : {}),
      stream: true,
      temperature: 0.3,
      max_tokens: turnMaxTokens,
    };
    const stream = a._createStream
      ? await a._createStream(opts)
      : fetchOpenAIStream(pConfig, opts);

    let content = '';
    let truncated = false;
    const nativeCalls: any[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta as any;
      if (chunk.choices?.[0]?.finish_reason === 'length') truncated = true;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
      }
      if (delta.tool_calls) {
        for (const tcd of delta.tool_calls) {
          const idx = tcd.index ?? 0;
          if (!nativeCalls[idx]) nativeCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tcd.id) nativeCalls[idx].id = tcd.id;
          if (tcd.function?.name) nativeCalls[idx].function.name += tcd.function.name;
          if (tcd.function?.arguments) nativeCalls[idx].function.arguments += tcd.function.arguments;
        }
      }
    }

    const textCalls = withTools ? parseTextToolCalls(content) : [];
    const combinedToolCalls = [...nativeCalls.filter(Boolean), ...textCalls];

    // Only stream text to user if this is a final answer (no tools called and no hallucination)
    if (combinedToolCalls.length === 0 && isFinal) {
      const cleanContent = cleanTextForUser(content);
      if (cleanContent) {
        wroteAnything = true;
        a.writeContent(cleanContent);
      }
    }

    return { content, toolCalls: combinedToolCalls, truncated };
  }

  /**
   * Write the final answer, auto-continuing when the turn hit its token cap or
   * (coding mode) ended inside an open code fence — same [CONTINUATION]
   * mechanism as the streaming path, so long multi-file projects keep
   * generating instead of dying mid-fence.
   */
  async function emitFinalAnswer(turn: { content: string; toolCalls: any[]; truncated: boolean }): Promise<boolean> {
    let content = turn.content;
    let truncated = turn.truncated;
    let rounds = 0;

    // First write: the tools-enabled pass content (may be blank, or pure tool
    // narration that strips to empty). If nothing user-visible came out of it,
    // fetch one clean tools-off final turn (streamTurn writes its own text).
    if (!wroteAnything) {
      const firstClean = cleanTextForUser(content);
      if (firstClean) {
        wroteAnything = true;
        a.writeContent(firstClean);
      } else {
        try {
          const fresh = await streamTurn(false, true, false); // isFinal → writes itself when non-empty
          content += fresh.content;
          truncated = fresh.truncated;
        } catch {
          return wroteAnything;
        }
      }
    }

    // Auto-continue when the last turn hit its token cap or (coding mode) ended
    // inside an open code fence. The continuation prompt keeps the already
    // streamed text as an assistant turn, so the model continues rather than
    // restarting. streamTurn, called with isFinal, writes each step's own text.
    while ((truncated || (a.mode === 'coding' && replyLooksTruncated(content))) && rounds < maxContinuations) {
      rounds++;
      console.log(`[agent-loop] auto-continue round ${rounds} (truncated=${truncated})`);
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content:
          '[CONTINUATION] Continue the assistant response above EXACTLY from where it stopped, ' +
          'preserving the existing code fences and file structure. Do NOT repeat anything already written. ' +
          'Finish the full project, then stop.',
      });
      try {
        const next = await streamTurn(false, true, false);
        truncated = next.truncated;
        content += next.content;
      } catch {
        break;
      }
    }
    return wroteAnything;
  }

  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      // Force tool_choice:'required' on first turn if user clearly needs a tool
      const forceTools = (i === 0 && userNeedsTool);
      
      let content: string;
      let toolCalls: any[];
      let truncated = false;

      try {
        const result = await streamTurn(true, false, forceTools);
        content = result.content;
        toolCalls = result.toolCalls;
        truncated = result.truncated;
      } catch (turnErr: any) {
        const errMsg = String(turnErr?.message ?? turnErr);
        // Groq rejects tool_choice:'required' or malformed tool calls — retry with 'auto'
        if (forceTools && (errMsg.includes('failed_generation') || errMsg.includes('tool call validation') || errMsg.includes('not in request.tools'))) {
          console.log('[agent-loop] tool_choice:required failed, retrying with auto:', errMsg.slice(0, 100));
          try {
            const fallback = await streamTurn(true, false, false);
            content = fallback.content;
            toolCalls = fallback.toolCalls;
            truncated = fallback.truncated;
          } catch (retryErr: any) {
            console.error('[agent-loop] Retry also failed:', retryErr?.message);
            throw retryErr;
          }
        } else {
          throw turnErr;
        }
      }

      if (!toolCalls.length) {
        // Check for hallucinated tool narration — if detected, retry with forced tool call
        if (i === 0 && isHallucinatedToolNarration(content)) {
          console.log('[agent-loop] Hallucination detected, retrying with tool_choice:required');
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: 'You described what you would do instead of actually doing it. CALL THE TOOL NOW — do not describe, narrate, or explain. Execute the function call immediately.' });
          try {
            const retry = await streamTurn(true, false, true);
            if (retry.toolCalls.length) {
              messages.push({ role: 'assistant', content: retry.content || null, tool_calls: retry.toolCalls });
              for (const tc of retry.toolCalls) {
                const label = TOOL_LABELS[tc.function.name] || tc.function.name;
                a.ctx.onStep(`🔧 ${label}…`);
                const result = await executeTool(tc.function.name, safeParse(tc.function.arguments), a.ctx);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
              }
              continue;
            }
            content = retry.content;
            truncated = retry.truncated;
          } catch {
            // tool_choice:required failed on retry — fall through to stream text
          }
        }

        // No hallucination or retry failed — stream whatever we have as final
        // answer, auto-continuing if the turn hit its token cap or (coding
        // mode) ended inside an open code fence. If no user-visible text came
        // out at all, report failure (return false) so the caller's fallback
        // chain can try another model instead of silently ending the stream
        // with zero bytes.
        return emitFinalAnswer({ content, toolCalls: [], truncated });
      }

      // Record the assistant tool-call turn verbatim (required before tool results).
      messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

      // Execute each tool, surface a step line, append the result.
      for (const tc of toolCalls) {
        const label = TOOL_LABELS[tc.function.name] || tc.function.name;
        a.ctx.onStep(`🔧 ${label}…`);
        const result = await executeTool(tc.function.name, safeParse(tc.function.arguments), a.ctx);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
      }
    }

    // Iteration cap hit — force a final answer with tools disabled, then
    // auto-continue if it truncated mid-output/code-fence.
    a.ctx.onStep('🔧 Wrapping up…');
    return emitFinalAnswer({ content: '', toolCalls: [], truncated: false });
  } catch (err: any) {
    console.error('[agent-loop] Error:', err?.message ?? err);
    if (!wroteAnything) {
      // Instead of returning false (which triggers hallucination fallthrough),
      // try one last time with no tools as a clean text response
      try {
        await streamTurn(false, true, false);
        return wroteAnything;
      } catch {
        return false;
      }
    }
    a.writeError(String(err?.message ?? err).slice(0, 200));
    return true;
  }
}
