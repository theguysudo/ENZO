# ENZO — Knowledge Transfer

Last updated: 2026-11-11 · Release: v1.6.0 · Repo: `github.com/theguysudo/ENZO` (Apache-2.0)

This document hands over everything a new maintainer needs: how the code is organized, how releases go out, what is currently uncommitted, how to run and debug it, and what is still open. It is a working document — keep it in the repo root or delete it before a public release if you don't want it shipped.

---

## 1. What ENZO is

ENZO is a self-hosted, bring-your-own-key (BYOK) AI workspace. One Node process serves both the API and a built React frontend on port 5001. The user plugs in their own provider keys (Groq, OpenRouter, NVIDIA NIM, Google AI Studio, HuggingFace, Cloudflare, Exa), and ENZO gives them: chat with memory, a custom agent builder (agents that draft, save and run), an in-chat file converter (PDF/Excel/CSV), a music player with a real equalizer, a coding preview (it writes a project, boots it, and previews it live), and — newest, uncommitted — an evidence-backed investigation workspace and a private preference layer.

Everything runs on free tiers by design: no server-side model spend, no paid APIs, keys never leave the operator's browser unencrypted. That privacy/BYOK pitch is the project's identity — don't break it for convenience.

## 2. Repository topology and the release flow

| Path | What it is |
|---|---|
| `/Users/aditya/backend` | Local checkout **= the PUBLIC repo's history** (theguysudo/ENZO) since the v1.4.0 restructure (2026-09-17) |
| `index.ts` | The entire backend: one Express 5 file (~6,900 lines) run by `tsx`. Feature modules live in `src/` and mount routers into it |
| `synthetic-nature/` | The frontend: React 18.3 + Vite 6 + Tailwind 3. Main app shell is `src/App.tsx` (tab union + nav + content switch) |
| `src/intelligence/`, `src/neural-engine/` | The two newest modules — **uncommitted** (see §6) |
| `tests/` | Offline test suites, wired into `npm test` |
| `docs/CHANGELOG.md` | The project changelog (dated sections, narrative format) |
| `scripts/traffic-render.py` + `traffic/` | The hourly traffic snapshot that feeds the README badges |

**Release flow = `git push origin main`.** There is no separate release script anymore; the tag/release/ghcr build all hang off the push (CI builds `lite` and `full` images to ghcr). The old `make-docker-release.sh` flow and the private `enzo-beta` sync are retired. `enzo-beta` (private, github.com/theguysudo/Enzo_Beta) is **frozen** at a95d966 — it only hosts campaign/tracker docs; update it via `git worktree add /tmp/wt enzo-beta/main` + `git push enzo-beta HEAD:main` (a plain `git push enzo-beta main` from a detached worktree resolves to the wrong repo).

**Branch protection (as of 2026-10-22):** the only active rule is a ruleset "Rule 1" that blocks branch deletion and force-pushes. The classic PR-requirement protection that briefly broke the traffic bot (§8) was removed. Direct pushes to `main` work.

**Git identities:** the active `gh` auth token is theguysudo's and lacks the `workflow` scope — pushing workflow-file changes needs the `ADITYADUBEY2023` keyring entry (which holds a theguysudo token WITH repo+workflow scopes).

## 3. Runtime architecture

- **Backend**: Express 5 on tsx, port from `PORT` (5001 in docker). Serves `synthetic-nature/dist` statically — one origin, no CORS. Health endpoint: `/api/health` (not `/api/v1/health`).
- **Persistence**: JSON files with atomic tmp+rename writes. Agent memory → `/app/data/memory-store.json` (docker volume). Investigations → `src/intelligence/data/`, neural profile → `src/neural-engine/data/owners/`. There is **no core database**; `better-sqlite3` appears only in prompt text for *generated* projects (pinned `^13.0.3` — v11 cannot compile on Node 26).
- **Auth/BYOK model**: provider keys are sealed client-side (AES-256-GCM vault in the browser) and attached **per request** — resolution order: `x-groq-key`/`x-exa-key` headers → `providerKeys` body → `process.env` fallback. A vault token (instance-wide HMAC per time window) authorizes management routes; **device ownership** (`x-enzo-owner` header, a random per-browser device id) isolates projects, investigations and neural profiles per device (added in the v1.6.0 audit remediation).
- **Streaming contract**: long operations (agent runs, investigations) stream over SSE with **named events** (`phase`, `step`, `done`, `error`); the frontend reads with fetch + reader + frame-parse (see `AgentsSection.tsx` / `IntelligenceSection.tsx`).
- **Model chain** (live-verified 2026-10-20): `openai/gpt-oss-20b` (JSON mode) → `openai/gpt-oss-120b` → `qwen/qwen3.8-27b` (plain + regex extraction). Note: `qwen3.6-27b` is **delisted** from Groq and `research-engine.ts` still references it — known rot, flagged, not yet fixed.
- **Rate limits**: every sensitive route goes through the per-IP limiter (`src/core/rate-limit.ts`); Groq free-tier RPM budget makes occasional `retry` events in SSE streams normal, not bugs.

