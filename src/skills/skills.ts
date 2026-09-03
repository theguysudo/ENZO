/**
 * skills.ts — the user-taught skill store.
 *
 * Owns: the `skills/` directory and its `index.json` — `listSkills`, `getSkill`,
 * `deleteSkill`, `buildSkillContext`, `learnSkillFromRepo`, `parseSkillMd`,
 * `SkillSignalFilter`, and the intent detection (`isLearnIntent`,
 * `extractRepoUrl`) that turns "learn this repo" into a clone.
 * Called by: index.ts (the /api/skills routes and the chat prompt builder),
 * tunnel.ts, bundled-skills.ts (which reuses `parseSkillMd`).
 *
 * `skills/` is gitignored: it is per-install user data. The read-only companion
 * set that ships with the repo is bundled-skills.ts / `skills-bundled/`.
 *
 * SECURITY NOTE. `learnSkillFromRepo` runs `git clone` on a URL the user supplies
 * and reads SKILL.md files out of it. Cloning is done with execFile (no shell, so
 * no argument injection) into `.skill-tmp`, and only markdown is read back —
 * nothing from the clone is executed. Keep it that way: the moment a skill can
 * carry a script, "learn this repo" becomes remote code execution.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.resolve(__dirname, 'skills');
const SKILLS_INDEX = path.join(SKILLS_DIR, 'index.json');
const TMP_CLONE_DIR = path.resolve(__dirname, '.skill-tmp');

const execFileAsync = promisify(execFile);

export interface SkillEntry {
  id: string;          // slug (repo owner/repo)
  name: string;        // human-readable name (distilled)
  sourceUrl: string;   // repo URL it was learned from
  description: string; // distilled one-liner
  keywords: string[];  // distilled trigger keywords/tags
  instructions: string;// distilled usage guide (injected when relevant)
  sourceSnapshot: string; // truncated key source content (docs/readme) for reference
  learnedAt: number;
  model: string;       // LLM used to distill
  files: string[];     // sampled file list from the repo
}

interface SkillsIndex {
  skills: SkillEntry[];
}

const EMPTY_INDEX: SkillsIndex = { skills: [] };

let indexCache: SkillsIndex | null = null;

function loadIndex(): SkillsIndex {
  if (indexCache) return indexCache;
  try {
    if (fs.existsSync(SKILLS_INDEX)) {
      const raw = JSON.parse(fs.readFileSync(SKILLS_INDEX, 'utf-8'));
      if (raw && Array.isArray(raw.skills)) {
        indexCache = raw as SkillsIndex;
        return indexCache;
      }
    }
  } catch (err) {
    console.error('[skills] Error reading skills index:', err);
  }
  indexCache = EMPTY_INDEX;
  return indexCache;
}

function persistIndex(index: SkillsIndex): void {
  try {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.writeFileSync(SKILLS_INDEX, JSON.stringify(index, null, 2), 'utf-8');
    indexCache = index;
  } catch (err) {
    console.error('[skills] Error writing skills index:', err);
  }
}

export function listSkills(): SkillEntry[] {
  return loadIndex().skills;
}

export function getSkill(id: string): SkillEntry | null {
  const norm = String(id || '').toLowerCase();
  return loadIndex().skills.find((s) => s.id.toLowerCase() === norm) || null;
}

export function deleteSkill(id: string): boolean {
  const norm = String(id || '').toLowerCase();
  const index = loadIndex();
  const idx = index.skills.findIndex((s) => s.id.toLowerCase() === norm);
  if (idx === -1) return false;
  const [removed] = index.skills.splice(idx, 1);
  persistIndex(index);
  return true;
}

/** Build a `[SKILLS — PROACTIVE]` block for the system prompt so the model can
 *  use all learned skills by need — WITHOUT the user naming them.
 *
 *  Strategy:
 *   - Auto-apply: the strongest-matching skill(s) get their FULL usage guide
 *     injected with an 'apply now' directive (no user request required).
 *   - Menu: the top candidate skills are listed by ID so the model can pull any
 *     of them mid-stream via `<use_skill>ID</use_skill>` (see SkillSignalFilter),
 *     which ENZO reloads and continues from.
 *  Returns '' when nothing matches.
 */
