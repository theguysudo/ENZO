/**
 * update.ts — self-update for the desktop installs (.app / .exe).
 *
 * The desktop app is a normal installed app, so it can do what docker users
 * cannot: replace itself. This module owns the whole flow:
 *
 *   1. check   — read the latest GitHub release, compare against the running
 *                build, pick the asset that matches this platform.
 *   2. notify  — a REMINDER, never a nag: at most two prompts per rolling
 *                seven days, tracked in <data>/update-state.json. The banner
 *                is dismissible and the user can always keep running the old
 *                version; nothing is forced.
 *   3. apply   — download the asset, stage it, then hand the final swap to a
 *                detached helper script (the server has to exit for its own
 *                bundle to be replaced). The helper swaps the app, clears the
 *                quarantine flag, re-signs ad hoc and relaunches.
 *
 * Nothing here is destructive to user data: ALL writable state lives in the
 * per-user data dir (~/Library/Application Support/ENZO or %APPDATA%\ENZO),
 * which sits outside the app bundle, so replacing the bundle keeps memory,
 * vault keys, investigations, neural state and generated projects intact. The
 * browser tab survives too (its state is in localStorage) and simply
 * reconnects when the server comes back.
 *
 * Desktop-only by construction: every entry point is a no-op unless the app
 * was launched by desktop/launcher.js (ENZO_DESKTOP_HOME is set), so docker
 * and hosted runs never expose a self-update path.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = 'theguysudo/ENZO';
// ENZO_RELEASE_API points the check at a different release feed. It exists for
// rehearsals (a local fake release) and for enterprise mirrors; unset in the
// wild, the app always talks to GitHub.
const RELEASE_API = process.env.ENZO_RELEASE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;      // re-check at most every 6h
const REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one rolling week
const REMINDERS_PER_WINDOW = 2;               // "remind twice a week, never compulsory"

export interface UpdateNotification {
  version: string;
  at: number;
}

export interface UpdateState {
  lastCheckAt: number;
  latestTag?: string;
  notified: UpdateNotification[];
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  /** true when this poll should actually surface the reminder (throttled) */
  notify: boolean;
  assetName?: string;
  assetUrl?: string;
  assetSize?: number;
  releaseNotesUrl?: string;
  releaseName?: string;
  desktop: boolean;
  checkedAt: number;
}

export interface ApplyStatus {
  phase: 'idle' | 'downloading' | 'staged' | 'restarting' | 'done' | 'error';
  progress: number;
  message?: string;
  error?: string;
  version?: string;
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface ReleasePayload {
  tag_name?: string;
  name?: string;
  html_url?: string;
  assets?: ReleaseAsset[];
}

/* ── state ─────────────────────────────────────────────────────────────── */

function dataDir(): string {
  return process.env.ENZO_DATA_DIR
    ? path.resolve(process.env.ENZO_DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

function statePath(): string {
  return path.join(dataDir(), 'update-state.json');
}

export function readState(): UpdateState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastCheckAt: Number(parsed.lastCheckAt) || 0,
      latestTag: typeof parsed.latestTag === 'string' ? parsed.latestTag : undefined,
      notified: Array.isArray(parsed.notified)
        ? parsed.notified
            .filter((n: unknown) => n && typeof (n as UpdateNotification).version === 'string')
            .map((n: UpdateNotification) => ({ version: n.version, at: Number(n.at) || 0 }))
        : [],
    };
  } catch {
    return { lastCheckAt: 0, notified: [] };
  }
}

export function writeState(state: UpdateState): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${statePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath());
  } catch {
    /* state is best-effort — a read-only data dir must not break the app */
  }
}

/* ── version + asset helpers ───────────────────────────────────────────── */

/** True when `latest` is a higher semver than `current` ("v1.7.0" vs "1.6.0"). */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** The reminder fires at most REMINDERS_PER_WINDOW times per rolling week. */
export function shouldNotify(state: UpdateState, now: number = Date.now()): boolean {
  const recent = state.notified.filter((n) => now - n.at < REMINDER_WINDOW_MS);
  return recent.length < REMINDERS_PER_WINDOW;
}

export function markNotified(state: UpdateState, version: string, now: number = Date.now()): UpdateState {
  return { ...state, notified: [...state.notified, { version, at: now }] };
}

