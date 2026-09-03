/**
 * bundled-skills.ts — the read-only skill library that ships with the repo.
 *
 * Owns: `loadBundledSkills`, `listBundledSkills`, `buildCodingSkillContext`, and
 * the `skills-bundled/` directory they read.
 * Called by: index.ts (the coding-mode prompt builder).
 *
 * The counterpart to skills.ts: that one holds what a user taught this install
 * (gitignored, mutable); this one holds ~67 vendored specialist `SKILL.md`
 * modules that are committed and never written to, so coding mode carries domain
 * guidance with no learn step and no network call. Both parse the same format —
 * `parseSkillMd` is imported from skills.ts rather than duplicated.
 *
 * `skills-bundled/` is 2.1 MB and IS tracked; the module loads it at boot, so an
 * untracked copy means a fresh clone silently loses coding guidance.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSkillMd } from '../skills/skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Hardcoded skill library for the CODING agent — vendored from real Claude Code
 * skill repos (jeffallan/claude-skills: 67 specialist SDM/`SKILL.md` modules) so
 * the coding prompt carries production-grade domain guidance WITHOUT a runtime
 * learn step. Files live at `skills-bundled/<name>/SKILL.md` and are committed
 * with the repo (unlike the user-taught `skills/` store, which is gitignored).
 */
// skills-bundled/ stayed at the repo root when the sources moved into src/, so
// this resolves up out of src/skills/ rather than beside this file.
export const BUNDLED_SKILLS_DIR = path.resolve(__dirname, '../../skills-bundled');

export interface BundledSkill {
  id: string;          // module dir name (e.g. react-expert)
  name: string;        // frontmatter name (title-cased)
  description: string; // frontmatter description
  keywords: string[];  // trigger tokens (metadata.triggers + description)
  instructions: string;// full SKILL.md body
  domain: string;      // frontmatter metadata.domain (frontend/backend/language/…)
}

let cache: BundledSkill[] | null = null;
let cacheWarned = false;

/** Scan `skills-bundled` subdirectories for SKILL.md once at boot and parse each module. */
export function loadBundledSkills(): BundledSkill[] {
  if (cache) return cache;
  const found: BundledSkill[] = [];
  if (!fs.existsSync(BUNDLED_SKILLS_DIR)) {
    if (!cacheWarned) console.error(`[bundled-skills] ${BUNDLED_SKILLS_DIR} missing — no hardcoded coding skills injected`);
    cacheWarned = true;
    cache = [];
    return cache;
  }
  for (const entry of fs.readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(BUNDLED_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const parsed = parseSkillMd(raw, entry.name);
      // metadata.triggers: a comma-separated line inside the YAML frontmatter
      // ("  triggers: React, JSX, hooks, …") — the richest matching signal.
      const triggersMatch = raw.match(/^\s*triggers:\s*(.+)$/m);
      const triggers = triggersMatch
        ? triggersMatch[1].split(/[,\n]/).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 24)
        : [];
      const domainMatch = raw.match(/^\s*domain:\s*(.+)$/m);
      const domain = domainMatch ? domainMatch[1].trim() : '';
      const keywordSet = new Set<string>(triggers);
      for (const k of parsed.keywords) keywordSet.add(k);
      found.push({
        id: entry.name,
        name: parsed.name,
        description: parsed.description.slice(0, 500),
        keywords: [...keywordSet].slice(0, 32),
        instructions: parsed.instructions,
        domain,
      });
    } catch (err) {
      console.error(`[bundled-skills] failed to parse ${skillFile}:`, err);
    }
  }
  cache = found.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`[bundled-skills] loaded ${cache.length} hardcoded coding skills`);
  return cache;
}

/** Generic role/scope suffixes that never signal a tech name in a skill id
 *  (react-expert → "react", javascript-pro → "javascript", api-designer → "api"). */
const ROLE_SUFFIX_TOKENS = new Set([
  'pro', 'expert', 'specialist', 'engineer', 'developer', 'architect', 'guardian',
  'designer', 'master', 'wizard', 'fool', 'miner', 'harness', 'junior', 'senior',
  'leetcode',
]);

