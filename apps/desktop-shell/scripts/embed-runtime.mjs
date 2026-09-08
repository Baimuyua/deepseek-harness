#!/usr/bin/env node
// Embed the production runtime into src-tauri/resources/runtime before
// `tauri build`: the published @deepseek-ai/dsh npm tree (runtime/dsh/node_modules)
// and an official Node distribution (runtime/node). The shell then runs
// `runtime/node/bin/node runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web`
// with no external Node or repository checkout required.
//
// Usage: node scripts/embed-runtime.mjs --platform <darwin-arm64|win-x64|linux-x64>
//        [--dsh-version 0.1.3-alpha.2] [--node-version v24.11.1]
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SRCTAURI = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri');
const RUNTIME_DIR = join(SRCTAURI, 'resources/runtime');
const PLATFORMS = ['darwin-arm64', 'win-x64', 'linux-x64'];

function parseArgs(argv) {
  const args = { dshVersion: '0.1.3-alpha.2', nodeVersion: 'v24.11.1' };
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
function extract(file, dir) {
  // Windows CI ships bsdtar (tar handles .zip); the node archives are tar.gz.
  run('tar', ['-xf', file, '-C', dir, '--strip-components=1']);
}

async function embedNode(platform, nodeVersion) {
  const distDir = platform === 'win-x64' ? `node-${nodeVersion}-${platform}` : `node-${nodeVersion}-${platform}`;
  const ext = platform === 'win-x64' ? 'zip' : 'tar.gz';
  const url = `https://nodejs.org/dist/${nodeVersion}/${distDir}.${ext}`;
  const work = await mkdtemp(join(tmpdir(), 'dsh-node-'));
  const archive = join(work, `node.${ext}`);
  await download(url, archive);
  const nodeDir = join(RUNTIME_DIR, 'node');
  await rm(nodeDir, { recursive: true, force: true });
  await mkdir(nodeDir, { recursive: true });
  extract(archive, nodeDir);
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

const args = parseArgs(process.argv);
await mkdir(RUNTIME_DIR, { recursive: true });
await embedNode(args.platform, args.nodeVersion);
await embedDsh(args.platform, args.dshVersion);
const manifest = {
  protocol: 1,
  dshVersion: args.dshVersion,
  nodeVersion: args.nodeVersion,
  platform: args.platform,
  createdAt: new Date().toISOString(),
};
await writeFile(join(RUNTIME_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`embedded runtime: dsh ${args.dshVersion} + node ${args.nodeVersion} (${args.platform})`);