export function buildSkillContext(userMessage: string, opts?: { maxSkills?: number }): string {
  const index = loadIndex();
  if (!index.skills.length) return '';
  const max = opts?.maxSkills ?? 1;

  const userTokens = tokenize(userMessage);
  if (!userTokens.length) return '';

  // Stem-tolerant overlap: an exact token counts, and so does a shared root for
  // longer words ("organize"/"organizes", "file"/"files") so clearly-relevant
  // skills auto-apply without the user naming them.
  const hits = (skillTokens: string[]): number =>
    userTokens.reduce((acc, t) => (skillTokens.some((s) => s === t || (t.length >= 5 && s.length >= 5 && (s.startsWith(t) || t.startsWith(s)))) ? acc + 1 : acc), 0);

  const scored = index.skills
    .map((s) => {
      const skillTokens = tokenize(`${s.name} ${s.keywords.join(' ')} ${s.description}`);
      const overlap = hits(skillTokens);
      const ratio = userTokens.length ? overlap / userTokens.length : 0;
      return { s, score: overlap + ratio, overlap, ratio };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return '';

  // "Strong" = at least half the user's tokens hit this skill, or 3+ tokens hit —
  // confident enough to auto-apply its guide without the user asking.
  const strong = scored.filter((x) => x.ratio >= 0.5 || x.overlap >= 3);
  const autoApply = strong.slice(0, max);
  const menu = scored.slice(0, Math.max(Math.max(strong.length, 2), 6));

  const lines: string[] = [];
  lines.push(
    '[SKILLS — PROACTIVE]',
    'You have learned skills from real repositories. USE THEM PROACTIVELY: when the current request matches a skill, follow its usage guide automatically — the user should NOT have to ask for it or mention the skill.',
    'To load any listed skill\'s full guide mid-response, emit exactly: <use_skill>ID</use_skill>. ENZO injects that skill and your response continues seamlessly following it.',
    ''
  );

  if (autoApply.length) {
    for (const { s } of autoApply) {
      lines.push(
        `● APPLY NOW — Skill: ${s.name} (ID: ${s.id})`,
        `  ${s.description}`,
        s.instructions ? `  Usage guide:\n${indent(s.instructions.slice(0, 3000), '    ')}` : '',
        ''
      );
    }
  }

  if (menu.length) {
    lines.push('· Other relevant skills (load via <use_skill>ID</use_skill> if any fits better than the applied one):');
    for (const { s } of menu) {
      lines.push(`  • ${s.id} — ${s.name}: ${s.description.slice(0, 160)}`);
    }
  }

  return lines.join('\n').trim();
}

/**
 * Streaming filter that strips `<use_skill>ID</use_skill>` signals out of model
 * output as it flows, exposing them to the host instead of the user. Feed it the
 * raw token text in `process()`; it returns the viewable text (signals removed)
 * and records the most recent skill id via `skillId`. Correctly handles signals
 * split across chunk boundaries by holding back any incomplete tag.
 */
export class SkillSignalFilter {
  private pending = '';
  private _skillId: string | null = null;
  private readonly MAX_PENDING = 80;

  /** Feed a text chunk → returns viewable text with any complete signal removed. */
  process(chunk: string): string {
    this.pending += chunk;
    let out = '';
    // 1. Extract/delete complete <use_skill>ID</use_skill> signals anywhere.
    for (;;) {
      const m = /<use_skill\s*>\s*([^<]+?)\s*<\/use_skill>/i.exec(this.pending);
      if (!m) break;
      const id = m[1].trim();
      if (id) this._skillId = id;
      this.pending = this.pending.slice(0, m.index) + this.pending.slice(m.index + m[0].length);
    }
    // 2. Hold back from any tag start that hasn't closed yet; emit the rest.
    const m2 = /<\/?use_skill\s*>/i.exec(this.pending);
    if (m2) {
      out += this.pending.slice(0, m2.index);
      this.pending = this.pending.slice(m2.index);
    } else {
      out += this.pending;
      this.pending = '';
    }
    // 3. Safety valve: an unterminated signal degenerates into real text.
    if (this.pending.length > this.MAX_PENDING) {
      out += this.pending;
      this.pending = '';
    }
    return out;
  }

  /** Most recent skill id signaled so far this round (null when none). */
  get skillId(): string | null {
    return this._skillId;
  }

  reset(): void {
    this._skillId = null;
  }

  /** Emit any still-held tail (e.g. an abandoned tag) at end of stream. */
  flush(): string {
    const out = this.pending;
    this.pending = '';
    return out;
  }
}

/** True when the user is asking to teach/learn a skill from a repo. */
export function isLearnIntent(message: string): boolean {
  return /(learn|teach|add skill|new skill|install skill|teach me|give it a skill|load skill)/i.test(message);
}

/** Extract a GitHub repo URL from free text (supports full URLs, ssh forms, and
 *  `owner/repo` shorthand). Returns null when none is found. */
export function extractRepoUrl(text: string): string | null {
  const t = (text || '').trim();

  // Full URL forms
  const urlMatch =
    t.match(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/) ||
    t.match(/git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  if (urlMatch) {
    if (urlMatch[1] === 'github.com' || urlMatch[1] === 'gitlab.com' || urlMatch[1] === 'bitbucket.org') {
      const host = urlMatch[1];
      const owner = urlMatch[2];
      const repo = urlMatch[3].replace(/\.git$/, '');
      return `https://${host}/${owner}/${repo}`;
    }
    const owner = urlMatch[1];
    const repo = urlMatch[2].replace(/\.git$/, '');
    return `https://github.com/${owner}/${repo}`;
  }

  // owner/repo shorthand (only if it looks like a repo ref, not a model id)
  const shortMatch = t.match(/\b([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\b/);
  if (shortMatch && !/^(groq|openrouter|hf|nvidia|pollinations)\//i.test(t)) {
    const owner = shortMatch[1];
    const repo = shortMatch[2].replace(/\.git$/, '');
    if (owner.length > 1 && repo.length > 1) {
      return `https://github.com/${owner}/${repo}`;
    }
  }
  return null;
}

/**
 * Learn a skill from a GitHub repo:
 *  1. shallow-clone into a temp dir,
 *  2. sample key files (README, docs, entry points),
 *  3. distill a skill guide with a small LLM,
 *  4. save to the skills index.
 * Returns the saved SkillEntry, or throws a descriptive error.
 */
export async function learnSkillFromRepo(repoUrl: string, opts?: {
  groqKey?: string;
  cloneFn?: (url: string, dest: string) => Promise<void>;
  readSample?: (dir: string) => { files: string[]; snapshot: string };
}): Promise<SkillEntry> {
  const url = repoUrl.trim();
  if (!url) throw new Error('Empty repo URL');

  const ownerRepo = url.replace(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//, '').replace(/\.git$/, '');
  const id = ownerRepo.toLowerCase().replace(/[^a-z0-9/]/g, '-');

  // Reject re-learning the same repo (avoid clobbering unless forced)
  if (getSkill(id)) {
    const existing = getSkill(id)!;
    throw new Error(`Skill "${existing.name}" already learned from ${existing.sourceUrl}. Delete it first to re-learn.`);
  }

  // Clone (injectable for tests)
  const clone = opts?.cloneFn ?? (async (u: string, dest: string) => {
    await execFileAsync('git', ['clone', '--depth', '1', u, dest], { timeout: 60000 });
  });

  fs.mkdirSync(TMP_CLONE_DIR, { recursive: true });
  const cloneTarget = path.join(TMP_CLONE_DIR, `skill-${Date.now()}`);
  try {
    await clone(url, cloneTarget);

    // Sample key files from the clone
    const sample = opts?.readSample ? opts.readSample(cloneTarget) : readSample(cloneTarget);

    // Distill into a skill guide
    const groqKey = opts?.groqKey || process.env.GROQ_API_KEY || '';
    const distilled = await distillSkill(url, sample.snapshot, sample.files, groqKey);

    const entry: SkillEntry = {
      id,
      name: distilled.name,
      sourceUrl: url,
      description: distilled.description,
      keywords: distilled.keywords,
      instructions: distilled.instructions,
      sourceSnapshot: sample.snapshot.slice(0, 6000),
      learnedAt: Date.now(),
      model: 'groq/llama-3.1-8b-instant',
      files: sample.files.slice(0, 40),
    };

    const index = loadIndex();
    index.skills.unshift(entry);
    persistIndex(index);
    console.log(`[skills] Learned "${entry.name}" from ${url}`);
    return entry;
  } finally {
    fs.rmSync(cloneTarget, { recursive: true, force: true });
  }
}

export interface BundledSkillResult {
  imported: SkillEntry[];
  skipped: string[];
}

/** Claude Code bundles ship skills as `<dir>/SKILL.md` (YAML frontmatter + body).
 *  These are already distilled skill definitions, so a bundled repo can be
 *  imported directly without an LLM round-trip — preserving the author's exact
 *  instructions instead of re-synthesizing them (see `importBundledSkillsFromRepo`). */

interface ParsedSkillMd {
  name: string;
  description: string;
  keywords: string[];
  instructions: string;
}

/** Parse a SKILL.md (Claude Code / awesome-claude-skills format): a small YAML
 *  frontmatter block (`---\nname: …\ndescription: …\n---`) plus a markdown body
 *  of instructions. Tolerates missing frontmatter (falls back to the module dir
 *  name and first non-heading line). */
export function parseSkillMd(content: string, relPath: string): ParsedSkillMd {
  const fallbackName = path.basename(relPath) || 'unnamed-skill';
  let frontmatter: Record<string, string> = {};
  let body = content;

  const m = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    body = content.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        if (k && v) frontmatter[k] = v;
      }
    }
  }

  const name = (frontmatter.name || fallbackName).slice(0, 120);
  const description = (frontmatter.description || firstMeaningfulLine(body) || `Skill learned from ${relPath}.`).slice(0, 500);
  const keywords = deriveSkillKeywords(name, description);
  const instructions = body.trim().slice(0, 6000);

  return { name, description, keywords, instructions };
}

function firstMeaningfulLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith('#') && !line.startsWith('---') && line.length > 12) {
      return line.slice(0, 300);
    }
  }
  return '';
}