/** Pick the release asset that matches this platform/arch (null if none). */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  edition: string = process.env.ENZO_DESKTOP_EDITION || '',
): ReleaseAsset | null {
  const list = assets.filter((a) => a && typeof a.browser_download_url === 'string');
  if (platform === 'darwin') {
    const want = arch === 'arm64' ? /arm64/i : /x64|x86_64/i;
    return (
      list.find((a) => /\.dmg$/i.test(a.name || '') && want.test(a.name || '')) ||
      list.find((a) => /\.dmg$/i.test(a.name || '')) ||
      null
    );
  }
  if (platform === 'win32') {
    const exes = list.filter((a) => /\.exe$/i.test(a.name || '') && !/debug/i.test(a.name || ''));
    // Two theme editions are published side by side (…-less-theme-setup.exe /
    // …-full-theme-setup.exe). The running install must update to the SAME
    // edition — the launcher exports ENZO_DESKTOP_EDITION for exactly this.
    const token = edition === 'less' ? /less-theme/i : edition === 'full' ? /full-theme/i : null;
    if (token) {
      const match = exes.find((a) => token.test(a.name || ''));
      if (match) return match;
    }
    return exes[0] || null;
  }
  return null;
}

/* ── desktop install detection ─────────────────────────────────────────── */

export function isDesktopInstall(): boolean {
  return Boolean(process.env.ENZO_DESKTOP_HOME);
}

/** Where the running app lives on disk (mac: the .app bundle, win: the root). */
export function installedAppPaths(): { appPath: string; isMac: boolean; isWin: boolean } | null {
  if (!isDesktopInstall()) return null;
  const execDir = path.dirname(process.execPath);
  if (process.platform === 'darwin') {
    // execPath: ENZO.app/Contents/Resources/node-runtime/bin/node
    const appPath = path.resolve(execDir, '../../../..');
    // ENZO_UPDATE_TARGET overrides the swap destination (rehearsals only).
    if (process.env.ENZO_UPDATE_TARGET) {
      return { appPath: process.env.ENZO_UPDATE_TARGET, isMac: true, isWin: false };
    }
    return fs.existsSync(path.join(appPath, 'Contents', 'MacOS', 'ENZO'))
      ? { appPath, isMac: true, isWin: false }
      : null;
  }
  if (process.platform === 'win32') {
    // execPath: <root>/node-runtime/node.exe
    const appPath = path.resolve(execDir, '..');
    if (process.env.ENZO_UPDATE_TARGET) {
      return { appPath: process.env.ENZO_UPDATE_TARGET, isMac: false, isWin: true };
    }
    return fs.existsSync(path.join(appPath, 'app', 'launcher.js'))
      ? { appPath, isMac: false, isWin: true }
      : null;
  }
  return null;
}

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/* ── check ─────────────────────────────────────────────────────────────── */

let cachedRelease: { payload: ReleasePayload; at: number } | null = null;

async function fetchLatestRelease(force = false): Promise<ReleasePayload | null> {
  if (!force && cachedRelease && Date.now() - cachedRelease.at < CHECK_TTL_MS) {
    return cachedRelease.payload;
  }
  const state = readState();
  if (!force && state.lastCheckAt && Date.now() - state.lastCheckAt < CHECK_TTL_MS) {
    if (cachedRelease) return cachedRelease.payload;
  }
  try {
    const res = await fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ENZO-desktop-updater',
      },
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as ReleasePayload;
    cachedRelease = { payload, at: Date.now() };
    writeState({ ...state, lastCheckAt: Date.now(), latestTag: payload.tag_name });
    return payload;
  } catch {
    return null; // offline / rate-limited — stay silent, never break the UI
  }
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const current = currentVersion();
  const desktop = isDesktopInstall();
  const state = readState();
  const base: UpdateInfo = {
    current,
    latest: state.latestTag || current,
    available: false,
    notify: false,
    desktop,
    checkedAt: Date.now(),
  };
  if (!desktop) return base;

  const payload = await fetchLatestRelease(force);
  const latest = payload?.tag_name;
  if (!latest) return base;

  const available = isNewerVersion(latest, current);
  const asset = payload?.assets ? pickAsset(payload.assets) : null;
  const info: UpdateInfo = {
    ...base,
    latest,
    available,
    notify: available && shouldNotify(state),
    assetName: asset?.name,
    assetUrl: asset?.browser_download_url,
    assetSize: asset?.size,
    releaseNotesUrl: payload?.html_url,
    releaseName: payload?.name,
  };
  // Count the reminder the moment it is surfaced, so a page reload does not
  // burn the user's two-per-week allowance twice.
  if (info.notify) {
    writeState(markNotified(state, latest));
  }
  return info;
}

/* ── apply ─────────────────────────────────────────────────────────────── */

let status: ApplyStatus = { phase: 'idle', progress: 0 };

export function applyStatus(): ApplyStatus {
  return status;
}

function updatesDir(): string {
  return path.join(dataDir(), 'updates');
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'ENZO-desktop-updater' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length') || 0);
  const file = fs.createWriteStream(dest);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (!file.write(value)) {
      await new Promise((r) => file.once('drain', r));
    }
    status = {
      phase: 'downloading',
      progress: total ? Math.min(99, Math.round((received / total) * 100)) : 50,
    };
  }
  await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
}