/** Lightweight tokenizer matching memory.ts/skills.ts scoring (used for matching). */
function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .replace(/`/g, ' ')
    .replace(/[^a-z0-9+._-]+/g, ' ')
    .split(' ')
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 3);
}

/**
 * Match the coding request against the hardcoded library (stem-tolerant
 * token overlap, same semantics as buildSkillContext):
 *  - "Strong" skills (ratio ≥ 0.5 or ≥ 3 overlapping tokens vs the request)
 *    get their FULL SKILL.md injected with a "● APPLY NOW" directive.
 *  - Additional candidates are listed by ID so the coding agent can pull any of
 *    them mid-stream via <use_skill>ID</use_skill> (SkillSignalFilter handles it).
 * Returns '' when nothing matches.
 */
export function buildCodingSkillContext(userMessage: string, opts?: { maxSkills?: number }): string {
  const skills = loadBundledSkills();
  if (!skills.length) return '';
  const userTokens = tokenize(userMessage);
  if (!userTokens.length) return '';

  const blocks: string[] = [];

  // ── Always-on ponytail (hardcoded minimalism doctrine) ────────────────────
  // ponytail is ACTIVE EVERY CODING RESPONSE by default (full level): the lazy
  // senior dev who writes the shortest solution that works. Its own SKILL.md
  // asserts persistence, so the hardcoded version rides along on every coding
  // prompt — balanced against the coding DESIGN STANDARD below (ponytail
  // governs implementation, not product polish).
  const ponytailMain = skills.find((s) => s.id === 'ponytail');
  if (ponytailMain) {
    blocks.push(buildAlwaysOnPonytail(ponytailMain, userMessage));
  }

  // ── Always-on UI/UX design intelligence ───────────────────────────────────
  // The ui_search tool + design database is a core coding-mode capability (like
  // Claude Code's design sense), so its guide rides EVERY coding prompt — the
  // model must always know it can query palettes/fonts/styles/UX rules on
  // demand. Full guide injected (it is compact and its whole value is teaching
  // the tag syntax + when to search).
  const uiux = skills.find((s) => s.id === 'ui-ux-pro-max');
  if (uiux) {
    blocks.push(
      '[UI/UX PRO MAX — DESIGN DATABASE, ALWAYS AVAILABLE IN CODING MODE]',
      uiux.instructions.trim(),
      '',
    );
  }

  // ── Triggered ponytail family (one-shot sub-skills + full/ultra modes) ────
  const family = skills.filter((s) => s.id.startsWith('ponytail'));
  const familyUserTokens = userTokens.slice();
  const explicitLazy = /ponytail|be lazy|lazy mode|laziest|simplest solution|minimal solution|yagni|do less|shortest path|over-engineering|over-engineered|boilerplate|bloat|unnecessary depend|simplif/i;

  // Sub-skills match their purpose word (audit / review / debt / gain / help),
  // whether written spaced ("ponytail review"), hyphenated ("ponytail-audit"),
  // or concatenated ("ponytailaudit" — the tokenizer strips hyphens).
  const wanted = family.filter((s) => {
    if (s.id === 'ponytail') return false; // handled separately below
    const suffix = s.id.replace(/^ponytail[-_]/i, '').replace(/[-_]/g, '');
    const sufTokens = tokenize(suffix).filter((t) => !ROLE_SUFFIX_TOKENS.has(t));
    if (sufTokens.some((s2) => familyUserTokens.some((t) => s2 === t || (t.length >= 5 && s2.length >= 5 && (s2.startsWith(t) || t.startsWith(s2)))))) return true;
    if (new RegExp(`ponytail[\\s_-]?(?:${suffix})(?:\\s|$|[-_])`, 'i').test(userMessage)) return true;
    return false;
  });
  const familyApplied: string[] = [];
  for (const s of wanted) {
    familyApplied.push(s.id);
    blocks.push(
      `● APPLY NOW — Skill: ${s.id} (${s.domain || 'specialist'})`,
      `  ${s.description}`,
      `  Guide:\n${indent(s.instructions.slice(0, 2200), '    ')}`,
      ''
    );
  }

  // Full main ponytail guide only when lazy mode is explicitly invoked AND no
  // sub-skill already carried the full detail — the always-on condensed block
  // above covers everyday requests.
  if (familyApplied.length === 0 && explicitLazy.test(userMessage)) {
    const main = family.find((s) => s.id === 'ponytail');
    if (main) {
      familyApplied.push(main.id);
      blocks.push(
        `● APPLY NOW — Skill: ${main.id} (${main.domain || 'specialist'}) — FULL GUIDE`,
        `  ${main.description}`,
        `  Guide:\n${indent(main.instructions.slice(0, 2200), '    ')}`,
        ''
      );
    }
  }

  // ── Tech-specialist matching (unchanged) ──────────────────────────────────
  // The ponytail family + always-on ui-ux-pro-max are handled above — keep them
  // out of generic scoring so they never double-inject or show as a menu item.
  const nonFamily = skills.filter((s) => !s.id.startsWith('ponytail') && s.id !== 'ui-ux-pro-max');

  const hits = (skillTokens: string[]): number =>
    userTokens.reduce((acc, t) => (skillTokens.some((s) => s === t || (t.length >= 5 && s.length >= 5 && (s.startsWith(t) || t.startsWith(s)))) ? acc + 1 : acc), 0);

  const scored = nonFamily
    .map((s) => {
      const skillTokens = tokenize(`${s.name} ${s.keywords.join(' ')} ${s.description}`);
      const overlap = hits(skillTokens);
      const ratio = overlap / userTokens.length;
      // The user NAMED the tech this skill is about. We key this on the skill's
      // PRIMARY token — the leading noun of its id (react / vue / fastapi /
      // postgres / debugging) — minus generic role suffixes, so "design a
      // postgres schema" fires postgres-pro and NOT api-designer/architecture-
      // designer (whose name matches the generic verb "design").
      const idTokens = tokenize(s.id.replace(/[-_]/g, ' '))
        .filter((t) => !ROLE_SUFFIX_TOKENS.has(t));
      const nameMatch = idTokens.some((s2) => userTokens.some((t) => s2 === t || (t.length >= 5 && s2.length >= 5 && (s2.startsWith(t) || t.startsWith(s2)))));
      const bonus = nameMatch ? 3 : 0;
      return { s, score: overlap + ratio + bonus, overlap, ratio, nameMatch };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // "Strong" = named the tech, or 3+ tokens hit. A standalone ratio-of-short-
  // matches is intentionally NOT strong — "build a small tool" must not inject
  // mcp-developer's full guide just because "tool" is in its keywords, and with
  // ponytail always riding coding prompts, every false positive is expensive.
  const strong = scored.filter((x) => x.overlap >= 3 || x.nameMatch);
  const max = opts?.maxSkills ?? 2;
  // Prefer explicitly-named skills first, then highest-scored.
  const autoApply = [...strong]
    .sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.score - a.score)
    .slice(0, max);
  // Dedupe by skill domain so "react" + "angular-architect" don't both inject
  // full guides over the same frontend ground.
  const appliedDomains = new Set(autoApply.map((x) => x.s.domain));
  const appliedIds = new Set([...autoApply.map((x) => x.s.id), ...familyApplied]);
  const menuRaw = scored.filter((x) => !appliedIds.has(x.s.id));
  const menu = menuRaw
    .filter((x) => !appliedDomains.has(x.s.domain))
    .slice(0, Math.max(Math.max(strong.length, 2), 6));

  // If no specialist is strong enough to auto-apply, the coding prompt gets just
  // the ponytail doctrine (and any requested ponytail sub-skill) — never a menu
  // of coincidental matches polluting a generic request.
  if (autoApply.length === 0) {
    return blocks.join('\n').trim();
  }

  const lines: string[] = [
    '[CODING SKILLS — HARDCODED SPECIALIST LIBRARY]',
    'You carry a hardcoded library of production-grade specialist skills (vendored from Claude Code skill repos). When the request matches one, APPLY its full guide — the user should not have to ask.',
    'To load any listed skill\'s full guide mid-response, emit exactly: <use_skill>ID</use_skill>. ENZO injects that skill and your response continues seamlessly following it.',
    '',
  ];

  for (const { s } of autoApply) {
    lines.push(
      `● APPLY NOW — Skill: ${s.id} (${s.domain || 'specialist'})`,
      `  ${s.description}`,
      `  Usage guide:\n${indent(s.instructions.slice(0, 2200), '    ')}`,
      ''
    );
  }

  if (menu.length) {
    lines.push('· Other relevant skills (load via <use_skill>ID</use_skill> if any fits better than the applied one):');
    for (const { s } of menu) {
      lines.push(`  • ${s.id} — ${s.description.slice(0, 150)}`);
    }
  }

  blocks.push(lines.join('\n').trim());
  return blocks.join('\n').trim();
}

/**
 * The always-on ponytail block for coding mode — condensed from skills-bundled/
 * ponytail. Active every coding response (default level: full) as a philosophy
 * of implementation, explicitly balanced against the coding DESIGN STANDARD:
 * ponytail shortens code/deps/speculative features, never the required product
 * polish or requested scope.
 */
function buildAlwaysOnPonytail(ponytail: BundledSkill, userMessage: string): string {
  let level = 'full';
  if (/\bultra|laziest|extremely|lazy mode\b/i.test(userMessage)) level = 'ultra';
  else if (/\blite\b|light|lazy-ish/i.test(userMessage)) level = 'lite';

  const levelLine = level === 'full'
    ? 'Default level: FULL (the ladder below is enforced).'
    : `Requested level: ${level.toUpperCase()}. ${level === 'ultra' ? 'YAGNI extremist — deletion before addition, challenge the requirement before building.' : 'Lite — build what is asked, but name the lazier alternative in one line.'}`;

  return [
    '[PONYTAIL — LAZY SENIOR DEV, ALWAYS ACTIVE]',
    'You are additionally a lazy senior developer: lazy means efficient, never careless. ACTIVE EVERY CODING RESPONSE at default full level; do not drift back into over-building. ' + levelLine,
    'Climb the ladder and stop at the first rung that holds:',
    '1. Does this need to exist at all? Speculative need = skip it, say so in one line (YAGNI).',
    '2. Already in this codebase (helper/util/pattern)? Reuse it before rewriting.',
    '3. Does the standard library do it? Use it.',
    '4. Does the native platform feature cover it? `<input type="date">` over a picker lib, CSS over JS, a DB constraint over app code.',
    '5. Already-installed dependency? Use it — never add a new dependency for what a few lines do.',
    '6. Can it be one line? One line.',
    '7. Only then: the minimum code that works.',
    'Rules: no unrequested abstractions (one-impl interface, one-product factory, config that never changes); deletion over addition; boring over clever; fewest files possible; shortest working diff that still meets the spec. Bug fix = root cause in the shared place, not a guard in every caller. Mark deliberate cuts with a `ponytail:` comment naming the ceiling and upgrade path. Nontrivial logic leaves ONE runnable check (assert self-check or one small test), no frameworks.',
    'SCOPE: ponytail governs IMPLEMENTATION (code size, deps, speculative features). It does NOT relax the coding DESIGN STANDARD or requested product scope — a landing page must still be a complete polished page; polish, real content, and requested features are never "yagni".',
    'Never simplify away: input validation at trust boundaries, error/security handling, accessibility basics, or anything the user explicitly requested. User insists on full version → build it, no re-arguing.',
    '',
  ].join('\n');
}

function indent(text: string, pad: string): string {
  return text.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n');
}

/** Flat catalog (id + description + domain) for debug surfaces. */
export function listBundledSkills(): Array<Pick<BundledSkill, 'id' | 'name' | 'description' | 'domain'>> {
  return loadBundledSkills().map(({ id, name, description, domain }) => ({ id, name, description, domain }));
}