/** Keyword tokens from name + description, most-frequent first (max 8). */
function deriveSkillKeywords(name: string, description: string): string[] {
  const counts: Record<string, number> = {};
  for (const t of tokenize(`${name} ${description}`)) {
    counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
    .filter((t) => t.length > 2)
    .slice(0, 8);
}

/** Find every directory in a clone that holds a `SKILL.md` (a skill module).
 *  Adds the module dir and stops descending into it (its subdirs are assets). */
export function findSkillModules(dir: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.github', '.next', '.venv']);
  function walk(d: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (!e.isDirectory()) continue;
      if (SKIP.has(e.name)) continue;
      const hasSkillMd = fs.existsSync(path.join(full, 'SKILL.md')) || fs.existsSync(path.join(full, 'skill.md'));
      if (hasSkillMd) {
        found.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  }
  walk(dir, 0);
  return found;
}

/** Top-level text files inside one skill module (relative paths, capped). */
export function listSkillFiles(mod: string): string[] {
  const files: string[] = [];
  const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.lock', '.map', '.min.js']);
  function walk(d: string, depth = 0): void {
    if (depth > 2 || files.length > 40) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      const rel = path.relative(mod, full);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue;
        walk(full, depth + 1);
      } else if (!SKIP_EXT.has(path.extname(e.name))) {
        files.push(rel);
      }
    }
  }
  walk(mod, 0);
  return files;
}

