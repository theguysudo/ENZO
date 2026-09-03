/**
 * vaultRecovery.test.ts — self-check for the .enzokey recovery file.
 *
 * The file is a credential and it is parsed from user-supplied bytes, so both
 * halves need a check: the round-trip must work, and every way a wrong or edited
 * file can arrive must be rejected with a message rather than accepted or
 * crashing. downloadRecovery() is not covered — it is DOM-only plumbing.
 *
 * Run: `npm test` from the repo root, which includes this file.
 */
import assert from 'assert';
import { sealRecovery, openRecovery, RECOVERY_EXT } from '../lib/vaultRecovery.js';

const MAGIC = 'ENZO-VAULT-RECOVERY-v1';

/** The base64 payload line of a file, as a mutable envelope object. */
function envelopeOf(file: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(file.trim().split('\n')[1], 'base64').toString());
}

/** Rebuild a file around a modified envelope. */
function fileOf(envelope: unknown): string {
  return `${MAGIC}\n${Buffer.from(JSON.stringify(envelope)).toString('base64')}\n`;
}

async function main() {
  const passcode = '48210673';

  // 1. Round-trip: the whole point.
  const file = await sealRecovery(passcode);
  assert.strictEqual(await openRecovery(file), passcode, 'recovery file must round-trip');

  // 2. Identifiable by header, unreadable by eye. The passcode must not appear in
  //    the file in any encoding a grep of a backup would catch.
  assert.ok(file.startsWith(`${MAGIC}\n`), 'file must start with the magic header');
  assert.ok(!file.includes(passcode), 'the passcode must not appear in the file text');
  assert.ok(
    !Buffer.from(file.trim().split('\n')[1], 'base64').toString().includes(passcode),
    'the passcode must not appear in the decoded envelope either',
  );

  // 3. Fresh key and IV per call, so two files for one passcode never match —
  //    otherwise an identical file would confirm someone reused a passcode.
  assert.notStrictEqual(await sealRecovery(passcode), file, 'each file needs fresh key + IV');

  // 4. Whitespace and CRLF survive a round trip through an editor or email.
  assert.strictEqual(
    await openRecovery(`  ${file.trim().replace('\n', '\r\n')}  \n`),
    passcode,
    'CRLF and surrounding whitespace must be tolerated',
  );

  // ── Rejections. Each must throw, not return a wrong passcode and not crash. ──

  // 5. Not our file at all.
  await assert.rejects(() => openRecovery('hello world'), new RegExp(RECOVERY_EXT), 'a foreign file must be named');
  await assert.rejects(() => openRecovery(''), /not an ENZO recovery file/, 'empty input must be rejected');
  await assert.rejects(() => openRecovery(`${MAGIC}\n`), /no contents/, 'header alone must be rejected');

  // 6. Header right, payload garbage.
  await assert.rejects(() => openRecovery(`${MAGIC}\nnot-base64-at-all!!`), /damaged/, 'bad payload must be rejected');
  await assert.rejects(
    () => openRecovery(`${MAGIC}\n${Buffer.from('{"nope":1}').toString('base64')}\n`),
    /not an ENZO vault recovery file/,
    'wrong kind must be rejected',
  );
  await assert.rejects(
    () => openRecovery(fileOf({ ...envelopeOf(file), v: 99 })),
    /version 99/,
    'a future version must be named, not guessed at',
  );

  // 7. Truncated key or IV — caught by length, before WebCrypto sees them.
  await assert.rejects(
    () => openRecovery(fileOf({ ...envelopeOf(file), key: Buffer.alloc(16).toString('base64') })),
    /wrong key or IV length/,
    'a short key must be rejected',
  );
  await assert.rejects(
    () => openRecovery(fileOf({ ...envelopeOf(file), iv: Buffer.alloc(8).toString('base64') })),
    /wrong key or IV length/,
    'a short IV must be rejected',
  );

  // 8. An edited ciphertext fails the GCM tag. This is the difference between a
  //    corrupted file failing loudly and yielding a garbage passcode.
  const env = envelopeOf(file);
  const ct = Buffer.from(String(env.ct), 'base64');
  ct[0] ^= 0xff;
  await assert.rejects(
    () => openRecovery(fileOf({ ...env, ct: ct.toString('base64') })),
    /integrity check/,
    'a tampered ciphertext must fail its auth tag',
  );

  // 9. A file sealed under a different random key does not open this one — i.e.
  //    the key in the envelope is genuinely the one that opens its own ct.
  const other = envelopeOf(await sealRecovery('99999999'));
  await assert.rejects(
    () => openRecovery(fileOf({ ...env, key: other.key })),
    /integrity check/,
    'a swapped key must fail',
  );

  // 10. Nothing to seal.
  await assert.rejects(() => sealRecovery(''), /no passcode/, 'sealing nothing must be refused');

  console.log('✔ vaultRecovery: 15 checks passed');
}

main().catch((err) => {
  console.error('✗ vaultRecovery self-check FAILED');
  console.error(err);
  process.exit(1);
});
