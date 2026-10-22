/**
 * dsh-ruflo —— 把官方 Ruflo（ruvnet/ruflo）接进 DeepSeek Harness 的一等公民插件。
 *
 * 设计原则：不复制、不重写 Ruflo 的内部实现，而是直接运行官方运行时——
 *   1. bundle patch 插入官方 MCP 服务（整组 mcp__ruflo__* 工具）；
 *   2. 本文件提供 ruflo_status / ruflo_cli 两个工具、/ruflo 命令、
 *      一段系统提示词，以及一个全局 ruflo 技能（ctx.skills.register）。
 *
 * 因此“能力”与官方同源：Ruflo 升级多少能力，这里就自动拥有多少能力。
 *
 * 配置（Config）即「设置 → 插件 → Ruflo」里的表单；字段全部声明为 volatile，
 * 修改后热更新，不重挂插件。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUFLO_SKILL } from './skill.js';
import { createNativeTools } from './native.js';

export const name = 'dsh-ruflo';

/** 硬依赖：缺任一服务时插件保持未激活，而不是抛错拖垮整棵插件树。 */
export const inject = ['tools', 'commands', 'systemPrompt', 'subprocess'];

const PLUGIN_NAME = 'dsh-ruflo';
const PLUGIN_VERSION = '1.2.4';
/** 与 MCP 服务端的行配置保持一致；改这里时同步改 cordis.patch.yml。 */
const DEFAULT_CLI_ARGS = ['-y', 'ruflo@3.59.7'];
const DEFAULT_MCP_SERVER = 'ruflo';

/** 官方 3.59.7 的 MCP 标准环境变量（来自官方 mcp-generator.js）。 */
const OFFICIAL_ENV = Object.freeze({
  npm_config_update_notifier: 'false',
  CLAUDE_FLOW_MODE: 'v3',
  CLAUDE_FLOW_HOOKS_ENABLED: 'true',
  CLAUDE_FLOW_TOPOLOGY: 'hierarchical-mesh',
  CLAUDE_FLOW_MAX_AGENTS: '15',
  CLAUDE_FLOW_MEMORY_BACKEND: 'hybrid',
});

/** 允许透传的敏感变量：只给官方子进程需要的，不把整个 process.env 塞进去。 */
const SECRET_ALLOWLIST = Object.freeze([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'OPENROUTER_API_KEY',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
]);

/** 非敏感基础变量；不包含 NODE_OPTIONS、LD_PRELOAD 等可注入项。 */
const BASE_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

function profileDir() {
  const value = process.env.DSH_PROFILE_DIR;
  return typeof value === 'string' && value !== '' ? value : join(homedir(), '.dsh', 'profiles', 'web');
}

function npmCacheDir() {
  return join(profileDir(), 'cache', 'npm-ruflo');
}

function workspaceDir() {
  const value = process.env.DSH_WORKSPACE;
  if (typeof value === 'string' && value !== '') return value;
  return process.cwd();
}

/** 只允许工作区或 DSH profile 内的目录，防止 cwd 逃逸。 */
function safeWorkdir(input) {
  const candidate = typeof input === 'string' && input !== '' ? resolve(input) : resolve(workspaceDir());
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`ruflo 工作目录不存在或不可访问：${candidate}`);
  }
  const roots = [workspaceDir(), profileDir()].map((item) => {
    try { return realpathSync(item); } catch { return resolve(item); }
  });
  const inside = roots.some((root) => real === root || real.startsWith(root + sep));
  if (!inside) {
    throw new Error(`ruflo 工作目录越界：${real}（只允许工作区或 DSH profile 内）`);
  }
  return real;
}

