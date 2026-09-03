/**
 * keyVault.test.ts — self-check for the browser vault's crypto core.
 *
 * A security path, so it leaves a runnable check behind. This exercises the
 * primitives (seal / open / device key / passphrase derivation) under node's
 * WebCrypto, which is the same implementation surface the browser exposes. The
 * IndexedDB plumbing around them is not covered here — that needs a real browser
 * and is checked by hand per the plan's verification section (observe `v1.gcm.`
 * in localStorage and `extractable: false` on the stored CryptoKey).
 *
 * Run: `npm test` from the repo root, which includes this file. It lives under
 * synthetic-nature/ but runs on the backend's tsx, because keyVault.ts has no
 * imports and no `import.meta.env` — node can load it as-is, so this needs no
 * second test runner in the frontend package.
 */
import assert from 'assert';
import { seal, open, generateDeviceKey, deriveKeyFromPassphrase, passcodeError, enablePassphrase } from '../lib/keyVault.js';

async function main() {
  // Shaped like a provider key but deliberately not scanner-matching: CI greps
  // tracked files for /sk-or-v1-[a-f0-9]+/ and a realistic fixture fails it.
  const secret = 'sk-or-v1-EXAMPLE-ONLY-not-a-real-key';

  // 1. Round-trip under a device key.
  const key = await generateDeviceKey();
  const sealed = await seal(key, secret);
  assert.strictEqual(await open(key, sealed), secret, 'sealed value must round-trip');

  // 2. The stored form reveals nothing and is tagged so hydrate() can spot it.
  assert.ok(sealed.startsWith('v1.gcm.'), 'ciphertext must carry the version prefix');
  assert.ok(!sealed.includes(secret), 'plaintext must not appear in the ciphertext');

  // 3. Fresh IV per call — same key + same plaintext must not repeat.
  assert.notStrictEqual(await seal(key, secret), sealed, 'each seal needs a fresh IV');

  // 4. The device key cannot be exfiltrated by script. This is the entire
  //    rebuttal to "encrypting here would be theater".
  assert.strictEqual(key.extractable, false, 'device key must be non-extractable');
  await assert.rejects(() => crypto.subtle.exportKey('raw', key), 'exportKey must reject');

  // 5. A different key does not open it, and returns null rather than throwing
  //    (hydrate() relies on null to mean "drop this entry").
  const other = await generateDeviceKey();
  assert.strictEqual(await open(other, sealed), null, 'wrong key must not decrypt');

  // 6. A tampered ciphertext fails its auth tag.
  const [, ivB64, ctB64] = [sealed.slice(0, 7), ...sealed.slice(7).split('.')];
  const ct = Buffer.from(ctB64, 'base64');
  ct[0] ^= 0xff;
  assert.strictEqual(
    await open(key, `v1.gcm.${ivB64}.${ct.toString('base64')}`),
    null,
    'tampered ciphertext must not decrypt',
  );

  // 7. Anything without the prefix is treated as legacy plaintext, not decrypted.
  assert.strictEqual(await open(key, secret), null, 'unprefixed input must be rejected');

  // 8. Passphrase mode: same passphrase + salt derives an equivalent key.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const fromPass = await deriveKeyFromPassphrase('correct horse battery staple', salt);
  const passSealed = await seal(fromPass, secret);
  const again = await deriveKeyFromPassphrase('correct horse battery staple', salt);
  assert.strictEqual(await open(again, passSealed), secret, 'passphrase must re-derive the same key');
  assert.strictEqual(fromPass.extractable, false, 'derived key must be non-extractable too');

  // 9. Wrong passphrase, and right passphrase with a different salt, both fail —
  //    the salt is what stops one precomputation from covering every install.
  const wrong = await deriveKeyFromPassphrase('correct horse battery stapler', salt);
  assert.strictEqual(await open(wrong, passSealed), null, 'wrong passphrase must not decrypt');
  const otherSalt = await deriveKeyFromPassphrase(
    'correct horse battery staple',
    crypto.getRandomValues(new Uint8Array(16)),
  );
  assert.strictEqual(await open(otherSalt, passSealed), null, 'salt must change the derived key');

  // 10. The passcode rule. Exactly 8 digits, or a real passphrase — the check it
  //     replaced was `length < 8`, which accepted "password".
  assert.strictEqual(passcodeError('12345678'), null, '8 digits must be accepted');
  assert.ok(passcodeError('1234567'), '7 digits must be rejected');
  assert.ok(passcodeError('123456789'), '9 digits must be rejected');
  assert.ok(passcodeError('password'), 'the old 8-char loophole must be closed');
  assert.ok(passcodeError(''), 'empty must be rejected');
  assert.ok(passcodeError('       '), 'whitespace must be rejected');
  assert.strictEqual(passcodeError('correct horse battery staple'), null, '12+ chars must be accepted');

  // 11. And it is wired into the setter, not just exported for the UI to forget.
  await assert.rejects(
    () => enablePassphrase('1234'),
    /exactly 8 digits/,
    'enablePassphrase must enforce the rule itself',
  );

  console.log('✔ keyVault: 21 checks passed');
}

main().catch((err) => {
  console.error('✗ keyVault self-check FAILED');
  console.error(err);
  process.exit(1);
});