/** Derive a stable `owner/repo` slug from a repo URL (matches learnSkillFromRepo ids). */
function repoSlug(url: string): string {
  return url
    .replace(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//, '')
    .replace(/\.git$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9/]/g, '-');
}

/**
 * Bulk-import a "bundled skills" repo (a single GitHub repo that ships multiple
 * Claude Code skills, like `ComposioHQ/awesome-claude-skills`). Clones once,
 * finds every `<dir>/SKILL.md`, and registers each as its own SkillEntry by
 * parsing the SKILL.md directly — no LLM distillation needed. Already-learned
 * modules are skipped (same no-clobber rule as `learnSkillFromRepo`).
 *
 * Returns { imported, skipped }; throws when the repo has no SKILL.md modules.
 */
export async function importBundledSkillsFromRepo(repoUrl: string, opts?: {
  cloneFn?: (url: string, dest: string) => Promise<void>;
  findSkillModules?: (dir: string) => string[];
  parseSkillMd?: (content: string, relPath: string) => ParsedSkillMd;
}): Promise<BundledSkillResult> {
  const url = repoUrl.trim();
  if (!url) throw new Error('Empty repo URL');

  const clone = opts?.cloneFn ?? (async (u: string, dest: string) => {
    await execFileAsync('git', ['clone', '--depth', '1', u, dest], { timeout: 90000 });
  });

  fs.mkdirSync(TMP_CLONE_DIR, { recursive: true });
  const cloneTarget = path.join(TMP_CLONE_DIR, `skills-${Date.now()}`);
  try {
    await clone(url, cloneTarget);

    const modules = (opts?.findSkillModules ?? findSkillModules)(cloneTarget);
    if (!modules.length) {
      throw new Error('No SKILL.md modules found in this repo — it is not a bundled-skills repo.');
    }

    const slug = repoSlug(url);
    const treeBase = `https://github.com/${slug}/tree/HEAD`;
    const imported: SkillEntry[] = [];
    const skipped: string[] = [];
    const index = loadIndex();

    for (const mod of modules) {
      const rel = path.relative(cloneTarget, mod).split(path.sep).join('/');
      const mdPath = fs.existsSync(path.join(mod, 'SKILL.md')) ? path.join(mod, 'SKILL.md') : path.join(mod, 'skill.md');
      let content: string;
      try { content = fs.readFileSync(mdPath, 'utf-8'); } catch { continue; }

      const parsed = (opts?.parseSkillMd ?? parseSkillMd)(content, rel);
      const id = `${slug}/${rel.toLowerCase()}`;
      if (getSkill(id)) { skipped.push(id); continue; }

      const entry: SkillEntry = {
        id,
        name: parsed.name,
        sourceUrl: `${treeBase}/${rel}`,
        description: parsed.description,
        keywords: parsed.keywords,
        instructions: parsed.instructions,
        sourceSnapshot: content.slice(0, 6000),
        learnedAt: Date.now(),
        model: 'bundled-skillmd',
        files: listSkillFiles(mod),
      };
      index.skills.unshift(entry);
      imported.push(entry);
    }

    persistIndex(index);
    console.log(`[skills] Bundled import from ${url}: +${imported.length} learned, ${skipped.length} skipped`);
    return { imported, skipped };
  } finally {
    fs.rmSync(cloneTarget, { recursive: true, force: true });
  }
}