/** 最小化环境：基础白名单 + 密钥白名单 + 官方 5+1 变量 + 缓存/工作区。 */
function buildChildEnv(cwd) {
  const env = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  for (const name of SECRET_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  const cache = npmCacheDir();
  const agentBrowserBin = join(profileDir(), 'tools', 'agent-browser', 'node_modules', '.bin');
  const pathParts = [agentBrowserBin, env.PATH].filter((item) => typeof item === 'string' && item !== '');
  return {
    ...env,
    PATH: pathParts.join(':'),
    ...OFFICIAL_ENV,
    HOME: join(profileDir(), 'home'),
    XDG_CONFIG_HOME: join(profileDir(), 'config'),
    CLAUDE_FLOW_CWD: cwd,
    npm_config_cache: cache,
    npm_config_logs_dir: join(cache, '_logs'),
  };
}

/** 只返回“是否配置”，永远不返回值。 */
function securitySummary() {
  return {
    officialEnv: Object.keys(OFFICIAL_ENV),
    secrets: SECRET_ALLOWLIST.map((name) => ({ name, configured: Boolean(process.env[name]) })),
    cacheDir: npmCacheDir(),
  };
}
/** 系统提示词排序：MCP_SERVERS = 3100，TOOLS_SDK = 5000，落在两者之间。 */
const PROMPT_ORDER = 3150;
/** 单次工具调用最多展示给模型的字符数，防止 200KB 输出塞满上下文。 */
const RENDER_LIMIT = 24_000;

/**
 * 解析宿主自带的 schemastery（设置表单的 schema 库）。
 *
 * 为什么不用静态 import：插件可能以两种方式被加载——
 *   1. 正常安装：包在 <profile>/node_modules/dsh-ruflo 下，`@deepseek-ai/schemastery`
 *      沿 node_modules 向上解析即可命中；
 *   2. 开发期 `link:` 安装：模块真实路径在源码目录，那里没有 node_modules，
 *      静态 import 会直接让整条插件行加载失败。
 * 这里先试裸模块名，失败再按 `DSH_PROFILE_DIR` 组合绝对路径兜底。
 * 两者都失败时插件仍可运行，只是没有设置表单（Config 为 undefined）。
 */
async function loadSchemastery() {
  const pick = (namespace) => namespace?.default ?? namespace;
  try {
    return pick(await import('@deepseek-ai/schemastery'));
  } catch {
    /* 继续尝试 profile 内的绝对路径 */
  }
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === 'string' && profileDir !== '') {
    for (const file of ['lib/index.mjs', 'lib/index.cjs']) {
      const url = pathToFileURL(`${profileDir}/node_modules/@deepseek-ai/schemastery/${file}`).href;
      try {
        return pick(await import(url));
      } catch {
        /* 试下一个扩展名 */
      }
    }
  }
  return undefined;
}

const z = await loadSchemastery();

/**
 * 把 schemastery 字段标记为 volatile。
 *
 * 依据 @deepseek-ai/dsh-settings：设置表单只接受被标记为 volatile 的路径，
 * 且没有任何 volatile 字段时该插件的设置卡会被整个丢弃。3.18.4 起有
 * `.volatile()`；更早的 3.18.x 用等价的 `.extra('volatile', true)`。
 */
function volatileField(schema) {
  if (typeof schema?.volatile === 'function') return schema.volatile();
  if (typeof schema?.extra === 'function' && schema.meta?.volatile !== true) {
    return schema.extra('volatile', true);
  }
  return schema;
}

/**
 * 插件配置。每个字段都必须带 `.default(...)`：
 * dsh-settings 的 projectForm() 会丢弃解析结果为 undefined 的字段，
 * 字段一旦缺席，设置卡就会报 “writable but not applied”。
 */
function buildConfig(z) {
  return z
  .object({
    cliCommand: volatileField(
      z
        .string()
        .default('npx')
        .description('运行 ruflo 的可执行文件；默认 npx（无需全局安装）'),
    ),
    cliArgs: volatileField(
      z
        .array(z.string())
        .default(DEFAULT_CLI_ARGS)
        .description('可执行文件的前置参数；默认 -y ruflo@3.59.7（官方最新稳定版）。跟随更新可手动改 cliArgs'),
    ),
    cliPath: volatileField(
      z
        .string()
        .default('')
        .description('可选：ruflo 的 JS 入口绝对路径（如 .../bin/ruflo.js）。填写后优先于 cliCommand/cliArgs，并用当前 node 执行'),
    ),
    cwd: volatileField(
      z
        .string()
        .default('')
        .description('CLI 工作目录；留空 = 当前会话工作区（安全边界内），不再回退 HOME'),
    ),
    timeoutMs: volatileField(
      z
        .number()
        .default(120_000)
        .description('单次 CLI 调用的最长毫秒数；超时会终止子进程并报错'),
    ),
    maxOutputBytes: volatileField(
      z
        .number()
        .default(200_000)
        .description('stdout / stderr 各自最多保留的字节数，超出部分截断'),
    ),
    mcpServerName: volatileField(
      z
        .string()
        .default(DEFAULT_MCP_SERVER)
        .description('bundle patch 中 MCP 行的 serverName；ruflo_status 用它统计已注册工具数'),
    ),
    promptGuidance: volatileField(
      z
        .boolean()
        .default(true)
        .description('向每个会话的系统提示词注入一段 Ruflo 使用指引'),
    ),
    registerSkill: volatileField(
      z
        .boolean()
        .default(true)
        .description('注册全局 ruflo 技能（项目内同名技能优先，不会被覆盖）'),
    ),
  })
    .default({});
}