## 4. Shipped feature map (one line each)

| Feature | Where |
|---|---|
| Custom Agent Builder (race drafter, neural layer, run engine) | `src/agents.ts`, `AgentsSection.tsx` |
| File converter (PDF text-layer + table heuristic → CSV/Excel) | `src/intelligence/../fileConvert.ts` (terminal feature), `TerminalSection.tsx` |
| Music player + 5-band Web Audio EQ | `musicEq.ts`, `useEnhancedEngine`, `/api/music-stream/:id/audio` relay |
| Voice mode (Gemini Live speech-to-speech) — uncommitted | see `enzo-voice-mode` notes |
| BYO Gmail OAuth client (docker onboarding step 6) | onboarding + `.env` healing, consent URL heals without restart |
| Preview panel (generated-project live preview, sandboxed) | `PreviewPanel.tsx`, `src/projects/project-runtime.ts` (`node --permission` sandbox) |
| Marketplace + workspace themes (23 videos full / 1 lite) | `public/background_elements/`, `THEME_VARIANT` build arg |
| Liquid-glass UI system (SmokeNav shader, SystemPulse ECG, LiquidTick, weather widget) | components of the same names |
| Update banner + one-time star ask | `UpdateBanner.tsx`, `__ENZO_VERSION__` define from root `package.json` |

## 5. Docker runbook

- **One image, two variants**, chosen at build: `--build-arg THEME_VARIANT=lite` (default; ships only the 3.3MB NYC subway loop) or `full` (all 23 theme videos). Login is key-onboarding in both (`ENZO_GOOGLE_AUTH=0`).
- `docker-entrypoint.sh` **auto-heals dependencies on every start** (`ENZO_AUTO_INSTALL=0` to skip; the `npm ci --include=dev` at bake time is load-bearing — tsx and typescript are devDependencies).
- Container runs as the unprivileged `node` user; **every writable path must be node-owned from the image** (learned the hard way: Docker-created volume mountpoints come up root-owned → EACCES on first write; the Dockerfile `RUN mkdir -p` layer pre-creates them).
- **Volumes that matter** (state wiped on rebuild if not mounted):

| Volume | Container path |
|---|---|
| `enzo-dev-memory` | `/app/data` (memory-store, vault-boot.json, vault-keys.json) |
| `enzo-dev-projects` | `/app/generated-projects` |
| `enzo-dev-skills` | `/app/src/skills/skills` |
| `enzo-dev-intelligence` | `/app/src/intelligence/data` |
| `enzo-dev-neural` | `/app/src/neural-engine/data` |

- **Local test container recipe** (image `enzo:dev-test`, built from the working tree):

```bash
docker build -t enzo:dev-test /Users/aditya/backend
docker run -d --name enzo-dev-test -p 5001:5001 \
  --env-file /Users/aditya/backend/.env \
  -v enzo-dev-projects:/app/generated-projects \
  -v enzo-dev-skills:/app/src/skills/skills \
  -v enzo-dev-memory:/app/data \
  -v enzo-dev-intelligence:/app/src/intelligence/data \
  -v enzo-dev-neural:/app/src/neural-engine/data \
  --restart unless-stopped enzo:dev-test
```

`--env-file .env` makes the container "born claimed" (operator keys pre-loaded). Health check uses node's fetch (the slim image has no curl). If a rebuilt container can't write, check ownership of the mountpoint first (`docker exec -u root <c> ls -ln <path>`), not the app.

