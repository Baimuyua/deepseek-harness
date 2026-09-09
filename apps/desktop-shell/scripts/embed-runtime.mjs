#!/usr/bin/env node
// Embed the production runtime into src-tauri/resources/runtime before
// `tauri build`: the published @deepseek-ai/dsh npm tree (runtime/dsh/node_modules)
// and an official Node distribution (runtime/node). The shell then runs
// `runtime/node/bin/node runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web`
// with no external Node or repository checkout required.
//
// Usage: node scripts/embed-runtime.mjs --platform <darwin-arm64|win-x64|linux-x64>
//        [--dsh-version 0.1.3-alpha.2] [--node-version v24.11.1] [--pnpm-version 11.7.0]
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SRCTAURI = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri');
const RUNTIME_DIR = join(SRCTAURI, 'resources/runtime');
const PLATFORMS = ['darwin-arm64', 'win-x64', 'linux-x64'];
// node-pty's prebuilds directory names differ from ours on Windows.
const PTY_PREBUILD_DIR = { 'darwin-arm64': 'darwin-arm64', 'win-x64': 'win32-x64', 'linux-x64': 'linux-x64' };

function parseArgs(argv) {
  const args = { dshVersion: '0.1.3-alpha.2', nodeVersion: 'v24.11.1', pnpmVersion: '11.7.0' };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${argv[i]}`);
    args[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    i += 1;
  }
  if (!PLATFORMS.includes(args.platform)) {
    throw new Error(`--platform must be one of ${PLATFORMS.join(', ')}, got ${args.platform}`);
  }
  return args;
}

function run(command, argv, options = {}) {
  console.log(`+ ${command} ${argv.join(' ')}`);
  execFileSync(command, argv, { stdio: 'inherit', ...options });
}

async function download(url, dest) {
  console.log(`+ download ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}): ${url}`);
  }
  await pipeline(response.body, createWriteStream(dest));
}

// Extract an archive downloaded to `file` into `dir`, stripping the top level.
// The Windows Node dist only ships as .zip and Windows runners resolve GNU
// tar (no zip support) in bash, so extract through Expand-Archive there.
async function extract(file, dir, topLevel) {
  if (process.platform === 'win32') {
    const stage = `${dir}.stage`;
    await rm(stage, { recursive: true, force: true });
    run('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${file}' -DestinationPath '${stage}' -Force`,
    ]);
    await cp(join(stage, topLevel), dir, { recursive: true });
    await rm(stage, { recursive: true, force: true });
    return;
  }
  run('tar', ['-xf', file, '-C', dir, '--strip-components=1']);
}

async function embedNode(platform, nodeVersion) {
  const distDir = `node-${nodeVersion}-${platform}`;
  const ext = platform === 'win-x64' ? 'zip' : 'tar.gz';
  const url = `https://nodejs.org/dist/${nodeVersion}/${distDir}.${ext}`;
  const work = await mkdtemp(join(tmpdir(), 'dsh-node-'));
  const archive = join(work, `node.${ext}`);
  await download(url, archive);
  const nodeDir = join(RUNTIME_DIR, 'node');
  await rm(nodeDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  await extract(archive, nodeDir, distDir);
  const expected = platform === 'win-x64' ? 'node.exe' : 'bin/node';
  await stat(join(nodeDir, expected));
  await rm(work, { recursive: true, force: true });
}

// Install dsh with the embedded Node, not the build host's: native prebuilds
// (fs-ext) are selected for the installing Node's ABI.
async function embedDsh(platform, dshVersion) {
  const dshDir = join(RUNTIME_DIR, 'dsh');
  await rm(dshDir, { recursive: true, force: true });
  await mkdir(dshDir, { recursive: true });
  const nodeDir = join(RUNTIME_DIR, 'node');
  const nodeBin = platform === 'win-x64' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin/node');
  const npmCli = platform === 'win-x64'
    ? join(nodeDir, 'node_modules/npm/bin/npm-cli.js')
    : join(nodeDir, 'lib/node_modules/npm/bin/npm-cli.js');
  run(nodeBin, [
    npmCli,
    'install',
    '--prefix', dshDir,
    `@deepseek-ai/dsh@${dshVersion}`,
    '--no-audit',
    '--no-fund',
  ], {
    env: {
      ...process.env,
      PATH: `${platform === 'win-x64' ? nodeDir : join(nodeDir, 'bin')}${platform === 'win-x64' ? ';' : ':'}${process.env.PATH}`,
    },
  });
  const bin = join(dshDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(bin)) throw new Error(`dsh CLI entry missing after install: ${bin}`);
}

// Embed pnpm: the desktop app seeds its bundled market plugin and runs any
// later `dsh plugin` transactions through this copy, because pruneRuntime
// deletes the Node dist's own npm below. pnpm is pure JavaScript, so no ABI
// selection is needed, but install before pruning.
async function embedPnpm(platform, pnpmVersion) {
  const pnpmDir = join(RUNTIME_DIR, 'pnpm');
  await rm(pnpmDir, { recursive: true, force: true });
  await mkdir(pnpmDir, { recursive: true });
  const nodeDir = join(RUNTIME_DIR, 'node');
  const nodeBin = platform === 'win-x64' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin/node');
  const npmCli = platform === 'win-x64'
    ? join(nodeDir, 'node_modules/npm/bin/npm-cli.js')
    : join(nodeDir, 'lib/node_modules/npm/bin/npm-cli.js');
  run(nodeBin, [
    npmCli,
    'install',
    '--prefix', pnpmDir,
    `pnpm@${pnpmVersion}`,
    '--no-audit',
    '--no-fund',
  ], {
    env: {
      ...process.env,
      PATH: `${platform === 'win-x64' ? nodeDir : join(nodeDir, 'bin')}${platform === 'win-x64' ? ';' : ':'}${process.env.PATH}`,
    },
  });
  const entry = join(pnpmDir, 'node_modules/pnpm/bin/pnpm.cjs');
  if (!existsSync(entry)) throw new Error(`pnpm entry missing after install: ${entry}`);
}

// Sum the bytes removed by deleting every file matching `predicate` under dir.
async function stripFiles(dir, predicate) {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await stripFiles(path, predicate);
    } else if (predicate(entry.name)) {
      const { size } = await stat(path);
      removed += size;
      await rm(path);
    }
  }
  return removed;
}