/** 无 schemastery 时仍可运行，只是没有设置表单。 */
export const Config = z ? buildConfig(z) : undefined;

/** 系统提示词正文：只陈述事实与入口，不写死会随版本变化的工具数量。 */
const PROMPT_SECTION = `## Ruflo orchestration

The official Ruflo runtime (ruvnet/ruflo) is available in this session through the
\`dsh-ruflo\` plugin. It is the official implementation, not a reimplementation.

- MCP tools: every tool is named \`mcp__ruflo__<name>\` (agents, swarms, memory, hooks,
  tasks, sessions, workflows, security, neural, performance, github, browser, federation).
- CLI: \`ruflo_cli\` runs any ruflo subcommand as an argv array, e.g.
  \`{"args": ["doctor", "--fix"]}\`; \`/ruflo <args>\` does the same from the composer.
- Status: \`ruflo_status\` shows the CLI version and the number of registered
  \`mcp__ruflo__*\` tools.
- Claims: always use \`ruflo_claims\` (1.2.2+) for claim / release / status / handoff /
  steal / mark_stealable / accept_handoff / board / list. It normalizes a bare agent id
  (\`agent-…\`) into \`agent:<agentId>:<agentType>\` and a bare name into
  \`human:local:<name>\`. Calling \`mcp__ruflo__claims_claim\` directly with a bare id fails
  with \"Invalid claimant format\" — the MCP server only accepts the strict three-part form.

Use Ruflo for genuine multi-agent orchestration, cross-session memory, learned routing,
hooks, workflow pipelines or security scans. For a single-file edit or a one-turn answer,
prefer the native Harness tools; orchestration overhead is not worth it there.`;

