# ENZO

**Bring your own AI keys. ENZO routes across nine providers at provider cost.**

ENZO is a self-hostable AI workspace. You supply API keys for the providers you
already pay for (or don't — several are free), and ENZO gives you one interface
over all of them: a model marketplace with live health checks, a streaming chat
terminal with agent tools, and a coding mode that writes a project, boots it, and
tells you when it's broken.

There is no ENZO account, no proxy in the middle, and no markup. Your keys go
from your browser to the provider you chose.

---

## What's in the box

| Surface | What it does |
|---|---|
| **Marketplace** | Every model from 9 gateways in one catalog, refreshed every 6 hours, with measured latency and a live status dot per model. Filter by price, capability, or provider. |
| **Terminal** | Streaming chat in 5 modes (normal, thinking, research, coding, image gen), with web search, memory that survives a provider switch, and automatic fallback when a model goes down. |
| **Vault** | Add, mask, test, and rotate your provider keys. Encrypted at rest in your browser — see [SECURITY.md](SECURITY.md). |
| **Coding mode** | Generates a multi-file project, verifies it statically, boots the backend, and feeds the failures back to the model for repair. Live preview in a sandboxed iframe. |
| **Agent tools** | 9 real tools the model can call: web search, deep research, Gmail read/send, Calendar list/create, model recommend/compare, and document assist. |

Providers: OpenRouter, NVIDIA NIM, Groq, HuggingFace, Google AI Studio,
Pollinations, LLM7, Puter, Cloudflare Workers AI.

---

## Run it

Requires Node 20+.

```bash
git clone <your-fork-url> enzo && cd enzo
npm install
cp .env.example .env
npm start
```

The backend listens on `http://localhost:5001`. Then, in a second terminal:

```bash
cd synthetic-nature && npm install && npm run dev
```

The app is at `http://localhost:5173`. `/api` is proxied to the backend, so
nothing else needs configuring.

There is **no build step for the backend** — `npm start` is `tsx index.ts`.

### Which mode am I in?

ENZO runs two ways, and the difference is one environment variable.

**Hosted / BYOK** — leave `ENZO_MASTER_KEY` empty. The server holds no keys and
stores nothing. Every visitor supplies their own keys through the Vault UI; they
are encrypted in that browser and sent with each request. The server-side vault
writer, memory, skills, and the OpenAI-compatible tunnel all refuse to run,
which is exactly right when the server is not supposed to be trusted. **This is
the correct setup for a public deployment.**

**Self-hosted (single operator)** — set `ENZO_MASTER_KEY` to a strong random
string and put your provider keys in `.env`. Now the vault UI can write back to
`.env`, memory and skills persist server-side, and the tunnel works.

Everything in `.env.example` is optional. The server boots with zero keys — it
just can't reach any paid provider until you add one.

### Optional integrations

| To enable | Set |
|---|---|
| Google sign-in | `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FRONTEND_ORIGIN` |
| Gmail + Calendar tools | the Google vars above, plus `GMAIL_REDIRECT_URI` |
| One-click HuggingFace connect | `HF_CLIENT_SECRET` here, `VITE_HF_CLIENT_ID` in `synthetic-nature/.env` |
| Cloudflare token grant | `CLOUDFLARE_OAUTH_CLIENT_ID`, `CLOUDFLARE_OAUTH_CLIENT_SECRET` |

Each is genuinely optional: skip Google sign-in and the auth routes return `503`
rather than issuing a forgeable token; skip the HF OAuth app and users paste a
token instead, which works fine.

---

## Repo map

```
/                        backend — Express 5, run directly by tsx
  index.ts               the app. Start here; its header is a navigation map
  src/agent/             agent-tools (the 9 model tools), search, research-engine,
                         crypto-store (AES-256-GCM for token files at rest)
  src/core/              build-verify (does the generated project run?), memory,
                         env-manager (the only module that rewrites .env), preview
  src/features/          tunnel (OpenAI-compatible /api/v1), featureRoutes
                         (Google OAuth handshake for Gmail/Calendar), ui-ux-search, unsplash
  src/models/            model-sync (the catalog), model-info, health, throttle
                         (liveness probes + per-provider pacing and budgets)
  src/projects/          project (multi-file project host), project-runtime
                         (spawns it, with an explicit env allowlist)
  src/skills/            skills a user taught this install (gitignored data) +
                         bundled-skills (~67 specialist SKILL.md files that ship)
  scripts/               pentest.sh, check-tracked-imports.mjs, ci-runner.sh

synthetic-nature/        frontend — Vite + React 18, strict TypeScript
  src/App.tsx            view routing, header, homepage composition
  src/components/        TerminalSection (the terminal), OnboardingView, homepage
  src/content/docs.ts    the in-product documentation, one typed source
  src/lib/keyVault.ts    AES-256-GCM key storage. Every key read goes through it
  src/features/gesture/  quarantined, unwired, not shipping — see its README
  src/themes/            three themes; the rail in the header switches them
```

Two files are much longer than the rest — `index.ts` (~6.1k lines) and
`TerminalSection.tsx` (~4.9k). Both are navigable by searching their section
banners. Splitting them is the next structural step, recorded in
[PROJECT_REPORT.md](PROJECT_REPORT.md) §7; it was deliberately not
done in the same pass as the security work, because they are the highest-traffic
files in the project.

---

## Checks

```bash
npm run typecheck      # backend — must be clean
npm test               # agent-tools, project-fix, project-idor, the two AES
                       # round-trips (crypto-store server-side, keyVault
                       # in-browser), modelPeer, and model-sync
npm run check:imports  # every relative import resolves to a *tracked* file
npm run pentest        # black-box checks against a running server (10 checks)
npm run ci             # everything above, as CI runs it
```

```bash
cd synthetic-nature && npx tsc --noEmit && npx vite build
```

`check:imports` exists because this repo once had 13 modules that `index.ts`
imported and git did not track — a fresh clone could not boot. `tsx` resolves
imports at runtime, so nothing but that guard catches it before deploy.

---

## Docs

- **In the product:** the **Docs** tab on the homepage — how to use ENZO, in
  plain language, for both users and developers. Source:
  `synthetic-nature/src/content/docs.ts`. It deliberately carries **no
  clone-and-run or local-setup instructions** — those live here, in a repo file,
  because the source is not published and the in-product docs are read by people
  who cannot act on them. Keep it that way when editing.
- [SECURITY.md](SECURITY.md) — threat model: what's encrypted, what isn't, and
  what the sandbox does and does not stop.
- [AGENTS.md](AGENTS.md) — conventions and gotchas for anyone (human or agent)
  editing this repo.
- [PROJECT_REPORT.md](PROJECT_REPORT.md) — architecture, current
  status, known limitations, technical debt.
- [GUIDEBOOK.md](GUIDEBOOK.md) — driving OpenCode on this repo.
- [CHANGELOG.md](CHANGELOG.md) — dated history.

## Contributing

Read [AGENTS.md](AGENTS.md) first — it records the conventions and the traps.
The short version: `npm run ci` must pass, provider keys never get hardcoded, and
if you touch a `enzo.keys.*` value in the frontend it goes through
`keyVault.ts` or the build fails on purpose.
