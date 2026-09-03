// ─── VaultGate.tsx — the vault screens shown instead of the app ───────────────
//
// VaultUnlock  — shown when passphrase mode is on and the vault is locked. Also
//                holds the recovery-file path, because "I cannot get in" is the
//                only moment a recovery file is ever wanted.
// SetPasscode — the setup form used by the post-recovery reset. Turning the lock
//                on in the first place is done in the vault section of App.tsx,
//                which has its own row-shaped form; both call
//                keyVault.enablePassphrase then write the recovery file, in that
//                order, so a failed enable never leaves a file behind.
//
// Nothing here nags: setting a passcode is offered in the vault section, next to
// the keys it protects, never over the homepage.
//
// These live outside main.tsx so main.tsx keeps its one job (init-then-render).

import { useState } from 'react'
import * as keyVault from '../lib/keyVault'
import { sealRecovery, openRecovery, downloadRecovery, RECOVERY_EXT } from '../lib/vaultRecovery'

const OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center px-4'
const PANEL = 'w-full max-w-sm space-y-5 rounded-3xl border border-white/10 bg-white/[0.03] p-7 backdrop-blur-2xl'
const FIELD = 'w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono-display text-xs text-white placeholder:text-white/25 outline-none focus:border-white/25'
const PRIMARY = 'w-full rounded-full bg-white py-3 font-mono-display text-xs font-semibold uppercase tracking-widest text-black transition-all hover:bg-white/90 disabled:opacity-50'
const QUIET = 'font-mono-display text-[10px] uppercase tracking-widest text-white/40 transition-colors hover:text-white/70'
const ERRBOX = 'rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2 font-mono-display text-[10px] text-red-400'
const EYEBROW = 'font-mono-display text-[9px] uppercase tracking-[0.25em] text-white/40'

/**
 * Set a passcode and write its recovery file. Calls `onSaved` with the filename.
 * The rule itself lives in keyVault.passcodeError — this only reports it.
 */