/** 去掉首尾空白；非字符串一律返回空串。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 统一提取错误信息，避免把 Error 对象直接拼进字符串。 */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 取第一行非空文本，用于 `ruflo --version` 这类输出。 */
function firstLine(value) {
  if (typeof value !== 'string') return '';
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/** 把 argv 还原成可读命令行；只影响展示，不参与执行。 */
function formatCommand(argv) {
  return argv
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

/** 支持双引号、单引号与空格的极简分词器，供 /ruflo 命令使用。 */
function splitArgs(input) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  let match = pattern.exec(input);
  while (match !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
    match = pattern.exec(input);
  }
  return parts;
}

/** 输出过长时截断，并明确告知模型被截断了多少字符。 */
function clampForRender(value) {
  if (value.length <= RENDER_LIMIT) return value;
  return `${value.slice(0, RENDER_LIMIT)}\n…（已截断，共 ${value.length} 字符）`;
}

/**
 * 读取 volatile 字段的当前值。
 *
 * dsh-settings 的“可热更新配置”不是普通值，而是 cosmokit 的活引用
 * `{ get: () => value }`；直接当字符串/数组用会得到对象。每次使用都解引用，
 * 设置页保存后立即生效，无需重挂插件。
 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get();
  }
  return value;
}

/** 合并配置与代码默认值，保证即使 Config 未解析也有完整设置。 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const args = unwrap(raw.cliArgs);
  const timeoutMs = Number(unwrap(raw.timeoutMs));
  const maxOutputBytes = Number(unwrap(raw.maxOutputBytes));
  return {
    cliCommand: text(unwrap(raw.cliCommand)) || 'npx',
    cliArgs: Array.isArray(args) && args.length > 0 ? args.map((item) => String(item)) : [...DEFAULT_CLI_ARGS],
    cliPath: text(unwrap(raw.cliPath)),
    cwd: text(unwrap(raw.cwd)),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1_000 ? timeoutMs : 120_000,
    maxOutputBytes:
      Number.isFinite(maxOutputBytes) && maxOutputBytes >= 1_024 ? maxOutputBytes : 200_000,
    mcpServerName: text(unwrap(raw.mcpServerName)) || DEFAULT_MCP_SERVER,
    promptGuidance: unwrap(raw.promptGuidance) !== false,
    registerSkill: unwrap(raw.registerSkill) !== false,
  };
}

/** 从 cliArgs 里取出版本号（`ruflo@3.59.7` → `3.59.7`；`latest` 这类标签返回空）。 */
function requestedRufloVersion(cliArgs) {
  for (const arg of cliArgs) {
    const match = /^ruflo@(.+)$/u.exec(arg);
    if (match === null) continue;
    const version = match[1];
    if (/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(version)) return version;
  }
  return '';
}

/**
 * 找一个已经由 npx 下载好的官方 ruflo 入口，避免每次调用都重新走 npm 解析。
 *
 * 背景：`npx -y ruflo@3.59.7` 在冷缓存、npm 锁竞争或网络抖动时可能耗时数十秒，
 * 会让 ruflo_status 误报「CLI 异常」。npx 的缓存目录里已经有一份完整的官方包
 * （MCP 行启动时下载的），直接用 `node <bin>` 执行即可：离线、零解析、毫秒级。
 *
 * 只接受与 cliArgs 精确匹配的版本；`latest` 等标签不匹配任何缓存，仍走 npx。
 */
function cachedRufloEntry(cliArgs) {
  const wanted = requestedRufloVersion(cliArgs);
  const roots = [];
  if (typeof process.env.npm_config_cache === 'string' && process.env.npm_config_cache !== '') {
    roots.push(join(process.env.npm_config_cache, '_npx'));
  }
  roots.push(join(process.env.HOME || homedir(), '.npm', '_npx'));
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') {
    roots.push(join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'));
  }
  let best = null;
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(root, entry.name, 'node_modules', 'ruflo', 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (wanted !== '' && pkg.version !== wanted) continue;
        const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.ruflo;
        if (typeof relative !== 'string') continue;
        const bin = join(root, entry.name, 'node_modules', 'ruflo', relative);
        if (!existsSync(bin)) continue;
        const mtime = statSync(pkgPath).mtimeMs;
        if (best === null || mtime > best.mtime) best = { bin, mtime, version: pkg.version };
      } catch {
        /* 跳过损坏或不完整的缓存项 */
      }
    }
  }
  return best;
}

/**
 * CLI 执行器：解析可执行文件、带超时与取消地跑子进程、回收 stdout/stderr。
 *
 * 走 ctx.subprocess（Harness 提供的受管子进程服务），而不是 node:child_process：
 * 子进程随插件卸载统一终止，输出按字节安全截断，且与 MCP 服务端同样的权限模型
 * 一致（不受工作区写沙箱限制，否则 Ruflo 无法写 ~/.claude-flow 记忆库）。
 */
