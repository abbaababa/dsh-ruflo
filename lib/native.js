/**
 * dsh-ruflo 原生执行层（host 1.2.0）
 *
 * 把两件过去只能"声明"的事做成真的：
 *   1. 子代理执行：走 Harness 的 ctx.subagents（provider = spawn），
 *      由 exec.agent 作父级，可显式指定 provider / model / reasoningEffort。
 *      → ruflo_agent_run、ruflo_workflow_run、ruflo_model_probe
 *   2. 安全扫描：确定性规则引擎（注入 / PII / 密钥 / 危险命令 / 路径穿越），
 *      可选 deep 模式交给子代理复核。
 *      → ruflo_guard_scan
 *
 * 不复制 Ruflo 的编排实现：工作流定义仍由 Ruflo 的 workflow_create 管理，
 * 这里只提供"在 Harness 内真实执行步骤"的宿主能力。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const MAX_STEPS = 12;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_PROMPT_CHARS = 120_000;
const RECEIPT_TEXT_LIMIT = 4_000;

/** 默认路由：生产步用 Doubao，审查步用 DeepSeek V4.1 Flash（可用参数覆盖）。 */
export const DEFAULT_ROUTES = {
  production: { provider: 'decode', model: 'doubao-seed-evolving' },
  review: { provider: 'deepseek-official', model: 'deepseek-flash' },
};

function clamp(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function getSubagents(ctx) {
  let svc;
  try {
    svc = ctx.get('subagents');
  } catch {
    svc = undefined;
  }
  if (!svc) {
    try {
      svc = ctx.subagents;
    } catch {
      svc = undefined;
    }
  }
  if (!svc || typeof svc.startActivation !== 'function') {
    throw new Error('subagents 服务不可用：当前 profile 未加载 dsh-subagent，无法执行原生子代理');
  }
  return svc;
}

/** 核心：创建一个真实子代理并等待结果。 */
async function runAgent(ctx, exec, options) {
  const svc = getSubagents(ctx);
  const parent = exec && exec.agent;
  if (!parent) throw new Error('缺少调用方 Agent（exec.agent 为空）：原生执行必须在会话内调用');
  const prompt = String(options.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt 不能为空');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt 过长（>${MAX_PROMPT_CHARS} 字符）`);

  const provider = options.provider || DEFAULT_ROUTES.production.provider;
  const model = options.model || DEFAULT_ROUTES.production.model;
  const agentOptions = { provider, model };
  if (options.effort) agentOptions.reasoningEffort = String(options.effort);
  if (Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0) {
    agentOptions.maxTokens = Math.floor(Number(options.maxTokens));
  }

  const timeoutMs = clamp(options.timeoutMs, 5_000, 900_000, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const parentSignal = exec && exec.signal;
  const onAbort = () => controller.abort();
  if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    parentSignal.addEventListener('abort', onAbort, { once: true });
  }

  const startedAt = Date.now();
  let activation;
  try {
    activation = await svc.startActivation({
      provider: options.providerName || 'spawn',
      label: options.label || 'ruflo-native',
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        agentOptions,
        maxDepth: 1,
      },
      signal: controller.signal,
      delivery: 'caller',
    });
  } catch (error) {
    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
      parentSignal.removeEventListener('abort', onAbort);
    }
    throw new Error(`子代理启动失败（provider=${options.providerName || 'spawn'}）：${error && error.message ? error.message : error}`);
  }

  let hardTimer;
  try {
    const result = await Promise.race([
      activation.result,
      new Promise((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error(`子代理执行超时（${timeoutMs}ms）`)),
          timeoutMs + 5_000,
        );
      }),
    ]);
    return {
      text: blocksToText(result && result.output),
      stopReason: result && result.stopReason ? String(result.stopReason) : 'unknown',
      provider,
      model,
      effort: agentOptions.reasoningEffort ?? '',
      durationMs: Date.now() - startedAt,
      childId: activation.childId ? String(activation.childId) : '',
      diagnostic: result && result.diagnostic ? String(result.diagnostic).slice(0, 1_000) : '',
    };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (parentSignal && typeof parentSignal.removeEventListener === 'function') {
      parentSignal.removeEventListener('abort', onAbort);
    }
    try {
      if (typeof activation.dispose === 'function') await activation.dispose();
    } catch {
      /* dispose 失败不影响结果 */
    }
  }
}

