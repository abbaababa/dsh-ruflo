#!/usr/bin/env node
/**
 * 把 @ruvector/ruvllm-wasm 接到当前官方 ruflo CLI 的 ESM 解析链。
 * 只写 npx 缓存中的 @ruvector/ruvllm-wasm 路径；先备份；不 sudo；不联网。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const VERSION = '3.59.7';
const WASM = '@ruvector/ruvllm-wasm';
const dry = process.argv.includes('--dry-run');
const projectWasm = resolve(import.meta.dirname, '../../../159667_forecast_20261021/tools/ruvllm/node_modules/@ruvector/ruvllm-wasm');
const workspace = process.env.DSH_WORKSPACE || resolve(import.meta.dirname, '../../..');
const localBase = join(workspace, 'tools', 'ruflo-official', 'node_modules');
const cacheRoots = [
  process.env.npm_config_cache,
  join(process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web'), 'cache', 'npm-ruflo'),
  join(homedir(), '.npm'),
].filter((v, i, a) => typeof v === 'string' && v !== '' && a.indexOf(v) === i);

function findCliRoots() {
  const found = [];
  if (existsSync(join(localBase, '@claude-flow', 'cli'))) found.push({ npxDir: localBase, base: localBase, cli: join(localBase, '@claude-flow', 'cli') });
  for (const root of cacheRoots) {
    const npx = join(root, '_npx');
    if (!existsSync(npx)) continue;
    for (const entry of readdirSync(npx, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = join(npx, entry.name, 'node_modules');
      const pkg = join(base, 'ruflo', 'package.json');
      if (!existsSync(pkg)) continue;
      let version = '';
      try { version = JSON.parse(readFileSync(pkg, 'utf8')).version; } catch { continue; }
      if (version !== VERSION) continue;
      const cli = join(base, '@claude-flow', 'cli');
      if (existsSync(cli)) found.push({ npxDir: join(npx, entry.name), base, cli });
    }
  }
  return found;
}

if (!existsSync(projectWasm)) {
  console.error(`找不到项目内 wasm 包：${projectWasm}`);
  process.exit(1);
}
const realSource = realpathSync(projectWasm);
const targets = findCliRoots();
if (targets.length === 0) {
  console.error(`没有找到 ruflo@${VERSION} 的 npx 缓存。请先让 MCP 成功启动一次，再运行本脚本。`);
  process.exit(2);
}
let changed = 0;
for (const { npxDir, base } of targets) {
  const target = join(base, '@claude-flow', 'cli', 'node_modules', '@ruvector', 'ruvllm-wasm');
  if (existsSync(target)) {
    try {
      if (realpathSync(target) === realSource) {
        console.log(`SKIP  ${target} -> 已指向项目 wasm`);
        continue;
      }
    } catch { /* 继续备份 */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (dry) {
    console.log(`DRY   ${target} 将被备份并链接到 ${realSource}`);
    continue;
  }
  mkdirSync(join(base, '@claude-flow', 'cli', 'node_modules', '@ruvector'), { recursive: true });
  if (existsSync(target) || lstatExists(target)) {
    const backup = `${target}.backup-${stamp}`;
    renameSync(target, backup);
    console.log(`BACKUP ${backup}`);
  }
  try {
    symlinkSync(realSource, target, 'dir');
    console.log(`LINK  ${target} -> ${realSource}`);
  } catch (error) {
    console.log(`LINK_FAIL ${target}: ${error.message}; 改为复制`);
    cpSync(realSource, target, { recursive: true, dereference: true });
    console.log(`COPY  ${target}`);
  }
  changed += 1;
  console.log(`NPX   ${npxDir}`);
}
console.log(`DONE targets=${targets.length} changed=${changed}`);

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}