function createRunner(ctx, readSettings) {

  /** 只有默认的 npx 方式才尝试复用 npx 缓存；自定义 cliCommand/cliPath 优先。 */
  function cachedFor(settings) {
    if (settings.cliPath !== '' || settings.cliCommand !== 'npx') return null;
    return cachedRufloEntry(settings.cliArgs);
  }

  function argvFor(settings, args) {
    if (settings.cliPath !== '') {
      return [process.execPath, settings.cliPath, ...args];
    }
    const cached = cachedFor(settings);
    if (cached !== null) {
      return [process.execPath, cached.bin, ...args];
    }
    return [settings.cliCommand, ...settings.cliArgs, ...args];
  }

  function describe() {
    const settings = readSettings();
    if (settings.cliPath !== '') return `node ${settings.cliPath}`;
    const cached = cachedFor(settings);
    if (cached !== null) return `node ${cached.bin}（npx 缓存 v${cached.version}，免联网）`;
    return formatCommand([settings.cliCommand, ...settings.cliArgs]);
  }

  /**
   * @param {string[]} args 传给 ruflo 的参数（不含可执行文件与前缀参数）。
   * @param {{ cwd?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<object>} 结构化执行结果；启动失败、超时、取消时抛错。
   */
  async function run(args, options = {}) {
    const settings = readSettings();
    const argv = argvFor(settings, args);
    const cwd = safeWorkdir(text(options.cwd) || settings.cwd);
    const budget = Number(options.timeoutMs);
    const timeoutMs =
      Number.isFinite(budget) && budget >= 1_000
        ? Math.min(budget, settings.timeoutMs)
        : settings.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const startedAt = Date.now();

    let executable;
    try {
      executable = await ctx.subprocess.resolveExecutable(argv[0], undefined, signal);
    } catch (error) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new Error(`ruflo CLI 超时（${timeoutMs} ms）：${formatCommand(argv)}`, {
          cause: error,
        });
      }
      if (options.signal?.aborted) {
        throw new Error(`ruflo CLI 已取消：${formatCommand(argv)}`, { cause: error });
      }
      throw new Error(
        `无法找到 ruflo 可执行文件 “${argv[0]}”：${errorMessage(error)}。` +
          '请在插件设置中检查 cliCommand / cliPath，或先执行 npx -y ruflo@3.59.7 --version 验证。',
        { cause: error },
      );
    }

    let handle;
    try {
      handle = ctx.subprocess.spawn({
        argv: [executable, ...argv.slice(1)],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: settings.maxOutputBytes },
          stderr: { maxBytes: settings.maxOutputBytes },
        },
        graceMs: 3_000,
        signal,
        env: buildChildEnv(cwd),
      });
    } catch (error) {
      throw new Error(`无法启动 ruflo CLI（${formatCommand(argv)}）：${errorMessage(error)}`, {
        cause: error,
      });
    }

    let outcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new Error(
          `ruflo CLI 超时（${timeoutMs} ms）：${formatCommand(argv)}。` +
            '可在插件设置中调大 timeoutMs，或给本次调用传更小的 timeoutMs。',
          { cause: error },
        );
      }
      if (options.signal?.aborted) {
        throw new Error(`ruflo CLI 已取消：${formatCommand(argv)}`, { cause: error });
      }
      throw new Error(`ruflo CLI 启动失败：${formatCommand(argv)}：${errorMessage(error)}`, {
        cause: error,
      });
    }

    // 有些提供方在终止后会正常 resolve（exitCode=null + signal），这里统一补一条可读错误。
    if (timeoutSignal.aborted && !options.signal?.aborted) {
      throw new Error(
        `ruflo CLI 超时（${timeoutMs} ms）：${formatCommand(argv)}。` +
          '可在插件设置中调大 timeoutMs，或给本次调用传更小的 timeoutMs。',
      );
    }
    if (options.signal?.aborted) {
      throw new Error(`ruflo CLI 已取消：${formatCommand(argv)}`);
    }

    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    return {
      command: formatCommand(argv),
      cwd,
      exitCode: outcome.exitCode ?? -1,
      signal: outcome.signal ?? '',
      durationMs: Date.now() - startedAt,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      truncated: Boolean(stdout?.lossy || stderr?.lossy),
    };
  }

  return {
    run,
    describe,
    get defaultCwd() {
      return safeWorkdir(readSettings().cwd);
    },
    get mcpServerName() {
      return readSettings().mcpServerName;
    },
    get security() {
      return securitySummary();
    },
  };
}

