# ENZO Guidebook — working on this repo with OpenCode

Repo-local notes for driving [OpenCode](https://opencode.ai) on ENZO. This is
the only thing left in this file; everything else it used to hold now lives
somewhere better:

| Looking for | Read |
|---|---|
| How to **use** ENZO — setup, the three surfaces, models, agent tools, security, FAQ | The **Docs** tab on the homepage. Source of truth: `synthetic-nature/src/content/docs.ts` — **edit it there**, not here. |
| Clone → `.env` → run, and the repo map | [`README.md`](./README.md) |
| Threat model, what the encryption does and does not cover | [`SECURITY.md`](./SECURITY.md) |
| Architecture, technical debt | [`PROJECT_REPORT.md`](./PROJECT_REPORT.md) |
| Conventions and don'ts for coding agents | [`AGENTS.md`](./AGENTS.md) |

> **Why the user guide and developer guide are gone from this file.** The user
> guide moved into the product, where visitors can actually find it. The
> developer guide described a `public/` folder of hand-written HTML and JS —
> an architecture this repo has not had for a long time. Stale instructions are
> worse than none, so it was deleted rather than half-corrected.

---

## Install OpenCode

```bash
# macOS
brew install anomalyco/tap/opencode

# Or install script
curl -fsSL https://opencode.ai/install | bash
```

## Connect a provider

Inside the OpenCode TUI:

```
/connect
```

Pick a provider (Groq, Anthropic, OpenCode team models, …) and authenticate.

## Point it at this repo

```bash
cd /Users/aditya/backend
opencode
```

The conventions live in [`docs/AGENTS.md`](./AGENTS.md) (there is no `AGENTS.md`
at the repo root) — load it into the session explicitly. It carries the
conventions, the routing map and the don'ts.

**Do not run `/init` casually.** It scans the repo and rewrites `AGENTS.md`, and
this project's copy is hand-written and load-bearing. If you do run it, diff the
result before committing.

## Agents

| Agent | Use for |
|-------|---------|
| **Build** (Tab) | Implement features, fix bugs, edit files |
| **Plan** (Tab) | Read-only exploration, architecture questions |
| **@general** | Multi-step search across the repo |

Plan first on anything touching `index.ts` (~6.1k lines) or
`TerminalSection.tsx` (~4.9k) — both are high-traffic and neither is split, on
purpose. See `docs/PROJECT_REPORT.md` §7.

## Files to read first

| Priority | File | Why |
|----------|------|-----|
| 1 | `docs/AGENTS.md` | Conventions, routing, don'ts |
| 2 | `docs/README.md` | What the project is, how to run it, repo map |
| 3 | `index.ts` | Every backend route. Has a navigation map in its header |
| 4 | `synthetic-nature/src/App.tsx` | View state, nav, marketplace, vault |
| 5 | `synthetic-nature/src/components/TerminalSection.tsx` | Chat client, SSE parsing, modes, live preview |
| 6 | `docs/SECURITY.md` | Read before touching keys, auth, the sandbox or child processes |
| 7 | `docs/PROJECT_REPORT.md` | Architecture and the real debt list |

## Example prompts that fit this codebase

**Understand it:**

```
Read docs/AGENTS.md and docs/README.md, then trace one chat message from TerminalSection.tsx
through the backend to the provider and back, naming every SSE event on the way.
```

**Fix a bug at the root:**

```
Users report the model status dot is wrong for one provider. Find where the dot's
state is computed, check every caller, and fix it once where they all route through.
```

**Add a feature:**

```
Add a provider to the catalog. Four places, in this order: a fetcher in
`model-sync.ts` so its models enter the catalog, a stream adapter in `index.ts`
next to the existing ones, a probe in `health.ts` so the status dot is real, and
a key field in the Vault. Do not add tests unless I ask.
```

**Safe refactor:**

```
Extract the per-provider stream adapters out of index.ts into one module.
Behaviour must not change; run `npm run typecheck` and `npm test` before you finish.
```

## Before you finish anything

```bash
npm run typecheck && npm run check:imports && npm test
```

`check:imports` exists because 13 modules `index.ts` imports were once untracked
by git — `tsx` resolves imports at runtime, so nothing else catches it until a
clean clone fails to boot.

Frontend:

```bash
cd synthetic-nature && npx tsc --noEmit && npm run build
```

`noUnusedLocals` is on there, so a leftover import is a build failure, not a
warning.

## Rules files

| Tool | Project rules file |
|------|---------------------|
| OpenCode | `AGENTS.md` (root) |
| Cursor | `.cursor/rules/`, user rules |

Same file serves both.

## Committing

Agents edit; **you** commit. There are no pre-commit hooks, so nothing catches a
bad commit for you — run the checks above first.

---

*Full technical report: [PROJECT_REPORT.md](./PROJECT_REPORT.md). Agent
conventions: [AGENTS.md](./AGENTS.md).*
