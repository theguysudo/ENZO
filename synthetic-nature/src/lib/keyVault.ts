// ─── keyVault.ts — AES-256-GCM at rest for the user's provider keys ───────────
//
// Owns: every `enzo.keys.*` value and its legacy `enzo-<provider>-key` alias.
// Called by: keyStore.ts, vaultToken.ts, App.tsx, TerminalSection.tsx —
// everywhere that used to call `localStorage` directly for a provider key.
//
// WHY THIS EXISTS. localStorage is plaintext and permanent. A key pasted into
// the vault in January is still sitting there in June, readable by anything with
// a moment of same-origin script execution — a bad extension, a devtools paste,
// a compromised dependency, or someone with the laptop. This module makes the
// stored form ciphertext and keeps the plaintext only in a module-local map that
// dies with the tab.
//
// The old comment in keyStore.ts argued encryption here "would be theater — the
// WebCrypto key would have to be stored beside the ciphertext." That is true for
// an *extractable* key and false for the key we actually use: a CryptoKey created
// with `extractable: false` is structured-clonable into IndexedDB, so the browser
// can persist and reuse it, but `crypto.subtle.exportKey` on it rejects and there
// is no other path to its bytes from JavaScript. An attacker who reads IndexedDB
// gets an opaque handle, not a key. See SECURITY.md for the full boundary —
// notably, this does NOT stop script that is already running on the live page
// from calling getItem() itself. It shrinks the window from "forever" to "while
// the tab is open and unlocked".
//
// SHAPE. getItem / setItem / removeItem are synchronous and localStorage-shaped
// on purpose: there are ~120 call sites, and any design that made them async
// would have to touch all of them. Reads hit an in-memory map; writes update the
// map now and seal to disk in the background, the same fire-and-forget the old
// keyStore.persistToDb() already used.
//
// THE ORDERING RULE. `await init()` must complete before the first component
// renders (see main.tsx). Before init the map is empty, so a read returns null —
// which a caller would interpret as "no key configured". main.tsx is the only
// place that gets this right for everyone.

const DB_NAME = 'enzo-key-vault' // same DB the plaintext mirror used, so nothing is orphaned
const STORE_KEYS = 'keys' // ciphertext mirror: survives a localStorage sweep
const STORE_META = 'meta' // master key handle + which KDF produced it
const DB_VERSION = 2 // v1 was keyStore's plaintext mirror; v2 adds STORE_META

const CIPHER_PREFIX = 'v1.gcm.'
// 600k is the OWASP floor for PBKDF2-SHA256 as of 2023 and costs roughly a
// second on a mid-range laptop — paid once at unlock, never per read.
const PBKDF2_ITERATIONS = 600_000

// ─── The passcode rule ───────────────────────────────────────────────────────
//
// One definition, here, because two UIs collect a passcode (App.tsx to set one,
// main.tsx to unlock) and "8 digits" must not come to mean two different things.
//
// CEILING, stated plainly: 8 digits is 10^8 ≈ 26.6 bits. 600k PBKDF2 rounds turn
// an offline sweep of that keyspace into hours of GPU time rather than seconds,
// and there is nothing on disk to sweep unless the attacker already has the
// device — but it is not passphrase strength. So a long passphrase stays
// allowed and is the better choice. Upgrade path is requiring a passphrase, not
// adding digits.
const PASSCODE_DIGITS = 8
const MIN_PASSPHRASE_LEN = 12

/**
 * null when the value may be used as a vault secret, else the reason it may not.
 * Accepts exactly 8 digits (the passcode) or a passphrase of 12+ characters.
 */
export function passcodeError(value: string): string | null {
  if (/^\d+$/.test(value)) {
    return value.length === PASSCODE_DIGITS
      ? null
      : `A numeric passcode must be exactly ${PASSCODE_DIGITS} digits — this one is ${value.length}.`
  }
  if (value.trim().length < MIN_PASSPHRASE_LEN) {
    return `Use exactly ${PASSCODE_DIGITS} digits, or a passphrase of at least ${MIN_PASSPHRASE_LEN} characters.`
  }
  return null
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Names this module owns. Used only to decide what to load at init. */
function managed(name: string): boolean {
  return name.startsWith('enzo.keys.') || /^enzo-[a-z0-9]+-key$/.test(name)
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// vaultRecovery.ts seals its file with the same two, rather than keeping a second
// pair of base64 helpers a few lines away that could drift.
export { b64, unb64 }

// ─── Crypto primitives (exported so keyVault.test.ts can exercise them) ──────

/** Fresh 12-byte IV per call — an AES-GCM IV must never repeat under one key. */
export async function seal(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))
  return `${CIPHER_PREFIX}${b64(iv)}.${b64(ct)}`
}

/** Returns null for anything that is not our ciphertext or fails its auth tag. */
export async function open(key: CryptoKey, sealed: string): Promise<string | null> {
  if (!sealed.startsWith(CIPHER_PREFIX)) return null
  const [ivB64, ctB64] = sealed.slice(CIPHER_PREFIX.length).split('.')
  if (!ivB64 || !ctB64) return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB64) },
      key,
      unb64(ctB64),
    )
    return dec.decode(pt)
  } catch {
    return null // wrong key, or the value was edited
  }
}