/** 读取磁盘上已安装包的版本；读不到返回空串（不影响状态展示）。 */
function readInstalledVersion() {
  try {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
}

/** 统计当前会话真正注册了哪些 mcp__<server>__* 工具（0 表示 MCP 未连上）。 */
function countMcpTools(ctx, serverName) {
  const prefix = `mcp__${serverName}__`;
  try {
    return ctx.tools.schemas().filter((tool) => tool.name.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

/** 汇总 CLI 与 MCP 两侧的真实状态，不猜、不缓存。 */
async function readStatus(ctx, runner) {
  let version = '';
  let cliError = '';
  try {
    const result = await runner.run(['--version'], { timeoutMs: 45_000 });
    version = firstLine(result.stdout) || firstLine(result.stderr);
    if (version === '' && result.exitCode !== 0) {
      cliError = `退出码 ${result.exitCode}：${firstLine(result.stderr)}`;
    }
  } catch (error) {
    cliError = errorMessage(error);
  }
  const mcpTools = countMcpTools(ctx, runner.mcpServerName);
  const installedVersion = readInstalledVersion();
  return {
    plugin: PLUGIN_NAME,
    pluginVersion: PLUGIN_VERSION,
    installedVersion,
    // 磁盘已更新、进程仍跑旧模块时置真：这是热升级后“版本没变”的唯一正确判据。
    reloadRequired: installedVersion !== '' && installedVersion !== PLUGIN_VERSION,
    version,
    cli: runner.describe(),
    cliOk: cliError === '',
    cliError,
    mcpServerName: runner.mcpServerName,
    mcpConnected: mcpTools > 0,
    mcpTools,
    cwd: runner.defaultCwd,
    security: runner.security,
  };
}

/** 把状态结构渲染成模型能直接读的中文文本。 */
function formatStatus(value) {
  const lines = [
    `Ruflo 状态（插件 ${value.plugin} v${value.pluginVersion}）`,
    `- CLI：${value.cli}`,
  ];
  if (value.cliOk && value.version !== '') {
    lines.push(`- 版本：${value.version}`);
  } else if (value.cliOk) {
    lines.push('- 版本：命令成功，但未读到版本号（可用 ruflo_cli ["--version"] 复查）');
  } else {
    lines.push(`- CLI 异常：${value.cliError}`);
  }
  if (value.mcpConnected) {
    lines.push(`- MCP：${value.mcpServerName} 已连接，注册了 ${value.mcpTools} 个 mcp__${value.mcpServerName}__* 工具`);
  } else {
    lines.push(
      `- MCP：${value.mcpServerName} 未连接（0 个工具）。` +
        '请检查 dsh-ruflo-mcp 行是否启用、网络是否可达，或重启 dsh 后重试。',
    );
    lines.push(
      '- 提示：同一 serverName 只能有一个 MCP 行。若你还配置了旧的 mcp-ruflo 行，' +
        '请只保留一行（安装本插件时应已自动关闭旧行）。',
    );
  }
  lines.push(`- 工作目录：${value.cwd}`);
  if (value.security) {
    const secrets = value.security.secrets || [];
    const configured = secrets.filter((item) => item.configured).map((item) => item.name);
    lines.push(`- 安全：官方环境 ${value.security.officialEnv?.length ?? 0} 项；密钥仅白名单透传`);
    lines.push(`- 已配置外部凭据：${configured.length > 0 ? configured.join(', ') : '无（相关工具将标记 EXTERNAL_BLOCKED）'}`);
    lines.push(`- npm 缓存：${value.security.cacheDir}`);
  }
  if (value.reloadRequired) {
    lines.push(
      `- 重载提示：磁盘上已是 v${value.installedVersion}，当前进程仍运行 v${value.pluginVersion}。` +
        '请重启 dsh web，或在插件页把 dsh-ruflo-plugin 行关掉再打开。',
    );
  }
  return lines.join('\n');
}

/** 把 CLI 结果渲染成“命令 + 退出码 + stdout + stderr”的文本块。 */
function formatCliResult(value) {
  const head = [
    `$ ${value.command}`,
    `cwd: ${value.cwd}    exit: ${value.exitCode}` +
      (value.signal ? `    signal: ${value.signal}` : '') +
      `    ${value.durationMs} ms` +
      (value.truncated ? '    [输出已按 maxOutputBytes 截断]' : ''),
  ].join('\n');
  const blocks = [head];
  if (value.stdout !== '') blocks.push(`--- stdout ---\n${clampForRender(value.stdout)}`);
  if (value.stderr !== '') blocks.push(`--- stderr ---\n${clampForRender(value.stderr)}`);
  if (value.stdout === '' && value.stderr === '') blocks.push('(无输出)');
  return blocks.join('\n\n');
}

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    plugin: { type: 'string' },
    pluginVersion: { type: 'string' },
    installedVersion: { type: 'string' },
    reloadRequired: { type: 'boolean' },
    version: { type: 'string' },
    cli: { type: 'string' },
    cliOk: { type: 'boolean' },
    cliError: { type: 'string' },
    mcpServerName: { type: 'string' },
    mcpConnected: { type: 'boolean' },
    mcpTools: { type: 'number' },
    cwd: { type: 'string' },
    security: {
      type: 'object',
      properties: {
        officialEnv: { type: 'array', items: { type: 'string' } },
        secrets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, configured: { type: 'boolean' } },
            required: ['name', 'configured'],
            additionalProperties: false,
          },
        },
        cacheDir: { type: 'string' },
      },
      required: ['officialEnv', 'secrets', 'cacheDir'],
      additionalProperties: false,
    },
  },
  required: [
    'plugin',
    'pluginVersion',
    'installedVersion',
    'reloadRequired',
    'cli',
    'cliOk',
    'mcpServerName',
    'mcpConnected',
    'mcpTools',
    'cwd',
    'security',
  ],
  additionalProperties: false,
};

