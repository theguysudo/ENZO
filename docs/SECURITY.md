# Security

This document is the threat model ENZO actually implements — what is protected,
what is not, and why. It is written to be checkable: every claim here points at
the code that makes it true.

The plain-language version of this page ships **in the product**, under the Docs
tab → Security and privacy.
---

## The premise

ENZO is BYOK: **bring your own keys**. There is no ENZO account and no proxy that
holds your credentials. You give the app API keys for providers you chose, and
requests go from your browser, through the ENZO backend, to that provider.

This shapes everything below. The most valuable thing in the system is your
collection of provider keys, and the design assumption is that **the server
should not be trusted with them** unless you are the person running it.

### Two deployment modes

| | Hosted / BYOK | Self-hosted |
|---|---|---|
| `ENZO_MASTER_KEY` | unset | set |
| Where keys live | your browser only | your browser **and** the server's `.env` |
| Server-side vault writer, memory, skills, `/api/v1` tunnel | **refuse to run** | enabled |
| Trust required in the operator | none for your keys | full |

Those "refuse to run" branches are the hosted design, not a degradation. If you
deploy ENZO publicly, **leave `ENZO_MASTER_KEY` empty.**

---

## Keys at rest — AES-256-GCM

### In the browser

Provider keys are stored as AES-256-GCM ciphertext in `localStorage`, format
`v1.gcm.<base64 iv>.<base64 ciphertext>`, with a **fresh 12-byte IV per write**.
The master key is a WebCrypto `CryptoKey` generated with `extractable: false` and
stored in IndexedDB (`enzo-key-vault`).

**Why `extractable: false` is the whole point.** A non-extractable `CryptoKey` is
structured-clonable — the browser can persist it in IndexedDB — but
`crypto.subtle.exportKey()` on it **rejects**. No JavaScript can read its bytes:
not ours, and not an attacker's. The key can be *used* to decrypt while never
being *copied*. (An earlier version of this codebase argued encryption at rest
"would be theater, because the key sits beside the ciphertext." That is true only
for an extractable key.)

Implementation: `synthetic-nature/src/lib/keyVault.ts`. Round-trip, tamper, and
migration checks: `synthetic-nature/src/lib/keyVault.test.ts`, run by the root
`npm test` (12 assertions) against node's WebCrypto.

**Every key access goes through that one module, enforced by CI.** There are 120+
direct key-access sites across the frontend. A single missed read site would ship
ciphertext to a provider *as if it were an API key* — a confusing, silent
failure. So a CI step greps `synthetic-nature/src` for any direct `localStorage`
access to an `enzo.keys.*` name or a legacy `enzo-*-key` alias and **fails the
build** on a hit. A missed site is a red build, not a production bug.

### Optional passphrase mode

By default the master key is a device key: no prompt, nothing for you to
remember, and the keys survive a reload. Turn on **passphrase mode** in the Vault
and the master key becomes `PBKDF2-SHA256(passphrase, salt, 600_000 iterations)`,
every stored key is re-sealed under it, and **the device key is deleted from
IndexedDB** — so nothing usable remains at rest at all. The app then asks for the
passphrase once per load.

This is off by default on purpose: the default path must add no friction.
Passphrase mode is the right choice on a shared or backed-up machine.

### On the server

Token files are sealed by `crypto-store.ts`: AES-256-GCM under a key derived with
`scryptSync(ENZO_MASTER_KEY, salt, 32)`, envelope
`{ v, alg, salt, iv, tag, ct }`, written with `mode: 0o600`. This covers the
files that hold credentials: the Gmail/Calendar OAuth refresh tokens
(`.gmail-tokens.json`) and the agent-tools token store. A legacy plaintext file
is read once and re-written sealed, so nothing needs reconnecting.

**`cloudflare-plan-tier.json` is deliberately *not* sealed.** It holds
`{ "<cloudflare account id>": { tier, checkedAt } }` — an account id is an
identifier that appears in API URLs, not a secret, and the plan tier is
public-by-observation (a free account 403s on paid models). Sealing it would
encrypt nothing sensitive while making the model catalog fail without
`ENZO_MASTER_KEY`, since `crypto-store` fails closed by design. It is gitignored
because it is machine-local cache, not because it is a secret.

