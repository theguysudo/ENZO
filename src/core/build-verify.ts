/**
 * build-verify.ts — does the project the model just generated actually run?
 *
 * Owns: `extractProjectFiles` (pull files out of an LLM reply),
 * `verifyProject` (static checks), `bootCheckBackend` (start it and probe it),
 * `renderBuildReport`, `buildRepairContext` (turn failures into a repair prompt).
 * Called by: index.ts (the coding-mode pipeline).
 *
 * WHY IT EXISTS. An LLM will confidently emit a project that imports a package it
 * never listed, or a server that exits on boot. This module is the difference
 * between shipping the user a broken folder and telling the model what it got
 * wrong — `buildRepairContext` feeds straight back into the next turn.
 *
 * `bootCheckBackend` actually EXECUTES generated code. Both it and the real
 * runtime spawn children with the env allowlist exported from
 * project-runtime.ts (`buildChildEnv`) rather than inheriting this process's
 * secrets — see the comment there before changing how a child is started.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import { backendNodePath, buildChildEnv } from '../projects/project-runtime';

const execFileAsync = promisify(execFile);

const BACKEND_ENTRY_NAMES = ['server.js', 'server/server.js', 'server/index.js', 'api/server.js', 'api/index.js', 'backend.js'];

export interface FileEntry {
  path: string;
  content: string;
}

export interface BuildCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail?: string;
}

export interface BuildReport {
  ok: boolean;
  checks: BuildCheck[];
  errors: string[];
  warnings: string[];
}

/**
 * Parse ```file:path ... ``` fences out of a coding reply — mirrors the
 * frontend extractor (TerminalSection.tsx) so the server validates exactly
 * what the preview panel will register. Later occurrences win per path.
 */
