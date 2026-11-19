/**
 * desktop-update.test.ts — offline tests for the desktop self-update core.
 *
 * Covers the three things that must not be wrong: the version comparison, the
 * "twice a week, never compulsory" reminder cadence, and the per-platform
 * asset pick. The network parts (GitHub release fetch, download, bundle swap)
 * are exercised live, not here.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enzo-desktop-update-'));
process.env.ENZO_DATA_DIR = tmp;

async function main() {
  const {
    isNewerVersion,
    shouldNotify,
    markNotified,
    pickAsset,
    readState,
    writeState,
    isDesktopInstall,
    currentVersion,
  } = await import('../src/desktop/update.js');

  let checks = 0;
  const ok = (label: string, cond: boolean) => {
    checks++;
    assert.ok(cond, `✗ ${label}`);
    console.log(`  ✔ ${label}`);
  };

  console.log('— version comparison —');
  ok('1.7.0 is newer than 1.6.0', isNewerVersion('1.7.0', '1.6.0'));
  ok('v1.7.0 is newer than 1.6.0', isNewerVersion('v1.7.0', '1.6.0'));
  ok('1.10.0 is newer than 1.9.0', isNewerVersion('1.10.0', '1.9.0'));
  ok('same version is not newer', !isNewerVersion('1.6.0', '1.6.0'));
  ok('older version is not newer', !isNewerVersion('1.5.9', '1.6.0'));
  ok('patch bump counts', isNewerVersion('1.6.1', '1.6.0'));
  ok('equal with v prefix is not newer', !isNewerVersion('v1.6.0', '1.6.0'));

  console.log('— reminder cadence (twice per rolling week) —');
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let state = { lastCheckAt: 0, notified: [] as { version: string; at: number }[] };
  ok('first reminder is allowed', shouldNotify(state, now));
  state = markNotified(state, '1.7.0', now);
  ok('second reminder is allowed', shouldNotify(state, now));
  state = markNotified(state, '1.7.0', now + 60_000);
  ok('third reminder inside the window is suppressed', !shouldNotify(state, now + 120_000));
  ok('reminder allowed again once the week rolls over', shouldNotify(state, now + WEEK + 1000));
  ok('only recent notifications count', shouldNotify({ lastCheckAt: 0, notified: [{ version: '1.7.0', at: now - WEEK - 1000 }] }, now));
  ok('a single notification inside the window still allows a reminder', shouldNotify({ lastCheckAt: 0, notified: [{ version: '1.7.0', at: now - WEEK + 1000 }] }, now) === true);
  ok('marked notifications are recorded', markNotified(state, '1.8.0', now).notified.length === state.notified.length + 1);

  console.log('— state persistence —');
  writeState({ lastCheckAt: 123, latestTag: 'v1.7.0', notified: [{ version: '1.7.0', at: 456 }] });
  const read = readState();
  ok('state roundtrips the last check', read.lastCheckAt === 123);
  ok('state roundtrips the latest tag', read.latestTag === 'v1.7.0');
  ok('state roundtrips notifications', read.notified.length === 1 && read.notified[0].version === '1.7.0');
  fs.writeFileSync(path.join(tmp, 'update-state.json'), 'not json');
  ok('corrupt state degrades to empty', readState().notified.length === 0);

  console.log('— platform asset pick —');
  const assets = [
    { name: 'ENZO-1.7.0-macOS-arm64.dmg', browser_download_url: 'https://x/arm64.dmg', size: 10 },
    { name: 'ENZO-1.7.0-macOS-x64.dmg', browser_download_url: 'https://x/x64.dmg', size: 11 },
    { name: 'ENZO-1.7.0-setup.exe', browser_download_url: 'https://x/setup.exe', size: 12 },
    { name: 'source-code.tar.gz', browser_download_url: 'https://x/src.tgz', size: 13 },
  ];
  ok('arm64 mac picks the arm64 dmg', pickAsset(assets, 'darwin', 'arm64')?.browser_download_url === 'https://x/arm64.dmg');
  ok('intel mac picks the x64 dmg', pickAsset(assets, 'darwin', 'x64')?.browser_download_url === 'https://x/x64.dmg');
  ok('windows picks the exe', pickAsset(assets, 'win32', 'x64')?.browser_download_url === 'https://x/setup.exe');
  ok('linux gets nothing', pickAsset(assets, 'linux', 'x64') === null);
  ok('no assets means no pick', pickAsset([], 'darwin', 'arm64') === null);

  console.log('— theme edition asset pick (windows ships both editions) —');
  const editions = [
    { name: 'ENZO-1.7.0-full-theme-setup.exe', browser_download_url: 'https://x/full.exe', size: 20 },
    { name: 'ENZO-1.7.0-less-theme-setup.exe', browser_download_url: 'https://x/less.exe', size: 21 },
  ];
  ok('the less edition downloads the less installer', pickAsset(editions, 'win32', 'x64', 'less')?.browser_download_url === 'https://x/less.exe');
  ok('the full edition downloads the full installer', pickAsset(editions, 'win32', 'x64', 'full')?.browser_download_url === 'https://x/full.exe');
  ok('an unknown edition still gets an exe', pickAsset(editions, 'win32', 'x64', '')?.browser_download_url === 'https://x/full.exe');
  ok('a debug exe is never picked', pickAsset([
    { name: 'ENZO-1.7.0-debug-setup.exe', browser_download_url: 'https://x/debug.exe', size: 22 },
    { name: 'ENZO-1.7.0-less-theme-setup.exe', browser_download_url: 'https://x/less.exe', size: 21 },
  ], 'win32', 'x64', 'less')?.browser_download_url === 'https://x/less.exe');

  console.log('— desktop install detection —');
  ok('not a desktop install without ENZO_DESKTOP_HOME', !isDesktopInstall());
  process.env.ENZO_DESKTOP_HOME = path.join(tmp, 'ENZO');
  ok('desktop install detected with the marker', isDesktopInstall());
  delete process.env.ENZO_DESKTOP_HOME;
  ok('current version resolves to the package version', /^\d+\.\d+\.\d+/.test(currentVersion()));

  console.log(`\n✔ desktop-update.test.ts — ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