/** Non-extractable: the browser can persist and use it, JavaScript cannot read it. */
export async function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function deriveKeyFromPassphrase(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ─── IndexedDB ───────────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS)
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { dbPromise = null; resolve(null) }
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve((req.result ?? null) as T | null)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

function idbAll(db: IDBDatabase, store: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const out: Record<string, unknown> = {}
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (cur) { out[String(cur.key)] = cur.value; cur.continue() } else resolve(out)
      }
      req.onerror = () => resolve(out)
    } catch { resolve(out) }
  })
}

function idbWrite(db: IDBDatabase, store: string, ops: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite')
      ops(tx.objectStore(store))
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch { resolve() }
  })
}

// ─── State ───────────────────────────────────────────────────────────────────

const plain = new Map<string, string>() // the only place plaintext lives
let master: CryptoKey | null = null
let started = false
let lockedState = false
let passphraseSalt: Uint8Array<ArrayBuffer> | null = null
let encrypted = true

// Serialises background writes so two setItem calls for the same name can never
// land out of order. Everything after the first is one microtask behind.
let writeChain: Promise<void> = Promise.resolve()

/** False only when IndexedDB is unavailable — see the fallback note in init(). */
export function isEncrypted(): boolean { return encrypted }
/** True when passphrase mode is on and unlock() has not run yet. */
export function isLocked(): boolean { return lockedState }
export function hasPassphrase(): boolean { return passphraseSalt !== null }
/**
 * True when at least one provider key is actually held. The passcode nudge in
 * VaultGate.tsx asks this first: prompting someone to protect an empty vault is
 * a prompt about nothing, and the ones you ignore teach you to ignore the rest.
 */
export function hasStoredKeys(): boolean {
  for (const v of plain.values()) if (v) return true
  return false
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Load the master key and decrypt every stored provider key into memory.
 * Idempotent. Resolves *locked* (with an empty map) when passphrase mode is on;
 * main.tsx renders an unlock prompt instead of the app in that case.
 */
export async function init(): Promise<void> {
  if (started) return
  started = true
  const db = await openDb()

  if (!db) {
    // No IndexedDB (some private-browsing modes) means no durable place for a
    // non-extractable key, and a fresh per-load key would make every stored
    // value permanently unreadable — losing the user's keys to protect them.
    // Stay on plaintext and say so, rather than silently destroying data.
    encrypted = false
    console.warn('[keyVault] IndexedDB unavailable — provider keys stay in plaintext this session')
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name && managed(name)) plain.set(name, localStorage.getItem(name) ?? '')
    }
    return
  }

  const kdf = await idbGet<{ mode: string; salt: number[] }>(db, STORE_META, 'kdf')
  if (kdf?.mode === 'passphrase' && Array.isArray(kdf.salt)) {
    passphraseSalt = new Uint8Array(kdf.salt)
    lockedState = true
    return // map stays empty until unlock()
  }

  master = await idbGet<CryptoKey>(db, STORE_META, 'deviceKey')
  if (!master) {
    master = await generateDeviceKey()
    await idbWrite(db, STORE_META, (s) => s.put(master, 'deviceKey'))
  }
  await hydrate(db)
}

/**
 * Populate the map from localStorage, falling back to the IndexedDB mirror, and
 * re-seal anything that was not already ciphertext. That last part is the whole
 * migration: an existing user's plaintext keys are read once, encrypted in
 * place, and the plaintext copies (including keyStore's old plaintext IDB
 * mirror, which was keyed by bare provider name) are overwritten or removed.
 */
async function hydrate(db: IDBDatabase): Promise<void> {
  if (!master) return
  const mirror = await idbAll(db, STORE_KEYS)

  const names = new Set<string>()
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i)
    if (name && managed(name)) names.add(name)
  }
  const legacyMirrorNames: string[] = []
  for (const name of Object.keys(mirror)) {
    if (managed(name)) names.add(name)
    else legacyMirrorNames.push(name) // keyStore v1 stored PLAINTEXT under 'openrouter' etc.
  }

  const resealNeeded: string[] = []
  for (const name of names) {
    const stored = localStorage.getItem(name) ?? (typeof mirror[name] === 'string' ? (mirror[name] as string) : null)
    if (stored === null || stored === '') continue
    if (stored.startsWith(CIPHER_PREFIX)) {
      const value = await open(master, stored)
      if (value === null) {
        // Undecryptable: the master key was replaced (e.g. site data cleared but
        // localStorage restored). Drop it — a ciphertext string handed to a
        // provider as an API key is worse than a missing key.
        console.warn(`[keyVault] dropping unreadable ${name}`)
        localStorage.removeItem(name)
        continue
      }
      plain.set(name, value)
      if (localStorage.getItem(name) === null) resealNeeded.push(name) // came from the mirror only
    } else {
      plain.set(name, stored) // pre-encryption plaintext
      resealNeeded.push(name)
    }
  }

  // Recover the v1 plaintext mirror (bare provider names) before deleting it.
  for (const legacy of legacyMirrorNames) {
    const value = mirror[legacy]
    if (typeof value !== 'string' || !value.trim()) continue
    const name = `enzo.keys.${legacy}`
    if (!plain.has(name)) { plain.set(name, value); resealNeeded.push(name) }
  }
  if (legacyMirrorNames.length) {
    await idbWrite(db, STORE_KEYS, (s) => { for (const n of legacyMirrorNames) s.delete(n) })
  }

  for (const name of resealNeeded) await persist(name)
}

