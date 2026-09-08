/**
 * vault-boot.ts — let a fresh self-hosted instance be claimed from the web UI.
 *
 * Owns: `initVaultBoot` (master-key bootstrap + sealed operator-key restore),
 * `deriveVaultToken` (the vault session HMAC, both formulas), the first-key
 * claim helpers (`isSelfHostedInstance`, `serverHoldsNoProviderKeys`,
 * `persistClaimedKey`, `CLAIMABLE_PROVIDERS`).
 * Called by: index.ts (boot + the /api/vault/session mint).
 *
 * WHY THIS EXISTS. A fresh self-hosted install — `docker compose up`, open the
 * browser, paste a provider key — could never use the server-side features
 * (agents, skills, memory, the .env sync itself): every one of those routes is
 * behind verifyVaultAccess, which wants the master key (curl-only, not in the
 * UI) or a session token, and the token mint only accepted keys that ALREADY
 * matched the server's .env. With no .env seeded, no token could ever mint —
 * the web UI's "enter your keys here" promise was unactionable. The bridge:
 *
 *   1. On boot, a self-hosted instance with no ENZO_MASTER_KEY gets one
 *      generated and persisted (ENZO_DATA_DIR, mode 0o600). The key never
 *      leaves the box; it is the instance root secret, like Jenkins' or
 *      Gitea's secret file — sealing it under itself would protect nothing.
 *   2. When the server holds ZERO provider keys, the FIRST live-validated
 *      provider key offered via /api/vault/session claims the instance: it is
 *      written to .env + process.env (this runtime) and to a sealed
 *      crypto-store file (across restarts), and the token mints immediately.
 *      A keyless server has nothing to steal; the first claimant with a real
 *      working key becomes the operator. Afterwards strict-match resumes
 *      exactly as before — only a browser holding a key the server already
 *      knows can mint.
 *
 * What does NOT change: public/hosted BYOK deployments (no ENZO_MASTER_KEY,
 * no ENZO_SELF_HOSTED) never generate a master key and never accept a claim —
 * the writer keeps failing closed there, and the browser vault remains the
 * only place keys live. That mode is a design, not a degradation.
 *
 * SECURITY NOTE — the claim race: on an internet-exposed FRESH instance,
 * anyone with any real provider key can arrive first and claim it. That is
 * the standard self-hosted bootstrap trade-off (Portainer's first-admin has
 * the same property). It closes the moment the operator claims the instance
 * (do it right after boot) or pre-seeds a key via compose env — a server
 * holding even one provider key never accepts claims.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { VAULT_TO_ENV_MAP, NON_PROVIDER_ENV_VARS } from './env-manager.js';
import { writeSecretFile, readSecretFile } from '../agent/crypto-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Writable state dir. Docker mounts the persistent volume exactly here
// (ENV ENZO_DATA_DIR=/app/data in the Dockerfile); local runs default to
// <repo>/data (gitignored). Overridable so tests are hermetic.
export const VAULT_DATA_DIR = process.env.ENZO_DATA_DIR
  ? path.resolve(process.env.ENZO_DATA_DIR)
  : path.resolve(__dirname, '../../data');

const MASTER_KEY_FILE = path.join(VAULT_DATA_DIR, 'vault-boot.json');
// Operator keys claimed via the web UI. Sealed with crypto-store under the
// master key — protects the volume/backup path (the documented threat there).
const OPERATOR_KEYS_FILE = path.join(VAULT_DATA_DIR, 'vault-keys.json');

/** Providers whose keys can be validated live before claiming the instance.
 * pollinations (probe can't validate), llm7 (gateway 2xx regardless of token)
 * and the id-only fields (cloudflareAccount) are deliberately absent. */
export const CLAIMABLE_PROVIDERS = ['groq', 'openrouter', 'nvidia', 'huggingface', 'exa', 'google'] as const;

/** Self-hosted = explicit marker OR the operator already set a master key
 * (master key implies operator CLI access implies self-hosted). A hosted
 * public deployment has neither and stays BYOK-only. */
export function isSelfHostedInstance(): boolean {
  return process.env.ENZO_SELF_HOSTED === '1' || Boolean((process.env.ENZO_MASTER_KEY || '').trim());
}

