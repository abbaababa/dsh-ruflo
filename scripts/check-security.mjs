import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildChildEnv, safeWorkdir, securitySummary } from '../lib/host-1.2.4.js';

const host = readFileSync(new URL('../lib/host-1.2.4.js', import.meta.url), 'utf8');
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

// 1. 不允许把整个环境塞给子进程
assert.ok(!host.includes('...process.env'), 'host must not spread process.env');
assert.ok(!patch.includes('...process.env'), 'patch must not spread process.env');

// 2. 密钥白名单存在，且不包含明显无关凭据
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GITHUB_TOKEN', 'HF_TOKEN']) {
  assert.ok(host.includes(key), `allowlist missing ${key}`);
}
assert.ok(!host.includes('AWS_SECRET_ACCESS_KEY'), 'must not pass AWS secret');

// 3. 版本与 cwd
assert.ok(host.includes("'1.2.4'"), 'plugin version');
assert.ok(host.includes('ruflo@3.59.7'), 'ruflo version');
assert.ok(host.includes('ruflo@3.59.7') || patch.includes('ruflo@3.59.7'), 'ruflo version');
assert.ok(patch.includes('ruflo-mcp-launcher.mjs'), 'patch launcher');
assert.ok(!patch.includes('CLAUDE_FLOW_CWD: !!js process.env.HOME'), 'patch must not default HOME');
assert.ok(patch.includes('toolCallTimeoutMs: 300000'), 'MCP timeout');
assert.ok(!patch.includes('/Users/'), 'patch must not hardcode a local path');
assert.ok(patch.includes('DSH_RUFLO_LAUNCHER'), 'launcher override');

// 4. 工作目录越界拒绝
const cwd = safeWorkdir('');
assert.ok(cwd.length > 0);
assert.throws(() => safeWorkdir('/etc'), /越界|不存在/, 'outside dir must be rejected');

// 5. 环境最小化：允许的密钥进入，无关变量与伪造值不进入
const old = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'sk-test-SECRET-SHOULD-NOT-LEAK';
process.env.DSH_PROFILE_DIR = '/tmp/dsh-ruflo-security-profile';
const env = buildChildEnv(cwd);
assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-SECRET-SHOULD-NOT-LEAK');
assert.equal(env.CLAUDE_FLOW_MODE, 'v3');
assert.equal(env.CLAUDE_FLOW_HOOKS_ENABLED, 'true');
assert.ok(env.npm_config_cache.includes('/cache/npm-ruflo'));
assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must not be forwarded');
assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
assert.equal(env.FAKE_SECRET, undefined);

// 6. 状态只显示是否配置，不回显值
const summary = securitySummary();
const shallow = JSON.stringify(summary);
assert.ok(!shallow.includes('sk-test-SECRET-SHOULD-NOT-LEAK'), 'secret value leaked in status summary');
assert.ok(summary.secrets.some((s) => s.name === 'ANTHROPIC_API_KEY' && s.configured === true));

if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old;

// 7. npm 安装器
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = readFileSync(new URL('../bin/dsh-ruflo.js', import.meta.url), 'utf8');
assert.equal(pkg.version, '1.2.4', 'package version');
assert.equal(pkg.bin?.['dsh-ruflo'], './bin/dsh-ruflo.js', 'bin entry');
assert.ok(bin.includes("'plugin'"), 'installer uses dsh plugin');
assert.ok(bin.includes('dsh.profile.bundles'), 'installer selects the bundle');
assert.ok(!bin.includes('/Users/'), 'installer must not hardcode a local path');

console.log('SECURITY CHECKS PASS');
