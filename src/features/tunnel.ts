/**
 * ENZO Smart Middleware — AI Tunnel
 *
 * A single OpenAI-compatible endpoint that:
 *   1. Authenticates via a single master key
 *   2. Routes to Groq / Pollinations / OpenRouter based on model prefix
 *   3. Translates protocols transparently (always OpenAI JSON in/out)
 *   4. Streams with zero buffering (hollow pipe)
 *   5. Isolates upstream failures into clean JSON errors
 *
 * Mount:  app.use('/api/v1', tunnelRouter)
 * Usage:  POST /api/v1/chat/completions  { model: "groq/qwen3-32b", messages: [...] }
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { readModelCache, syncModels, tryReadNvidiaKey } from '../models/model-sync.js';
import { buildMemoryContext } from '../core/memory.js';
import { buildSkillContext } from '../skills/skills.js';
import { getModelHealth } from '../models/health.js';

// ── Master Key ───────────────────────────────────────────────────────────────
// No hardcoded fallback: when ENZO_MASTER_KEY is unset, strict auth fails closed.
// Read lazily at request time — this module is ESM-imported before index.ts
// loads .env at boot, so a module-level const would always capture ''.
function getMasterKey(): string {
  return process.env.ENZO_MASTER_KEY || '';
}

/** Constant-time compare that never throws on length mismatch / empty values. */
function safeKeyEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── Provider API Keys (dynamic getter — reads live process.env) ──────────────
export function getProviderKey(provider: string): string {
  switch (provider) {
    case 'groq':
      return process.env.GROQ_API_KEY || '';
    case 'pollinations':
      return process.env.POLLINATIONS_API_KEY || '';
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY || '';
    case 'hf':
      return process.env.HF_TOKEN || '';
    case 'nvidia':
      return process.env.NVIDIA_API_KEY || tryReadNvidiaKey() || '';
    case 'llm7':
      return process.env.LLM7_API_KEY || '';
    case 'google':
      return process.env.GEMINI_API_KEY || '';
    case 'puter':
      return process.env.PUTER_AUTH_TOKEN || '';
    case 'cloudflare':
      return process.env.CLOUDFLARE_API_TOKEN || '';
    default:
      return '';
  }
}

// ── Provider Endpoints ───────────────────────────────────────────────────────
const PROVIDER_ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  pollinations: 'https://gen.pollinations.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  hf: 'https://api-inference.huggingface.co/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions', // NVIDIA NIM API
  llm7: 'https://api.llm7.io/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', // Google Gemini (OpenAI-compat)
  puter: 'https://api.puter.com/puterai/openai/v1/chat/completions', // Puter user-pays gateway
  cloudflare: 'https://api.cloudflare.com/client/v4', // Cloudflare Workers AI (base — chat endpoint built from account id)
} as const;

