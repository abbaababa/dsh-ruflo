#!/usr/bin/env node
/**
 * MCP 启动器：优先用本机已安装的官方 ruflo@3.59.7（免 npx 冷启动/网络），
 * 缺失时才回退 npx；只执行固定版本，不接受 shell 字符串。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const workspace = process.env.DSH_WORKSPACE || process.cwd();
for (const dir of [process.env.HOME, process.env.XDG_CONFIG_HOME, process.env.npm_config_cache]) {
  if (typeof dir === 'string' && dir !== '' && dir.startsWith(workspace + '/') === false) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* 由子进程报可诊断错误 */ }
  }
}
const explicit = process.env.RUFLO_CLI_JS;
const local = explicit
  ? explicit
  : join(workspace, 'tools', 'ruflo-official', 'node_modules', 'ruflo', 'bin', 'ruflo.js');
const args = process.argv.slice(2);
let command;
let argv;
if (existsSync(local)) {
  let version = '';
  try { version = JSON.parse(readFileSync(join(dirname(local), '..', 'package.json'), 'utf8')).version; } catch { /* handled below */ }
  if (version !== '3.59.7') {
    console.error(`ruflo-mcp-launcher: local CLI version ${version || 'unknown'} != 3.59.7; refusing`);
    process.exit(1);
  }
  command = process.execPath;
  argv = [local, ...args];
} else {
  command = 'npx';
  argv = ['-y', 'ruflo@3.59.7', ...args];
}
const child = spawn(command, argv, {
  cwd: process.env.CLAUDE_FLOW_CWD || workspace,
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* noop */ } });
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
child.on('error', (error) => { console.error(`ruflo-mcp-launcher: ${error.message}`); process.exit(1); });