function resolveDir(dir) {
  if (!dir) return null;
  const raw = String(dir);
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function getPath(object, path) {
  const keys = String(path || '').split('.').filter(Boolean);
  let cursor = object;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function evaluateCondition(when, vars) {
  if (when === null || typeof when !== 'object') return Boolean(when);
  const value = getPath(vars, when.path);
  if (Object.prototype.hasOwnProperty.call(when, 'equals')) return value === when.equals;
  if (Object.prototype.hasOwnProperty.call(when, 'truthy')) return Boolean(value) === Boolean(when.truthy);
  if (Object.prototype.hasOwnProperty.call(when, 'contains')) {
    return typeof value === 'string' && value.includes(String(when.contains));
  }
  return Boolean(value);
}

function interpolate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    const value = getPath(vars, key);
    if (value === undefined || value === null) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…（已截断）` : text;
  });
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 执行一个由 ruflo workflow_create 定义的 DAG（task / condition / wait）。 */
async function runWorkflow(ctx, exec, input) {
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, MAX_STEPS) : [];
  if (steps.length === 0) {
    throw new Error('steps 不能为空：请传 [{id,type:"task",prompt}, …]，最多 12 步');
  }
  const defaults = {
    provider: input.provider || DEFAULT_ROUTES.production.provider,
    model: input.model || DEFAULT_ROUTES.production.model,
    effort: input.effort || 'high',
  };
  const receipt = {
    workflow: input.workflowId || input.name || 'inline',
    startedAt: new Date().toISOString(),
    defaults,
    status: 'running',
    steps: [],
  };
  const vars = { ...(input.vars && typeof input.vars === 'object' ? input.vars : {}) };

  for (const step of steps) {
    const id = String(step.id || `step-${receipt.steps.length + 1}`);
    const type = String(step.type || 'task');
    const startedAt = Date.now();

    if (type === 'wait') {
      const ms = clamp(step.ms, 0, 60_000, 1_000);
      await sleep(ms);
      receipt.steps.push({ id, type, status: 'completed', durationMs: Date.now() - startedAt });
      continue;
    }

    if (type === 'condition') {
      const ok = evaluateCondition(step.when, vars);
      receipt.steps.push({ id, type, status: ok ? 'completed' : 'stopped', passed: ok, durationMs: Date.now() - startedAt });
      if (!ok) {
        receipt.status = 'stopped';
        break;
      }
      continue;
    }

    const prompt = interpolate(step.prompt, vars);
    if (!prompt.trim()) throw new Error(`步骤 ${id} 的 prompt 为空`);
    const attempt = await runAgent(ctx, exec, {
      prompt,
      label: `${receipt.workflow}:${id}`,
      provider: step.provider || defaults.provider,
      model: step.model || defaults.model,
      effort: step.effort || defaults.effort,
      maxTokens: step.maxTokens,
      timeoutMs: step.timeoutMs || input.timeoutMsPerStep,
    });
    vars[id] = attempt.text;
    receipt.steps.push({
      id,
      type: 'task',
      status: attempt.stopReason === 'completed' ? 'completed' : `ended:${attempt.stopReason}`,
      provider: String(attempt.provider ?? ''),
      model: String(attempt.model ?? ''),
      effort: String(attempt.effort ?? ''),
      durationMs: attempt.durationMs,
      chars: attempt.text.length,
      output: attempt.text.slice(0, RECEIPT_TEXT_LIMIT),
      diagnostic: String(attempt.diagnostic ?? ''),
    });
  }

  receipt.finishedAt = new Date().toISOString();
  if (receipt.status === 'running') receipt.status = 'completed';

  const dir = resolveDir(input.artifactsDir);
  if (dir) {
    await mkdir(dir, { recursive: true });
    const file = resolve(dir, `${String(receipt.workflow).replace(/[^\w.-]+/g, '_')}.receipt.json`);
    await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    receipt.receiptPath = file;
  }
  return receipt;
}

const SECURITY_RULES = [
  { id: 'prompt-injection-en', severity: 'high', re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i },
  { id: 'prompt-injection-zh', severity: 'high', re: /(忽略|无视|忘记|跳过)(之前|以上|前面|所有|系统)?(的)?(指令|提示词?|规则|要求)/ },
  { id: 'system-prompt-leak', severity: 'high', re: /(reveal|print|show|输出|泄露|打印).{0,16}(system\s*prompt|系统提示词|初始指令|隐藏指令)/i },
  { id: 'jailbreak-role', severity: 'medium', re: /(你现在是|you are now|act as).{0,30}(dan|jailbreak|无限制|不受任何限制|开发者模式)/i },
  { id: 'secret-openai', severity: 'high', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { id: 'secret-aws', severity: 'high', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'secret-github', severity: 'high', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'pii-email', severity: 'low', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'pii-cn-id', severity: 'medium', re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/ },
  { id: 'danger-rm-root', severity: 'high', re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/|\$HOME|~)(?:\s|$)/ },
  { id: 'danger-curl-pipe', severity: 'high', re: /\bcurl\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/ },
  { id: 'danger-chmod-777', severity: 'medium', re: /\bchmod\s+(?:-R\s+)?777\b/ },
  { id: 'danger-sql-drop', severity: 'high', re: /\b(?:drop|truncate)\s+table\b/i },
  { id: 'path-traversal', severity: 'medium', re: /(?:^|[\s"'])(?:\.\.\/){2,}/ },
];

function maskExcerpt(text, index, length) {
  const start = Math.max(0, index - 20);
  const raw = text.slice(start, Math.min(text.length, index + length + 20));
  return raw.replace(/[A-Za-z0-9_+/=-]{12,}/g, (token) => `${token.slice(0, 4)}***`);
}

function scanText(text) {
  const findings = [];
  for (const rule of SECURITY_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    findings.push({
      rule: rule.id,
      severity: rule.severity,
      excerpt: maskExcerpt(text, match.index, match[0].length),
    });
  }
  const score = findings.reduce((sum, item) => sum + (item.severity === 'high' ? 40 : item.severity === 'medium' ? 20 : 8), 0);
  const verdict = score >= 40 ? 'unsafe' : score >= 15 ? 'suspicious' : 'safe';
  return { verdict, score, findings };
}

/* ───────────────────────── 工具定义 ───────────────────────── */

function agentRunTool(ctx) {
  return {
    name: 'ruflo_agent_run',
    description:
      'Run one real subagent through the Harness subagent service (no external API key needed). Defaults to provider "decode" / model "doubao-seed-evolving" (Doubao) at effort "high"; pass provider/model/effort to override. Returns the child final text plus the exact route and duration used, so callers can build an honest model ledger.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Self-contained task for the child agent.' },
        label: { type: 'string', description: 'Short label shown in the session.' },
        provider: { type: 'string', description: 'Provider route id, e.g. decode or deepseek-official.' },
        model: { type: 'string', description: 'Model id, e.g. doubao-seed-evolving or deepseek-flash.' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'max'], description: 'Reasoning effort.' },
        maxTokens: { type: 'number', description: 'Max output tokens for the child.' },
        timeoutMs: { type: 'number', description: 'Hard timeout in ms (5000-900000).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    timeoutMs: 900_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          stopReason: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
          durationMs: { type: 'number' },
          childId: { type: 'string' },
          diagnostic: { type: 'string' },
        },
        required: ['text', 'stopReason', 'provider', 'model', 'effort', 'durationMs', 'childId', 'diagnostic'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `[${value.provider}/${value.model}${value.effort ? ` · ${value.effort}` : ''} · ${value.durationMs}ms · ${value.stopReason}]\n\n${value.text}`,
        },
      ],
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      return runAgent(ctx, exec, input);
    },
  };
}

function workflowRunTool(ctx) {
  return {
    name: 'ruflo_workflow_run',
    description:
      'Execute a Ruflo workflow DAG for real inside the Harness (task / condition / wait steps). Each task step runs a subagent with an explicit provider/model/effort; results flow into later steps via {{stepId}} interpolation. Writes a JSON receipt (per-step model, duration, status, output excerpt) when artifactsDir is given. Max 12 steps.',
    parameters: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Ruflo workflow id, for the receipt only.' },
        name: { type: 'string', description: 'Human name for the receipt.' },
        provider: { type: 'string', description: 'Default provider for task steps.' },
        model: { type: 'string', description: 'Default model for task steps.' },
        effort: { type: 'string', description: 'Default reasoning effort.' },
        artifactsDir: { type: 'string', description: 'Directory for the receipt JSON.' },
        vars: { type: 'object', description: 'Initial variables available to {{name}} interpolation.' },
        steps: {
          type: 'array',
          description: 'Ordered steps. task: {id,prompt,provider?,model?,effort?}; condition: {id,when:{path,equals|truthy|contains}}; wait: {id,ms}.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['task', 'condition', 'wait'] },
              prompt: { type: 'string' },
              when: { type: 'object' },
              ms: { type: 'number' },
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
              timeoutMs: { type: 'number' },
            },
            required: ['id'],
            additionalProperties: true,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    timeoutMs: 1_800_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          startedAt: { type: 'string' },
          finishedAt: { type: 'string' },
          status: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          receiptPath: { type: 'string' },
        },
        required: ['workflow', 'startedAt', 'status', 'steps'],
        additionalProperties: true,
      },
      render: (_args, value) => {
        const lines = value.steps.map((step) => {
          if (step.type === 'task') return `- ${step.id}: ${step.status} · ${step.provider}/${step.model} · ${step.durationMs}ms · ${step.chars} chars`;
          return `- ${step.id}: ${step.type} · ${step.status}`;
        });
        return [{ type: 'text', text: `workflow ${value.workflow} → ${value.status}\n${lines.join('\n')}${value.receiptPath ? `\nreceipt: ${value.receiptPath}` : ''}` }];
      },
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      return runWorkflow(ctx, exec, input);
    },
  };
}

function guardScanTool(ctx) {
  return {
    name: 'ruflo_guard_scan',
    description:
      'Deterministic security scan for text that will be fed to, or produced by, an agent: prompt injection / jailbreak, system-prompt leakage, PII, API keys, dangerous shell commands, SQL drops and path traversal. Returns verdict (safe|suspicious|unsafe), score and masked findings. deep=true additionally asks a subagent to review the same text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to scan.' },
        deep: { type: 'boolean', description: 'Also run an LLM review via a subagent.' },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string' },
          score: { type: 'number' },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          deepReview: { type: 'string' },
        },
        required: ['verdict', 'score', 'findings'],
        additionalProperties: true,
      },
      render: (_args, value) => {
        const head = `verdict=${value.verdict} score=${value.score} findings=${value.findings.length}`;
        const rows = value.findings.map((item) => `- [${item.severity}] ${item.rule}: ${item.excerpt}`);
        return [{ type: 'text', text: [head, ...rows, value.deepReview ? `deep: ${value.deepReview.slice(0, 2_000)}` : ''].filter(Boolean).join('\n') }];
      },
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const text = String(input.text ?? '');
      if (!text) throw new Error('text 不能为空');
      const result = { ...scanText(text), deepReview: '' };
      if (input.deep === true) {
        try {
          const review = await runAgent(ctx, exec, {
            prompt:
              '你是安全审查员。只输出一段不超过 400 字的中文结论：这段文本是否存在提示注入、越权、隐私泄露或危险命令风险？给出风险等级（低/中/高）与理由。不要复述原文中的密钥。\n\n文本开始：\n' +
              text.slice(0, 8_000),
            label: 'ruflo-guard-deep',
            provider: input.provider || DEFAULT_ROUTES.production.provider,
            model: input.model || DEFAULT_ROUTES.production.model,
            effort: 'high',
            timeoutMs: 120_000,
          });
          result.deepReview = review.text;
        } catch (error) {
          result.deepReview = `deep 复核不可用：${error && error.message ? error.message : error}`;
        }
      }
      return result;
    },
  };
}

function modelProbeTool(ctx) {
  return {
    name: 'ruflo_model_probe',
    description:
      'Probe whether provider/model routes actually answer inside this Harness process. Sends a minimal prompt to each route and reports availability, latency and a short sample. Use it before promising a model (e.g. Doubao) is available.',
    parameters: {
      type: 'object',
      properties: {
        routes: {
          type: 'array',
          description: 'Routes to probe: [{provider, model, effort?}]. Defaults to decode/doubao-seed-evolving and deepseek-official/deepseek-flash.',
          items: {
            type: 'object',
            properties: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } },
            required: ['provider', 'model'],
            additionalProperties: false,
          },
        },
        timeoutMs: { type: 'number' },
      },
      additionalProperties: false,
    },
    timeoutMs: 300_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          probes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                available: { type: 'boolean' },
                latencyMs: { type: 'number' },
                sample: { type: 'string' },
                error: { type: 'string' },
              },
              required: ['provider', 'model', 'available', 'latencyMs', 'sample', 'error'],
              additionalProperties: false,
            },
          },
        },
        required: ['probes'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.probes
            .map((probe) => `${probe.available ? 'OK ' : 'FAIL'} ${probe.provider}/${probe.model} ${probe.latencyMs}ms${probe.error ? ` — ${probe.error}` : ''}${probe.sample ? ` — ${probe.sample.slice(0, 60)}` : ''}`)
            .join('\n'),
        },
      ],
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const routes = Array.isArray(input.routes) && input.routes.length > 0
        ? input.routes
        : [DEFAULT_ROUTES.production, DEFAULT_ROUTES.review];
      const probes = [];
      for (const route of routes.slice(0, 6)) {
        const startedAt = Date.now();
        try {
          const outcome = await runAgent(ctx, exec, {
            prompt: '只回复两个字符：OK',
            label: 'ruflo-model-probe',
            provider: route.provider,
            model: route.model,
            effort: route.effort || 'low',
            timeoutMs: clamp(input.timeoutMs, 5_000, 180_000, 60_000),
          });
          probes.push({
            provider: route.provider,
            model: route.model,
            available: outcome.text.length > 0 && outcome.stopReason === 'completed',
            latencyMs: Date.now() - startedAt,
            sample: outcome.text.slice(0, 200),
            error: outcome.stopReason === 'completed' ? '' : `stopReason=${outcome.stopReason}${outcome.diagnostic ? `: ${outcome.diagnostic.slice(0, 200)}` : ''}`,
          });
        } catch (error) {
          probes.push({
            provider: route.provider,
            model: route.model,
            available: false,
            latencyMs: Date.now() - startedAt,
            sample: '',
            error: String(error && error.message ? error.message : error).slice(0, 400),
          });
        }
      }
      return { probes };
    },
  };
}

/* ───────────────────── claims 自动规范化（1.2.1） ───────────────────── */

const AGENT_ID_RE = /^agent[-_][A-Za-z0-9._-]+$/u;

/**
 * 把用户/模型给的松散 claimant 归一化成 Ruflo 认领工具要求的严格三段式：
 *   human:<userId>:<name>  或  agent:<agentId>:<agentType>
 * 裸 agentId（agent-xxx）自动补 agentType；裸名字自动补 human:local:<name>。
 * Ruflo 的 parseClaimant 只接受三段式，裸 id 会返回 “Invalid claimant format”，
 * 这就是 2026-10-21 那次工具报错的根因。
 */
export function normalizeClaimant(raw, agentType) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const parts = value.split(':');
  const head = parts[0];
  if (head === 'human' && parts.length >= 3) {
    const userId = parts[1].trim();
    const name = parts.slice(2).join(':').trim();
    if (userId && name) return `human:${userId}:${name}`;
  }
  if (head === 'agent' && parts.length >= 3) {
    const agentId = parts[1].trim();
    const type = parts[2].trim();
    if (agentId && type) return `agent:${agentId}:${type}`;
  }
  if (head === 'agent' && parts.length === 2 && parts[1].trim()) {
    return `agent:${parts[1].trim()}:${String(agentType ?? '').trim() || 'agent'}`;
  }
  if (head === 'human' && parts.length === 2 && parts[1].trim()) {
    return `human:${parts[1].trim()}:${parts[1].trim()}`;
  }
  const type = String(agentType ?? '').trim() || 'agent';
  if (parts.length === 2 && AGENT_ID_RE.test(parts[0].trim()) && parts[1].trim()) {
    return `agent:${parts[0].trim()}:${parts[1].trim()}`;
  }
  if (AGENT_ID_RE.test(value)) return `agent:${value}:${type}`;
  if (!value.includes(':')) return `human:local:${value}`;
  throw new Error(
    `claims: 无法识别的 claimant "${value}"；应为 human:<userId>:<name> 或 agent:<agentId>:<agentType>（裸 agentId 会自动补全）。`,
  );
}

const CLAIMS_ACTIONS = {
  claim: 'claims_claim',
  release: 'claims_release',
  status: 'claims_status',
  handoff: 'claims_handoff',
  steal: 'claims_steal',
  mark_stealable: 'claims_mark-stealable',
  accept_handoff: 'claims_accept-handoff',
  board: 'claims_board',
  list: 'claims_list',
};

const STEALABLE_REASONS = ['overloaded', 'stale', 'blocked-timeout', 'voluntary'];
const CLAIM_STATUSES = ['active', 'paused', 'blocked', 'review-requested', 'completed'];

function claimsTool(ctx) {
  return {
    name: 'ruflo_claims',
    description:
      'Call Ruflo claims tools with automatic claimant normalization. Use this INSTEAD of mcp__ruflo__claims_claim / claims_release / claims_status / claims_handoff / claims_steal / claims_mark-stealable / claims_accept-handoff: those require an exact "human:<userId>:<name>" or "agent:<agentId>:<agentType>" claimant, and a bare agent id fails with "Invalid claimant format". This tool accepts a bare agent id (agent-…) plus optional agentType, a bare name, or an already-canonical claimant, and forwards it through the live MCP connection.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: Object.keys(CLAIMS_ACTIONS),
          description: 'claim | release | status | handoff | steal | mark_stealable | accept_handoff | board | list',
        },
        issueId: { type: 'string', description: 'Issue id (required for every action except board/list).' },
        claimant: {
          type: 'string',
          description: 'Loose claimant: bare agent id (agent-…), bare name, human:u:n, or agent:id:type. Normalized automatically.',
        },
        agentType: { type: 'string', description: 'Agent type used when a bare agent id is normalized (default "agent").' },
        context: { type: 'string', description: 'Context for claim / mark_stealable.' },
        reason: { type: 'string', description: 'Reason for release / handoff; for mark_stealable one of overloaded|stale|blocked-timeout|voluntary.' },
        note: { type: 'string', description: 'Status note.' },
        progress: { type: 'number', description: 'Progress 0-100 for status.' },
        status: { type: 'string', enum: CLAIM_STATUSES, description: 'New claim status.' },
        from: { type: 'string', description: 'Handoff source claimant (loose, normalized).' },
        to: { type: 'string', description: 'Handoff target claimant (loose, normalized).' },
        preferredTypes: { type: 'array', items: { type: 'string' }, description: 'Preferred agent types for mark_stealable.' },
        ttlMs: { type: 'number', description: 'Claim time-to-live in ms.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          tool: { type: 'string' },
          claimant: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'action', 'tool', 'claimant', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `[claims ${value.action} → ${value.ok ? 'ok' : 'failed'} · ${value.tool}${value.claimant ? ` · ${value.claimant}` : ''}]\n${value.text}`,
        },
      ],
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const action = String(input.action ?? '').trim();
      const mcpName = CLAIMS_ACTIONS[action];
      if (!mcpName) {
        throw new Error(`ruflo_claims: action 必须是 ${Object.keys(CLAIMS_ACTIONS).join(' | ')}`);
      }
      const issueId = String(input.issueId ?? '').trim();
      if (action !== 'board' && action !== 'list' && !issueId) {
        throw new Error(`ruflo_claims: action=${action} 需要 issueId`);
      }
      const claimant = normalizeClaimant(input.claimant, input.agentType);
      const payload = {};
      if (issueId) payload.issueId = issueId;
      if (claimant) payload.claimant = claimant;
      if (action === 'claim') {
        if (!claimant) throw new Error('ruflo_claims: claim 需要 claimant');
        if (input.context) payload.context = String(input.context);
        if (input.ttlMs !== undefined) payload.ttlMs = Number(input.ttlMs);
      } else if (action === 'release') {
        if (!claimant) throw new Error('ruflo_claims: release 需要 claimant');
        if (input.reason) payload.reason = String(input.reason);
      } else if (action === 'status') {
        const status = String(input.status ?? '').trim();
        if (!CLAIM_STATUSES.includes(status)) {
          throw new Error(`ruflo_claims: status 必须是 ${CLAIM_STATUSES.join(' | ')}`);
        }
        payload.status = status;
        if (input.note) payload.note = String(input.note);
        if (input.progress !== undefined) payload.progress = Number(input.progress);
      } else if (action === 'handoff') {
        const from = normalizeClaimant(input.from || input.claimant, input.agentType);
        const to = normalizeClaimant(input.to, input.agentType);
        if (!from || !to) throw new Error('ruflo_claims: handoff 需要 from 与 to');
        payload.from = from;
        payload.to = to;
        if (input.reason) payload.reason = String(input.reason);
        if (input.progress !== undefined) payload.progress = Number(input.progress);
      } else if (action === 'steal') {
        const stealer = normalizeClaimant(input.claimant, input.agentType);
        if (!stealer) throw new Error('ruflo_claims: steal 需要 claimant（stealer）');
        payload.stealer = stealer;
      } else if (action === 'mark_stealable') {
        const reason = String(input.reason ?? 'voluntary').trim();
        if (!STEALABLE_REASONS.includes(reason)) {
          throw new Error(`ruflo_claims: mark_stealable 的 reason 必须是 ${STEALABLE_REASONS.join(' | ')}`);
        }
        payload.reason = reason;
        if (input.context) payload.context = String(input.context);
        if (Array.isArray(input.preferredTypes)) payload.preferredTypes = input.preferredTypes.map(String);
      } else if (action === 'accept_handoff') {
        if (!claimant) throw new Error('ruflo_claims: accept_handoff 需要 claimant');
      } else if (action === 'list') {
        if (input.status) payload.status = String(input.status);
        if (claimant) payload.claimant = claimant;
      }
      const tools = ctx.get('tools') ?? ctx.tools;
      if (!tools || typeof tools.execute !== 'function') {
        throw new Error('ruflo_claims: 当前上下文没有 tools 服务');
      }
      const callId = `ruflo_claims_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      let outcome;
      try {
        outcome = await tools.execute({
          callId,
          name: `mcp__ruflo__${mcpName}`,
          arguments: payload,
          agent: exec.agent,
          signal: exec.signal,
        });
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        return { ok: false, action, tool: `mcp__ruflo__${mcpName}`, claimant, text: `调用失败：${message}` };
      }
      const text = blocksToText(outcome.content);
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const ok = outcome.isError !== true && !(parsed && (parsed.success === false || parsed.error));
      return { ok, action, tool: `mcp__ruflo__${mcpName}`, claimant, text };
    },
  };
}

/** 注册入口：apply() 里逐个 ctx.effect(() => ctx.tools.register(tool))。 */
export function createNativeTools(ctx) {
  return [agentRunTool(ctx), workflowRunTool(ctx), guardScanTool(ctx), modelProbeTool(ctx), claimsTool(ctx)];
}
