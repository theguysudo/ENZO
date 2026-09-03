#!/usr/bin/env node
/**
 * check-tracked-imports.mjs — fails if any tracked source file imports a file
 * that git does not track.
 *
 * Why this exists: 13 of the 18 modules `index.ts` imports, plus most of
 * `synthetic-nature/src`, were never `git add`ed. A fresh clone could not boot
 * the backend or build the frontend, and nothing caught it — `tsx` transpiles
 * per-file and CI ran against a working tree that already had the files on disk.
 * This makes that class of bug structural instead of vigilance-dependent.
 *
 * Run: node scripts/check-tracked-imports.mjs      (exit 1 on any miss)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);

const tracked = new Set(git('ls-files'));
// archive/ is retired code: nothing live imports it and tsconfig does not include
// it, so a fresh clone builds fine without its dangling imports resolving.
const sources = [...tracked].filter(
  (f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !f.includes('/dist/') && !f.startsWith('archive/'),
);

// Bare `from '...'` / `import('...')` / `require('...')` specifiers.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
// tsx and Vite both accept an extensionless or `.js`-suffixed specifier for a
// `.ts` source, so every candidate spelling has to be tried before calling a miss.
const CANDIDATES = (p) => [
  p,
  ...(p.endsWith('.js') ? [p.slice(0, -3) + '.ts', p.slice(0, -3) + '.tsx'] : []),
  ...(p.endsWith('.jsx') ? [p.slice(0, -4) + '.tsx'] : []),
  `${p}.ts`, `${p}.tsx`, `${p}.d.ts`,
  `${p}/index.ts`, `${p}/index.tsx`,
];

const misses = [];
for (const file of sources) {
  const dir = path.dirname(file);
  let src;
  try {
    src = readFileSync(path.join(repo, file), 'utf8');
  } catch {
    continue; // staged-deleted; not our problem
  }
  for (const [, spec] of src.matchAll(SPEC)) {
    let target;
    if (spec.startsWith('./') || spec.startsWith('../')) target = path.posix.join(dir, spec);
    // `@/x` is the Vite alias for synthetic-nature/src/x (vite.config.ts).
    else if (spec.startsWith('@/')) target = path.posix.join('synthetic-nature/src', spec.slice(2));
    else continue; // bare specifier → node_modules, not ours to track

    if (!CANDIDATES(target).some((c) => tracked.has(c))) misses.push(`${file} → ${spec}`);
  }
}

if (misses.length) {
  console.error(`::error::${misses.length} import(s) point at files git does not track:`);
  for (const m of misses) console.error(`  ${m}`);
  console.error('\nA fresh clone cannot build. Run: git add <the missing files>');
  process.exit(1);
}
console.log(`✔ every relative import in ${sources.length} tracked source files resolves to a tracked file`);