function SetPasscode({ cta, onSaved }: { cta: string; onSaved: (file: string) => void }) {
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (pass !== confirm) return setError('The two entries do not match.')
    const rejected = keyVault.passcodeError(pass)
    if (rejected) return setError(rejected)
    setBusy(true)
    try {
      await keyVault.enablePassphrase(pass)
      // Sealed only after the passcode is live, so a failed enable can never
      // leave a recovery file for a passcode that was never set.
      onSaved(downloadRecovery(await sealRecovery(pass)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the passcode.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="password"
        autoFocus
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        placeholder="8-digit passcode, or a 12+ char passphrase"
        className={FIELD}
      />
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Repeat it"
        className={FIELD}
      />
      {error && <div className={ERRBOX}>{error}</div>}
      <button type="submit" disabled={busy || !pass || !confirm} className={PRIMARY}>
        {busy ? 'Sealing your keys…' : cta}
      </button>
      <p className="text-[10px] leading-relaxed text-white/35">
        A recovery file downloads automatically so a forgotten passcode is not the
        end of your keys.
      </p>
    </form>
  )
}

/** Shown right after a passcode is set. The one screen that must be read. */
function RecoverySaved({ file, onDone }: { file: string; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 font-mono-display text-[10px] text-emerald-300">
        ✓ Passcode set. Saved <span className="text-emerald-200">{file}</span> to your downloads.
      </div>
      <p className="text-[11px] leading-relaxed text-white/55">
        Move that file somewhere safe and private — a password manager, an
        encrypted drive, a USB stick in a drawer. It is the only way back into
        your keys if you forget the passcode.
      </p>
      <p className="text-[11px] leading-relaxed text-white/40">
        Keep it private too: anyone who has the file can open this vault without
        the passcode. Treat it exactly as carefully as the passcode itself.
      </p>
      <button type="button" onClick={onDone} className={PRIMARY}>
        I've saved it →
      </button>
    </div>
  )
}

/**
 * Shown instead of the app when passphrase mode is on. Four states:
 * unlock → (recover → reset → saved) → in.
 *
 * The recovery branch resets the passcode rather than just letting them in,
 * because the file now contains a passcode they have proven they do not
 * remember. Resetting re-seals under a new one and writes a fresh file; the old
 * file stops working at that moment, which the last screen says.
 */
export function VaultUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [mode, setMode] = useState<'unlock' | 'recover' | 'reset'>('unlock')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!passphrase) return
    setBusy(true)
    setError(null)
    // Deliberately slow: 600k PBKDF2 rounds is the point, so the UI says so.
    const ok = await keyVault.unlock(passphrase)
    setBusy(false)
    if (ok) onUnlocked()
    else { setError('That passcode does not match this vault.'); setPassphrase('') }
  }

  const useRecoveryFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const recovered = await openRecovery(await file.text())
      if (!(await keyVault.unlock(recovered))) {
        throw new Error('That recovery file is for a different vault — its passcode does not open this one.')
      }
      setMode('reset')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that recovery file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${OVERLAY} bg-[#06070c]`}>
      <div className={PANEL}>
        <div className="space-y-2">
          <div className={EYEBROW}>Encrypted vault</div>
          <h1 className="font-garamond text-2xl text-white">
            {saved ? 'Keep this file safe' : mode === 'reset' ? 'Choose a new passcode' : 'Unlock your keys'}
          </h1>
          {mode === 'unlock' && (
            <p className="text-[11px] leading-relaxed text-white/45">
              Your provider keys are sealed with your passcode. It is not stored
              anywhere — if you have forgotten it, the recovery file you saved when
              you set it is the way back in.
            </p>
          )}
          {mode === 'recover' && (
            <p className="text-[11px] leading-relaxed text-white/45">
              Pick the <span className="text-white/70">{RECOVERY_EXT}</span> file that
              downloaded when you set your passcode. You will choose a new passcode
              straight after.
            </p>
          )}
          {mode === 'reset' && !saved && (
            <p className="text-[11px] leading-relaxed text-white/45">
              Your keys are open. Set a new passcode and a replacement recovery file
              will download — the old one stops working.
            </p>
          )}
        </div>

        {mode === 'unlock' && (
          <form onSubmit={submit} className="space-y-4">
            <input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Vault passcode"
              className={FIELD}
            />
            {error && <div className={ERRBOX}>{error}</div>}
            <button type="submit" disabled={busy || !passphrase} className={PRIMARY}>
              {busy ? 'Deriving key…' : 'Unlock →'}
            </button>
            <button
              type="button"
              onClick={() => { setError(null); setMode('recover') }}
              className={`${QUIET} block w-full text-center`}
            >
              Forgot it? Use recovery file
            </button>
          </form>
        )}

        {mode === 'recover' && (
          <div className="space-y-4">
            <label className="block cursor-pointer rounded-xl border border-dashed border-white/15 bg-black/30 px-4 py-6 text-center font-mono-display text-[10px] uppercase tracking-widest text-white/50 transition-colors hover:border-white/30 hover:text-white/70">
              {busy ? 'Reading…' : `Choose ${RECOVERY_EXT} file`}
              <input
                type="file"
                accept={RECOVERY_EXT}
                disabled={busy}
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void useRecoveryFile(f) }}
              />
            </label>
            {error && <div className={ERRBOX}>{error}</div>}
            <button
              type="button"
              onClick={() => { setError(null); setMode('unlock') }}
              className={`${QUIET} block w-full text-center`}
            >
              ← Back to passcode
            </button>
          </div>
        )}

        {mode === 'reset' && (
          saved
            ? <RecoverySaved file={saved} onDone={onUnlocked} />
            : <SetPasscode cta="Set new passcode →" onSaved={setSaved} />
        )}
      </div>
    </div>
  )
}