scrypt rather than a bare hash, because `ENZO_MASTER_KEY` is a human-chosen
string. Round-trip and tamper checks: `crypto-store.test.ts`.

---

## What the encryption does **not** protect against

Being specific here matters more than the feature list above.

- **Scripted XSS on the live page.** If an attacker gets JavaScript running in
  your ENZO tab, they cannot export the master key — but they can ask the vault
  to decrypt, or simply read a key out of a form field, or make provider calls as
  you. Encryption at rest raises the cost of *offline* theft (a stolen disk, a
  synced profile, a browser backup, another tab's stray `localStorage` dump); it
  is not a defence against code running inside your own origin. There is no
  `dangerouslySetInnerHTML` and no `innerHTML` anywhere in `src` — that is the
  actual XSS defence, and it needs to stay true.
- **A malicious browser extension.** Extensions run with access to the page.
- **A compromised or hostile ENZO server.** In hosted mode the server never
  persists your keys, but every request passes through it. Self-host if that
  matters to you; the whole app runs locally with no external dependency.
- **The provider.** Your prompts go to whichever provider you selected, under
  their privacy policy. ENZO does not change that and cannot.
- **Passphrase mode with a weak passphrase.** 600k PBKDF2 iterations make
  guessing expensive, not impossible. A dictionary word is still a dictionary
  word.

---

## Isolation of generated code

Coding mode has a model write a project and then **runs it**. Two boundaries
contain that.

**The preview iframe** is `sandbox="allow-scripts allow-forms allow-modals
allow-popups allow-pointer-lock"` — deliberately **without `allow-same-origin`**.
Those two tokens together nullify the sandbox: the frame would share our origin
and `window.parent.localStorage` would hand generated code every provider key and
the auth token. Without it the frame gets an opaque origin, so
`parent.localStorage` and `parent.document` throw `SecurityError`, while relative
`fetch` from inside the preview still resolves. **Do not re-add
`allow-same-origin`** (`synthetic-nature/src/components/TerminalSection.tsx`).

**The child process** is spawned with an explicit env **allowlist** — `PATH`,
`HOME`, `TMPDIR`, `LANG`, `TZ`, `NODE_ENV`, `PORT`, `NODE_PATH`,
`ENZO_PROJECT_ID`, `ENZO_PROJECT_DIR` — not `{...process.env}`. It previously
inherited `ENZO_MASTER_KEY`, `JWT_SECRET`, `GOOGLE_CLIENT_SECRET` and every
provider key, and the child's stdout is streamed back to the browser as a boot
log, which made that inheritance directly exfiltratable. Allowlist rather than
blocklist, so the next secret added to `.env` is not readable there by default
(`project-runtime.ts`).

Skill learning (`skills.ts`) clones a user-supplied repo with `execFile` (no
shell, so no argument injection) and reads back **only markdown**. Nothing from a
cloned repo is ever executed. Keep it that way — the moment a skill can carry a
script, "learn this repo" becomes remote code execution.

---

## Authentication and authorization

- **Vault, memory, skills and the tunnel** require `ENZO_MASTER_KEY` (as
  `Authorization: Bearer`) or a **vault session token** (`x-vault-token`). The
  session token is an HMAC proving the caller already holds a valid provider key,
  computed over a rolling 12-hour window so it expires on its own. The previous
  window is still accepted, so a token never dies mid-session. It has no
  per-session nonce, so revoking one browser means rotating the underlying key —
  the upgrade path is a token table, noted in the code.
- **Google sign-in fails closed.** With `JWT_SECRET` unset, the three auth routes
  return `503` with a setup message. There is no fallback secret; a hardcoded one
  would let anyone forge a valid token. `jwt.verify` pins
  `algorithms: ['HS256']`, so a token claiming `alg: none` is rejected.
- **OAuth flows carry CSRF protection.** Gmail/Calendar consent issues a
  single-use `state` with a 10-minute TTL, verified before the code is exchanged.
  Without it the callback would accept *any* code from anyone — including one
  minted for an attacker's Google account, silently rebinding the server's Gmail
  identity so every later `gmail_send` ran against the attacker's mailbox. The
  HuggingFace flow uses PKCE plus `state` (its code is redeemed by our server);
  the OpenRouter flow uses PKCE alone, which is sufficient because the browser
  exchanges that code directly with the provider and no server hop is involved.
- **State-changing feature routes** require an `x-enzo-csrf` header, which a
  cross-site `fetch` cannot set without triggering a preflight that CORS blocks.
- **The Vault API returns masked values only.** Plaintext never travels
  backend → frontend.

---

## Transport, headers and limits

- `trust proxy` is set to **1 hop**. Behind the Cloudflare tunnel the socket peer
  is the tunnel, so without this `req.ip` is identical for every caller and all
  rate-limit buckets collapse into one — a single noisy client would 429 the whole
  instance. Do not raise it above 1 without adding a real second proxy: each
  extra hop is one more forgeable `X-Forwarded-For` entry.
- Rate limits are in-memory per-IP token buckets: `/api/ping-model` 30/min,
  `/api/catalog-recommend`, `/api/vision/analyze`, `/api/image/generate` 20/min,
  `/api/vault/*` 10/min. Per-process, so they reset on restart and assume a single
  instance.
- Response headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  same-origin`, `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security`,
  and `Permissions-Policy` (camera and microphone same-origin only — voice input
  uses the mic; geolocation and payment fully denied).
- **CSP ships as `Content-Security-Policy-Report-Only`, on purpose.** This one
  process serves three different content types: JSON API responses, the built
  SPA, and LLM-generated preview HTML with inline `<script>`. A blocking policy
  guessed in one pass will break one of them. Watch the browser console across a
  real session — chat, image generation, a coding-mode preview, wallpaper
  rotation — then rename the header to enforce it. `'unsafe-inline'` for scripts
  is unavoidable while the preview route serves generated HTML; the **iframe
  sandbox**, not the CSP, is the boundary that contains that code.
- CORS is restricted to `ENZO_CORS_ORIGINS`. Requests with no `Origin` header
  (curl, server-to-server) are allowed by design.
- A global Express error handler scrubs internals from every client-facing error.

---

## Operational notes

- **Never commit `.env`.** It is gitignored. So are `.gmail-tokens.json`,
  `client_secret_*.json`, and every runtime cache file.
- **Do not embed a token in a git remote URL.** A remote like
  `https://<token>@github.com/...` writes that credential into `.git/config` in
  plaintext, where any `git remote -v`, CI log, or shared screenshot leaks it.
  Use `gh auth login` or a credential helper instead. Check yours with
  `git remote -v` before sharing terminal output.
- **Set `ENZO_MASTER_KEY` to a strong random value** in any non-local
  self-hosted deployment — it is the KDF input for every sealed file on disk.
- Rotate a provider key the moment you suspect exposure. The Vault's Test button
  confirms a replacement works before you discard the old one.

## Verifying this yourself

```bash
npm run typecheck && npm test    # includes AES round-trip and tamper checks
npm run pentest                  # 10 black-box checks against a running server
npm run check:imports            # no module the app needs is untracked
```

In DevTools on a logged-in session: `localStorage['enzo.keys.openrouter']` should
be `v1.gcm.…` ciphertext, and the `enzo-key-vault` IndexedDB entry should show a
`CryptoKey` with `extractable: false`. From inside a coding-mode preview iframe,
`parent.localStorage` should throw `SecurityError`.

## Reporting a vulnerability

Open a **private** security advisory on the repository
(GitHub → Security → Report a vulnerability), or contact the maintainer directly.
Please do not open a public issue for anything exploitable.

> Maintainers: theguysudo

Include what you did, what you expected, and what happened. A proof of concept
against a local instance is ideal.
