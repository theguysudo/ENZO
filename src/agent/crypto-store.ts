/**
 * crypto-store.ts — AES-256-GCM at rest for the small JSON files this server
 * keeps on disk that contain live credentials.
 *
 * Owns: `writeSecretFile` / `readSecretFile` / `deleteSecretFile`.
 * Called by: google.ts (Gmail/Calendar refresh tokens), featureRoutes.ts (the
 * OAuth callback that first writes them), agent-tools.ts (the tool side of the
 * same file), model-sync.ts (the Cloudflare plan-tier record).
 *
 * What this defends against: someone who can read the filesystem but does not
 * have ENZO_MASTER_KEY — a stray backup, a synced folder, a mis-scoped volume
 * mount, a `tar` of the deploy directory, an operator browsing the box. A
 * refresh token is a long-lived credential; leaving it in plaintext next to the
 * source is the difference between "they saw a file" and "they have your inbox".
 *
 * What it does NOT defend against: anything running as this process. If an
 * attacker has code execution here they also have ENZO_MASTER_KEY, and the whole
 * point of the file is that this process can read it. See SECURITY.md.
 *
 * Envelope: { v, alg, salt, iv, tag, ct } — all base64 except v/alg. A fresh
 * 16-byte salt and 12-byte IV per write, so the same plaintext never produces
 * the same ciphertext and an IV is never reused under one derived key.
 *
 * Self-check: crypto-store.test.ts (round-trip, tamper detection, legacy
 * passthrough). Run `npx tsx crypto-store.test.ts`.
 */
import crypto from 'crypto';
import fs from 'fs';

const ENVELOPE_VERSION = 1;
const ALG = 'aes-256-gcm';

interface Envelope {
  v: number;
  alg: string;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function masterKey(): string {
  const key = (process.env.ENZO_MASTER_KEY || '').trim();
  if (!key) {
    // Fail closed and say exactly what to do. Writing plaintext "just this once"
    // is how a token file ends up unencrypted on a machine nobody revisits.
    throw new Error(
      'ENZO_MASTER_KEY is not set. It is required to seal credential files on disk ' +
      '(refresh tokens, plan records). Set it in .env — any long random string — ' +
      'and restart. The same value already gates the /api/vault/* endpoints.'
    );
  }
  return key;
}

/**
 * scrypt, not a bare hash: ENZO_MASTER_KEY is a human-chosen string, so the KDF
 * has to be the expensive part. Defaults are node's (N=16384, r=8, p=1) — a few
 * tens of milliseconds, which is nothing at this call volume (a handful of reads
 * per process lifetime) and a lot per guess for someone brute-forcing offline.
 */
function deriveKey(salt: Buffer): Buffer {
  return crypto.scryptSync(masterKey(), salt, 32);
}

function isEnvelope(value: unknown): value is Envelope {
  const e = value as Envelope;
  return Boolean(
    e && typeof e === 'object' &&
    e.v === ENVELOPE_VERSION && e.alg === ALG &&
    typeof e.salt === 'string' && typeof e.iv === 'string' &&
    typeof e.tag === 'string' && typeof e.ct === 'string'
  );
}

/** Seal `value` as JSON and write it to `filePath` with owner-only permissions. */
export function writeSecretFile(filePath: string, value: unknown): void {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, deriveKey(salt), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    alg: ALG,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  // 0o600 matters as much as the encryption on a shared box.
  fs.writeFileSync(filePath, JSON.stringify(envelope), { mode: 0o600 });
}

/**
 * Read and open `filePath`. Returns null when the file does not exist.
 *
 * A file written before this module existed is plaintext JSON: it is returned
 * as-is and immediately re-written sealed, so upgrading needs no reconnect and
 * no migration script. Throws on a file that IS an envelope but fails its auth
 * tag — that means the wrong ENZO_MASTER_KEY or a tampered file, and silently
 * returning null there would look identical to "not connected yet" and send the
 * user through a pointless reconnect.
 */
export function readSecretFile<T = any>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${filePath} is not valid JSON — delete it and reconnect.`);
  }

  if (!isEnvelope(parsed)) {
    // An envelope with an unknown version/alg is unreadable (not legacy), so
    // re-sealing would destroy the ciphertext — refuse those. Everything else is
    // a pre-encryption plaintext file, and those are JSON objects (token bundles,
    // plan records), so the legacy path has to accept objects, not just strings.
    if (parsed && typeof parsed === 'object' && 'ct' in parsed && 'iv' in parsed) {
      throw new Error(`${filePath} is encrypted with an unsupported format — delete and reconnect.`);
    }
    try {
      writeSecretFile(filePath, parsed);
      console.log(`[crypto-store] migrated ${filePath} to AES-256-GCM at rest`);
    } catch (err: any) {
      console.warn(`[crypto-store] could not seal ${filePath}: ${err?.message || err}`);
    }
    return parsed as T;
  }

  const decipher = crypto.createDecipheriv(
    ALG,
    deriveKey(Buffer.from(parsed.salt, 'base64')),
    Buffer.from(parsed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  let plaintext: string;
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      `${filePath} failed its authentication tag. Either ENZO_MASTER_KEY changed ` +
      `or the file was modified. Delete it and reconnect to recover.`
    );
  }
  return JSON.parse(plaintext) as T;
}

/** Remove a sealed file if it exists. Never throws. */
export function deleteSecretFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
