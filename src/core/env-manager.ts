/**
 * env-manager.ts — read and rewrite the server's own .env file.
 *
 * Owns: `VAULT_TO_ENV_MAP` / `ENV_TO_VAULT_MAP` (the vault-field ↔ env-var
 * translation), `getVaultEnvKeys`, `readEnvFile`, `saveVaultKeysToEnv`,
 * `refreshCloudflareAccessToken`.
 * Called by: index.ts (the /api/vault/keys writer), model-sync.ts (reads keys to
 * scrape provider catalogs).
 *
 * THIS IS THE SELF-HOSTED PATH ONLY. It writes to the operator's .env, so it sits
 * behind the vault master key / session token in index.ts. In hosted BYOK mode
 * there is no master key, the writer refuses, and the browser's own encrypted
 * store (synthetic-nature/src/lib/keyVault.ts) is the only place keys live —
 * which is the intended arrangement for a public deployment, not a degraded one.
 *
 * One of two modules allowed to call fs.writeFileSync (the other is model-sync);
 * CI warns if a third appears.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root, not src/core — this module lives two levels down. Resolving to
// `__dirname/.env` pointed at src/core/.env, which never existed, so the vault
// writer wrote keys to a phantom file and readEnvFile() always returned {}.
const ENV_PATH = path.resolve(__dirname, '../../.env');

// Map vault field IDs to .env variable names
export const VAULT_TO_ENV_MAP: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  groq_meme: 'GROQ_MEME_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  huggingface: 'HF_TOKEN',
  exa: 'EXA_API_KEY',
  pollinations: 'POLLINATIONS_API_KEY',
  llm7: 'LLM7_API_KEY',
  google: 'GEMINI_API_KEY',
  puter: 'PUTER_AUTH_TOKEN',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  cloudflareAccount: 'CLOUDFLARE_ACCOUNT_ID',
  cloudflareRefresh: 'CLOUDFLARE_REFRESH_TOKEN',
};

// Map .env variable names to vault field IDs
export const ENV_TO_VAULT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(VAULT_TO_ENV_MAP).map(([v, e]) => [e, v])
);

/**
 * Get all vault-related keys currently in process.env
 */
export function getVaultEnvKeys(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [vaultId, envVar] of Object.entries(VAULT_TO_ENV_MAP)) {
    result[vaultId] = process.env[envVar] || '';
  }
  return result;
}

/**
 * Read the raw .env file and parse into key-value pairs
 */
export function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result[key] = val;
      }
    }
    return result;
  } catch (err) {
    console.error('[env-manager] Error reading .env file:', err);
    return {};
  }
}

/**
 * Validate a vault entry: only known vaultIds are accepted, and values must not
 * contain newline characters (which would corrupt the .env file structure).
 * Throws on the first invalid entry.
 */
function validateVaultKey(vaultId: string, value: string): string {
  const envVar = VAULT_TO_ENV_MAP[vaultId];
  if (!envVar) {
    throw new Error(`Unknown vault key id: "${vaultId}"`);
  }
  if (/[\n\r]/.test(value || '')) {
    throw new Error(`Invalid value for "${vaultId}": must not contain newline characters`);
  }
  return envVar;
}

/**
 * Write/update vault keys in the .env file on disk and update process.env in memory
 */
export function saveVaultKeysToEnv(keys: Record<string, string>): { updated: string[]; envPath: string } {
  const updated: string[] = [];

  // 1. Update in-memory process.env
  for (const [vaultId, value] of Object.entries(keys)) {
    const envVar = validateVaultKey(vaultId, (value ?? '').trim());
    const cleanVal = (value || '').trim();
    if (cleanVal) {
      process.env[envVar] = cleanVal;
      updated.push(envVar);
    } else {
      delete process.env[envVar];
      updated.push(envVar);
    }
  }

  // 2. Read existing .env file lines or create header
  let lines: string[] = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  } else {
    lines = [
      '# ─── ENZO AI Backend — Environment Variables ──────────────────────────────────',
      '# Auto-managed via ENZO Developer Key Vault UI',
      '',
    ];
  }

  // 3. Update existing lines or append new ones
  const handledEnvVars = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const envKey = trimmed.slice(0, eqIdx).trim();
      const vaultId = ENV_TO_VAULT_MAP[envKey];
      if (vaultId !== undefined && keys[vaultId] !== undefined) {
        handledEnvVars.add(envKey);
        const val = keys[vaultId].trim();
        // disallowed ids/values throw out of the whole save (rejected before here)
        return `${envKey}=${val}`;
      }
    }
    return line;
  });

  // Append any keys that were not handled
  for (const [vaultId, value] of Object.entries(keys)) {
    const envVar = validateVaultKey(vaultId, (value ?? '').trim());
    if (!handledEnvVars.has(envVar)) {
      const val = (value || '').trim();
      if (val) newLines.push(`${envVar}=${val}`);
    }
  }

  // Write updated content to .env
  fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf-8');
  console.log(`[env-manager] Updated .env file at ${ENV_PATH} with keys: ${updated.join(', ')}`);

  return { updated, envPath: ENV_PATH };
}

// ─── Cloudflare OAuth token refresh ───────────────────────────────────────────
// A Cloudflare OAuth access token (from dash.cloudflare.com/oauth2, granted via
// the "Connect with Cloudflare" flow) is short-lived; `offline_access` grants a
// refresh token. This helper mints a fresh access token and writes it straight
// back into .env + process.env so catalog sync, health probes and chat all heal
// automatically on the next read. Returns null on any failure (caller falls
// back to the pasted-token path / surface the re-connect hint).

const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';

export async function refreshCloudflareAccessToken(): Promise<string | null> {
  const refreshToken = process.env.CLOUDFLARE_REFRESH_TOKEN || '';
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID || '';
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET || '';
  if (!refreshToken || !clientId || !clientSecret) return null;
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const res = await fetch(CLOUDFLARE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    const token = String(data?.access_token || '').trim();
    if (!token) return null;
    saveVaultKeysToEnv({ cloudflare: token });
    return token;
  } catch {
    return null;
  }
}
