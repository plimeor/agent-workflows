---
date: 2026-06-26
status: active
---

# 004 — 单包结构:monorepo 收敛为单一 npm 包

## 决定

agent-workflows 从双包 monorepo(`packages/core` + `packages/cli`)收敛为**单一包**
`@plimeor/agent-workflows`。所有源码在 `src/`(引擎/DSL 与 CLI/MCP 并列),示例 workflow 在
`workflows/`,安装资产在 `assets/{skills,hooks}`,测试在 `test/`。只有一个 `package.json`:
`bin → src/cli.ts`、`exports → src/index.ts`。沿用 Bun 原生直接运行 `.ts`,无构建步骤。

## 放弃的方案(及原因)

- **保留双包 monorepo** —— core/cli 拆分的主要理由是隔离 harness 抽象;harness 已拆为独立发布包
  `@plimeor/harness`(见 docs/decisions/003)之后,本仓不再需要内部包边界。没有外部消费者单独依赖
  core,拆分只剩 `workspace:*` 跨依赖与发布时的版本协调成本,无收益。
- **用 `bun build` 把 core 打进 cli 再发单包** —— 不需要。Bun 直接跑 TS 源码,单包以
  `files: [src, assets, workflows]` 直接发布即可,无需构建产物。

## 非目标

- 不改变引擎 / DSL / harness 边界 —— docs/decisions/001(DSL 契约)与 003(harness 采用)不受影响。
- 不引入构建步骤;继续以 TS 源码分发(与 `@plimeor/harness` 一致)。

## 影响

- 发布从「两个 scoped 包 + 解析 `workspace:*`」简化为单次 `bun publish`。
- 阅读源码只需看 `src/` 一处。项目级开发上下文见 AGENTS.md;开发命令见 CONTRIBUTING.md。
