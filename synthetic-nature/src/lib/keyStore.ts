// ─── Local device key store (vault backend for hosted/BYOK mode) ─────────────
// The vault is a GUI over the user's OWN device store — never the server .env.
// Nothing in this module touches the network or the server.
//
// This is the provider-shaped view: `getProviderKeys` / `saveProviderKeys` /
// `clearAllProviderKeys` work in short names ('openrouter') and handle the
// legacy `enzo-<provider>-key` aliases that older code paths still read.
// Storage itself belongs to keyVault.ts, which keeps values as AES-256-GCM
// ciphertext under a non-extractable key and mirrors them into IndexedDB so they
// survive a localStorage sweep. This module used to do that mirroring itself, in
// plaintext, in the same IndexedDB the master key now lives in — keyVault's
// hydrate() recovers and deletes those old entries on first load.

import * as keyVault from './keyVault'

// Legacy sibling keys some older code paths read (TerminalSection, App advisor).
const LEGACY_ALIASES: Record<string, string> = {
  openrouter: 'enzo-openrouter-key',
  huggingface: 'enzo-huggingface-key',
  nvidia: 'enzo-nvidia-key',
  exa: 'enzo-exa-key',
  groq: 'enzo-groq-key',
}

export const KNOWN_PROVIDERS = [
  'groq',
  'groq_meme',
  'openrouter',
  'nvidia',
  'huggingface',
  'exa',
  'pollinations',
  'llm7',
  'google',
  'puter',
  'cloudflare',
  'cloudflareAccount',
] as const

function keyId(k: string): string {
  return `enzo.keys.${k}`
}

/** All known providers, read from the device store. */
export function getProviderKeys(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of KNOWN_PROVIDERS) out[p] = keyVault.getItem(keyId(p)) ?? ''
  return out
}

/**
 * Write only the providers present in `keys` to the device store (values are
 * trimmed; empty strings remove). Providers absent from the object are left
 * untouched so partial saves never wipe unrelated keys. Returns providers stored.
 */
export function saveProviderKeys(keys: Record<string, string>): string[] {
  const stored: string[] = []
  for (const [k, raw] of Object.entries(keys)) {
    const val = (raw ?? '').trim()
    if (val) {
      keyVault.setItem(keyId(k), val)
      const alias = LEGACY_ALIASES[k]
      if (alias) keyVault.setItem(alias, val)
      stored.push(k)
    } else {
      keyVault.removeItem(keyId(k))
      const alias = LEGACY_ALIASES[k]
      if (alias) keyVault.removeItem(alias)
    }
  }
  return stored
}

export function clearAllProviderKeys(): void {
  for (const p of KNOWN_PROVIDERS) {
    keyVault.removeItem(keyId(p))
    const alias = LEGACY_ALIASES[p]
    if (alias) keyVault.removeItem(alias)
  }
}
