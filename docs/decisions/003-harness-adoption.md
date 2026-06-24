---
date: 2026-06-25
status: active
---

# 003 — 宿主层采用 @plimeor/harness;core 不再自带 codex

来源：docs/plans/2026-06-24-productization-and-fairness-plan.md（「Harness adoption」节），
取代该计划的 WS3（in-repo `HostInstaller` + `CodexHostInstaller` + `init`/`uninstall`，曾以 T006/T007/T013/T014 实现）。

## 决定

agent-workflows 把**整个宿主层**——宿主选择 / 探测 / health / 安装 / 卸载，**以及 subagent 执行**——
委托给已发布的 `@plimeor/harness`。`packages/adapter-codex` 删除,`core` 不再含任何 codex 执行或安装代码;
`core` 面向 `@plimeor/harness` 的 `HarnessAdapter` / `process.run` 编程。**codex 细节只存在于 `@plimeor/harness`,
core 不感知 codex。**

- **管理**：`getHarness(host).open().extensions.install / uninstall`、`health.check`、`detection`;
  `--harness` 默认 `codex`、探测失败报错。codex / claude / kiro / pi 由 SDK 提供。
- **执行**：`agent()` → `harness…​.process.run`（text run）;**schema 校验 + 重试留在 agent-workflows**（已有,
  叠在 text run 之上,无需 StandardSchema 转换）;`AbortSignal` → `run.kill()`;`ok = exitCode === 0`。

## 放弃的方案（及原因）

- **自建 in-repo `HostInstaller` + `CodexHostInstaller` + 模板化 skills + `init`/`uninstall`（原 WS3）** —
  被发布的 `@plimeor/harness` 取代:后者多宿主（codex/claude/kiro/pi）、自带 ownership / 冲突 / 回滚 / 锁的
  安装安全,维护成本归 SDK,不再在本仓重复造。
- **运行侧保留内部 codex runner（`runCodexAgent` / `mcp-policy`）** — 不需要。owner 确认 per-agent
  model / effort / sandbox / MCP-scoping 与 token usage / budget 都不重要,published harness 的 `process.run`
  已足够,故运行侧也彻底解耦。

## 非目标

- **不修改 `@plimeor/harness`**——它是外部已发布依赖,未授权改动;本仓只做消费侧适配。harness run 面当前
  不带 usage / per-run 运行配置,这是有意接受的边界,不在本决策内通过改 SDK 来补。
- 不在 `core` 保留任何 codex 兼容路径或 `*_CODEX_*` 残留。

## 影响

- 取代计划 WS3;WS1 / WS2 / WS4 / WS5 / WS6 不受影响。
- decisions 001（DSL 契约）、002（agent-workflows 自身 MCP run-surface）仍有效——002 管的是被 harness
  安装进宿主的 `agent-workflows mcp` server,与「subagent 如何被运行」正交。
