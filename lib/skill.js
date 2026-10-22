/**
 * 全局技能正文：让每个项目里的模型都知道 Ruflo 的三层入口（MCP 工具 / CLI / 状态）。
 *
 * 这里的工具族名称来自实际注册的 mcp__ruflo__* 工具（工具数量以运行期实测为准），
 * 不写死数量，避免升级后数字过期。
 */
export const RUFLO_SKILL = `# Ruflo orchestration (official ruflo)

Ruflo (ruvnet/ruflo, the runtime formerly distributed as claude-flow) is wired into this
Harness by the \`dsh-ruflo\` plugin. It is the official runtime, not a reimplementation:
the plugin starts the official MCP server and shells out to the official CLI.

## Three surfaces

1. **MCP tools** — every tool is named \`mcp__ruflo__<name>\`. Families include:
   - \`agent_*\` / \`managed_agent_*\` — spawn, inspect, run, pool and terminate agents
   - \`swarm_*\` — topology, consensus, health, pheromone scheduling
   - \`memory_*\` — store, retrieve, semantic search, stats, import/export
   - \`hooks_*\` — routing, model selection, pattern learning, background workers
   - \`task_*\` / \`session_*\` / \`workflow_*\` — durable coordination
   - \`security\`/\`aidefence_*\`, \`neural_*\`, \`performance_*\`, \`github_*\`,
     \`browser_*\`, \`federation_*\`, \`mission_*\` — specialised capabilities
2. **CLI** — \`ruflo_cli\` runs any ruflo subcommand as an argv array (no shell parsing),
   for example \`{"args": ["doctor", "--fix"]}\` or \`{"args": ["swarm", "status"]}\`.
   The \`/ruflo <args>\` composer command does the same and prints the output in chat.
3. **Status** — \`ruflo_status\` reports the CLI version and how many \`mcp__ruflo__*\`
   tools are actually registered in this session.

## When to reach for Ruflo

Use it for multi-agent swarms, cross-session memory, learned model/agent routing, hooks,
durable task queues, workflow pipelines, security scans, or federation. For a one-file
edit or a question a single agent can answer in one turn, prefer the native Harness tools
(\`read\`, \`edit\`, \`bash\`, \`subagent\`) — orchestration overhead is not worth it there.

## Typical loop

1. \`memory_search\` with \`namespace: "patterns"\` to recall earlier decisions.
2. \`swarm_init\` and/or \`agent_spawn\` when the work genuinely fans out.
3. Do the actual edits with the native Harness tools.
4. \`memory_store\` and \`hooks_post-task\` to persist what worked.

## Operational notes

- Ruflo state (\`.claude-flow\`, \`.swarm\`, the memory database) lives under the CLI working
  directory. The plugin defaults that directory to the user's home, so memory is shared
  across projects; change \`cwd\` in the plugin settings for a project-local store.
- \`ruflo_cli\` runs with the Harness process permissions (same trust level as the MCP
  server it ships with), not inside the workspace write sandbox.
- The CLI binary is resolved from \`cliPath\` when set, otherwise from \`cliCommand\` +
  \`cliArgs\` (default \`npx -y ruflo@3.59.7\`).
`;