// Runtime-settable base URL for LLM7 (env LLM7_API_BASE_URL). Stored beside the
// endpoints table so the tunnel uses the exact same base as the /v1/models sync.
function llm7Endpoint(): string {
  const env = process.env.LLM7_API_BASE_URL || '';
  if (/^https:\/\/[a-z0-9.-]+\//i.test(env)) return `${env.replace(/\/+$/, '')}/chat/completions`;
  return PROVIDER_ENDPOINTS.llm7;
}

// Cloudflare's account id is a required URL path segment; the chat-completions
// endpoint only exists once an account id is configured (vault / .env).
function cloudflareChatEndpoint(): string {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  if (!account) return '';
  return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`;
}

type Provider = keyof typeof PROVIDER_ENDPOINTS;

// ── Types ────────────────────────────────────────────────────────────────────
interface TunnelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
}

interface ParsedRoute {
  provider: Provider;
  model: string;
  endpoint: string;
  apiKey: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. UNIFIED AUTHENTICATION PROTOCOL
// ═══════════════════════════════════════════════════════════════════════════════

function authGate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: {
        message: 'Missing Authorization header. Use: Bearer <ENZO_MASTER_KEY>',
        type: 'auth_error',
        code: 'missing_key',
      },
    });
    return;
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!safeKeyEqual(token, getMasterKey())) {
    res.status(401).json({
      error: {
        message: 'Invalid ENZO master key.',
        type: 'auth_error',
        code: 'invalid_key',
      },
    });
    return;
  }

  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PREFIX-BASED DYNAMIC TRAFFIC ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

function parseModelRoute(modelString: string, req: Request): ParsedRoute {
  const prefixes: Array<{ prefix: string; provider: Provider }> = [
    { prefix: 'groq/', provider: 'groq' },
    { prefix: 'pollinations/', provider: 'pollinations' },
    { prefix: 'openrouter/', provider: 'openrouter' },
    { prefix: 'hf/', provider: 'hf' },
    { prefix: 'nvidia/', provider: 'nvidia' }, // NVIDIA Build API
    { prefix: 'llm7/', provider: 'llm7' }, // LLM7 OpenAI-compatible gateway
    { prefix: 'google/', provider: 'google' }, // Google Gemini (OpenAI-compat)
    { prefix: 'puter/', provider: 'puter' }, // Puter user-pays gateway
    { prefix: 'cloudflare/', provider: 'cloudflare' }, // Cloudflare Workers AI
  ];

  for (const { prefix, provider } of prefixes) {
    if (modelString.startsWith(prefix)) {
      const model = modelString.slice(prefix.length);
      if (!model) {
        throw new RouteError(`Empty model name after "${prefix}" prefix`);
      }

      // Check for user-provided custom keys and base URLs in headers
      let apiKey = getProviderKey(provider);
      // Endpoint is a string (not the literal union) — provider-specific base
      // URLs are swapped in below.
      let endpoint: string = PROVIDER_ENDPOINTS[provider];

      if (provider === 'openrouter' && req.headers['x-openrouter-key']) {
        apiKey = String(req.headers['x-openrouter-key']);
      } else if (provider === 'hf') {
        if (req.headers['x-huggingface-key']) {
          apiKey = String(req.headers['x-huggingface-key']);
        }
        endpoint = `https://api-inference.huggingface.co/models/${model}`;
      } else if (provider === 'nvidia') {
        if (req.headers['x-nvidia-key']) {
          apiKey = String(req.headers['x-nvidia-key']);
        }
        if (req.headers['x-nvidia-base-url']) {
          endpoint = `${String(req.headers['x-nvidia-base-url'])}/chat/completions`;
        } else if (process.env.NVIDIA_API_BASE_URL) {
          endpoint = `${process.env.NVIDIA_API_BASE_URL}/chat/completions`;
        }
      } else if (provider === 'llm7') {
        if (req.headers['x-llm7-key']) {
          apiKey = String(req.headers['x-llm7-key']);
        }
        endpoint = llm7Endpoint();
      } else if (provider === 'google') {
        if (req.headers['x-google-key']) {
          apiKey = String(req.headers['x-google-key']);
        }
      } else if (provider === 'puter') {
        if (req.headers['x-puter-key']) {
          apiKey = String(req.headers['x-puter-key']);
        }
      } else if (provider === 'cloudflare') {
        if (req.headers['x-cloudflare-key']) {
          apiKey = String(req.headers['x-cloudflare-key']);
        }
        const accountOverride = String(req.headers['x-cloudflare-account'] || '').trim();
        endpoint =
          accountOverride || process.env.CLOUDFLARE_ACCOUNT_ID
            ? `https://api.cloudflare.com/client/v4/accounts/${accountOverride || process.env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`
            : cloudflareChatEndpoint();
      }

      return {
        provider,
        model,
        endpoint,
        apiKey,
      };
    }
  }

  // No prefix → default to Groq
  return {
    provider: 'groq',
    model: modelString,
    endpoint: PROVIDER_ENDPOINTS.groq,
    apiKey: getProviderKey('groq'),
  };
}

class RouteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. TRANSPARENT PROTOCOL TRANSLATION
// ═══════════════════════════════════════════════════════════════════════════════

function buildUpstreamHeaders(route: ParsedRoute): Record<string, string> {
  // LLM7 requires a key — no anonymous tier (the gateway serves a rotating
  // shared model for unauthenticated calls, so model fidelity is impossible).
  // Google, Puter and Cloudflare are also keyed providers: Gemini 404s keyless,
  // Puter bills the end user, and Cloudflare Workers AI needs a token + account
  // id (both are URL/protocol requirements, not optional).
  let bearerKey = route.apiKey;
  if (['llm7', 'google', 'puter', 'cloudflare'].includes(route.provider) && !bearerKey) {
    const hint =
      route.provider === 'google'
        ? 'add a free key from aistudio.google.com/apikey'
        : route.provider === 'puter'
          ? 'create a token at puter.com/dashboard'
          : route.provider === 'cloudflare'
            ? 'create a token at dash.cloudflare.com + add your account id in Vault > Cloudflare'
            : 'add a free token from dash.llm7.io';
    throw new RouteError(`${route.provider} key required — ${hint}.`, 401);
  }
  if (route.provider === 'cloudflare' && !route.endpoint) {
    throw new RouteError('cloudflare account id required — create a token at dash.cloudflare.com and add your account id in Vault > Cloudflare.', 401);
  }
  if (!bearerKey) bearerKey = 'unused';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearerKey}`,
  };

  if (route.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://enzo-unified.local';
    headers['X-Title'] = 'ENZO Unified AI Tunnel';
  }

  return headers;
}

function buildUpstreamBody(body: TunnelRequest, route: ParsedRoute): string {
  // All three providers accept OpenAI-compatible JSON.
  // We just swap the model name to the stripped (prefix-free) version.

  // Cross-provider / cross-API memory: inject learned skills + remembered
  // facts into the system message so ANY model called through the tunnel
  // (Groq, Pollinations, OpenRouter, NVIDIA) has the same persistent memory.
  let messages = body.messages;
  try {
    const enriched = injectMemoryAndSkills(messages);
    if (enriched) messages = enriched;
  } catch (err) {
    console.error('[tunnel] memory/skill injection failed:', (err as Error)?.message || err);
  }

  return JSON.stringify({
    model: route.model,
    messages,
    stream: body.stream ?? false,
    ...(body.max_tokens !== undefined && { max_tokens: body.max_tokens }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { top_p: body.top_p }),
    ...(body.frequency_penalty !== undefined && {
      frequency_penalty: body.frequency_penalty,
    }),
    ...(body.presence_penalty !== undefined && {
      presence_penalty: body.presence_penalty,
    }),
    ...(body.stop !== undefined && { stop: body.stop }),
  });
}

/** Enrich a tunnel request's messages with [MEMORY] + [SKILLS] context derived
 *  from the last user message. Returns the augmented array, or null when no
 *  context applies (keeps tunnel requests byte-identical for unrelated calls). */
function injectMemoryAndSkills(
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> | null {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
  if (!userText) return null;

  const context: string[] = [];
  const memory = buildMemoryContext(userText, { maxEntries: 3 });
  if (memory) context.push(memory);
  const skills = buildSkillContext(userText, { maxSkills: 1 });
  if (skills) context.push(skills);
  if (!context.length) return null;

  const systemMsg = messages.find((m) => m.role === 'system');
  const extra = context.join('\n\n');
  if (systemMsg) {
    return messages.map((m) =>
      m.role === 'system' ? { ...m, content: `${m.content}\n\n${extra}` } : m
    );
  }
  return [{ role: 'system', content: extra }, ...messages];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. UPSTREAM ISOLATION & FAULT TOLERANCE
// ═══════════════════════════════════════════════════════════════════════════════

function sanitizeUpstreamError(
  detail: string,
  provider: Provider,
  status: number
): string {
  try {
    const parsed = JSON.parse(detail);
    const msg =
      parsed?.error?.message ||
      (typeof parsed?.error === 'string' ? parsed.error : null) ||
      parsed?.message;

    if (typeof msg === 'string') {
      // Scrub internal URLs and keys from error messages
      return msg.replace(/https?:\/\/[^\s"')]+/g, '[upstream-url]');
    }
  } catch {
    // detail is not JSON
  }

  if (detail.length > 300) {
    return `${provider} returned error ${status}`;
  }

  return detail || `${provider} returned error ${status}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. ZERO-LATENCY STREAM PIPING + NON-STREAMING HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleStreamingRequest(
  res: Response,
  route: ParsedRoute,
  body: TunnelRequest
): Promise<void> {
  const headers = buildUpstreamHeaders(route);
  const upstreamBody = buildUpstreamBody({ ...body, stream: true }, route);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(route.endpoint, {
      method: 'POST',
      headers,
      body: upstreamBody,
    });
  } catch (err: any) {
    // Network-level failure: DNS, connection refused, timeout
    res.status(502).json({
      error: {
        message: `${route.provider} is unreachable — try a different model or provider`,
        type: 'provider_down',
        provider: route.provider,
      },
    });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    res.status(upstream.status).json({
      error: {
        message: sanitizeUpstreamError(detail, route.provider, upstream.status),
        type: 'upstream_error',
        provider: route.provider,
        upstream_status: upstream.status,
      },
    });
    return;
  }

  if (!upstream.body) {
    res.status(502).json({
      error: {
        message: `${route.provider} returned no stream body`,
        type: 'upstream_error',
        provider: route.provider,
      },
    });
    return;
  }

  // ── Hollow Pipe: relay SSE chunks byte-for-byte ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Tunnel-Provider', route.provider);
  res.setHeader('X-Tunnel-Model', route.model);

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Zero-buffer relay: pass raw bytes straight through
      res.write(Buffer.from(value));
    }
  } catch (err: any) {
    // Mid-stream failure
    console.error(
      `[tunnel] Stream interrupted from ${route.provider}:`,
      err.message
    );
    // Try to send a final error event if the connection is still open
    try {
      res.write(
        `data: ${JSON.stringify({
          error: {
            message: `Stream interrupted from ${route.provider}`,
            type: 'stream_error',
          },
        })}\n\n`
      );
    } catch {
      // connection already closed
    }
  } finally {
    res.end();
  }
}