## 6. Uncommitted work in the tree (the current batch)

Everything below is built, tested, and deployed to the local test container — **awaiting his review/approval before any commit/push** (standing rule: never push without his explicit OK).

### 6a. ENZO Intelligence (investigation workspace)

`src/intelligence/` — `types.ts`, `store.ts` (index.json + `inv-<id>.json`, caps 400 evidence / 10 runs), `fetcher.ts` (strictest SSRF guard in the repo: DNS recheck per redirect hop, default ports only, 400 KB / 15 s, metadata endpoints blocked), `llm.ts` (`askJson` + `askText` + UNTRUSTED rule — scraped page content is data, never instructions), `connectors.ts` (Exa web search, website fetch, GitHub REST, Wikipedia, user documents), `orchestrator.ts` (plan → discover → extract → resolve → verify → report → diff; budgets enforced by code; every claim's quote is machine-verified verbatim against its source), `router.ts` (CRUD + SSE run + cancel + analyst; vault-token auth; `intel-*` rate-limit buckets; device ownership bound at create).

Pipeline verified live with real keys: 27-claim ledger, a paraphrased quote flagged by verification, discrepancies surfaced not smoothed over, honest "not in sources" gaps in the report, ledger-only analyst answers, correct run-to-run diff. UI: `IntelligenceSection.tsx` (~1000 lines; tabs Brief | Graph | Evidence | Runs | Report | Analyst; clickable [E#] chips; markdown download). Known-good UX: dedicated **Run planning** / **Run investigation** buttons in the Brief panel; a lost SSE stream self-heals (panel resets from server-side run state).

### 6b. Neural Engine, phases 0–4 (private preference layer)

`src/neural-engine/` — per-device-owner store (`owners/<ownerId>.json`), 8 preference dimensions with provenance (task-override > user-explicit > inferred, inference needs ≥2 samples), typed node/edge graph + append-only event history, `/forget` endpoint, preference context (≤1400 chars) injected into the chat path after memory (`ENZO_NEURAL_OVERLAY=0` disables), provider capability registry with **ZERO_COST_MODE default ON, fail-closed** (governs neural routing only — chat model selection stays BYOK). Phase 5 (dataset builder / anything training-adjacent) is explicitly gated on his review.

### 6c. Frontend graph stack — the reagraph verdict

The Neural Map's default renderer is a hand-rolled **SVG force graph** (`IntelligenceGraph.tsx`); reagraph WebGL is a lazy "WebGL beta" toggle (`NeuralMapGraphCanvas.tsx`). The reagraph path is pinned: **reagraph 4.22.0 + @react-three/fiber exactly 8.13.5 (package.json overrides) + three ^0.161.0** — 4.32 needs React 19/fiber 9 (dual-fiber = silent blank render), and glodrei needs three < r162. Proven broken on this stack, do not retry: `node.icon` sprites never render; d3 `forceDirected2d` positions dead/unstable; centrality sizing starves leaves. The pin exists to be dropped the day the app moves to React 19. Dev servers to know about: container/backend on **:5001**, optional vite dev on **:5200** (needs `VITE_BACKEND_ORIGIN=http://localhost:5001`), temp graph harness on **:5233**.

### 6d. Everything else in the batch

Dockerfile (pre-created node-owned data dirs), `.gitignore`/`.dockerignore` (intelligence/neural data + harness), local fonts (`public/fonts/space-grotesk-500.ttf` — troika must not CDN-fetch), tests (`tests/intelligence.test.ts` 51 checks, `tests/neural-engine.test.ts` 59 checks; full `npm test` = 12 suites, exit 0), CHANGELOG entry (prepared 2026-11-11 in `docs/CHANGELOG.md` as "Unreleased").

**Stray files to clean before committing:** `synthetic-nature/graph-smoke.html` + `src/graph-smoke-entry.tsx` (temp harness — delete once he approves the graph design; the :5233 vite can be killed then too), `Subway_…_gwr_video_mvp.mp4` (15MB raw source at repo root), `synthetic-nature/mlx-trace.json`, `synthetic-nature/vite.config.js` + `.d.ts` (verify intentional), `modelcover/`, `promo.png` (promo.png is used by the desktop icon step — keep it in the repo), plus desktop build artifacts (`desktop/dist/`, `desktop/windows/staged/`) which are gitignored.

### 6f. Desktop self-update (one click, twice a week, never forced)

`src/desktop/update.ts` + `src/desktop/router.ts`, mounted at `/api/desktop` in index.ts. The backend checks the latest GitHub release (every 6h at most), compares semver, and picks the platform asset (`…-macOS-arm64.dmg` / `…-setup.exe`). The reminder is throttled to **two prompts per rolling week** via `<data>/update-state.json` — dismissing keeps the current version, nothing is forced. "Update now" downloads the asset, mounts it (macOS) or runs it silently (Windows), stages the new bundle, and hands the swap to a **detached helper** (the server must exit for its own bundle to be replaced): the helper waits for that exact server PID, moves the old bundle aside, moves the new one in, clears `com.apple.quarantine`, re-signs ad hoc and relaunches. All writable state lives outside the bundle (`~/Library/Application Support/ENZO` / `%APPDATA%\ENZO`), so memory, vault keys, investigations, neural state and generated projects survive; the browser tab survives too (localStorage) and just reconnects. Routes are **loopback-only**, need **no vault token** (a fresh install must hear about updates before any key is claimed) and exist only when the launcher set `ENZO_DESKTOP_HOME` — docker/hosted expose nothing. Test hooks for rehearsals: `ENZO_RELEASE_API` (alternate release feed), `ENZO_UPDATE_TARGET` (swap destination), `ENZO_UPDATE_REOPEN=0` (skip relaunch). Offline suite: `tests/desktop-update.test.ts` (26 checks). Frontend: `UpdateBanner.tsx` gained the one-click Update / Later buttons, a progress bar and the "restarting" state, with the old docker "pull the new image" notice kept as the fallback.

### 6e. Desktop one-click installers (the no-docker/no-git path)
`desktop/` — a fully self-contained macOS `.dmg` (built + live-tested: `desktop/dist/ENZO-1.6.0-macOS-arm64.dmg`, 171 MB) and a Windows NSIS `.exe` (scripted; builds on a CI runner via `desktop-release.yml` — pushing that workflow file needs the ADITYADUBEY2023 token). **The desktop build IS the docker variant**: frontend built with `VITE_GOOGLE_AUTH=0` + `VITE_THEME_VARIANT=lite` (Google OAuth dead-code-eliminated, trimmed theme registry) and backend run with `ENZO_GOOGLE_AUTH=0`; it serves on **port 5200**. Bundle = pinned Node 22 runtime + backend tree (production deps, tsx; typescript/@types stripped) + built frontend with the LITE theme filter + `launcher.js` (data-dir redirection to `~/Library/Application Support/ENZO` / `%APPDATA%\ENZO` via the new `ENZO_MEMORY_PATH` / `ENZO_PROJECTS_DIR` / existing dir envs; `NODE_ENV=production` is mandatory or `/` 404s; port fallback 5200→5220 driven by the server's own `listening on` stdout marker — never trust cross-process port/health probes, another service answers those). Quit works because `macos/main.swift` (compiled Swift AppKit shell) is the .app's real executable — bash/node wrappers cannot answer the Dock's quit AppleEvent. App icon = the **EZ monogram** (the project's main logo) on a white rounded square — the same artwork as the website's apple-touch-icon — from the committed master `desktop/assets/enzo-icon-1024.png`; the Windows installer uses `favicon.ico` (NSIS MUI_ICON). The website favicon set (`favicon.ico`, `favicon-16x16/32x32/48/180.png`) was regenerated from the EZ mark — browsers prefer `.ico`, so the tab icon is EZ too; the old heritage crest is preserved as `synthetic-nature/public/brand-crest.png`. Verified live: port 5200, workspace opens with no Google login anywhere, clean AppleEvent quit from the /Applications-installed copy. Trade-offs (no code-signing cert, no auto-updater, generated projects needing better-sqlite3 still want a C toolchain) are documented in `desktop/README.md`.



## 7. Testing and verification discipline

- `npm test` at the repo root runs the whole offline chain (12 suites). Frontend type-check: `tsc` in `synthetic-nature/`. Both were green on this batch.
- After any `npm install` in the frontend, **delete `node_modules/.vite` and restart vite** before smoke-testing — stale pre-bundled deps produce phantom failures.
- CI (`ci.yml`) runs 7 checks — Security Checks, Frontend build, Dependency Audit, Backend check, Repo Hygiene, Security Pentest (black box), Pipeline Summary. "Repo Hygiene" will flag stray files, so clean §6d before pushing.
- Live-SSE features are best verified through a real run, not mocks; the browser automation notes (stale screenshots, DOM-attribute verification) live in the assistant's memory file `zcode-browser-use-recipes`.

## 8. Ops incidents worth knowing (post-mortems in one line)

- **Traffic CI red Oct 20–22, 2026 (~30 runs):** branch protection with "require PR + 7 required checks" blocked the bot's GITHUB_TOKEN push. Fast-fail (12–16s) *after* a successful local commit = a push-side rejection, not a script bug. Fix: classic protection deleted, "Rule 1" kept; a `workflow_dispatch` catch-up run landed the backlog (commit 710e0e1). The 14-day-window "total" badge bug (badge values shrinking as the window slid) was fixed earlier via `traffic/history.json` — totals are a persistent per-day sum; uniques stay honestly windowed.
- **Docker data wipes / EACCES:** unmounted runtime dirs are wiped by rebuilds; Docker-created mountpoints come up root-owned. Both are now structurally fixed (volumes + Dockerfile mkdir), but any NEW runtime-writable dir must be added to the Dockerfile `mkdir` layer and volume-mounted on day one.
- **Music 404s (2026-09-15):** stale ports, not API rot — docker-variant containers held old images; `ps eww <pid> | tr ' ' '\n' | grep VITE` tells you what a running vite is pointed at.
- **"Workflow stalled" misreads:** check `gh run list` + `git fetch` before declaring a pipeline dead — the local clone was 25 commits behind origin once.

## 9. Open items / deferred work

1. **His browser review** of Intelligence + Neural Engine on the test container (http://localhost:5001) — the gate for the release.
2. On approval: version bump, retitle the CHANGELOG "Unreleased" section, `docs.ts` feature sections, commit the batch (minus §6d strays), `git push origin main`.
3. Deferred: `research-engine.ts` qwen3.6-27b rot fix; PDF document parsing through fileConvert for intelligence document sources; scheduled investigation auto-refresh; chat-inline feedback buttons; Phase 5 dataset builder (gated); delete the graph smoke harness + :5233 vite.
4. **Keys/security:** the NVIDIA NIM key lives at `~/.enzo-keys/nvidia-nim-key.txt` (0600, outside the repo) — it passed through chat once, so rotate if transcripts are ever shared. `domSnapshot` in browser automation leaks password values; the vault's casual-SAVE-wipes-keys bug (ROOT 5) has a recipe in memory. Secret-scan before every push is standing practice.
5. First external PR **#15** (OpenAI-compatible endpoint, @haterfactory) awaits security review.

## 10. Growth context (affects roadmap visibility)

All-time (2026-10-22): **115★ / 2,605 clones / 3,342 views / 146 docker pulls** — roughly triple the mid-September numbers. Empirical rule learned from the traffic history: stars move only on external-audience events (Reddit post, awesome-list merges like alvinreal 4.7k★), never from releases alone. Live channels: 4 awesome-list merges, ~15 open PRs (e2b #1519 CLA-green is the best bet; age-gated lists unlock Dec 2026–Jan 2027), outreach kit at `~/enzo-outreach-kit` (note: his egress IP is Spamhaus-listed — direct cold mail from this machine won't deliver). r/docker modmail is parked until Dec 2026. HN: the Show HN account is flagged — the fast path is a technical article on one owned subsystem, in his words, as a normal link post. Hard line: no fake engagement of any kind (bots, rings, star-buying) — declined before, will be declined again.

---

*Sources for this document: the repo itself, `docs/CHANGELOG.md`, the TRAFFIC.md history, and the assistant's session memory (files under `~/.zcode/cli/memories/projects/backend-677ce09bfb8d2ebf/memory/`, index `MEMORY.md`).*