const CLI_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    cwd: { type: 'string' },
    exitCode: { type: 'number' },
    signal: { type: 'string' },
    durationMs: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['command', 'cwd', 'exitCode', 'durationMs', 'stdout', 'stderr', 'truncated'],
  additionalProperties: false,
};

/** ruflo_status：一条命令看清 CLI 与 MCP 两侧是否真的可用。 */
function createStatusTool(ctx, runner) {
  return {
    name: 'ruflo_status',
    description:
      'Report whether Ruflo is actually usable in this session: the ruflo CLI version and the number of registered mcp__ruflo__* tools. Use it before a Ruflo-heavy task, or when Ruflo tools seem missing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
    },
    async execute() {
      return readStatus(ctx, runner);
    },
  };
}

/** ruflo_cli：官方 CLI 的完整出口（26 个命令、140+ 子命令）。 */
function createCliTool(settings, runner) {
  return {
    name: 'ruflo_cli',
    description:
      'Run any Ruflo CLI subcommand with the official `ruflo` binary and return stdout, stderr and the exit code. Use it for capabilities that the mcp__ruflo__* tools do not expose (for example `doctor --fix`, `swarm status`, `memory export`, `plugins list`, `daemon status`). Pass an argv array; no shell is involved. Example: {"args": ["doctor", "--fix"]}.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments after `ruflo`, e.g. ["memory", "stats"] or ["--version"].',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for this call; defaults to the plugin cwd (home).',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-call timeout in milliseconds; clamped to the configured timeoutMs.',
        },
      },
      required: ['args'],
      additionalProperties: false,
    },
    // 工具层超时略大于内层超时，让内部先报出可读错误。
    timeoutMs: settings.timeoutMs + 60_000,
    output: {
      schema: CLI_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatCliResult(value) }],
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const list = Array.isArray(input.args) ? input.args.map((item) => String(item)) : [];
      if (list.length === 0) {
        throw new Error('ruflo_cli 需要非空 args 数组，例如 {"args": ["--version"]}');
      }
      return runner.run(list, {
        cwd: text(input.cwd),
        timeoutMs: Number(input.timeoutMs),
        signal: exec.signal,
      });
    },
  };
}

/** /ruflo：在输入框里直接看状态或跑任意子命令，输出进对话。 */
function createRufloCommand(ctx, runner) {
  return {
    name: 'ruflo',
    description: '查看 Ruflo 状态，或执行任意 ruflo CLI 子命令（例如 /ruflo doctor --fix）',
    input: { hint: '[status | <ruflo 参数>]' },
    async handler(invocation) {
      const raw = invocation.rawInput.trim();
      if (raw === '' || raw === 'status') {
        const status = await readStatus(ctx, runner);
        return { kind: 'success', text: formatStatus(status) };
      }
      const args = splitArgs(raw);
      if (args.length === 0) {
        return { kind: 'error', text: '没有解析到参数。示例：/ruflo doctor --fix' };
      }
      const result = await runner.run(args, { signal: invocation.signal });
      return {
        kind: result.exitCode === 0 ? 'success' : 'error',
        text: formatCliResult(result),
      };
    },
  };
}

