---
date: 2026-06-28
status: active
---

# 005 — `get_run` 默认紧凑投影

上游决策:docs/decisions/002-run-runtime-contract.md(MCP run-control surface)。

## 决定

`agent_workflows_get_run` 默认返回一个**紧凑进度摘要**,而不是 `getRun` 的完整读出。摘要只含进度
转述所需的字段:

```json
{
  "runId": "wf_...",
  "name": "deep-review",
  "state": "running",
  "currentPhase": "Verify",
  "updatedAt": 1782638381557,
  "phases": [
    { "title": "Review", "done": 11 },
    { "title": "Verify", "running": 3, "done": 7, "error": 1 },
    { "title": "Synthesize" }
  ],
  "narration": ["...最后 5 条..."],
  "result": null,
  "view": "summary"
}
```

- `phases` 是按声明顺序排列的每 phase agent 计数,**只列非零状态**,父会话由此即可拼出
  `Review ✓2/2 · Verify ◐3 ✗1` 这类一行状态。
- `narration` 截到最后 5 条;`result` 仅在终态非空(running 期间为 null)。
- 摘要视图**不读、也不返回** `progress.log` tail(`logTailBytes` 在 summary 下被忽略),也不返回
  `launch` / `process` / `heartbeat` / `control` / 完整 `agents[]`。

`view: 'full'` 显式取回未投影的完整读出(完整 `agents[]` + launch/process/heartbeat/control +
`progress.log` tail,沿用 `logTailBytes`/`includeResult` 语义),用于钻取单个卡住或报错的 agent。

投影只活在 MCP 层(`src/cli/mcp.ts` 的 `projectRun`):`getRun` core 与 `status.json` 存储不变,
CLI `watch` / `ps` 仍消费完整 agent 树。`waitMs` 的有界等待语义(decision 002)不变——等待循环仍读
完整状态判定终态,只在返回那一刻投影。

配套指导:安装的 skill 把父会话的稳态轮询周期下限定为 **60 秒/次**(首次确认启动可更短),并说明默认
摘要足以转述、`view:'full'` 仅用于钻取。

## 放弃的方案(及原因)

- **保持默认全量,新增 `view:'summary'` 选项** —— 省不省取决于父会话是否遵守 skill;`get_run` 是个被
  反复轮询的工具,默认就该是便宜的那条路径,贵的全量读出应是显式 opt-in。
- **只改指导、不动工具(拉长 `waitMs`、少轮询)** —— 只降轮询频率,降不了单轮体积。真正的增长项是
  `status.agents[]`(随 agent 数线性增长)和 `progress.log` tail(append-only、随 run 单调增长);每轮
  全量返回并在父上下文里逐轮累积,是接近平方级的 token 堆积,纯指导改不掉。
- **收窄 `status.json` 存储或 `getRun` core** —— 会波及直接消费完整 agent 树来渲染实时进度树的 CLI
  `watch` / `ps`。收窄点应落在 MCP 读投影,而非存储或 core。

## 非目标

- 不改 `status.json` / `result.json` 等 durable run files 的结构,也不改 `getRun` core 的返回。
- 不改 `waitMs` 有界等待、`includeResult`、`logTailBytes` 的既有语义;summary 只是不主动取 log tail。
- 不改 MCP resources(`agent-workflows://runs/{runId}/{status,result,progress-log,script,journal}`)
  —— 需要某一类完整原文时,resource 仍是直读入口。

## 影响

- 一次长 run(1–2 小时、数十个 agent、几十次轮询)的父会话 token 占用大幅下降:每轮从「全量对象 +
  单调增长的 log tail」降为约十余行、且**不随 agent 数或 run 时长增长**的有界摘要。
- 任何依赖 `get_run` 默认返回里 `agents[]` / `launch` / `progressLog` 字段的消费方需显式传
  `view:'full'`。当前唯一的消费方是 skill 指导下的父会话,已同步更新。