/**
 * macOS: mount the downloaded DMG, stage the new bundle, then let a detached
 * helper do the swap once this server has exited.
 */
async function stageMac(assetPath: string, version: string): Promise<string> {
  const mount = path.join(updatesDir(), 'mount');
  fs.rmSync(mount, { recursive: true, force: true });
  fs.mkdirSync(mount, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn('hdiutil', ['attach', assetPath, '-nobrowse', '-readonly', '-mountpoint', mount], {
      stdio: 'ignore',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('could not mount the update'))));
    p.on('error', reject);
  });
  const staged = path.join(updatesDir(), `ENZO-${version}.app`);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(path.join(mount, 'ENZO.app'), staged, { recursive: true });
  // The detach has to COMPLETE before the mount folder can be removed —
  // removing a still-mounted volume fails with "Resource busy".
  await new Promise<void>((resolve) => {
    const detach = spawn('hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' });
    detach.on('exit', () => resolve());
    detach.on('error', () => resolve());
    setTimeout(() => resolve(), 8000);
  });
  fs.rmSync(mount, { recursive: true, force: true });
  return staged;
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Start the update. Resolves once the download is staged; the server exits
 * right after (the helper takes over from there).
 */
export async function startApply(info: UpdateInfo): Promise<ApplyStatus> {
  const paths = installedAppPaths();
  if (!paths) {
    status = { phase: 'error', progress: 0, error: 'not a desktop install' };
    return status;
  }
  if (!info.assetUrl) {
    status = { phase: 'error', progress: 0, error: 'no installer asset for this platform' };
    return status;
  }
  const version = info.latest.replace(/^v/, '');
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
    const assetPath = path.join(updatesDir(), path.basename(info.assetUrl));
    status = { phase: 'downloading', progress: 1, version };
    await download(info.assetUrl, assetPath);

    if (paths.isMac) {
      const staged = await stageMac(assetPath, version);
      const helper = path.join(updatesDir(), 'apply-mac.sh');
      const reopen = process.env.ENZO_UPDATE_REOPEN === '0' ? '' : `open "$TARGET"`;
      fs.writeFileSync(
        helper,
        [
          '#!/bin/bash',
          '# ENZO self-update helper: waits for the running server to exit,',
          '# swaps the app bundle, clears quarantine, re-signs and relaunches.',
          'set -u',
          'TARGET="$1"',
          'STAGED="$2"',
          'SERVER_PID="$3"',
          'sleep 3',
          'for _ in $(seq 1 40); do',
          '  kill -0 "$SERVER_PID" 2>/dev/null || break',
          '  sleep 1',
          'done',
          'OLD="${TARGET}.old.$$"',
          'mv "$TARGET" "$OLD" 2>/dev/null || true',
          'mv "$STAGED" "$TARGET"',
          'xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true',
          'codesign --force --deep --sign - "$TARGET" >/dev/null 2>&1 || true',
          'rm -rf "$OLD"',
          reopen,
          '',
        ].join('\n'),
      );
      fs.chmodSync(helper, 0o755);
      spawnDetached('bash', [helper, paths.appPath, staged, String(process.pid)]);
    } else {
      // Windows: run the NSIS installer silently after the server is gone,
      // then start ENZO again. User data lives in %APPDATA% and is untouched.
      const helper = path.join(updatesDir(), 'apply-win.cmd');
      fs.writeFileSync(
        helper,
        [
          '@echo off',
          'REM ENZO self-update helper: wait for the server, install silently, relaunch.',
          'timeout /t 3 /nobreak >nul',
          ':wait',
          'timeout /t 1 /nobreak >nul',
          'tasklist /FI "PID eq %3" 2>nul | find "%3" >nul && goto wait',
          `"${assetPath}" /S`,
          'timeout /t 2 /nobreak >nul',
          `start "" "${path.join(paths.appPath, 'node-runtime', 'node.exe')}" "${path.join(paths.appPath, 'app', 'launcher.js')}"`,
          '',
        ].join('\r\n'),
      );
      spawnDetached('cmd.exe', ['/c', helper, String(process.pid)]);
    }

    status = { phase: 'restarting', progress: 100, version, message: 'ENZO is restarting into the new version' };
    return status;
  } catch (err) {
    status = {
      phase: 'error',
      progress: 0,
      error: err instanceof Error ? err.message : String(err),
      version,
    };
    return status;
  }
}

/** Called by the router after the response was flushed — the bundle must go. */
export function exitAfterApply(): void {
  setTimeout(() => process.exit(0), 400);
}