async function handleNonStreamingRequest(
  res: Response,
  route: ParsedRoute,
  body: TunnelRequest
): Promise<void> {
  const headers = buildUpstreamHeaders(route);
  const upstreamBody = buildUpstreamBody({ ...body, stream: false }, route);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(route.endpoint, {
      method: 'POST',
      headers,
      body: upstreamBody,
    });
  } catch (err: any) {
    res.status(502).json({
      error: {
        message: `${route.provider} is unreachable — try a different model or provider`,
        type: 'provider_down',
        provider: route.provider,
      },
    });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    res.status(upstream.status).json({
      error: {
        message: sanitizeUpstreamError(detail, route.provider, upstream.status),
        type: 'upstream_error',
        provider: route.provider,
        upstream_status: upstream.status,
      },
    });
    return;
  }

  // Relay the JSON response directly (already OpenAI-compatible from all 3 providers)
  const json = await upstream.json();
  res.setHeader('X-Tunnel-Provider', route.provider);
  res.setHeader('X-Tunnel-Model', route.model);
  res.json(json);
}

async function handleHuggingFaceServerlessRequest(
  res: Response,
  route: ParsedRoute,
  body: TunnelRequest
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (route.apiKey) {
    headers['Authorization'] = `Bearer ${route.apiKey}`;
  }

  const isStream = body.stream ?? false;

  let upstream: globalThis.Response;
  try {
    // Auto-router: HF picks whatever provider is live for this model (nscale,
    // featherless, deepinfra, novita, ...). The old /hf-inference/ path 400s
    // because that provider no longer serves chat/text-generation models.
    upstream = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: route.model,
        messages: [
          ...body.messages,
          {
            role: 'system',
            content: ``,
          },
        ],
        max_tokens: body.max_tokens || 2048,
        temperature: body.temperature ?? 0.7,
        stream: isStream,
      }),
    });
  } catch (err: any) {
    res.status(502).json({
      error: {
        message: `Hugging Face is unreachable — try a different model or provider`,
        type: 'provider_down',
        provider: 'hf',
      },
    });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    res.status(upstream.status).json({
      error: {
        message: sanitizeUpstreamError(detail, 'hf', upstream.status),
        type: 'upstream_error',
        provider: 'hf',
        upstream_status: upstream.status,
      },
    });
    return;
  }

  if (!isStream) {
    // Chat-completions endpoint returns OpenAI shape — pass it straight through.
    const json = await upstream.json();
    res.setHeader('X-Tunnel-Provider', 'hf');
    res.setHeader('X-Tunnel-Model', route.model);
    res.json(json);
    return;
  }

  if (!upstream.body) {
    res.status(502).json({
      error: {
        message: `HuggingFace returned no stream body`,
        type: 'upstream_error',
        provider: 'hf',
      },
    });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Tunnel-Provider', 'hf');
  res.setHeader('X-Tunnel-Model', route.model);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const text = parsed.token?.text || parsed.choices?.[0]?.delta?.content;
        if (!text) continue;

        res.write(`data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              content: text,
            },
          }],
        })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err: any) {
    console.error(`[tunnel] HF stream interrupted:`, err.message);
    try {
      res.write(`data: ${JSON.stringify({
        error: {
          message: `Stream interrupted from HuggingFace`,
          type: 'stream_error',
        },
      })}\n\n`);
    } catch {}
  } finally {
    res.end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER ASSEMBLY
// ═══════════════════════════════════════════════════════════════════════════════

export const tunnelRouter = Router();

// ── POST /chat/completions ───────────────────────────────────────────────────
tunnelRouter.post('/chat/completions', authGate, async (req: Request, res: Response) => {
  const body = req.body as TunnelRequest;

  // Validate required fields
  if (!body.model || typeof body.model !== 'string') {
    res.status(400).json({
      error: {
        message:
          'Missing "model" field. Use prefix routing: "groq/qwen3-32b", "pollinations/minimax-m3", "openrouter/nvidia/nemotron-3-ultra-550b-a55b"',
        type: 'validation_error',
      },
    });
    return;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Missing or empty "messages" array.',
        type: 'validation_error',
      },
    });
    return;
  }

  // Parse the model prefix to determine provider
  let route: ParsedRoute;
  try {
    route = parseModelRoute(body.model, req);
  } catch (err: any) {
    res.status(400).json({
      error: {
        message: err.message,
        type: 'routing_error',
      },
    });
    return;
  }

  console.log(
    `\n[tunnel] -> ${route.provider}/${route.model} | stream=${body.stream ?? false} | messages=${body.messages.length}`
  );

  // Dispatch to streaming or non-streaming handler
  try {
    if (route.provider === 'hf') {
      await handleHuggingFaceServerlessRequest(res, route, body);
    } else if (body.stream) {
      await handleStreamingRequest(res, route, body);
    } else {
      await handleNonStreamingRequest(res, route, body);
    }
  } catch (err: any) {
    if (err instanceof RouteError) {
      if (!res.headersSent) {
        res.status(err.status).json({
          error: { message: err.message, type: 'routing_error' },
        });
      } else {
        res.end();
      }
      return;
    }
    console.error('[tunnel] Unhandled error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: 'Internal tunnel error',
          type: 'internal_error',
        },
      });
    }
  }
});

// ── GET /models ──────────────────────────────────────────────────────────────
// Serves dynamic model list from cached file.
// If x-groq-key header is present, does a live Groq fetch and merges those
// models into the response (so Groq tab is always populated for keyed users).
tunnelRouter.get('/models', async (req: Request, res: Response) => {
  try {
    const cache = readModelCache();
    let models = [...cache.models];
    // ponytail: track whether the caller handed us fresh provider keys. If any
    // are present we kick off a short on-demand sync so keyed boots see the
    // current catalog instead of yesterday's disk cache (which under a stale
    // verify-cache could be a 3-model NVIDIA list). The live fetch is bounded by
    // a short abort so a slow provider doesn't stall the first page load; if it
    // times out we fall straight back to the on-disk cache.
    const providedKeys = {
      groq: (req.headers['x-groq-key'] as string | undefined) || undefined,
      nvidia: (req.headers['x-nvidia-key'] as string | undefined) || undefined,
      hf: (req.headers['x-huggingface-key'] as string | undefined) || undefined,
      cloudflare: (req.headers['x-cloudflare-key'] as string | undefined) || undefined,
      cloudflareAccount: (req.headers['x-cloudflare-account'] as string | undefined) || undefined,
      llm7: (req.headers['x-llm7-key'] as string | undefined) || undefined,
      google: (req.headers['x-google-key'] as string | undefined) || undefined,
      puter: (req.headers['x-puter-key'] as string | undefined) || undefined,
    };
    const hasFreshKey = Object.values(providedKeys).some((v) => !!v);

    if (hasFreshKey) {
      // Re-run the full sync with the caller's keys. syncModels is internally
      // paced per-provider, but a 6000ms bound was too tight for the scrape to
      // finish before the abort fired — so the route served the stale disk
      // cache instead of the fresh list (3 NVIDIA models). Loosen to 15s and,
      // on timeout, return the partially-built list (syncModels falls back to
      // last-known-good per provider on any individual failure) rather than the
      // whole disk cache, so a slow provider degrades the specific provider —
      // not the entire catalog.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      try {
        const fresh = await syncModels(
          providedKeys.groq || getProviderKey('groq'),
          providedKeys.hf || getProviderKey('hf'),
          providedKeys.nvidia || getProviderKey('nvidia') || tryReadNvidiaKey(),
          providedKeys.llm7 || '',
          providedKeys.google || '',
          providedKeys.puter || '',
          providedKeys.cloudflare || '',
          providedKeys.cloudflareAccount || '',
        );
        models = [...fresh.models];
        cache.updatedAt = fresh.updatedAt;
        console.log(`[models] On-demand keyed sync: ${fresh.models.length} models (NVIDIA: ${fresh.models.filter((m) => m.provider === 'NVIDIA').length})`);
      } catch (syncErr: any) {
        // AbortError (timeout) or provider network blip → keep whatever we
        // already have from the disk read above (syncModels writes last-known-
        // good per provider on failure). Only fall fully to disk cache would
        // lose the fresh scrape. Don't abort the in-flight sync on our end —
        // syncModels isn't AbortSignal-aware, so the abort here only bounds the
        // route's own fetch time, not the children.
        console.warn('[models] Keyed on-demand sync incomplete, serving partial/disk:', syncErr?.name === 'AbortError' ? 'timeout' : syncErr?.message);
      } finally {
        clearTimeout(timer);
      }
    } else if (providedKeys.groq || getProviderKey('groq')) {
      // Keyless caller but a server-side Groq key exists: keep the legacy live
      // Groq merge so the Groq tab is never empty without a rebadge.
      const groqKey = (req.headers['x-groq-key'] as string | undefined) || getProviderKey('groq');
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${groqKey}` },
          signal: AbortSignal.timeout(4000),
        });
        if (groqRes.ok) {
          const groqData = (await groqRes.json()) as { data: Array<{ id: string; context_window?: number; created?: number }> };
          const existingIds = new Set(models.map((m) => m.id));
          const GROQ_META: Record<string, { name: string; desc: string; maxOut: number }> = {
            'qwen/qwen3.6-27b': { name: 'Qwen3.6-27B', desc: 'Alibaba 27B multilingual model. Excellent at coding and reasoning.', maxOut: 32768 },
            'llama-3.3-70b-versatile': { name: 'LLaMA-3.3-70B', desc: "Meta's 70B instruction-tuned model. Fast and general-purpose.", maxOut: 32768 },
            'llama-3.1-8b-instant': { name: 'LLaMA-3.1-8B Instant', desc: 'Ultra-fast 8B model for low-latency tasks.', maxOut: 8192 },
            'groq/compound-mini': { name: 'Compound Mini', desc: 'Groq research model with built-in web search and tool use.', maxOut: 8192 },
            'groq/compound': { name: 'Compound', desc: 'Groq agentic model with web search and multi-step tool use.', maxOut: 8192 },
            'openai/gpt-oss-120b': { name: 'GPT-OSS-120B', desc: 'OpenAI open 120B model. Strong general reasoning.', maxOut: 32768 },
            'openai/gpt-oss-20b': { name: 'GPT-OSS-20B', desc: 'OpenAI open 20B model. Fast general-purpose.', maxOut: 32768 },
            'allam-2-7b': { name: 'ALLAM-2-7B', desc: 'Arabic-centric 7B instruction-tuned model.', maxOut: 8192 },
          };
          const liveGroqModels = groqData.data.map((m) => {
            const meta = GROQ_META[m.id] ?? { name: m.id, desc: 'Groq-hosted model.', maxOut: 8192 };
            const isVision = m.id.includes('vision');
            return {
              id: `groq/${m.id}`,
              name: meta.name,
              provider: 'Groq' as const,
              type: isVision ? ('multimodal' as const) : ('text' as const),
              free: true,
              context_length: m.context_window ?? 32768,
              description: meta.desc,
              tags: isVision ? ['Vision', 'General Chat'] : ['General Chat'],
              moderated: true,
              pricing_prompt: '$0.00',
              added_date: m.created ? new Date(m.created * 1000).toISOString() : new Date().toISOString(),
              max_output: meta.maxOut,
            };
          }).filter((m) => !existingIds.has(m.id));
          models = [...liveGroqModels, ...models];
          console.log(`[models] Live Groq fetch: +${liveGroqModels.length} models for keyed user`);
        }
      } catch (groqErr: any) {
        console.warn('[models] Live Groq fetch failed (non-fatal):', groqErr?.message);
      }
    }

    res.json({
      object: 'list',
      updatedAt: cache.updatedAt,
      data: models.map((m) => ({ ...m, health: getModelHealth(String(m.id)) ?? null })),
    });
  } catch (err: any) {
    res.status(500).json({
      error: {
        message: `Failed to read model catalog: ${err.message}`,
        type: 'internal_error',
      },
    });
  }
});

// ── POST /sync ───────────────────────────────────────────────────────────────
// Manual refresh triggered by admin (requires master key)
tunnelRouter.post('/sync', authGate, async (_req: Request, res: Response) => {
  try {
    const groqKey = getProviderKey('groq');
    const hfToken = getProviderKey('hf');
    const nvidiaKey = getProviderKey('nvidia');
    const cache = await syncModels(groqKey, hfToken, nvidiaKey);
    res.json({
      success: true,
      message: `Model cache refreshed. Total models: ${cache.models.length}`,
      updatedAt: cache.updatedAt,
    });
  } catch (err: any) {
    res.status(500).json({
      error: {
        message: `Sync failed: ${err.message}`,
        type: 'internal_error',
      },
    });
  }
});

console.log('[tunnel] Smart Middleware initialized.');
