// ─── vaultRecovery.ts — the .enzokey file, for "I forgot my passcode" ─────────
//
// Owns the recovery file: written once when a passcode is set (App.tsx and
// components/VaultGate.tsx both call sealRecovery + downloadRecovery), read back
// when someone is locked out (VaultGate.tsx again).
//
// WHAT THIS FILE IS, PLAINLY. It is a second key to the vault. It holds the
// passcode sealed with AES-256-GCM under a random key kept in the same file, so
// anything holding the file can open it with no other input. That is not a hole
// in the sealing — it is what "recovers the vault by itself" means, and it is how
// a BitLocker recovery key or a 1Password Emergency Kit works. The seal buys two
// real things and nothing more: the passcode is not sitting in a readable file
// that anyone can shoulder-read or grep out of a cloud backup, and the GCM tag
// makes an edited or truncated file fail loudly instead of yielding garbage.
//
// So the file is exactly as sensitive as the passcode, and the UI says so.
//
// ponytail: CEILING — the file reveals the passcode itself, so someone who reused
// that PIN elsewhere has leaked it there too. Upgrade path is DEK indirection:
// seal a random data key under the passcode AND under a recovery secret, and the
// file then restores vault access without revealing anything the user typed. That
// costs a storage-format migration for existing passphrase users, which is why it
// is not here — this version reuses keyVault.unlock() and enablePassphrase()
// exactly as they already are, and adds no new stored state at all.
//
// The magic header is a format check, NOT a security boundary. It is there so a
// wrong file gets "that is not a recovery file" instead of a crypto stack trace.

import { b64, unb64 } from './keyVault'

const MAGIC = 'ENZO-VAULT-RECOVERY-v1'
const KIND = 'enzo.vault.recovery'
export const RECOVERY_EXT = '.enzokey'

interface Envelope {
  v: 1
  kind: typeof KIND
  createdAt: string
  key: string // raw AES-256 key — see the note above about why it lives here
  iv: string
  ct: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** File text for `passcode`. Fresh key and IV per call, so two files never match. */
export async function sealRecovery(passcode: string): Promise<string> {
  if (!passcode) throw new Error('There is no passcode to write a recovery file for.')
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await aesKey(raw),
    enc.encode(JSON.stringify({ passcode })),
  )
  const envelope: Envelope = {
    v: 1,
    kind: KIND,
    createdAt: new Date().toISOString(),
    key: b64(raw),
    iv: b64(iv),
    ct: b64(ct),
  }
  // Header on its own line so the file is identifiable in an editor while staying
  // unreadable; the payload is one long line, with nothing to hand-edit.
  return `${MAGIC}\n${b64(enc.encode(JSON.stringify(envelope)))}\n`
}

/**
 * The passcode out of a recovery file, or a throw explaining what is wrong with it.
 *
 * Every field is checked before use: this is a file a person picked off their
 * disk, so it is a trust boundary, and "it decoded" is not the same as "it is
 * ours". Messages name the fault so the user knows whether to hunt for a
 * different file or accept the vault is gone.
 */
export async function openRecovery(text: string): Promise<string> {
  const lines = text.trim().split(/\r?\n/)
  if (lines[0]?.trim() !== MAGIC) {
    throw new Error(`That is not an ENZO recovery file — the right one ends in ${RECOVERY_EXT}.`)
  }
  const payload = lines.slice(1).join('').trim()
  if (!payload) throw new Error('The recovery file has its header but no contents.')

  let envelope: Envelope
  try {
    envelope = JSON.parse(dec.decode(unb64(payload)))
  } catch {
    throw new Error('The recovery file is damaged — its contents did not decode.')
  }
  if (envelope?.kind !== KIND) throw new Error('That file is not an ENZO vault recovery file.')
  if (envelope.v !== 1) throw new Error(`The recovery file is version ${envelope.v}, which this build cannot read.`)

  let raw: Uint8Array<ArrayBuffer>
  let iv: Uint8Array<ArrayBuffer>
  let ct: Uint8Array<ArrayBuffer>
  try {
    raw = unb64(envelope.key)
    iv = unb64(envelope.iv)
    ct = unb64(envelope.ct)
  } catch {
    throw new Error('The recovery file is damaged — its fields did not decode.')
  }
  if (raw.length !== 32 || iv.length !== 12) {
    throw new Error('The recovery file is damaged — wrong key or IV length.')
  }

  let pt: ArrayBuffer
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(raw), ct)
  } catch {
    throw new Error('The recovery file failed its integrity check — it has been edited or truncated.')
  }

  let passcode: unknown
  try {
    passcode = JSON.parse(dec.decode(pt))?.passcode
  } catch {
    throw new Error('The recovery file opened but held nothing we recognise.')
  }
  if (typeof passcode !== 'string' || !passcode) throw new Error('The recovery file held no passcode.')
  return passcode
}

/** Save `text` to the user's downloads. Returns the filename, for the UI to name. */
export function downloadRecovery(text: string): string {
  const name = `enzo-vault-recovery-${new Date().toISOString().slice(0, 10)}${RECOVERY_EXT}`
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Not revoked synchronously: Safari reads the blob after click() returns, and
  // revoking first cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return name
}
