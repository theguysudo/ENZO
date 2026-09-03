# ENZO Backend — OpenCode Agent Guide

This file is read by [OpenCode](https://opencode.ai) when working in this repository. It describes project structure, conventions, and safe change patterns.

## ⚠️ Standing rule: always verify in the browser preview

When doing **any** frontend/dev work in this project, you MUST use the browser preview to see and build — never just type-check, lint, or reason about the code. This is a non-negotiable standing rule ("always use browser preview to see and build").

- After **every** frontend edit (layout, positioning, styling, component behavior), start/refresh the dev server, open the browser pane, reload, and **visually confirm** the change is observable and correct (screenshot / inspect / snapshot).
- If the sandbox blocks a port or preview, **surface that explicitly** rather than declaring done blind.
- The frontend is `synthetic-nature/` (Vite dev server, typically port 5173/5174).

## Project summary

**ENZO** is a local DedSec-themed AI web app: Express/TypeScript backend + React/Vite frontend (`synthetic-nature/`). It routes chat across **nine providers** (OpenRouter, Groq, HuggingFace, NVIDIA NIM, Pollinations, LLM7, Google Gemini, Puter, Cloudflare Workers AI), image generation to **Pollinations**, web search to **DuckDuckGo** (plus **Exa** when `EXA_API_KEY` is set), and meme roasts to **Groq**. BYOK: users' provider keys live in an encrypted browser vault and are released per-request — the server also boots and runs fully keyless.

- **Entry point:** `index.ts` (port **5001** by default)
- **Main UI:** `synthetic-nature/` (Vite dev server at **http://localhost:5173**)
- **Run:** Backend: `npm start` → `tsx index.ts` | Frontend: `cd synthetic-nature && npm run dev`
- **URL:** http://localhost:5173

## Architecture

```
backend/
├── index.ts              # Express server, all API routes, model routing (~6.1k lines)
├── src/
│   ├── agent/            # agent-tools (tool loop), crypto-store (vault crypto), research-engine, search
│   ├── core/             # build-verify, env-manager, memory, preview (live HTML preview host)
│   ├── features/         # tunnel (AI Tunnel /api/v1 + model catalog), ui-ux-search, unsplash
│   ├── models/           # model-sync (multi-provider discovery, 6h sync), throttle, health, model-info
│   ├── projects/         # project (on-disk multi-file host, /api/project/*), project-runtime (spawns Node per project)
│   └── skills/           # skills + bundled-skills
└── synthetic-nature/     # React/Vite frontend (port 5173)
```

> Note: `search.ts` (DuckDuckGo), `model-sync.ts`, `throttle.ts`, `memory.ts`, `health.ts`, `preview.ts`, `project.ts`, `tunnel.ts`, etc. that older docs place at the repo root now live under `src/agent|core|features|models|projects/` (v2.0 reorg). There is no `public/` folder.

## Model catalog scrapers (`model-sync.ts`)

Each provider's catalog is scraped from its **authoritative** list — the exact endpoint the tunnel routes to — so cards only show models that actually exist:

| Provider | Scraper source | Notes |
|----------|----------------|-------|
| OpenRouter | `openrouter.ai/api/v1/models` | 395 live models, no key needed |
| Groq | `api.groq.com/openai/v1/models` | Uses server `GROQ_API_KEY` (or the user's vault key); names/descriptions enriched via `GROQ_META` since the API is sparse; count follows Groq's live list |
| NVIDIA | `build.nvidia.com/models` HTML scrape (primary) + `api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT` pagination (completes the list) + `integrate.api.nvidia.com/v1/models` live fetch when a key exists | **Reachability-verified** per key (see below); `models.md` scrape kept as fallback only if the page scrape returns nothing |

**Do NOT** trust NVIDIA's `/v1/models` list wholesale — it lists models that 404 at chat time ("Function not found for account"). `verifyNvidiaCatalog` in `model-sync.ts` chat-pings each model (1-token, 8s timeout, concurrency 5, **paced via `acquireProvider('nvidia')`**, cached in `nvidia-verified.json` 24h) and only keeps callable ids; ids are then prefixed `nvidia/<rawId>` so `resolveModelRoute` strips exactly one prefix and posts the raw org/model id to NIM. A real-key probe on this account dropped 61/102 phantoms. Note NVIDIA NIM free tier is **40 RPM** — chat pacing, health gaps, and the verifier all honor it (1600ms).

The build-page scraper (`scrapeBuildNvidiaModels` in `model-sync.ts`) parses the NGC catalog records embedded in `build.nvidia.com/models` HTML (`extractEmbeddedRecords`, ~24 first-page records) then pages the page's own catalog API (`api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT`, anonymous, ~128 total) to cover the rest. Records carry authoritative `publisher` labels and `AVAILABLE` flags; `ngcRecordToModel` converts them to catalog entries, mapping catalog underscores to NIM dots (`llama-3_1-70b-instruct` → `meta/llama-3.1-70b-instruct`) and dropping non-deployable records. When a key exists the live `/v1/models` fetch still wins (it's the exact set the key can reach); the scrape is the no-key default and supplies rich metadata for matching.
| HuggingFace | `router.huggingface.co/v1/models` (the **auto-router**, same endpoint the tunnel posts chat to) | Filters to `providers[].status === 'live'`; marks paid vs free; image-gen from curated known-good list |
| Pollinations | `gen.pollinations.ai/models` (categorized catalog) + curated free image models | Emits aliases (e.g. `minimax-m3` → `minimax`) so prefixed IDs resolve; drops dead models like `kontext` |
| LLM7 | `api.llm7.io/v1/models` (the exact OpenAI-compatible gateway the tunnel posts to; catalog listing is keyless) | Free = `usage_based_only === false` (NEVER a $0 price compare); chat-only + OpenAI-schema models only (video/image dropped); **identity-verified** — `verifyLlm7Catalog` (model-sync.ts) self-ID-probes each **free** chat model with the key and drops ids the gateway silently replaces (the gateway accepts any requested id but serves a rotating shared model for undeployed ones — keyed `codestral-latest` answers "llama-3-70b-8192"). Results cached in `llm7-verified.json` (gitignored, 24h). Paid models are preserved untouched (probing them bills the user). **Chat requires `LLM7_API_KEY`** — no anonymous tier |
| Google | `generativelanguage.googleapis.com/v1beta/openai/models` (the OpenAI-compat endpoint the tunnel posts chat to) | **Keyed only** — keyless listing 404s, so the catalog is enriched only when a `GEMINI_API_KEY` exists (i.e. exactly when models are usable). Parses `data[]`, drops embedding/image ids, marks `free` from the id (flash-family minus Pro — Pro is billing-required since early 2026), type `multimodal` for `gemini*`. Free tier ~5–15 RPM / 250K TPM / up to ~1,500 RPD per **project** (RPD resets midnight PT) |
| Puter | `api.puter.com/puterai/chat/models/details` (Puter's own keyless model catalog — what `puter.ai.listModels()` reads; the flat `/models` string list carries no cost/context info) | `fetchPuterModels` parses the rich entries: `puterModelSlug()` strips the provider prefix (`alibaba:qwen/qwen3-32b` → `qwen3-32b`, `infron:deepseek/deepseek-v4-flash:free` → `deepseek-v4-flash:free`) so chat uses the bare OpenAI slug; fills `context_length`/`max_output` and real names from the entry; `free` is set **only when per-1M input+output cost is 0** (~31 of ~575 models) — paid models show real per-1M pricing and `free: false`; drops `responses_api_only` + image/audio-gen ids. **User-pays gateway** — every chat call bills the END USER's Puter account (`PUTER_AUTH_TOKEN` from puter.com/dashboard, free monthly credits first). Note: even listed-free models can 402 `subscription_required` if the account lacks the entitlement — the catalog reflects LISTED cost, not account access |
| Cloudflare | `api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/models/search` (Workers AI catalog, **keyed only** — keyless returns `[]`, google pattern) | `fetchCloudflareModels` takes the token + account id (`CLOUDFLARE_ACCOUNT_ID`; auto-discovered from the token via `resolveCloudflareAccountId` when absent) and only keeps chat-capable entries. **The live `search` shape differs from the docs mirror**: the chat-verbatim id lives in `name` (`@cf/meta/llama-3.2-3b-instruct`; `id` is an opaque UUID) and `task` is an **object** whose `.name` ("text generation", "text embeddings", …) is the filter signal — entries with a chat-capable task (`text generation`, image-to-text/vision) are kept, everything else (embeddings, image-gen, ASR, TTS, translation, classification, dumb-pipe) dropped. No `context_length`/`max_output`/`capabilities`/`tier` on the real endpoint (that was a mirror-only shape), so ctx is 0 (backfilled by OR slug match for well-known models like deepseek-v4, ctx 1M) and names come from the slug. ids emitted `cloudflare/@cf/…` — but the catalog marks plan-gated models with a `require_workers_paid` property (`moonshotai/kimi-*`, `deepseek-ai/deepseek-v4-*`): on first sync ENZO probes **one** paid-only id per account (max_tokens=1, 8s timeout, paced via `acquireProvider('cloudflare')`) and caches the account's plan tier in `cloudflare-plan-tier.json` 24h. **Free-plan accounts have paid-only models dropped from the marketplace entirely** (they 403 "not available on the Workers Free plan" at chat); paid-plan accounts keep them but flagged `free:false` with real per-1M `properties.price` pricing. `free:true` (neuron bucket) is only set for genuinely free-tier models. (`resolveModelRoute` strips just one `cloudflare/` prefix). A dead/expired token 401s the first catalog fetch → lazy `refreshCloudflareAccessToken()` (OAuth refresh token) then retry |

**Do NOT** source HF from the Hub `inference=warm` filter — it reflects the in-browser widget, not the router, and produced 82 phantom models that 400'd/401'd at chat time. HF router `/v1/models` is free (no auth needed) and carries live provider status.

### Sync-time catalog hygiene (`syncModels` in `model-sync.ts`)

After merging all 9 provider fetches, `syncModels` applies three safety/enrichment passes so the catalog stays current and readable:

- **Prune decommissioned models**: health-marked `offline` + `unsupported`/`model_not_found` (a real chat ping returning 400/404/422/406 — e.g. deprecated `google/models/gemini-2.5-flash`, which Google still lists in `/models` but 404s at chat) are dropped each refresh. Guards: probe freshness ≤36h (matches Google's ~1 probe/model/day cadence under its 50/day budget) and provider unsupported-share <95% of online+unsupported (a transient provider-wide 400 flood is not independent decommissions). Re-opened models get re-added automatically after the next online health pass.
- **Provider-failure retention**: a failed fetch falls back to that provider's last-known-good models from the previous cache instead of wiping the whole provider for 6h.
- **Cross-provider enrichment**: Google exposes no context/max-output and its names are id-derived (and Puter's `details` catalog covers most of it); `syncModels` fills `context_length`/`max_output` and upgrades machine names (`puter/nova-2-lite-v1` → "Amazon: Nova 2 Lite", ctx 1M) from OpenRouter's catalog matched by trailing base-model slug — but only fills when the field is still 0/empty, so Puter's native values win. Google ids additionally get curated names/context from the `GOOGLE_META` table (`googleName` strips the `models/` prefix).

### Model classification (`inferTags` in `model-sync.ts`)

Every `CatalogModel` carries a `tags` array that the marketplace renders as color pills and the Task filter keys on (`Reasoning | Coding | Creative | Vision | General Chat | Image Gen`, plus informational `Fast` / `Multilingual` / `Uncensored` / `New`). Classification is **id-family first**, description last — display names lie (a "Codestral 25.08" card must be `Coding` no matter how OpenRouter labels it). The `FAMILY_TAG_RULES` knowledge base maps regexes over the **bare provider model id** (e.g. `deepseek-r1`, `qwen3-coder`, `minimax-m2`, `gpt-oss:20b`, `compound`, `glm-4.7`, `kimi-k2`, `o3`) to their true task; every `inferTags(...)` call site passes the real raw id as the first argument (OpenRouter/Groq/HF/NVIDIA pass `m.id`, LLM7/Google/Puter/Cloudflare pass their decoded `rawId`, pollinations passes the catalog slug). Fallbacks: `type === 'multimodal'` implies `Vision`, image-capable ids imply `Image Gen`, and only models with **zero** task matches get the generic `General Chat` bucket.

## Provider throttling (`throttle.ts`)

Protects chat requests and the health monitor from ever hitting provider rate limits:

- **Pacing**: `acquireProvider(provider)` spaces out requests per provider (`openrouter` 1.5s, `nvidia` 1.6s, `groq` 1s, `pollinations` 0.6s, `hf` 0.8s, `llm7` 2s, `google` 2s, `puter` 2s, `cloudflare` 2s). Called before every chat/tunnel request in `index.ts`. Env override `ENZO_THROTTLE_PACING_<PROV>_MS`.
- **Cooldowns**: `markProviderCooldown(provider, ms)` parks a provider for a while after 429/402/401 (OpenRouter honors `Retry-After` up to 300s). The chat attempt loop skips cooled-down providers with a `[SYSTEM: ... cooling down ...]` notice. `isProviderCooledDown` also gates the smart-fallback picker. Env override `ENZO_THROTTLE_COOLDOWN_<PROV>_MS`; remaining wait readable via `providerCooldownMs(provider)`.
- **Auto-retry after rate-limit** (`recoverableResumeWaitMs` + the resume loop wrapped around the `/api/chat` attempt loop in `index.ts`): a mid-build rate-limit is no longer a hard fail. When every fallback route exhausts because a provider is parked (the last error is 429/402/401 or carries a rate-limit/cooldown message), ENZO waits out that provider's cooldown **in background** (SSE keepalive pings every 15s) and re-runs the attempts — the `continuation` buffer carries the partial output, so the reply/build **resumes from the exact stopping point**, not from scratch. Status + ETA stream to the UI as `event: retry` `{ status:'waiting', provider, waitMs, cycle, etaSec }` plus a `[SYSTEM: … auto-retrying in ~Ns …]` notice; the React terminal shows a countdown chip while it waits. Env knobs: `ENZO_CHAT_AUTO_RETRY=0` disables; `ENZO_CHAT_AUTO_RETRY_MAX_MS` caps the total wait (default 10 min). Per-request `body.autoRetry: false` also disables. Non-throttle failures (bogus-model 404/422, hard timeouts) still fail immediately.
- **Daily probe budgets**: `dailyRemaining(provider)`/`spendProbe(provider)` persist per-day probe counts in `throttle-state.json` (gitignored, reset at UTC midnight) so the background health monitor can't burn a user's quota. Defaults: openrouter 10, nvidia 40, groq 500, pollinations 1, hf 100, llm7 60, google 50, puter 20, cloudflare 50. Override `ENZO_HEALTH_DAILY_BUDGET_<PROV>`.
- **Thunder-pause (sustained-rate guard for long builds)**: providers enforce *real* RPM ceilings well below their advertised numbers (NVIDIA NIM free ≈ 20 RPM despite advertising 40), and a long coding build firing auto-continuation rounds back-to-back crosses that ceiling — the provider then hard-429s us mid-fence, killing the reply. Every outbound request is logged into a rolling 60s window (`rpmUsed` in `throttle.ts`, `recordProviderRequest` called from `acquireProvider`). In `/api/chat`, `dispatchStreamOnce` checks the window *between continuation/build-verify rounds*; when a route's window is at/above its **soft ceiling** it parks the STREAM for `streamPauseMs()` (default 120s — SSE keepalives keep the connection alive) via `streamPauseNeeded(provider)`, streams `event: retry` `{status:'pacing', provider, waitMs, etaSec, rpm, softRpm}` (the React terminal renders the existing countdown chip with pacing wording), then resumes the exact continuation point. Repeats automatically until the build completes. Soft ceilings default: nvidia 15 (the ~20 real ceiling minus headroom), openrouter 20, groq 30, pollinations 15, hf 20, llm7 15, google 10, puter 10, cloudflare 20. Knobs: `ENZO_STREAM_RPM_<PROV>` (ceiling per provider), `ENZO_STREAM_PAUSE_MS` (pause length, default `120000`), `ENZO_STREAM_PACING=0` (disable). Only rounds mid-build pause — a fresh single-turn query never blocks.
- **Per-model continuation compaction**: each model has its own `context_length` input limit. A long multi-file build can grow the accumulated `assistantBuffer` past it (→ 400/truncation). `compactContinuation(buffer, contextLimit, reservedChars)` (index.ts, near `buildContinueMessages`) — keyed on the route's catalog `context_length` via `modelContextLimit(route)` (per-provider defaults when the catalog lookup misses) — compacts the EARLY material between continuation rounds: merges blank-line runs, trims line ends, and elides the bodies of **fully-closed** early code fences into `[ENZO compacted: N lines elided]` markers (headers + first/last 2 body lines + closing fence re-emitted so the section stays a valid closed fence). The **TAIL is always kept verbatim** so the `[CONTINUATION]` turn resumes at the exact last character. The stored reply / build-verify output is untouched — compaction only shapes what the model sees on the next round.

## Memory system (`memory.ts`)

Persistent, model-agnostic memory so any model/provider can pick up work started by a different one (e.g. research done on Groq/deepseek continues on Llama after a reboot):

- Store: `memory-store.json` (gitignored), capped at 200 entries, deduped by topic within 24h.
- Every completed `/api/chat` turn auto-records an entry (`recordMemory`) — title, model/provider, mode, summary, last exchange. **Identity/meta probes are not recorded**: `isIdentityProbe` (memory.ts) blocks "which model are you" / "who are you" turns from BOTH recording and recall — a model must answer from its own awareness, not parrot another model's stored self-ID (prevents cross-model memory echoes like granite claiming to be deepseek-r1).
- On each new request, `buildMemoryContext` scores stored entries against the current message (keyword overlap + recency). If the user says *"continue the work"* (`isContinueIntent`) or a topic overlaps, a `[MEMORY — PREVIOUS WORK]` block is injected into the system prompt.
- **Facts**: explicit durable facts via `/remember <fact>` → `rememberFact` (entry kind `'fact'`). Facts are **always injected** (`[MEMORY — FACTS]` block) regardless of topic scoring — true cross-provider memory. `/forget [query]` removes entries (matches title/summary/exchange substring; `all` wipes). `/memory` lists facts + recent work. Intent helpers: `isRememberIntent`, `isForgetIntent`, `isListMemoryIntent`, `extractFactFromMessage`, `extractForgetQuery`, `getFacts`.
- Unrelated queries inject only the facts block.
- Endpoints: `GET /api/memory` (masked list) and `POST /api/memory/clear` — both protected by `verifyVaultAccess` (master key or vault session token).

## Health monitor (`health.ts`)

Background pass every **5 minutes** (default) probes **every catalog model** and records live status + measured latency into `model-health.json` (gitignored):

- Started on `server.on('listening')`; first pass after 10s (`ENZO_HEALTH_STARTUP_DELAY_MS`), interval via `ENZO_HEALTH_PING_INTERVAL_MS`, pool size via `ENZO_HEALTH_CONCURRENCY`.
- Store shape: `{ lastPassAt, lastPassDurationMs, passesCompleted, models: { [id]: { status, latencyMs, checkedAt, error? } } }` with `status ∈ online | degraded | offline | n/a | unknown` (`degraded` = latency > 3000ms).
- Probes hit the exact endpoint the tunnel routes to (reuses `probeModelHealth`, shared with `POST /api/ping-model`). Retries 0 in background (1 retry on the interactive endpoint).
- Guardrails: bounded worker pool (default 6); per-provider cooldown (2 min) on `rate_limited`/`auth_failed` skips the rest of that provider's pass instead of hammering it; Pollinations models share one backend so a **single catalog GET** covers all of them (blanket probe); `image-gen` models can't be chat-pinged → `status: 'n/a'`; passes are self-rescheduled (no overlap). Per-provider min gaps also honor RPM caps (e.g. NVIDIA 40 RPM → 1600ms gap).
- **Daily probe budget** (`throttle.ts`): every probe checks `dailyRemaining(provider)` before firing and `spendProbe(provider)` after. Defaults are deliberately low so the background monitor never burns a user's daily chat quota (e.g. OpenRouter free tier = 50 req/day → cap 10 probes/day; NVIDIA 40/day). Budgets persist in `throttle-state.json` (gitignored), reset at UTC midnight, override via `ENZO_HEALTH_DAILY_BUDGET_<PROV>`.
- `GET /api/v1/models` annotates every model with `health` (from the store) so cards show a live dot + measured response time. `GET /api/models/health?full=1` dumps the whole store plus `budgets` (probes remaining per provider). No keys ever stored.
- **LLM7**: probed only when a key exists (no anonymous tier) at 2000ms gap (30 RPM free tier); daily probe budget 60. Free LLM7 models are chat-pingable like any chat model — but note the catalog currently has **zero free LLM7 models** (the gateway silently replaces every free id; `verifyLlm7Catalog` drops them), so health only ever sees paid ones.

## Skills system (`skills.ts`)

User-taught skills learned from GitHub repos, distilled by a small LLM, and injected only when the current request matches:

- Store: `skills/index.json` (gitignored via `skills/`). Entry: `{id, name, sourceUrl, description, keywords, instructions, sourceSnapshot (≤6k chars), learnedAt, model, files}`.
- `learnSkillFromRepo(url, {groqKey})`: shallow `git clone --depth 1` (60s timeout) → `readSample()` walks the clone (skip `.git`/`node_modules`/`dist`/binaries, prioritize README/package.json/docs, max 60 files, 30k snapshot) → `distillSkill()` asks Groq `llama-3.1-8b-instant` (JSON mode) for name/description/keywords/instructions. **Snapshot capped at 6,000 chars** to stay within Groq TPM budget. Graceful fallback to a generic skill on LLM failure. Rejects re-learning the same repo id.
- `buildSkillContext(message, {maxSkills})` is **proactive**: it stem-tolerant token-scores the user message against skill name+keywords+description (suffix variants like `organize`/`organizes`, `file`/`files` match) and returns a `[SKILLS — PROACTIVE]` block or `''`. Skills scoring `ratio ≥ 0.5` OR `overlap ≥ 3` are "strong" — the top `maxSkills` (default 1) strong skills are **auto-applied** with their FULL instructions (`● APPLY NOW`) so the model follows them without the user naming the skill; up to 6 candidates are listed (`• ID — name: description`) for the model to pull mid-response. Block header teaches the `<use_skill>ID</use_skill>` contract (see below).
- **Proactive runtime wiring**: `/api/chat` and `tunnel.ts` call with `{ maxSkills: 1 }`. Both the agent tool-loop path and the smart-fallback attempt loop wrap streaming output in a `SkillSignalFilter` (index.ts `writeContent`) that strips `<use_skill>ID</use_skill>` from the user-visible stream and records it on `skillFilter.skillId`. When a signal is seen, ENZO reloads that skill's full instructions into `systemContent`/`enhancedSystemContent` and re-runs the loop seamlessly (threading the already-streamed `assistantBuffer` as a continuation turn), capped at `MAX_SKILL_LOADS = 2` per request. Rounds reset the filter; an abandoned tag is flushed as text at stream end.
- `SkillSignalFilter` (skills.ts, exported): handles signals split across chunk boundaries by holding back incomplete tags (`MAX_PENDING = 80` safety valve), `reset()`, `flush()`. `cleanTextForUser`/`StreamSanitizer` do NOT strip `<use_skill>`, so signals survive to the filter in agent-loop and streaming paths alike.
- Commands: `/learn <repo-url-or-owner/repo>`, `/skills`, `/unlearn <name|id|url>`. Chat command interception lives in `/api/chat` (replies in SSE or AI-SDK format).
- REST (all `verifyVaultAccess` + vault rate limit): `GET /api/skills` (masked list), `POST /api/skills/learn` `{repoUrl}`, `POST /api/skills/import` `{repoUrl}` (bulk), `GET /api/skills/:id`, `DELETE /api/skills/:id`.
- **Bundled-skills import** (`importBundledSkillsFromRepo` in `skills.ts`): repos that ship many Claude Code skills as `<dir>/SKILL.md` (e.g. `ComposioHQ/awesome-claude-skills`, ~865 modules incl. the `composio-skills/` automation pack) are imported in one shot — clone once, `findSkillModules()` walks for `SKILL.md`, `parseSkillMd()` reads the YAML frontmatter (`name`/`description`) + body as instructions **directly, with no LLM round-trip** (these files are already distilled skill definitions). Ids are `owner/repo/<relpath>`; already-learned modules are skipped (idempotent). `buildSkillContext` scoring stays ~2.3ms/message even at 865 entries (stem-tolerant token matching). The `/skills` dropdown has an **Import** button wired to `POST /api/skills/import` with the awesome-claude-skills URL.
- **Tunnel injection**: `/api/v1/chat/completions` also injects memory + skills (`injectMemoryAndSkills` in `tunnel.ts`), so any model/API called through the tunnel shares the same cross-model memory and learned skills.

## Hardcoded coding skills (`bundled-skills.ts` + `skills-bundled/`)

The CODING agent carries a **committed, hardcoded specialist library** — no runtime learn step. Vendored from `jeffallan/claude-skills` (67 `SKILL.md` modules, MIT) into `skills-bundled/<name>/SKILL.md` (SKILL.md bodies only, not the `references/` trees — keeps the repo at ~536KB). Unlike the user-taught `skills/` store (gitignored), this ships with the repo so coding mode always has production-grade domain guidance. Plus the **Ponytail** minimalism doctrine (MIT, `dietrichgebert/ponytail`) — see below:

- **Loader**: `loadBundledSkills()` scans `skills-bundled/*/SKILL.md` once at boot (warmed in `server.on('listening')`), reusing `parseSkillMd` from skills.ts; `metadata.triggers`/`domain` frontmatter lines are extracted for richer matching. Boot log: `[bundled-skills] loaded 73 hardcoded coding skills`.
- **Injection**: `/api/chat` appends `buildCodingSkillContext(message, { maxSkills: 2 })` to the system prompt **only when `chatMode === 'coding'`** (other modes keep the learned-skill store). Top matches get full guides (`● APPLY NOW`); candidates are listed for mid-stream `<use_skill>ID</use_skill>` loading; a `[CODING SKILLS — HARDCODED SPECIALIST LIBRARY]` block header teaches the contract.
- **Matching** (stem-tolerant token scoring, skill.ts semantics): a request auto-applies a skill when it names the tech (match on the skill's **primary id token** — the leading noun, minus role suffixes like `pro/expert/architect/designer` — so "postgres schema" fires `postgres-pro`, not `api-designer`; length ≥5 on both sides for prefix matches so "javascript" never trips `java-architect`), or when ≥3 tokens overlap. Applied skills are deduped by `domain`, guides capped at 2,200 chars each, and a request with no strong hit gets **no expert pollution** — just the ponytail block, never a menu of coincidental keyword matches.
- **Ponytail — always-on lazy-senior-dev doctrine**: the vendored `ponytail` skill is **injected into every coding prompt**, not trigger-matched (`buildAlwaysOnPonytail` in bundled-skills.ts): a `[PONYTAIL — LAZY SENIOR DEV, ALWAYS ACTIVE]` block with the 7-rung ladder (YAGNI → reuse → stdlib → native platform → installed dep → one line → minimum code), the rules, and an explicit **SCOPE bridge** keeping it from conflicting with the DESIGN STANDARD ("ponytail governs implementation, never required polish/scope; never simplify away validation, security/error handling, accessibility, or explicitly-requested features"). Level escalates to `ultra` on "ultra/laziest/extremely lazy mode" and `lite` on "lite/lazy-ish". Bug-fix rule (root cause, one shared place), `ponytail:` comment convention, and exactly ONE runnable check for non-trivial logic (aligns with the build-verify loop).
- **Ponytail one-shot sub-skills** are trigger-matched separately from specialists (spaced, hyphenated, or concatenated forms — `ponytail review`, `ponytail-audit`, `ponytailaudit`): `ponytail-review` (diff/code review for over-engineering), `ponytail-audit` (whole-repo cut list), `ponytail-debt` (`ponytail:` ledger), `ponytail-gain` (benchmark scoreboard), `ponytail-help` (reference card). When the user explicitly invokes lazy mode, the **full** main `ponytail` guide is also auto-applied (uncondensed).
- **UI/UX Pro Max — always-on design intelligence + `ui_search` tool** (`skills-bundled/ui-ux-pro-max/` + `ui-ux-search.ts`): a TS port of the `nextlevelbuilder/ui-ux-pro-max-skill` design database — 161 color palettes, 57 font pairings, 50+ visual styles, 99 UX guidelines, chart guidance, and 16 per-stack guides, vendored as CSVs under `skills-bundled/ui-ux-pro-max/data/`. `ui-ux-search.ts` reimplements the skill's Python BM25 engine (`core.py`/`search.py`) in stdlib TS: an RFC-4180 CSV parser (quoted fields + embedded newlines; a quote only opens a field at a field boundary, else a stray mid-field `"` merges rows), BM25 ranking, `detectDomain`, `search`/`searchStack`, and `formatResult`. Files are loaded + indexed lazily per-CSV and cached for the process.
- **`ui_search` = the coding twin of `<use_skill>`** (`UiSearchSignalFilter` in ui-ux-search.ts, wired in index.ts `writeContent` + the streaming reload loop): the model emits `<ui_search domain="color" stack="react">fintech dark dashboard</ui_search>` (several allowed per turn); the filter strips it from the visible stream and queues the request (holds back tags split across chunks, `MAX_PENDING = 400` safety valve). After each stream round the reload loop **batch-drains** all pending searches, runs them against the vendored DB, appends a `[UI/UX SEARCH RESULTS — …]` block to `systemContent`, and re-runs the attempt loop threading `assistantBuffer` as continuation — so the reply continues seamlessly with real palettes/fonts/rules in context. Own budget (`MAX_UI_SEARCH_ROUNDS = 4`) so design lookups never starve `MAX_SKILL_LOADS`. The `ui-ux-pro-max` SKILL.md guide is **injected into every coding prompt** (like ponytail — not trigger-matched; teaches the tag syntax + when to search) and is **excluded from generic specialist scoring** so it never double-injects or shows as a menu item.
- **Scope rule**: `"app"`-stack requests (react/fastapi/nestjs/vue/sql/…) rotate specialist guides; generic product requests ("beanie store landing page", "build a small tool") get **no skills** — just the ponytail doctrine; the coding DESIGN STANDARD already covers generic polish.

## API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat` | SSE chat stream. Body: `{ message, chosenModel, chatMode, webSearch, providerKeys: { openrouter, groq, nvidia, huggingface } }`. |
| POST | `/api/meme` | Meme roast JSON. Body: `{ message, recent? }` |
| POST | `/api/image/generate` | Text2img or img2img. Body: `{ prompt, image? }` → `{ dataUrl, mode }` |
| POST | `/api/preview` | Register a generated HTML doc for live preview. Body `{ html, title? }` → `{ id, url, title }`. In-memory, 1h TTL, 300 max. |
| GET | `/api/preview/:id` | Serve a registered doc as a full page (`text/html`). Same URL renders in the app's iframe side panel AND opens full-screen in a new tab. |
| POST | `/api/project/save` | Register a multi-file website (files written to `generated-projects/<id>/` on disk). Body `{ files: { path: content }, title? }` → `{ id, url, title, files[], backend? }`. Path-traversal-safe, 60-file / 3MB-per-file caps, `index.html` guaranteed. When the project contains a backend entrypoint (`server.js` by convention — see **Full-stack projects** below), `backend: { entry, base }` points at the live runtime. |
| GET | `/api/project/:id` (or `/:id/`) | Serve a saved project's `index.html` as a full page. When the project has a backend, a small bootstrap script is injected (sets `window.ENZO_BACKEND`). Same URL works in the iframe side panel AND full-screen in a new tab. |
| GET | `/api/project/:id/manifest` | Project file list `{ id, title, files: [{ path, size }], backend }`. |
| GET | `/api/project/:id/*splat` | Serve relative project assets (`css/`, `js/`, images) with correct content-types so multi-file sites render. Express 5: `splat` arrives as an array of segments. |
| ALL | `/api/project/:id/backend/*` (and `/backend`) | Reverse-proxy to the project's spawned Node backend runtime (all methods, streaming). Lazy-boots the runtime on first request; `404 no_backend` if the project has no backend, `502` if startup failed. |
| POST | `/api/search` | Debug search. Body: `{ query }` |
| POST | `/api/v1/chat/completions` | OpenAI-compatible tunnel (see `tunnel.ts`). Routes by `groq/`, `pollinations/`, `openrouter/`, `nvidia/`, `hf/` prefix. |
| GET  | `/api/unsplash/random` | Random Unsplash wallpaper `{url, alt, author, authorUrl}`. 503 when `UNSPLASH_ACCESS_KEY` unset. Rate-limited. |
| GET  | `/api/v1/models` | Live model catalog. Accepts per-provider key headers (`x-groq-key`, `x-openrouter-key`, `x-nvidia-key`, `x-llm7-key`, `x-google-key`, `x-puter-key`, `x-cloudflare-key` + `x-cloudflare-account`) to perform live keyed-provider fetching and merge into catalog. Every model annotated with `health` from the background monitor. |
| GET  | `/api/models/health` | Background health-ping store (live status + latency per model; `?full=1` includes the model map). No keys ever stored. |
| POST | `/api/v1/sync` | Manual catalog refresh (admin). |
| GET  | `/api/memory` | List recent memory entries (masked). Requires master key or vault token. |
| POST | `/api/memory/clear` | Wipe the memory store. Requires master key or vault token. |
| GET  | `/api/skills` | List learned skills (masked: no instructions/snapshot). Requires master key or vault token. |
| POST | `/api/skills/learn` | Learn a skill from a repo. Body `{ repoUrl }`. Requires master key or vault token. |
| POST | `/api/skills/import` | Bulk-import a "bundled skills" repo (many `<dir>/SKILL.md` modules, e.g. `ComposioHQ/awesome-claude-skills`). Body `{ repoUrl }`. Requires master key or vault token. |
| GET | `/api/skills/:id` | Full skill detail (instructions + snapshot). Requires master key or vault token. |
| DELETE | `/api/skills/:id` | Delete a learned skill. Requires master key or vault token. |

### Provider prefixes (`resolveModelRoute` in `index.ts`)

| Prefix | Provider |
|--------|----------|
| `groq/` | Groq |
| `pollinations/` | Pollinations |
| `openrouter/` | OpenRouter |
| `hf/` | HuggingFace Inference |
| `nvidia/` | NVIDIA NIM (via OpenRouter fallback if no NVIDIA key) |
| `llm7/` | LLM7 OpenAI-compatible gateway (**key required** — no anonymous tier) |
| `google/` | Google Gemini via AI Studio OpenAI-compat endpoint (**key required** — no anonymous tier, keyless 404s) |
| `puter/` | Puter user-pays gateway (**token required** — bills the END USER's Puter account, free monthly credits first) |
| `cloudflare/` | Cloudflare Workers AI (**token required** — keyless catalog returns `[]`; chats post to `accounts/{ACCOUNT_ID}/ai/v1/chat/completions`, account id auto-discovered from token when absent) |

Models with unknown prefixes fall through to Groq `qwen/qwen3-32b`. `getFallbackQueue()` always terminates with Groq `llama-3.3-70b-versatile` if the user has a Groq key, so marketplace selections never render an empty response when their primary key is missing.

### Formula

```
{action: "search"|"skip",
 query: string (the cleaned-up engine query, or empty)}
```

### SSE events (`/api/chat`)

- Default `data:` lines → assistant text tokens (forwarded as `text-delta`)
- `event: reasoning` → thinking tokens (forwarded as `reasoning-delta`)
- `event: search` → web search status messages (skipped, never sent to UI)
- `event: mode` → auto-decider routing decision `{ mode, webSearch }` (per-turn only; UI toggle untouched)
- `event: build` → coding build-verify progress `{ status, round, maxRounds, ok, fileCount, checks, warnings }` (metadata; skipped from reply text, never rendered into messages)
- `event: retry` → auto-retry status after a rate-limit OR a thunder-pause (sustained-rate pacing). `{ status: 'waiting', provider, waitMs, cycle, etaSec }` when a cooldown is being waited out; `{ status: 'pacing', provider, waitMs, cycle, etaSec, rpm, softRpm }` when the rolling RPM ceiling was hit mid-build (the React terminal renders the same countdown chip with pacing wording, `{ status: 'resuming' }` on unpause). Metadata, never part of the reply text.
- `[SYSTEM: ...]` inline text → stripped

### Chat history (TerminalSection localStorage)

- Sessions blob: `enzo.chat.v3.sessions` — full array of `ChatSession` (`{id, title, model, chatMode, isImageSession, messages[], createdAt, updatedAt}`).
- Last-active session id: `enzo.chat.v3.active-session` — restored on boot so returning users (even weeks/months later) land on their last conversation.
- Legacy messages blob: `enzo.terminal.history` (kept for backwards compat).
- `TerminalSection.tsx` keeps the active session's `messages` in lock-step with the live conversation via a sync effect, so sessions in the history drawer never load as empty chat boxes.
- On boot (or any remount — page reload, login, tab-switch back to terminal), the **last conversation is always restored**: prefers `enzo.chat.v3.active-session`, then the most recently updated session, then a fresh session. StrictMode-safe via an `initModelRef` (a changed model id means a real switch → mints fresh; same id re-run is a no-op). Switching models mints a new session.
- Incognito mode writes nothing.
- Switching models: current session is saved under the old model, a new sessionId is minted for the new model.

### Tunable UI behavior

- `webSearch` default: `false`.
- Search runs when `webSearch` is `on` (or `auto`/research mode) and `shouldAutoSearch()` in `search.ts` matches — heuristic-based, no separate refine endpoint.
- Temperature: `0.7`.
- Inline system prompt: short (one line) so replies stay focused. **No model-identity injection**: ENZO does NOT tell a model its underlying provider/model id ("running on node X" removed), does NOT force-identity via the HF tunnel ("CRITICAL: you are operating as model X" removed), and memory/skills never carry self-ID answers (see memory above) — a model asked "which model are you" answers from its own awareness (or hallucination), never from a wrapper-injected claim. **No model-identity injection**: ENZO does NOT tell a model its underlying provider/model id ("running on node X" removed), does NOT force-identity via the HF tunnel ("CRITICAL: you are operating as model X" removed), and memory/skills never carry self-ID answers (see memory above) — a model asked "which model are you" answers from its own awareness (or hallucination), never from a wrapper-injected claim.

### Auto mode (LLM-decided mode routing)

- **No button — silent escalation.** When `/api/chat` arrives with `chatMode: 'normal'` (or empty), `decideAutoMode()` in `index.ts` asks a small cheap LLM (reuses the smart-fallback picker infra: `buildPickerConfigs` + `askPickerForFallback`) to classify the message into the single best execution mode — `normal | thinking | research | coding` — plus a `webSearch` flag. The decision overrides `chatMode`/`webSearch` **for that request only**; the UI mode toggle is never mutated.
- **Deterministic fast-path first.** `strongIntentAutoMode()` in `index.ts` pattern-matches *unmistakable* requests ("code me a website", "research X", "solve this") and routes instantly — zero LLM latency, and the request can never linger in normal mode because the decider provider is slow or down. The LLM decider is only consulted for ambiguous messages. The routed mode is surfaced to the UI via `event: mode` + a visible `auto → <mode>` chip in the composer and live reply.
- The decider's web-search flag is authoritative, but an explicit user `webSearch: 'off'` is always respected. Trivial casual replies (`hi`, `ok`, `thanks`…) skip the LLM round-trip entirely and stay `normal`.
- If the decider is unreachable (no usable provider / picker error), the requested mode + heuristic `shouldAutoSearch` are kept — a reply is never blocked.
- **Frontend feedback:** backend emits `event: mode` (legacy SSE only) with `{ mode, webSearch }` before streaming. `TerminalSection.tsx` reads it into `autoRoutedMode` (+ a ref for the final message) so the live reply renders the *actual* mode (e.g. research shows `ResearchProgress`/`ResearchWindow`), records it on the finished message, and resets it on the next send.

### Research output UX (research mode)

- **LLM decides how to research.** The agent tool-loop (`agent-tools.ts`) hands the model real `web_search`/`deep_research` tools; Groq Llama/Qwen models emit their tool call as XML text (`<web_search><query>…</query></web_search>`) which `parseTextToolCalls` in `agent-tools.ts` converts into an actual executed search (Qwen XML format, `call:` format, `<function=…>` and DSML are all parsed). Never leaks raw tool XML to the user — `StreamSanitizer` in `index.ts` and `cleanTextForUser` in `agent-tools.ts` strip any leftovers.
- **Distinct "researching" phase.** While the AI is gathering sources, the chat renders `ResearchProgress` (`src/components/ui/ResearchProgress.tsx`) — a live radar-sweep window with the step ledger and a streaming "Report Draft" pane. The generic agent-activity panel is hidden during research streaming.
- **Popup appears only when research completes.** The Win95-styled `ResearchWindow` (`src/components/ui/ResearchWindow.tsx`, gray bevel frame + blue gradient title bar) renders only for *completed* research messages (`isResearchMessage`), replacing the plain bubble. The standalone "View Research Sources" collapsible and the standalone "Download PDF" button are suppressed for research messages (the window has its own Sources ledger + Download PDF).

### Live code preview (coding mode)

- **Coding mode is NOT agent-loop routed — it goes through the streaming path.** `toolsEligible` deliberately excludes `coding` (only `normal`/`thinking` run the agent tool-loop): building a website/app is pure generation, and exposing `web_search`/`gmail` tools only invites a weak model to narrate "let me search…" instead of shipping the project. The streaming path gives coding both the **completeness-driven auto-continuation loop** (finishes long multi-file projects: `finish_reason:'length'` OR `codingReplyIncompleteReason(assistantBuffer)` non-empty → same-route `[CONTINUATION]` rounds, `MAX_TRUNCATION_ROUNDS = 16`) and the **smart provider-fallback chain**. `codingReplyIncompleteReason` catches the case fence-counting misses — a weak model that STOPS EARLY with balanced fences but a half-built project (references a css/js file it never emitted, `index.html` missing `</html>`/`</body>`, an emitted-but-empty file); the loop then nudges the model toward that specific missing piece rather than just "keep going." **Segment-wise generation**: `getModeMaxTokens('coding')` = **32768** (raised from 8192), so each continuation round is a large ~32K segment resuming from the exact stop point via `compactContinuation` — a big app finishes in ~2–3 segments instead of ~11 tiny rounds. `providerOutputCap(provider)` clamps the segment at dispatch so a provider with a smaller real output ceiling (Pollinations/Cloudflare 8192, HF 16384) never 400s on the 32K target. A **frontend safety net** (`TerminalSection.tsx`) re-sends "continue" itself via `forcedPromptRef` (up to `MAX_AUTO_CONTINUE = 5`, mirror `codingReplyIncompleteReason` on the client) if the SSE still closes on an incomplete build. Because the agent loop is gone, `agentHandlesSearch` also excludes `coding` — when `webSearch` is on for coding, the forced pre-search injects `[SEARCH RESULTS]` context for the streaming coder instead.
- **The coding system prompt enforces a DESIGN STANDARD, not just structure** (`getModeSystemExtra('coding')` in `index.ts`): a cohesive design system of CSS custom-property tokens (`:root { --primary/--accent/--bg/--surface/--text… }`), a 1-2 font pairing from Google Fonts, tasteful surfaces/shadows/radii/borders, micro-interactions + scroll-reveal + counters, complete page anatomy (sticky nav, hero with dual CTAs, feature cards, stats band, testimonials, FAQ accordion, final CTA, footer), mobile-first responsive (clamp, auto-fit grid, hamburger), and real content (never lorem ipsum / empty boxes) with reliable CDN images or inline SVG. This replaces the old one-line "make it look 3D" guidance that produced default-browser pages.
- **Auto-routed coding replies get a live preview.** When a coding-mode reply contains a full HTML page (a ` ```html ` fence with a document body, or a bare doc), the frontend extracts it (`extractPreviewHtml` in `TerminalSection.tsx`) and registers it on the backend via `POST /api/preview` → `{ id, url }`. The extractor only fires for *real* pages — small snippets and non-HTML blocks are ignored.
- **Multi-file projects take priority.** Coding replies are prompted to emit ```` ```file:path ```` blocks (index.html + css/ + js/ + assets/, relative references). `extractProjectFiles` in `TerminalSection.tsx` parses those into `{path: content}` and `syncPreviewFromText` registers it via `POST /api/project/save` (project wins when an `index.html` or ≥2 files exist), falling back to single-HTML `registerPreview` otherwise. One code path serves both: `commitPreview` + `registerPreview` + `registerProject` + `syncPreviewFromText`.
- **Live while streaming.** A throttled effect (min 1.5s) re-registers the freshest complete doc/project as the model writes, so the panel keeps up; the finished message forces a final registration (`syncPreviewFromText(text, true)`) so the stored doc always matches the reply.
- **Side panel + redirect URL.** The panel (portaled to `document.body`, `fixed right`, z-index 9998) renders the doc/project in a sandboxed iframe (allow-scripts/same-origin/forms…). Header buttons: **Open new tab** (the redirect URL — `/api/preview/:id` or `/api/project/:id/` — same URL works full-screen in a new tab), **URL** (copies the absolute URL), reload, and close. Panel stays closed once dismissed mid-turn; a floating `Preview` tab reopens it. **The panel is suspended (invisible + `pointer-events-none`, kept mounted so the iframe state survives) whenever the History or My Projects drawer is open** — at z-9998 it physically covers the right-edge drawer buttons (Delete/Open/Download) when both are up, so the drawer must be clickable on top of it. Every message that carries a page also gets a small `Preview ↗` affordance.
- **Backend hosts: single pages in-memory, projects on disk.** `preview.ts` keeps raw-HTML docs in a `Map` (1h TTL + 300-entry cap, `GET /api/preview/:id` serves `text/html`, rate-limited 60/min, nothing touches disk). `project.ts` writes multi-file sites to `generated-projects/<id>/` (path-traversal-safe, 60-file / 3MB-per-file caps, `index.html` guaranteed) and serves `index.html` + relative assets via `projectRouter`.
- **My Projects drawer** (`TerminalSection.tsx`, backed by `codeStorage.ts`): a **Projects** button in the Terminal toolbar opens a slide-over listing every coding task mirrored to localStorage (newest first). Per card: **Open / Run** (opens the redirect URL in a new tab — `/api/project/:id/` boots the real sandboxed backend runtime, `/api/preview/:id` for single HTML docs), **Download** (`downloadTaskZip` — the dependency-free STORE-method zip writer in codeStorage.ts), **Edit** (pins the task via `startEditingTask` → `sessionProjectIdRef`, previews it, switches to coding mode, shows an emerald `Editing: <title>` banner in the composer), **Delete** (`removeCodeTask` locally + best-effort `DELETE /api/project/:id` to drop the on-disk container + stop its runtime).
- **Low-power mode** (`hooks/useLowPowerMode.ts` + `components/LowPowerToggle.tsx`): the full-screen WebGL video-blend background is the heaviest runtime cost on weak GPUs. `App.tsx` swaps both `*ThemeRenderer`s for a static gradient when low-power is active — tripped by a manual Lite toggle (localStorage), `prefers-reduced-motion`, or CONSERVATIVE hardware detection (`hardwareConcurrency ≤ 2` / `deviceMemory ≤ 2`, kept conservative so flagship visuals never auto-disable on capable machines). The floating bottom-right Lite/Full chip is the manual escape hatch. Separately, `three` (~600KB, only the forest theme) is `React.lazy`-loaded so it splits into its own chunk (initial JS gzip 443KB → 313KB).

### Build-verify loop (Claude Code-style: write → run → read errors → fix, `build-verify.ts`)

Coding replies are no longer trust-on-sight fence text. After the stream completes (and after auto-continuation/fallback rounds), ENZO deterministically verifies the extracted project and — when a check fails — hands the build report back to the **same winning route** for up to `MAX_BUILD_ROUNDS` (3) repair rounds, each streaming its corrected fences into the same reply so the frontend's later-wins fence parsing re-registers the fixed project:

- **Extraction** (`extractProjectFiles`): mirrors the frontend parser (TerminalSection.tsx) — `/```file:([^\n]+?)\s*\n([\s\S]*?)```/g` with `..`/length guards, later occurrence wins per path. The server validates exactly what the preview will register.
- **Checks** (`verifyProject`), all deterministic — same tools a human would reach for:
  - *HTML structure*: `index.html` must exist with `<html>/<head>/<body>`; warns on missing viewport/title, lorem-ipsum.
  - *Local asset refs*: every bare/relative `src`/`href` in `index.html` must resolve to an emitted project file (external `http(s)/data:` refs skipped; missing favicon/images are warned, not failed).
  - *JS syntax*: every `.js/.mjs/.cjs` run through `node --check` (temp file; `.mjs` when top-level ESM markers are detected; 1MB cap). Syntax errors are the #1 repair trigger.
  - *Backend boot*: when a backend entrypoint (`server.js` etc.) exists, `bootCheckBackend` writes all files to a scratch dir and **spawns `node server.js` exactly like project-runtime** (NODE_PATH → ENZO `node_modules`, ephemeral free port, cwd = scratch) then polls `/api/health` → `/` until any 2xx-4xx (API-only backends 404 the root — the process answering HTTP is the pass signal), 8s cap. On crash/timeout the last 8 stderr lines are surfaced as the error.
  - *Design tokens / typography*: warnings only (no `:root` palette, no font-family/Google Fonts) — polish hints, never a blocking fail.
- **Repair rounds**: on failure, `buildRepairContext` builds a fresh-generation system prompt carrying the report + every current project file (160KB context cap) and a directive to re-emit **complete corrected ````file:` fences** for defective files only — a new stream via the same `dispatchStreamOnce`, not a continuation, so the model isn't fighting the "don't repeat text" instruction. Rounds re-extract from the updated `assistantBuffer` and re-verify.
- **Events**: progress streams as `event: build` (legacy SSE metadata; skipped in AI-SDK format) — `{status: checking|passed|failed|done, round, maxRounds, ok, fileCount, checks, warnings}`. Warnings are always surfaced so even a passing build gets design feedback.
- **Dispatch refactor**: the provider stream call was extracted into a local `dispatchStreamOnce(route, continuation, repairContext?)` in the `/api/chat` handler (closes over `res`/`writeContent`/`activeKeys`/`nvidiaBaseUrl`); the auto-continuation loop, smart-fallback attempts, and build-verify repair rounds all route through it. `winnerRoute` records the model that actually replied so repairs reuse the same provider/model.
- **Prompt contract**: the coding system prompt now tells the model its output WILL be build-checked (`node --check`, boot probe hitting `/api/health`) and forbids knowingly-broken code and dangling local refs; generated backends are coached to expose `GET /api/health`.
- **Caveat**: a generated app is only "functioning" when served through the ENZO proxy (bootstrap sets `window.ENZO_BACKEND`). A project folder opened standalone (file:// or without the proxy) has `window.ENZO_BACKEND` undefined and every `/api` fetch fails — LinkVault (`enzo-project-2026-08-18/` at the repo root) is exactly that case: its registered copy `generated-projects/379680e38151/` works end-to-end (backend boots, CRUD answers), the root copy does not.

### Full-stack projects (live backend runtimes, `project-runtime.ts`)

Coding mode can ship a **real backend**, not just static files. When a saved project contains a backend entrypoint (`server.js` by convention; fallbacks `server/server.js`, `server/index.js`, `api/server.js`, `api/index.js`, `backend.js`), ENZO spawns it as a child Node process and reverse-proxies every method/path of `/api/project/<id>/backend/*` → `http://127.0.0.1:<ephemeral-port>/*`.

- **Model convention (taught in the coding system prompt, `index.ts`).** Backends are CommonJS (`require`), use Express + `better-sqlite3`, write the DB to `data/` inside the project folder (persists on disk), listen on `process.env.PORT`, never call `process.exit()`, and print `project-backend ready`. The frontend reaches it through `window.ENZO_BACKEND` (injected into served `index.html` when a backend exists), e.g. `fetch(window.ENZO_BACKEND + '/api/items')`.
- **Zero installs for generated code.** The child runs with `NODE_PATH` pointing at ENZO's own `node_modules`, so `require('express')` / `require('better-sqlite3')` just work — no per-project npm install. CJS-only by design (`NODE_PATH` doesn't affect ESM `import`).
- **Lifecycle.** Lazy-boot on first request (waits up to `ENZO_PROJECT_RUNTIME_BOOT_MS`, default 7s), idle shutdown after `ENZO_PROJECT_RUNTIME_IDLE_MS` (default 10 min), crash → mark dead → re-boot lazily, all runtimes killed via `stopAllRuntimes()` on SIGINT/SIGTERM (wired in `index.ts`). Boot logs are captured for `manifest`/502 error surfaces.
- **Persistence.** The DB (`generated-projects/<id>/data/*.db`) lives on disk, so generated apps keep their data across ENZO restarts and across AWS redeploys as long as `generated-projects/` is on a persistent volume / EBS mount.
- **Status surface.** `GET /api/project/:id/manifest` → `backend: { backend: 'running'|'starting'|'stopped'|'failed'|'none', entry?, port?, error? }`.
- **Security note.** These runtimes execute model-generated Node code as the ENZO process user with no sandbox — fine for a single-user local host, but do not expose `/api/project/*` to untrusted users.

**Deploying full-stack projects on AWS (documented, not hard-wired):** generated ports are ephemeral per rerun — never assume a fixed free port; all traffic enters through ENZO's `:5001` reverse-proxy, so no extra ingress rules are needed. Persistence = make `generated-projects/<id>/data/` land on durable storage (an EBS volume or an EFS/S3-backed mount at the app's cwd) so container restarts / Lambda cold starts keep the SQLite files. If you scale horizontally, remember each ENZO instance spawns its own children and owns its own runtime state — prefer a single instance, or put shared state in an external DB that generated backends connect to. `better-sqlite3` ships prebuilds but compiles from source on exotic platforms (needs `python3`/`make`/`g++` on the build host).

## Model routing (`resolveModelRoute` in `index.ts`)

UI `chosenModel` values map to backend providers:

| UI button | `data-model` | Provider | Actual model |
|-----------|--------------|----------|--------------|
| QWEN3-32B | `""` | Groq | `qwen/qwen3-32b` |
| COMPOUND-B | `deepseek-70b` | Groq | `compound-beta-mini` |
| LLAMA-3.3-70B | `llama-70b` | Groq | `llama-3.3-70b-versatile` |
| MINIMAX-M3 | `minimax` | Pollinations | `minimax-m3` |
| CLAUDE-S | `claude` | Groq | `llama-3.3-70b-versatile` + Claude-style system prompt |

**Chat modes** (`chatMode` from settings): `normal` | `thinking` | `research` | `coding`

- `thinking` → Qwen with `reasoning_format: parsed` (or MiniMax when selected)
- `research` → `compound-beta-mini` with research system prompt (or MiniMax)
- Modes combine with selected model; MiniMax-specific branches come first in `resolveModelRoute`

**Do not** re-add decommissioned Groq model IDs (`deepseek-r1-distill-llama-70b`, etc.).

## Smart auto-fallback (`pickSmartFallbackRoute` / `pickCodingFallbackRoute` in `index.ts`)

When `autoFallback` is on and a route fails at the streaming layer, ENZO asks a small LLM to pick the next model from the **live catalog** (`model-cache.json`) instead of blindly walking a hardcoded queue:

- Candidates built by one shared filter — `buildFallbackCandidates(activeKeys, failedRoute, error)` — chat-capable models (`text`/`multimodal`, excludes `image-gen`, transcription/embedding models like `whisper`, `bge-*`, `arctic-embed`) on providers that have usable keys (`providerUsable`), ranked **health (measured-online → untested → offline) → free first → preference provider → different provider first → coding/reasoning tag → closest/largest context window**. Known-bad models (health-marked `unsupported`/`auth_failed`/`quota`) and cooled-down providers are excluded.
- **TPM/quota exhaustion kills the whole provider.** `isTpmQuotaError(error)` (413 / `rate_limit_exceeded` / "Request too large" / `TPM` message) removes the failed provider from the candidate set entirely — after a 413, a sibling model on that provider would 413 identically, so it is never re-picked. This is what makes Groq (free tier 8000 TPM — a single coding prompt is ~11.8k tokens) fall through to big-context routers instead of chaining further Groq failures.
- **Mode-aware routers.** A `coding` failure uses `pickCodingFallbackRoute`: an LLM-picked route over a shortlist of the top 45 models sorted by `CODING_PROVIDER_PREFERENCE = ['nvidia','openrouter','cloudflare','pollinations','hf','groq','google','puter','llm7']` — NVIDIA first because its NIM free tier handles one large single request where Groq can't. Non-coding modes use the existing generic `pickSmartFallbackRoute` (capability-similarity ranking). Both routers share the candidate builder + the LLM decider.
- **The decision LLM is "always live" + LLM-mandatory.** `decideFallbackWithLLM` iterates `buildPickerConfigs` — openrouter free nemotron-nano → HF command-r7b → NVIDIA llama-3.1 → pollinations → LLM7 (verified-free only) → groq → google → puter → cloudflare — and **terminates with an ANONYMOUS Pollinations free picker** (`deepseek-v4-flash`, no key), so the fallback decision can never be blocked by every keyed router being down. The failed provider is pushed to the back of that order, so a rate-limited/TMP-exhausted Groq can't cripple the decision (it decides on HF/OpenRouter/Pollinations instead). `askPickerForFallback` 9s-timeouts each config and a clean candidate match short-circuits; `matchPickedCandidate` is tolerant (exact → case-insensitive → normalize-and-contains) because the LLM adds `-Instruct`/`:free` suffixes.
- If the picker is unreachable, `pickCodingFallbackRoute` **still returns a route**: `codingHeuristicChain(activeKeys)` walks the live catalog in `CODING_PROVIDER_PREFERENCE` order (max 6 routes, usable providers only) — the mandatory-LLM rule holds, but the fallback never blocks a response. Generic mode falls back to the `getFallbackQueue` tail.
- **LLM7 is in the picker queue only with a verified free model** (`buildPickerConfigs` reads `readModelCache()` and pushes the first free LLM7 id that survived `verifyLlm7Catalog` — never anonymous, never a known silently-replaced id like `gpt-oss:20b`): an auth-light last-resort decider/callback whenever every other keyed provider (Groq/OR/NVIDIA/HF/Pollinations) is down or rate-limited. With all free LLM7 ids currently dropped, LLM7 leaves the queue until a faithful one exists.

**Continuation:** when the previous model already streamed partial output (`assistantBuffer`), the next attempt gets it as an assistant turn plus a `[CONTINUATION]` instruction (`buildContinueMessages`), so the fallback model continues from the exact stopping point instead of restarting the response. Threaded through all four stream functions (`streamPollinationsChat`, `streamOpenRouterChat`, `streamHuggingFaceChat`, `streamNvidiaChat`) + the inline Groq branch. Reasoning output is suppressed on continuation attempts.

**Auto-continuation on truncation + incompleteness (coding/completion integrity):** every stream function returns whether the provider hit its `max_tokens` cap (`finish_reason === 'length'`). The `/api/chat` attempt loop wraps the route dispatch in a continuation loop (`MAX_TRUNCATION_ROUNDS = 16`): it re-invokes the SAME route with `continuation = assistantBuffer` while the reply hit the cap OR — in `coding` mode — `codingReplyIncompleteReason(assistantBuffer)` is non-empty. That predicate is the key upgrade over pure fence-counting: besides an unclosed fence (`replyLooksTruncated`), it flags a project that a weak model "finished" early but left half-built — `index.html` referencing a `css/js` file never emitted, missing `</html>`/`</body>`, or an emitted-but-empty file (the same structural signals build-verify uses, minus the expensive backend boot). When the model stopped early (not truncated) but incomplete, the continuation buffer gets an explicit `[SYSTEM: the project is NOT complete — <reason>. Continue from where you stopped …]` nudge so it targets the gap instead of re-emitting. Coding `max_tokens` is 32768 (segment-wise). This lives in `index.ts` (the `while` loop around the provider dispatch). A browser-side net in `TerminalSection.tsx` re-sends "continue" (≤ `MAX_AUTO_CONTINUE = 5`) if the SSE still closes incomplete.

**Streaming-path history + resume (cross-request continuation):** the streaming path (coding, or any non-agent mode) used to send only the newest prompt, so a follow-up ("continue", "finish the project") hit the model with zero context and the whole build restarted from scratch. `/api/chat` now rehydrates the session from `body.messages` via `extractConversationHistory`/`extractMessageText` (index.ts, module scope near `buildContinueMessages`): the last 8 prior turns are injected into `systemContent` as a `[PRIOR CONVERSATION — ...]` block — heads (2500 chars) for older turns, but the **TAIL** (last 3500 chars) of the last assistant reply, because that is the actual state the work stopped at (a model shown only the *start* of its old reply re-derives "I must build the project" and restarts). A `[CURRENT PROJECT FILES — …]` manifest of every `\`\`\`file:path` fence in the last reply tells the model the already-written tree. Then, when the message matches `isContinueIntent` (memory.ts) the resumption directive is **completeness-aware** — it computes `codingReplyIncompleteReason` against the authoritative on-disk files (then the last reply) and picks one of three:
- interrupted (`interrupted: true` / `replyLooksTruncated`) → `[CONTINUATION]` resuming EXACTLY from the last character (mid-fence/mid-sentence) — never restart;
- complete-looking but structurally incomplete → `[CONTINUATION — FINISH]`: emit ONLY the missing/unfinished files, do not rebuild;
- genuinely complete → `[ALREADY COMPLETE]`: do NOT regenerate — make only a specifically-requested change (re-emitting just the modified files), else confirm the project is done and list what was built. This is the fix for "every time I type continue it rewrites the whole thing."

**Authoritative on-disk project state:** the frontend re-registers each build via `POST /api/project/save`, so coding "continue" requests now carry `projectId` (the active `preview.id`) in the body. When set, `/api/chat` reads the REAL files from `generated-projects/<id>/` (`readProjectFiles` in project.ts — sanitizes the id, bounded to `MAX_FILES`/`MAX_FILE_BYTES`) and injects them verbatim as a `[PROJECT CURRENT STATE — …]` block (budget-capped by `ENZO_PROJECT_CONTEXT_CHARS`, default 150000, later files prioritized; dropped files flagged as unchanged). The model therefore extends the *actual current code* — even parts of the previous reply the context had to truncate — and build-verify re-`save`s the merged result. This is the definitive fix for "continue my project" restarting from scratch. The agent tool-loop path keeps its own `history: chatHistory` threading. The frontend preserves interrupted output: on `[Server Error: ...]`, AbortError (Stop), or a generic stream error, `TerminalSection.tsx` stores the already-streamed partial as an `interrupted: true` assistant message (error appended as a trailing notice) instead of discarding it, **re-registers the partial via `syncPreviewFromText(fullText, true)` so the preview panel keeps the produced files**, and sends `interrupted` per message in `body.messages` so the backend can detect it.
- **Editing OLD saved projects** (`findEditTargetTask` in TerminalSection.tsx): a prompt can target any of the user's saved My Projects tasks, not just the current one. Two ways — the drawer **Edit** button pins the task explicitly, or a **free-form mention** is matched against the localStorage task store: exact task-title mention (≥3 chars) scores +5, each distinctive token (≥5 chars, filtered by `EDIT_STOP_WORDS`) present in a task's title/filenames/content scores +1. A non-title match additionally needs an edit-intent verb (`EDIT_INTENT_RE` — edit/update/change/modify/tweak/redo/rewrite/refactor/adjust/improve/extend/continue/fix/add/remove/replace/style/restyle/redesign/transform/revamp/theme; fresh-build verbs like *build/create/generate/make* are deliberately excluded) plus a strict winner over the second-best task — so "build a basketball scoreboard site" never hijacks the basketball task, while "update the basketball keeper to glow red" does. Matched tasks pin `sessionProjectIdRef`, preview via `commitPreview`, switch to coding mode, and show the `Editing: <title>` banner for that send. The request body then carries the matched task's `projectId` AND `projectFiles` (`{path, content}` entries, ≤60 files / 140,000 chars each) so the backend has the files even when the on-disk container is gone (preview-only or deleted tasks). Backend-side, `[PROJECT CURRENT STATE]` injection now also fires **on the session's first message** whenever `chatMode === 'coding' && projectId` (not just after a prior build reply), falling back to `body.projectFiles` when `readProjectFiles(projectId)` returns nothing — so "edit my old X" works even with zero prior context in the session.

The **agent tool-loop path has the same protection** (`agent-tools.ts`): `runAgentLoop` now reads `AgentLoopArgs.maxTokens` (index.ts passes mode-derived tokens — e.g. 32768 for coding — instead of the old hardcoded 1500) and `AgentLoopArgs.mode`. Each `streamTurn` captures `finish_reason === 'length'`, and the loop's `emitFinalAnswer` helper auto-continues (default 6 rounds) when the final turn truncated `AND/OR` (coding mode) ended inside an open code fence — it appends the partial text as an assistant turn plus a `[CONTINUATION]` user turn and re-runs a clean tools-off turn, so Gemini/Cloudflare/tool-capable models that end mid-project through the agent loop keep generating too. Both the `!toolCalls.length` early-answer and the iteration-cap wrap-up route through `emitFinalAnswer`.

## Environment variables

Prefer env vars over hardcoding keys — all provider keys load from `.env` (gitignored) at boot:

| Variable | Used for |
|----------|----------|
| `GROQ_API_KEY` | **Optional.** Server-side Groq key (chat + meme engine). The server boots and runs in keyless BYOK mode without it — Groq models become usable when the user adds their own key via the Vault, or when this key is set. |
| `GROQ_MEME_API_KEY` | Meme engine (optional separate Groq key) |
| `POLLINATIONS_API_KEY` | MiniMax chat + image gen |
| `OPENROUTER_API_KEY` | OpenRouter chat + `/api/v1` tunnel |
| `NVIDIA_API_KEY` | NVIDIA NIM chat/vision |
| `HF_TOKEN` | HuggingFace Inference |
| `EXA_API_KEY` | Exa search (optional) |
| `LLM7_API_KEY` | **Required to use LLM7 models.** Free token from dash.llm7.io. No anonymous tier — ENZO refuses keyless LLM7 calls (the gateway serves a rotating shared model otherwise, so you'd get a different model than selected). Raises 30 → 120 RPM |
| `LLM7_API_BASE_URL` | LLM7 base URL override (default `https://api.llm7.io/v1`) |
| `GEMINI_API_KEY` | **Required to use google/ (Gemini) models.** Free key from aistudio.google.com/apikey. No anonymous tier — keyless requests 404. Free Flash/Flash-Lite tier only (~5–15 RPM, 250K TPM, up to ~1,500 RPD per project); Pro needs billing |
| `PUTER_AUTH_TOKEN` | **Required to use puter/ models.** Auth token created at puter.com/dashboard ("Create token"). User-pays gateway — every chat call bills the END USER's Puter account (free monthly credits first), never a direct ENZO charge |
| `CLOUDFLARE_API_TOKEN` | **Required to use cloudflare/ (Workers AI) models.** API token created at dash.cloudflare.com/profile/api-tokens with `Workers AI:Edit` (+ `Free Workers AI` entitlements). Keyless catalog returns `[]`. Account id auto-discovered from the token |
| `CLOUDFLARE_ACCOUNT_ID` | Workers AI account id (e.g. `a1b2c3d4…`). **Optional** — auto-discovered from the token when absent (first account) |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | OAuth app creds (dash.cloudflare.com → My Profile → OAuth Tokens) that enable the "Continue with Cloudflare" button (`/api/auth/cloudflare`, PKCE server-side exchange). **Optional** — without them the button 503s and users fall back to dash-link paste. `CLOUDFLARE_REFRESH_TOKEN` is written back on OAuth (used for lazy access-token refresh) |
| `UNSPLASH_ACCESS_KEY` | Unsplash auto-wallpaper proxy |
| `ENZO_MASTER_KEY` | Admin auth for `/api/v1/*` and vault. Fail-closed when unset. |
| `ENZO_CORS_ORIGINS` | CORS allowlist (default `http://localhost:5173,http://localhost:5001`) |
| `ENZO_CHAT_AUTO_RETRY` | Set `0` to disable auto-retry-after-rate-limit (default enabled) |
| `ENZO_CHAT_AUTO_RETRY_MAX_MS` | Total background-wait budget for auto-retry across all pauses (default `600000` = 10 min) |
| `ENZO_STREAM_RPM_<PROV>` | Thunder-pause soft per-minute ceiling per provider (e.g. `ENZO_STREAM_RPM_NVIDIA=15`; default nvidia 15, openrouter 20, groq 30, pollinations 15, hf 20, llm7 15, google 10, puter 10, cloudflare 20) |
| `ENZO_STREAM_PAUSE_MS` | Thunder-pause length when the rolling RPM ceiling is hit mid-build (default `120000` = 2 min) |
| `ENZO_STREAM_PACING` | Set `0` to disable the thunder-pause mechanism entirely (default enabled) |
| `ENZO_PROJECT_CONTEXT_CHARS` | Budget (chars) for injecting on-disk project files into coding "continue" requests (default `150000`) |
| `PORT` | Server port (default 5001) |

## Security notes (post-2026-08-23 hardening)

Full threat model: `SECURITY.md`. Summary of what is enforced in code:

**Keys and secrets at rest**

- Browser: provider keys are **AES-256-GCM ciphertext** in `localStorage`
  (`v1.gcm.<iv>.<ct>`), sealed under a **non-extractable** `CryptoKey` held in
  IndexedDB — no JavaScript, ours or an attacker's, can export it. All reads and
  writes go through `synthetic-nature/src/lib/keyVault.ts`; a CI grep fails the
  build if any file touches `localStorage` for an `enzo.keys.*` name directly.
- Optional **passphrase mode** re-seals everything under
  PBKDF2-SHA256(600k iterations) and deletes the device key, so nothing usable
  remains at rest. Off by default — the default path adds no prompt.
- Server: token files (`.gmail-tokens.json`, `cloudflare-plan-tier.json`) are
  sealed by `crypto-store.ts` (AES-256-GCM, scrypt-derived key, `mode 0o600`).
  Legacy plaintext files are read once and re-written sealed.

**Auth**

- Vault endpoints (`GET/POST /api/vault/keys`, `POST /api/v1/sync`, tunnel,
  memory, skills) require `ENZO_MASTER_KEY` or the browser's vault session
  token — no anonymous access. The token is now HMAC'd over a rolling 12-hour
  window, so it expires on its own (previous window still accepted, so nothing
  breaks mid-session).
- Google auth **fails closed**: with `JWT_SECRET` unset the three auth routes
  return `503` instead of issuing forgeable tokens. `jwt.verify` pins
  `algorithms: ['HS256']`.
- Gmail/Calendar OAuth carries a single-use expiring `state`; `/status` and
  `/disconnect` require vault access, and POSTs require an `x-enzo-csrf` header.
- Vault GET returns **masked** values only; plaintext never crosses
  backend ↔ frontend in that direction.

**Isolation**

- The live-preview iframe is `allow-scripts` **without** `allow-same-origin`, so
  LLM-generated code gets an opaque origin and cannot read `parent.localStorage`.
  Both tokens together would nullify the sandbox — do not re-add it.
- Generated projects are spawned with an **explicit env allowlist**, not
  `{...process.env}`, so no provider key, `JWT_SECRET` or `ENZO_MASTER_KEY`
  crosses into code a model wrote.

**Transport and limits**

- `trust proxy` is set to 1 hop, so `req.ip` is the real caller behind the
  Cloudflare tunnel and rate-limit buckets no longer collapse into one.
- Rate limiting: in-memory buckets on `/api/ping-model` (30/min),
  `/api/catalog-recommend` `/api/vision/analyze` `/api/image/generate` (20/min),
  `/api/vault/*` (10/min).
- Headers: `nosniff`, `Referrer-Policy`, `X-Frame-Options`,
  `Strict-Transport-Security`, `Permissions-Policy`, and a
  **`Content-Security-Policy-Report-Only`** (report-only on purpose — see the
  comment at the header block before enforcing).
- CORS restricted to `ENZO_CORS_ORIGINS`; global Express error handler scrubs
  stack traces.
- Pentest: `npm run pentest` (or `bash scripts/pentest.sh`) black-box checks the
  running server — 10 checks covering vault auth, CORS, rate limits, error leaks.

**Gesture control is not shipping.** The MediaPipe code is quarantined, unwired,
in `synthetic-nature/src/features/gesture/` (see its `README.md` for the two
bugs that block it). It is on `main` like everything else — there is no
`feature/gesture-beta` branch, and `GestureBetaBadge` is not mounted anywhere.
It is also deliberately not advertised in the product.

## Coding conventions

### Backend (TypeScript)

- ESM imports with `.js` extension for local modules (`./search.js`)
- Run via `tsx` — no separate build step
- Keep API keys server-side only; never expose them in anything served to the browser
- Image prompts auto-enhanced in `enhanceImagePrompt()` for photorealism
- Pollinations errors parsed in `parsePollinationsError()` — extend there for new error shapes
- `StreamSanitizer` (index.ts) strips `<think></think>`/tool-XML tags from non-reasoning Groq streams

### Frontend (React + Vite, `synthetic-nature/`)

- Vite dev server (`npm run dev`, port 5173) — hot reload, no manual script ordering
- Components in `src/components/` (e.g. `TerminalSection.tsx` — chat client, SSE parsing, modes, live preview); shared logic in `src/lib/` (`keyVault.ts`, `modelPeer.ts`, `vaultToken.ts`, `codeStorage.ts`, `keyStore.ts`)
- Chat API is called via relative `/api/chat` paths through the Vite proxy — no hardcoded backend URL
- Keys live in the encrypted Vault (`keyVault.ts`) — never in component state or localStorage plaintext
- DedSec theme: monospace fonts, green-on-black, scanlines — match existing CSS patterns

### When adding a new chat provider

1. Add a `fetchXModels` scraper in `src/models/model-sync.ts` and register it in the `Promise.allSettled` sync list
2. Add routing in `resolveModelRoute()` in `index.ts` (`provider` + stream implementation)
3. Add per-provider pacing defaults in `src/models/throttle.ts` if the provider rate-limits
4. Document the key in the env table above and `.env.example`; add Vault support frontend-side
5. Test with `curl -N -X POST http://localhost:5001/api/chat -H 'Content-Type: application/json' -d '{"message":"hi","chosenModel":"your-id"}'`

### When changing app settings

- Settings are React state in the app (mode toggles, theme, meme frequency live in components) — trace the toggle you're changing from its UI component
- Persisted user data keys live in `synthetic-nature/src/lib/` (`codeStorage.ts`, `keyVault.ts`) — check how each stores before adding a new one

## Common tasks for OpenCode agents

### Start / restart server

```bash
lsof -i :5001 -t | xargs kill 2>/dev/null; cd /Users/aditya/backend && npm start
```

If port in use, server logs `EADDRINUSE` with kill instructions.

### Debug chat streaming

- Watch terminal for `-> API HIT! model=[...]`
- Frontend shows `[ NO SIGNAL — CHECK BACKEND ON PORT 5001 ]` if stream empty
- Groq quota errors surface as `[Server Error: ...]` in SSE

### Debug image generation

- Models try in order: text2img `zimage` → `flux`; img2img `klein` → `flux`
- 402 / insufficient Pollen → user must top up at enter.pollinations.ai
- Paid models (`nanobanana`, etc.) require Pollen balance

### Web search

- Free DuckDuckGo HTML scrape in `search.ts` — fragile if DDG changes HTML
- Auto-trigger heuristics in `shouldAutoSearch()` — extend regex there
- Settings: `webSearch`: `auto` | `on` | `off`

## What NOT to do

- Do not expose API keys in frontend or commit `.env` with real keys
- Do not claim CLAUDE-S is real Anthropic Claude — it is Groq Llama with style prompting
- Do not remove `StreamSanitizer` without ensuring all models use parsed reasoning
- Do not set dedsec-cursor z-index above settings panel (100010) without testing ✕ close button
- Avoid large refactors (React, Vite) unless explicitly requested — this is intentionally simple
- Do not create commits unless the user asks

## Testing checklist

After backend changes:

1. `npm start` — confirm `-> listening on http://localhost:5001`
2. Chat default model responds
3. MiniMax (`chosenModel: minimax`) streams reasoning + content
4. Image gen text2img returns `dataUrl`
5. Settings panel opens/closes (Escape, ✕, backdrop)
6. Meme overlay respects frequency setting

## Related docs

- `README.md` — start here: what ENZO is, clone → `.env` → run, the repo map
- `SECURITY.md` — threat model, what the AES-256 layer does and does not defend
  against, how to report an issue
- `docs/PROJECT_REPORT.md` — full technical report (architecture, status, limitations)
- `docs/GUIDEBOOK.md` — driving OpenCode on this repo. The user-facing guide
  now lives **in the product**, under the Docs tab on the homepage
  (`synthetic-nature/src/content/docs.ts`) — edit it there, not here, so
  visitors actually see it.

## OpenCode usage

From this directory:

```bash
cd /Users/aditya/backend
opencode          # or: opencode .
```

Use **Plan** agent to explore; **Build** agent to implement. Reference this file for routing and conventions. For user-facing behaviour, read `synthetic-nature/src/content/docs.ts` — the in-product docs.
