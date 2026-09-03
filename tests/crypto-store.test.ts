/**
 * crypto-store.test.ts — self-check for the AES-256-GCM at-rest envelope.
 *
 * This is a security path, so it gets a runnable check: seal/open round-trips,
 * a tampered ciphertext is REJECTED rather than silently returning garbage, a
 * legacy plaintext file is readable and then upgraded in place, and a missing
 * ENZO_MASTER_KEY fails closed instead of writing plaintext.
 *
 * Run: npx tsx crypto-store.test.ts
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
// Safe as a static import: crypto-store reads ENZO_MASTER_KEY lazily inside
// masterKey(), not at module load, so setting it below still takes effect.
import { writeSecretFile, readSecretFile, deleteSecretFile } from '../src/agent/crypto-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-crypto-'));
const file = path.join(tmp, 'tokens.json');

process.env.ENZO_MASTER_KEY = 'test-master-key-for-the-self-check';

function reset() {
  deleteSecretFile(file);
}

async function main() {
  const secret = { access_token: 'ya29.a0AfB_x', refresh_token: '1//04xyz', expiry_date: 1787000000000 };

  // 1. Round-trip.
  reset();
  writeSecretFile(file, secret);
  assert.deepStrictEqual(readSecretFile(file), secret, 'sealed value must round-trip');

  // 2. Nothing recognisable is left on disk.
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('1//04xyz'), 'refresh token must not appear in the file');
  assert.ok(!onDisk.includes('access_token'), 'field names must not appear in the file');
  const envelope = JSON.parse(onDisk);
  assert.strictEqual(envelope.alg, 'aes-256-gcm');
  assert.ok(envelope.salt && envelope.iv && envelope.tag && envelope.ct, 'envelope must be complete');

  // 3. Owner-only permissions.
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'file must be mode 0600');

  // 4. Fresh salt + IV per write — same plaintext must not produce same ciphertext.
  const first = fs.readFileSync(file, 'utf8');
  writeSecretFile(file, secret);
  assert.notStrictEqual(fs.readFileSync(file, 'utf8'), first, 'each write needs a fresh salt/IV');

  // 5. Tampering is detected, not tolerated. Flip one byte of ciphertext.
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(tampered.ct, 'base64');
  ct[0] ^= 0xff;
  tampered.ct = ct.toString('base64');
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => readSecretFile(file), /authentication tag/, 'tampered ciphertext must throw');

  // 6. Wrong master key is rejected too (same auth-tag path, different cause).
  reset();
  writeSecretFile(file, secret);
  const rightKey = process.env.ENZO_MASTER_KEY;
  process.env.ENZO_MASTER_KEY = 'a-different-master-key';
  assert.throws(() => readSecretFile(file), /authentication tag/, 'wrong master key must throw');
  process.env.ENZO_MASTER_KEY = rightKey;

  // 7. Legacy plaintext file: readable, then upgraded in place.
  reset();
  fs.writeFileSync(file, JSON.stringify(secret));
  assert.deepStrictEqual(readSecretFile(file), secret, 'legacy plaintext must still be readable');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).alg, 'aes-256-gcm',
    'legacy file must be sealed on first read');
  assert.deepStrictEqual(readSecretFile(file), secret, 'and still readable after the upgrade');

  // 8. Missing file → null, not a throw (callers use this as "not connected").
  reset();
  assert.strictEqual(readSecretFile(file), null, 'missing file must read as null');

  // 9. No master key → fail closed. Never write plaintext as a fallback.
  process.env.ENZO_MASTER_KEY = '';
  assert.throws(() => writeSecretFile(file, secret), /ENZO_MASTER_KEY/, 'must refuse to write unsealed');
  assert.strictEqual(fs.existsSync(file), false, 'and must not have created the file');
  process.env.ENZO_MASTER_KEY = rightKey;

  console.log('✔ crypto-store: 9 checks passed');
}

main()
  .then(() => fs.rmSync(tmp, { recursive: true, force: true }))
  .catch((err) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error('✗ crypto-store self-check FAILED');
    console.error(err);
    process.exit(1);
  });
