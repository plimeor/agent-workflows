---
date: 2026-06-28
status: active
---

# 006 — schema 重试改为 repair pass

上游决策:docs/decisions/001-workflow-dsl-fidelity-contract.md(其映射表的 `agent()` 行与 §8
substrate 分歧中对 schema 重试的描述),docs/decisions/003-harness-adoption.md(校验与重试在
**引擎侧**、而非 host)。

## 决定

schema-bound `agent()` 的重试,从「整跑重开原始任务」改为 **repair pass**。

`attempts` 仍为 2(一次原始 + 一次重试)。按失败类型分流(`src/engine/hooks.ts` 的重试循环):

- **parse / validate 失败**(`res.ok`,但回复 JSON 脏或不合 schema):上一跑已有产出,重试走
  `buildRepairPrompt`(`src/engine/agent-run.ts`)—— 只发 **SUBAGENT_PREAMBLE + 上次原始回复 +
  schema + 精确校验错误**,要求 agent **只重排、不重做分析、不读任何东西**;**不再附带原始任务 prompt
  和 profile 前导**,因此重试不重读文件、不重推理。repair 指令写死「不许编造、不许丢弃;某个 required
  字段在上次回复里找不到依据,就置 null/空,而非猜一个值」。
- **host 进程死亡**(`!res.ok`):上一跑无产出,无可修,重试仍整跑原始 prompt。

## 放弃的方案(及原因)

- **整跑重开(旧 substrate,decision 001)** —— 重试重发含「整文件读入」的原始 prompt,为修一个 JSON
  信封而重读文件 + 重新分析;且旧实现只回灌错误信息、不带上次输出,把已经做对的分析整个扔掉重做。文件
  读取 + 重推理是重试里的 token 大头,这是主要浪费来源。
- **把上次输出灌进现有的整跑 correction** —— 仍重发原始任务 prompt、仍重读文件,只解决「丢了上次分析」,
  没解决主成本。
- **改用 host 原生 structured output 的 in-conversation 重试** —— 会让引擎依赖某个 host 的 tool-retry
  能力,违反 host-agnostic(decision 003:引擎只走文本 run + 引擎侧校验)。
- **只放宽解析(剥 code fence / 容忍尾逗号,零模型调用)** —— 只治信封噪声,治不了类型/形状错;可作为
  repair 之前的 tier-0 叠加,但单独不足以替代 repair。

## 非目标

- 不改 `agent(prompt, { schema })` 的对外 DSL 契约:仍返回校验过的对象,持续失败仍返 `null`。repair 是
  拿到该结果的内部手段,不是 API 表面变化(decision 001 的脚本面契约不受影响)。
- 不改 `attempts`(仍为 2,即一次 repair)。
- 不改 resume journal 的 key:仍按原始 `prompt` + 影响结果的 `opts` 计算,repair prompt 永不进入 key,
  resume 行为不变(decision 001 的内容寻址 journal 不受影响)。
- 不回改 decision 001 —— 其对旧 substrate 的描述是该时点的记录;新现实由本决定承载。

## 影响

- 常见的信封 / 类型错(回复带 prose、code fence、把数字写成字符串等)被廉价修好:重试不再重读文件、不再
  重推理,单次重试从「约一整跑」降到「几百~几千 token 的重排」,且已产出的分析被保留。
- **Tradeoff**:上次回复**真把某个 required 字段整个漏了**的情况,repair 不读文件、补不回真值,按「不编造」
  原则置 null → 校验仍不过 → 返 `null`;旧的整跑重开则有机会重新产出该字段。即省 token 的代价,是这种
  少见情形的恢复率下降。对资金敏感的评审输出,「宁可置 null / 判无效,也不编造一个 required 值」是更安全
  的方向。
- decision 001 中对 schema 重试 substrate 的描述(「a miss re-spawns a fresh codex exec … the retry
  prompt now includes the prior failure」)自本决定起被取代;001 作为时点历史保留。
