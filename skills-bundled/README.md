# skills-bundled/ — hardcoded coding-skill library

Vendored into the CODING agent so coding mode always carries production-grade
specialist guidance with no runtime learn step.

## Specialist library — jeffallan/claude-skills

- 67 `SKILL.md` modules copied as-is (bodies only; the upstream `references/`
  docs trees are not vendored to keep the repo small).
- Loaded by `bundled-skills.ts` and auto-applied to coding requests by token
  matching (`buildCodingSkillContext` in `/api/chat`).
- License: MIT (Jeff Allan, https://github.com/jeffallan/claude-skills).
- To refresh: `git clone --depth 1 https://github.com/jeffallan/claude-skills`,
  copy each `skills/<name>/SKILL.md` → `skills-bundled/<name>/SKILL.md`.

## Ponytail doctrine + one-shot sub-skills — dietrichgebert/ponytail

- Main `ponytail` skill is **always active on every coding response** (condensed
  always-on block injected by `buildAlwaysOnPonytail` in `bundled-skills.ts`),
  not trigger-matched — a "lazy senior dev" minimalism doctrine, balanced by an
  explicit SCOPE line so it never trims the DESIGN STANDARD or requested polish.
- The five one-shot sub-skills are trigger-matched like any specialist:
  `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`,
  `ponytail-help` (spaced, hyphenated, or concatenated forms all match).
- License: MIT (Dietrich Gebert, https://github.com/dietrichgebert/ponytail).
- To refresh: clone https://github.com/dietrichgebert/ponytail, copy each
  `skills/<name>/SKILL.md` → `skills-bundled/<name>/SKILL.md`.