// Drop everything the sidecar never loads: Node build headers and its bundled
// npm/corepack (the desktop's package manager lives in runtime/pnpm, kept on
// purpose), Node docs, dsh sourcemaps and type declarations, and node-pty
// prebuilds for other platforms.
async function pruneRuntime(platform) {
  const nodeDir = join(RUNTIME_DIR, 'node');
  for (const rel of [
    'include', 'share', 'README.md', 'CHANGELOG.md',
    'lib/node_modules/npm', 'lib/node_modules/corepack',
    'node_modules/npm', 'node_modules/corepack',
    'bin/npm', 'bin/npx', 'bin/corepack',
    'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd',
  ]) {
    await rm(join(nodeDir, rel), { recursive: true, force: true });
  }
  const dshDir = join(RUNTIME_DIR, 'dsh');
  const isDeclaration = (name) => /\.d\.(ts|cts|mts)$/.test(name);
  const maps = await stripFiles(dshDir, (name) => name.endsWith('.map'));
  const types = await stripFiles(dshDir, isDeclaration);
  const prebuilds = join(dshDir, 'node_modules/node-pty/prebuilds');
  if (existsSync(prebuilds)) {
    for (const entry of await readdir(prebuilds)) {
      if (entry !== PTY_PREBUILD_DIR[platform]) {
        await rm(join(prebuilds, entry), { recursive: true, force: true });
      }
    }
  }
  if (platform === 'linux-x64') {
    // linuxdeploy scans every ELF under resources/: the musl koffi variant
    // (bundled inside the same npm package) has no libc.musl on a glibc
    // runner and fails the AppImage build, and fs-ext's intermediate .o
    // files only trip patchelf. Both are dead weight at runtime.
    for (const rel of [
      'node_modules/@koromix/koffi-linux-x64/musl_x64',
      'node_modules/fs-ext/build/Release/obj.target',
    ]) {
      await rm(join(dshDir, rel), { recursive: true, force: true });
    }
  }
  return { maps, types };
}

const args = parseArgs(process.argv);
await mkdir(RUNTIME_DIR, { recursive: true });
await embedNode(args.platform, args.nodeVersion);
await embedDsh(args.platform, args.dshVersion);
await embedPnpm(args.platform, args.pnpmVersion);
const pruned = await pruneRuntime(args.platform);
console.log(`pruned ${(pruned.maps / 1e6).toFixed(1)}MB sourcemaps, ${(pruned.types / 1e6).toFixed(1)}MB type declarations`);
const manifest = {
  protocol: 1,
  dshVersion: args.dshVersion,
  nodeVersion: args.nodeVersion,
  pnpmVersion: args.pnpmVersion,
  platform: args.platform,
  createdAt: new Date().toISOString(),
};
await writeFile(join(RUNTIME_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`embedded runtime: dsh ${args.dshVersion} + node ${args.nodeVersion} (${args.platform})`);