/**
 * Web 状态页的数据通道：GET /dsh-ruflo/status。
 *
 * 只在 Web profile 注册（那里才有 webServer 与 connection）；TUI/headless 下
 * 插件其余能力不受影响。鉴权复用 Connection 的 Host/Origin 与浏览器凭据检查，
 * 与 /api 通道同一套规则，避免自建“裸接口”。
 */
const WEB_STATUS_ROUTE = '/dsh-ruflo/status';

/** 按工具名首段归类：agent_spawn → agent，hive-mind_init → hive-mind。 */
function toolFamilies(ctx, serverName) {
  const prefix = `mcp__${serverName}__`;
  const counts = new Map();
  let schemas = [];
  try {
    schemas = ctx.tools.schemas();
  } catch {
    schemas = [];
  }
  for (const tool of schemas) {
    if (!tool.name.startsWith(prefix)) continue;
    const raw = tool.name.slice(prefix.length);
    const family = raw.split('_')[0] || raw;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([familyName, count]) => ({ name: familyName, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function respondJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function createStatusRoute(ctx, runner) {
  let cachedAt = 0;
  let cachedValue = null;
  let inflight = null;

  /** 合并并发刷新：多个标签页同时轮询时只跑一次 CLI。 */
  function refresh() {
    if (inflight !== null) return inflight;
    inflight = (async () => {
      const status = await readStatus(ctx, runner);
      return {
        ...status,
        families: toolFamilies(ctx, runner.mcpServerName),
        checkedAt: new Date().toISOString(),
      };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    kind: 'exact',
    path: WEB_STATUS_ROUTE,
    async handler(req, res) {
      try {
        // 401/403 由 Connection 统一下发；只有被信任的页面请求才继续。
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          respondJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
          return;
        }
        const now = Date.now();
        if (cachedValue === null || now - cachedAt > 2_500) {
          cachedValue = await refresh();
          cachedAt = Date.now();
        }
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end();
          return;
        }
        respondJson(res, 200, cachedValue);
      } catch (error) {
        respondJson(res, 500, { error: 'status-unavailable', message: errorMessage(error) });
      }
    },
  };
}

/**
 * 插件入口。
 *
 * 注意：这里不直接读 MCP 工具数——MCP 行可能比本插件晚激活；数量在
 * ruflo_status 被调用时实时统计，永远反映当下真实状态。
 */
export function apply(ctx, config) {
  const readSettings = () => resolveConfig(config);
  const settings = readSettings();
  const runner = createRunner(ctx, readSettings);

  if (settings.promptGuidance) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'ruflo',
        order: PROMPT_ORDER,
        text: PROMPT_SECTION,
      }),
    );
  }

  ctx.effect(() => ctx.tools.register(createStatusTool(ctx, runner)));
  ctx.effect(() => ctx.tools.register(createCliTool(settings, runner)));

  // 原生执行层（1.2.0）：真实子代理、真实 DAG、确定性安全扫描、模型探针。
  for (const tool of createNativeTools(ctx)) {
    ctx.effect(() => ctx.tools.register(tool));
  }
  ctx.effect(() => ctx.commands.register(createRufloCommand(ctx, runner)));

  // Web 状态页：只在同时具备 webServer 与 connection 的 profile 注册（即 Web）。
  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(() => scope.webServer.register(createStatusRoute(scope, runner)));
  });

  if (settings.registerSkill) {
    ctx.inject(['skills'], (scope) => {
      scope.effect(() =>
        scope.skills.register({
          name: 'ruflo',
          description:
            'Official Ruflo multi-agent orchestration: mcp__ruflo__* tools, the ruflo CLI via ruflo_cli, and status checks via ruflo_status.',
          whenToUse:
            'Use when the task needs multi-agent swarms, cross-session memory, learned routing, hooks, durable tasks/workflows, security scans, or federation — and prefer native Harness tools for single-agent work.',
          source: 'runtime',
          content: RUFLO_SKILL,
        }),
      );
    });
  }
}

// 安全测试/审计用的纯函数导出；运行时只使用 apply。
export { buildChildEnv, safeWorkdir, securitySummary };
