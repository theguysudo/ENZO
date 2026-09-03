// ─── Vault session token (shared module — App + TerminalSection) ─────────────
// The vault endpoints require auth. The browser mints a proof by exchanging any
// provider key it already holds for an HMAC session token (server mints it).
const VAULT_PROVIDERS = ['openrouter', 'groq', 'nvidia', 'huggingface', 'pollinations', 'exa', 'llm7'] as const

import * as keyVault from './keyVault'

let vaultTokenInFlight: Promise<string | null> | null = null

export async function mintVaultToken(): Promise<string | null> {
  const cached = sessionStorage.getItem('enzo.vault.token')
  if (cached) return cached
  // One attempt per app mount: if no token could be minted (no keys, or the
  // endpoint rejected/rate-limited), remember that and don't hammer /session on
  // every view change. Cleared when a key is later saved (see VaultSection).
  if (sessionStorage.getItem('enzo.vault.mintBlocked') === '1') return null
  if (vaultTokenInFlight) return vaultTokenInFlight
  vaultTokenInFlight = (async () => {
    for (const provider of VAULT_PROVIDERS) {
      const key = (keyVault.getItem(`enzo.keys.${provider}`) || '').trim()
      if (!key) continue
      try {
        const res = await fetch('/api/vault/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, key }),
        })
        if (res.status === 429) break // rate-limited — stop, don't keep trying keys
        if (!res.ok) continue
        const data = await res.json()
        if (data.vaultToken) {
          sessionStorage.setItem('enzo.vault.token', data.vaultToken)
          sessionStorage.removeItem('enzo.vault.mintBlocked')
          return data.vaultToken as string
        }
      } catch {
        /* try next provider */
      }
    }
    sessionStorage.setItem('enzo.vault.mintBlocked', '1')
    return null
  })()
  try {
    return await vaultTokenInFlight
  } finally {
    vaultTokenInFlight = null
  }
}
