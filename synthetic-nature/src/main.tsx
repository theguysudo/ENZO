import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/homepage-polish.css'
import App from './App'
import { AuthCallback } from './components/AuthCallback'
import { VaultUnlock } from './components/VaultGate'
import * as keyVault from './lib/keyVault'
import { GOOGLE_AUTH } from './lib/variant'

// If the backend redirected here after Google OAuth, handle the token exchange.
// The backend sends: http://localhost:5173/auth/callback#token=...
// Docker variant (GOOGLE_AUTH=false): dead branch — tree-shaken out, and a
// stale /auth/callback URL falls through to the vault/App like any other path.
const isAuthCallback = GOOGLE_AUTH && window.location.pathname === '/auth/callback'

// Nothing here prompts for a passcode: setting one lives in the vault section,
// next to the keys it protects (see the "Passphrase lock" row in App.tsx).
function Root() {
  const [locked, setLocked] = useState(keyVault.isLocked())
  if (isAuthCallback) return <AuthCallback />
  if (locked) return <VaultUnlock onUnlocked={() => setLocked(false)} />
  return <App />
}

// keyVault.init() decrypts the stored provider keys into memory. It MUST finish
// before the first render: keyVault.getItem is synchronous, so a component that
// mounted first would read null and conclude the user has no keys configured.
keyVault.init().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  )
})