/** Walk a clone and return a representative file list + a text snapshot. */
export function readSample(dir: string): { files: string[]; snapshot: string } {
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv']);
  const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.lock', '.map', '.min.js']);
  const PRIORITY = ['README', 'README.md', 'readme.md', 'readme', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'setup.py', 'setup.cfg', 'tsconfig.json', 'docs'];

  const files: string[] = [];
  const contents: string[] = [];
  let totalChars = 0;
  const MAX_SNAPSHOT = 30000;

  function walk(dirPath: string, depth = 0) {
    if (depth > 4 || totalChars >= MAX_SNAPSHOT) return;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      const rel = path.relative(dir, full);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else {
        if (SKIP_EXT.has(path.extname(e.name))) continue;
        if (e.name.startsWith('.')) continue;
        if (!/\.(md|txt|js|ts|tsx|jsx|py|json|toml|rs|go|sh|yaml|yml|css|html|mdx)$/i.test(e.name)) continue;
        files.push(rel);
        if (files.length > 60) continue;
        try {
          const content = fs.readFileSync(full, 'utf-8').slice(0, 4000);
          if (totalChars + content.length > MAX_SNAPSHOT) {
            contents.push(`\n# ...truncated...\n`);
            return;
          }
          contents.push(`\n# FILE: ${rel}\n\n${content}`);
          totalChars += content.length;
        } catch { /* binary or unreadable */ }
      }
    }
  }

  // Prioritize README/entry files first
  for (const prio of PRIORITY) {
    const p = path.join(dir, prio);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const content = fs.readFileSync(p, 'utf-8').slice(0, 6000);
      contents.unshift(`\n# FILE: ${prio}\n\n${content}`);
      totalChars += content.length;
    }
  }

  walk(dir);
  return { files, snapshot: contents.join('\n').slice(0, MAX_SNAPSHOT) };
}