export function extractProjectFiles(text: string): FileEntry[] {
  if (!text || typeof text !== 'string') return [];
  const byPath = new Map<string, string>();
  const re = /```file:([^\n]+?)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].trim().replace(/^\/+/, '').replace(/\\/g, '/');
    if (!p || p.includes('..') || p.length > 200) continue;
    byPath.set(p, m[2].replace(/\n+$/, ''));
  }
  return [...byPath.entries()].map(([pathStr, content]) => ({ path: pathStr, content }));
}

function isJs(pathStr: string): boolean {
  return /\.(?:js|mjs|cjs)$/.test(pathStr);
}

function isHtml(pathStr: string): boolean {
  return /\.html?$/.test(pathStr);
}

/** Loose HTML structural sanity (not a validator — a quick smoke gate). */
function checkHtmlEntry(files: FileEntry[]): { status: BuildCheck['status']; detail?: string } {
  const index = files.find((f) => f.path === 'index.html');
  if (!index) return { status: 'fail', detail: 'no index.html (the project needs a landing page)' };
  const misses: string[] = [];
  for (const tag of ['<html', '</html>', '<head', '</head>', '<body', '</body>']) {
    if (!index.content.includes(tag)) misses.push(tag);
  }
  if (misses.length > 0) return { status: 'fail', detail: `index.html missing structural tags: ${misses.join(', ')}` };
  const warnings: string[] = [];
  if (!/<meta[^>]+name=["']viewport["']/i.test(index.content)) {
    warnings.push('index.html has no <meta name="viewport"> — add one for mobile-first responsiveness');
  }
  if (!/<title>/i.test(index.content)) {
    warnings.push('index.html has no <title>');
  }
  if (/lorem ipsum/i.test(index.content)) {
    warnings.push('index.html contains "lorem ipsum" placeholder text — use real content');
  }
  const detail = warnings.length ? warnings.join('. ') : undefined;
  return { status: warnings.length ? 'warn' : 'pass', detail };
}

/** Check every local src/href reference in index.html resolves to a project file. */
function checkLocalRefs(files: FileEntry[]): { status: BuildCheck['status']; detail?: string } {
  const index = files.find((f) => f.path === 'index.html');
  if (!index) return { status: 'pass' };
  const known = new Set(files.map((f) => f.path));
  const missing: string[] = [];
  const refRe = /(?:src|href)=["']([^"'#]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(index.content)) !== null) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:') || ref.startsWith('//') || ref.startsWith('mailto:')) continue;
    const clean = ref.replace(/^\.?\//, '');
    if (!known.has(clean)) {
      if (clean.endsWith('.ico') || clean.endsWith('.png') || clean.endsWith('.svg') || clean.endsWith('.jpg') || clean.endsWith('.webp')) continue;
      missing.push(ref);
    }
  }
  if (missing.length) {
    return { status: 'fail', detail: `index.html references missing local assets: ${[...new Set(missing)].slice(0, 6).join(', ')}` };
  }
  return { status: 'pass' };
}

async function nodeCheck(content: string, pathStr: string): Promise<string | null> {
  if (content.length > 1_000_000) return `${pathStr}: file too large to syntax-check (>1MB)`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-nodecheck-'));
  const ext = /(\bimport\b[\s\S]*\bfrom\b|\bexport\b\s+(?:default\s+)?(?:const|class|function|\{|\*))/m.test(content) ? '.mjs' : '.cjs';
  const tmpFile = path.join(tmpDir, `check-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    await execFileAsync(process.execPath, ['--check', tmpFile], { timeout: 10_000 });
    return null;
  } catch (err: any) {
    const lines = String(err?.stderr || err?.message || '').split('\n');
    const relevant = lines.filter((l) => /error|SyntaxError|Unexpected|missing|\^/i.test(l) || /^\s+\^/.test(l));
    const pick = relevant.slice(0, 4).join(' | ') || lines[0] || 'syntax error';
    return `${pathStr}: ${pick.trim().slice(0, 300)}`;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function httpGetOnce(port: number, pathStr: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathStr, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

export interface BackendBoot {
  ok: boolean;
  detail?: string;
}

/**
 * Boot a generated backend exactly the way project-runtime does (NODE_PATH →
 * ENZO's node_modules, ephemeral PORT, cwd = a scratch dir with all project
 * files) and prove it answers before declaring it working.
 */
export async function bootCheckBackend(files: FileEntry[]): Promise<BackendBoot> {
  const entryInfo = BACKEND_ENTRY_NAMES.map((name) => ({ name, file: files.find((f) => f.path === name) })).find((e) => e.file);
  const entry = entryInfo?.file;
  if (!entry) return { ok: true, detail: 'no backend entrypoint present' };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-bootcheck-'));
  for (const f of files) {
    const abs = path.join(scratch, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
  }

  const port = await findFreePort().catch(() => 42100 + Math.floor(Math.random() * 500));
  // Same env contract as the live runtime: allowlist only, NODE_PATH → ENZO's
  // real node_modules (process.cwd(), not __dirname — that's src/core, which has
  // no node_modules and silently broke module resolution for boot checks).
  const childEnv = buildChildEnv(port, backendNodePath());

  let childLog = '';
  const child = spawn(process.execPath, [entryInfo!.name], {
    cwd: scratch,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d: Buffer) => (childLog += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (childLog += d.toString()));
  child.on('exit', () => { /* read after timeout below */ });

  const BOOT_TIMEOUT_MS = 8000;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let status = 0;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      status = await httpGetOnce(port, '/api/health', 1200);
      if (status === 0) status = await httpGetOnce(port, '/', 1200);
      if (status >= 200 && status < 500) {
        return { ok: true, detail: `booted on port ${port}, /api/health → ${status}` };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const tail = childLog.split('\n').filter(Boolean).slice(-8).join('\n').trim().slice(0, 600);
  const reason = child.exitCode !== null
    ? `backend crashed at startup (exit ${child.exitCode})`
    : `backend did not answer on port ${port} within ${BOOT_TIMEOUT_MS / 1000}s`;
  return { ok: false, detail: `${reason}${tail ? ` — log:\n${tail}` : ''}` };
}

/**
 * The Claude Code-style verification pass. Deterministic checks only — the
 * same tools a human would reach for: is the HTML well-formed, do local
 * references resolve, does every JS file parse, and does the backend actually
 * boot and answer. Warnings are design/polish hints;
 * errors are what force a repair round.
 */
export async function verifyProject(files: FileEntry[]): Promise<BuildReport> {
  const checks: BuildCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (files.length === 0) {
    return { ok: false, checks: [{ name: 'project files', status: 'fail', detail: 'no ```file: blocks found in the reply' }], errors: ['the reply contained no project files (no ```file:path fences)'], warnings: [] };
  }

  const jsFiles = files.filter((f) => isJs(f.path));
  const html = checkHtmlEntry(files);
  checks.push({ name: 'html structure', ...html });
  if (html.status === 'fail') errors.push(html.detail!);
  else if (html.detail) warnings.push(html.detail);

  const refs = checkLocalRefs(files);
  checks.push({ name: 'local asset refs', ...refs });
  if (refs.status === 'fail') errors.push(refs.detail!);

  const syntaxResults: string[] = [];
  for (const f of jsFiles) {
    const err = await nodeCheck(f.content, f.path);
    if (err) syntaxResults.push(err);
  }
  const cssFiles = files.filter((f) => /\.css$/.test(f.path));
  if (jsFiles.length === 0 && cssFiles.length === 0 && html.status !== 'fail') {
    checks.push({ name: 'styling', status: 'warn', detail: 'no CSS or JS at all — the page will be unstyled and static' });
    warnings.push('add at least one stylesheet (css/styles.css) and a js/app.js for interactivity');
  }
  checks.push({
    name: 'javascript syntax',
    status: jsFiles.length === 0 ? 'pass' : syntaxResults.length ? 'fail' : 'pass',
    detail: syntaxResults.length ? syntaxResults.slice(0, 5).join('\n') : `${jsFiles.length} file(s) parsed clean`,
  });
  if (syntaxResults.length) errors.push(...syntaxResults.slice(0, 5));

  // Design-polish warnings — hints, not blocks.
  if (cssFiles.length) {
    const css = cssFiles.map((f) => f.content).join('\n');
    if (!/:root\s*\{/.test(css)) {
      checks.push({ name: 'design tokens', status: 'warn', detail: 'css has no :root custom-property palette — define --primary/--accent/--bg/--surface/--text tokens' });
      warnings.push('define a :root token palette (--primary/--accent/--bg/--surface/--text) in CSS');
    }
    if (!/font-family/i.test(css) && !/fonts\.googleapis/i.test(css)) {
      checks.push({ name: 'typography', status: 'warn', detail: 'no font-family in CSS and no Google Fonts link' });
      warnings.push('pair 1-2 Google Fonts (display + body) and set font-family');
    }
  } else if (html.status !== 'fail') {
    checks.push({ name: 'design tokens', status: 'warn', detail: 'no stylesheet present' });
    warnings.push('add a cohesive stylesheet before shipping');
  }

  // Backend boot check (only when a backend entrypoint exists).
  const boot = await bootCheckBackend(files);
  checks.push({
    name: 'backend boot',
    status: boot.ok ? 'pass' : 'fail',
    detail: boot.detail || 'no backend entrypoint',
  });
  if (!boot.ok) errors.push(boot.detail || 'backend failed to boot');

  return {
    ok: errors.length === 0,
    checks,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

/** Human-readable build report for the server log / console. */
export function renderBuildReport(report: BuildReport): string {
  const lines = report.checks.map((c) => `  [${c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  return [`BUILD CHECK ${report.ok ? 'PASSED' : 'FAILED'} (${report.checks.filter((c) => c.status === 'fail').length} failing):`, ...lines].join('\n');
}

const MAX_REPAIR_CONTEXT_CHARS = 160_000;

/**
 * The message the model receives on a repair round. Mirrors Claude Code's
 * write → run → read-errors → fix loop: we hand back the build report PLUS the
 * exact current project files (as the agent would re-read them) and ask for a
 * corrected re-emit of anything broken. Prepended to system content on a fresh
 * stream call (not a continuation), so the model fully regenerates fixed files
 * and the preview's later-wins fence parsing picks up the corrections.
 */
export function buildRepairContext(report: BuildReport, files: FileEntry[], round: number, maxRounds: number): string {
  const reportText = renderBuildReport(report);
  let listing = '';
  let used = 0;
  let omitted = 0;
  for (const f of files) {
    const block = `### ${f.path}\n${f.content}\n`;
    if (used + block.length > MAX_REPAIR_CONTEXT_CHARS) {
      omitted++;
      continue;
    }
    listing += block;
    used += block.length;
  }
  if (omitted > 0) listing += `### (${omitted} more files omitted for context budget)\n`;
  return `[BUILD VERIFICATION REPORT — repair round ${round}/${maxRounds}]\n${reportText}\n\n` +
    `A build check on your project failed. Fix EVERY failing check above.\n` +
    `The current project files are below (this is what the preview registers):\n\n${listing}\n\n` +
    `[INSTRUCTION] Re-emit each defective file as a COMPLETE corrected \`\`\`file:path fence (full file, top to bottom — not diffs, not snippets). ` +
    `Only re-emit files that are actually defective. Keep every other file exactly as-is. ` +
    `Do not narrate the fixes — just emit the corrected fences and a one-line summary.`;
}