/** Seal one name's current value to localStorage + the IndexedDB mirror. */
async function persist(name: string): Promise<void> {
  const value = plain.get(name)
  const db = await openDb()
  if (value === undefined || value === '') {
    localStorage.removeItem(name)
    if (db) await idbWrite(db, STORE_KEYS, (s) => s.delete(name))
    return
  }
  const stored = master ? await seal(master, value) : value
  localStorage.setItem(name, stored)
  if (db) await idbWrite(db, STORE_KEYS, (s) => s.put(stored, name))
}

/** Re-encrypt every held value under the current master. Used when it changes. */
async function resealAll(): Promise<void> {
  for (const name of [...plain.keys()]) await persist(name)
}

// ─── The localStorage-shaped surface ─────────────────────────────────────────

export function getItem(name: string): string | null {
  const v = plain.get(name)
  return v === undefined || v === '' ? null : v
}

export function setItem(name: string, value: string): void {
  plain.set(name, value)
  writeChain = writeChain.then(() => persist(name)).catch(() => {})
}

export function removeItem(name: string): void {
  plain.delete(name)
  writeChain = writeChain.then(() => persist(name)).catch(() => {})
}

/** Await the background writes — for tests and for "did my save land" flows. */
export function flush(): Promise<void> {
  return writeChain
}

// ─── Passphrase mode (opt-in) ────────────────────────────────────────────────

/**
 * Switch the master key to one derived from `passphrase` and delete the device
 * key, so nothing at rest can open the vault without the passphrase. Every held
 * value is re-sealed under the new master before the old one goes away.
 */
export async function enablePassphrase(passphrase: string): Promise<void> {
  const rejected = passcodeError(passphrase)
  if (rejected) throw new Error(rejected)
  // A setItem still in flight would seal under the OLD master and land after
  // resealAll(), leaving one value unreadable. ponytail: draining the queue is
  // enough because only a person drives these; a lock belongs here if anything
  // ever calls setItem on a timer.
  await flush()
  const db = await openDb()
  if (!db) throw new Error('Passphrase mode needs IndexedDB, which this browser context has disabled.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  master = await deriveKeyFromPassphrase(passphrase, salt)
  passphraseSalt = salt
  await resealAll()
  await idbWrite(db, STORE_META, (s) => {
    s.put({ mode: 'passphrase', salt: [...salt] }, 'kdf')
    s.delete('deviceKey')
  })
}

/** Back to the device key — no prompt on load, still encrypted at rest. */
export async function disablePassphrase(): Promise<void> {
  await flush() // same reason as enablePassphrase()
  const db = await openDb()
  if (!db) throw new Error('IndexedDB is unavailable.')
  master = await generateDeviceKey()
  passphraseSalt = null
  await resealAll()
  await idbWrite(db, STORE_META, (s) => {
    s.put(master, 'deviceKey')
    s.delete('kdf')
  })
}

/**
 * Try `passphrase` against the stored ciphertext. Returns false on a wrong one
 * (nothing decrypts) and leaves the vault locked. On success the map is
 * populated and `enzo:vault-unlocked` fires so mounted components re-read.
 *
 * Deliberately does NOT run passcodeError(): the format rule is a policy on new
 * secrets. Applying it here would permanently lock out anyone who set a secret
 * before the rule existed — losing their keys to enforce a format.
 */
export async function unlock(passphrase: string): Promise<boolean> {
  if (!lockedState || !passphraseSalt) return true
  const db = await openDb()
  if (!db) return false
  const candidate = await deriveKeyFromPassphrase(passphrase, passphraseSalt)

  // Verification is "does any stored value open" — no separate verifier blob to
  // keep in sync. With nothing stored yet there is nothing to be wrong about.
  const names: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const n = localStorage.key(i)
    if (n && managed(n) && (localStorage.getItem(n) || '').startsWith(CIPHER_PREFIX)) names.push(n)
  }
  if (names.length > 0) {
    let ok = false
    for (const n of names) {
      if ((await open(candidate, localStorage.getItem(n)!)) !== null) { ok = true; break }
    }
    if (!ok) return false
  }

  master = candidate
  lockedState = false
  await hydrate(db)
  window.dispatchEvent(new Event('enzo:vault-unlocked'))
  return true
}