/** Ask the small LLM to distill a repo snapshot into a reusable skill guide. */
async function distillSkill(repoUrl: string, snapshot: string, files: string[], groqKey: string): Promise<{
  name: string;
  description: string;
  keywords: string[];
  instructions: string;
}> {
  const fallback = {
    name: path.basename(repoUrl),
    description: `Skill learned from ${repoUrl}.`,
    keywords: [path.basename(repoUrl)],
    instructions: 'Read the source snapshot and use the repository\'s documented APIs and patterns.',
  };

  if (!groqKey || !snapshot.trim()) return fallback;

  const { Groq } = await import('groq-sdk');
  const groq = new Groq({ apiKey: groqKey, timeout: 15000, maxRetries: 0 });
  const fileList = files.slice(0, 30).map((f) => `- ${f}`).join('\n');

  const sysPrompt = `You distill GitHub repositories into reusable "skills" for an AI assistant. Given a repo snapshot, produce a JSON skill guide.

Source repo: ${repoUrl}

Files sampled:
${fileList || '- (none)'}

Repo content snapshot (first 6000 chars, prioritized samples):
${snapshot.slice(0, 6000)}

Return ONLY JSON:
{
  "name": "Short human-readable skill name (e.g. 'React Query Data Fetching')",
  "description": "One sentence: what this skill does and when to use it.",
  "keywords": ["5-8 lowercase trigger keywords/tags that match user requests, e.g. react-query, data-fetching, caching"],
  "instructions": "A practical usage guide for an AI: what the library/tool does, key APIs/functions to call, typical patterns, and common pitfalls. 150-300 words, written as instructions the assistant can follow."
}`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: `Distill a skill from ${repoUrl}. Return JSON only.` },
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    return {
      name: String(parsed.name || fallback.name).slice(0, 120),
      description: String(parsed.description || fallback.description).slice(0, 500),
      keywords: (Array.isArray(parsed.keywords) ? parsed.keywords : []).map(String).slice(0, 8),
      instructions: String(parsed.instructions || fallback.instructions).slice(0, 3000),
    };
  } catch (err: any) {
    console.error('[skills] distill failed:', err?.message || err);
    return fallback;
  }
}

/** Lightweight tokenizer mirroring memory.ts scoring for skill matching. */
const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','so','of','to','in','on','at','for','with',
  'from','by','is','are','was','were','be','been','being','it','its','this','that','these',
  'those','i','me','my','we','our','you','your','they','them','their','he','she','his','her',
  'not','no','do','does','did','have','has','had','can','could','will','would','should',
  'about','into','over','up','down','as','please','now','just','get','got','want',
  'need','like','still','there','here','what','why','how','when','where','who','which',
]);

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((l) => prefix + l).join('\n');
}