/**
 * Vault session token for a window. Two formulas, deliberately distinct:
 *
 *  - groq formula (unchanged since the token's introduction): tokens are
 *    bound to the server's GROQ_API_KEY, so rotating it revokes every vault
 *    session. Backwards-compatible byte-for-byte with every token minted
 *    before this module existed.
 *  - instance formula: when the server has no Groq key (a fresh install that
 *    claimed, say, an OpenRouter key), the token binds to the instance
 *    master key alone. If a Groq key arrives later, instance tokens stop
 *    validating and browsers re-mint transparently (12–24h windows, and
 *    mintVaultToken() re-mints on demand).
 *
 * No master key → null (hosted mode never mints; the 503 is the design).
 */
export function deriveVaultToken(masterKey: string, groqKey: string, window: number): string | null {
  const mk = (masterKey || '').trim();
  if (!mk) return null;
  const gk = (groqKey || '').trim();
  const message = gk ? `enzo-vault:${gk}:${window}` : `enzo-vault:instance:${window}`;
  return crypto.createHmac('sha256', mk).update(message).digest('hex');
}

let booted = false;

/**
 * Idempotent boot step. Call once at startup, after load-env (real env >
 * .env > this module) and before anything reads ENZO_MASTER_KEY. Never
 * throws — a broken state file must not take the server down; it logs and
 * the instance stays unclaimed (claimable again, worst case).
 */
export function initVaultBoot(): void {
  if (booted) return;
  booted = true;
  try {
    // 1. Master key. Env/.env first; generate only when self-hosted.
    if (!(process.env.ENZO_MASTER_KEY || '').trim() && isSelfHostedInstance()) {
      let generated: string | null = null;
      if (fs.existsSync(MASTER_KEY_FILE)) {
        try {
          const state = JSON.parse(fs.readFileSync(MASTER_KEY_FILE, 'utf-8'));
          if (typeof state.masterKey === 'string' && state.masterKey.length >= 32) generated = state.masterKey;
        } catch { /* unreadable — regenerate below */ }
      }
      if (!generated) {
        generated = crypto.randomBytes(32).toString('hex');
        fs.mkdirSync(VAULT_DATA_DIR, { recursive: true });
        fs.writeFileSync(MASTER_KEY_FILE, JSON.stringify({ masterKey: generated }, null, 2), { mode: 0o600 });
        console.log(`[vault-boot] generated instance master key at ${MASTER_KEY_FILE} (self-hosted bootstrap)`);
      }
      process.env.ENZO_MASTER_KEY = generated;
    }

    // 2. Restore keys claimed in a previous life of this instance. Real
    //    environment wins over the sealed store — an operator who later sets
    //    a key via compose env or .env is overriding on purpose.
    if ((process.env.ENZO_MASTER_KEY || '').trim()) {
      const claimed = readSecretFile<Record<string, string>>(OPERATOR_KEYS_FILE);
      if (claimed && typeof claimed === 'object') {
        for (const [vaultId, envVar] of Object.entries(VAULT_TO_ENV_MAP)) {
          const stored = (claimed[vaultId] || '').trim();
          if (stored && !(process.env[envVar] || '').trim()) {
            process.env[envVar] = stored;
          }
        }
      }
    }
  } catch (err: any) {
    console.error('[vault-boot] init failed (instance left claimable, nothing lost):', err?.message || err);
  }
}

/** True when the server holds no provider key at all — eligible for the
 * first-key claim. Runs at request time, so boot-restored keys count.
 * NON_PROVIDER_ENV_VARS (the Gmail OAuth client pair) don't count: an
 * operator who pre-seeded only their OAuth client still gets the claim
 * window for the first real provider key. */
export function serverHoldsNoProviderKeys(): boolean {
  for (const envVar of Object.values(VAULT_TO_ENV_MAP)) {
    if (NON_PROVIDER_ENV_VARS.has(envVar)) continue;
    if ((process.env[envVar] || '').trim()) return false;
  }
  return true;
}

/** Persist a claimed operator key to the sealed store (process.env/.env are
 * handled by the caller via saveVaultKeysToEnv). Never throws — a failed
 * persist only means the key won't survive a container recreation. */
export function persistClaimedKey(vaultId: string, key: string): void {
  try {
    const current = readSecretFile<Record<string, string>>(OPERATOR_KEYS_FILE) || {};
    current[vaultId] = key;
    fs.mkdirSync(VAULT_DATA_DIR, { recursive: true });
    writeSecretFile(OPERATOR_KEYS_FILE, current);
  } catch (err: any) {
    console.error('[vault-boot] could not persist claimed key (it will not survive a restart):', err?.message || err);
  }
}
