# 运行模型

## 一场会的生命周期

```
load      读取 table.md 与 seats/*.md，校验，等调用方传入主题
  ↓
discuss   所有席位并发发言，到时间停止
  ↓
judge     程序裁决（投票 / 否决 / 阈值）
  ↓
loop      未通过时按 onVeto 与 maxAttempts 决定重来或收手
  ↓
finalize  写会议记录，返回结构化结果
```

一次落盘（`state.json`）记录断点与消耗。

## 发言池

一场会有一个**发言池**，所有席位说过的话都会实时追加进去。

```
发言池 = [
  { seat: "grom",   content: "这个方案我们店做不到" },
  { seat: "jaina",  content: "开头太平，读者会划走" },
  { seat: "grom",   content: "不过第三个动作可以试" },
  { seat: "medivh", content: "平均寿命 15 个月这句缺出处" }
]
```

**池是共享的、只追加的。** 任何席位每次发起请求时，取一份当前池的快照作为「前序发言」放进提示词。谁先说完、谁后说完都不影响——它只是往池里追加。

这就是讨论能成立的原因：后说话的人天然看得见先说话的人，不需要谁去通知谁。

## 并发讨论

会一开始，所有席位**同时进入各自的循环**：

```
runSeat(seat):
  直到 deadline 或预算耗尽：
    snapshot = 池的当前快照（按 sees 过滤）
    result   = await text(buildPrompt(topic, brief, context, snapshot))
    池.append(result)
    persist()
```

### 时间怎么算

`deadline = 开始时间 + durationMs`（默认 3 分钟）。

- 到 deadline 后**不再发起新请求**
- 已经在飞行的请求照常等待返回并追加到池——已经付费了，丢弃是浪费
- 因此实际结束时间可能略晚于 deadline

### 并发下的顺序

发言进入池的顺序 = 实际返回顺序，不由席位声明顺序决定。

这意味着同一份配置跑两次，池的顺序可能不同。**这是真实的**：真人开会也是谁抢到话谁先说。记录里保留实际时间戳，可追溯。

### 为什么必须并发

串行意味着「A 说完 → B 开始思考 → B 说完 → C 开始思考」，一轮下来是 N 倍延迟。

并发下，所有人在同一时间段内持续接话。3 分钟能聊出好几轮对话，而不是一轮。

## 提示词的内容

每次调用带四块内容，分区标注：

| 区块 | 内容 | 来源 |
| --- | --- | --- |
| 议题 | 这场讨论要回答什么 | `topic`（必填） |
| 背景 | 为什么开这场会 | `brief`（可选） |
| 材料 | 桌上摆的东西，逐条编号 | `context`（可选） |
| 前序发言 | 池里已有的发言，按 `sees` 过滤 | 圆桌维护 |

前三块是外部输入，第四块是讨论过程。分开标注，模型才能分清「要讨论的问题」和「别人说了什么」。

## 可见性（sees）

| 取值 | 含义 |
| --- | --- |
| `all`（默认） | 看得见池内所有已完成发言 |
| `none` | 看不见任何人的发言，只看得到议题、背景与材料 |

### 为什么需要 none

如果所有席位都能看见所有发言，会出现两个退化：

1. **审核变附和** — 审核方读到别人的意见，会顺着接受
2. **讨论成回响室** — 后发言者倾向于贴合多数意见，观点多样性消失

因此独立审核类席位应写 `sees: none`。它拿到「要判断的东西」和「判定标准」，拿不到「别人怎么想」。

`topic` / `brief` / `context` 不受 `sees` 影响：即使 `sees: none`，席位照样看得见要讨论什么。

## 裁决由程序做

**模型永远不返回 `approved`。**

| 谁 | 产出 | 不产出 |
| --- | --- | --- |
| 席位 | `verdict`（`pass` / `reject`）、`score`、`issues` | 最终通过与否 |
| 圆桌程序 | 依据 `canVeto`、`weight`、阈值算出通过与否 | — |

理由：模型说「通过」不可靠，且会与文字建议矛盾。程序裁决保证同一份记录永远得出同一结论。

### 裁决算法

```
本场结论 =
  若任一 canVeto 席位给出 veto              → 否决
  否则若 加权通过票 / 加权总票 ≥ threshold  → 通过
  否则                                     → 否决
```

单个席位失败（`fallback: skip`）不计入总票数，并记一条 `skipped`——失败不等于反对。

## 一票否决

`canVeto: true` 是强权力，**任一否决即否决**。多人表决用 `weight` 表达，两者不混用：

| 需求 | 用哪个 |
| --- | --- |
| 某席位说了不就不能过 | `canVeto` |
| 多数人同意就能过 | `weight` + `threshold` |
| 少数人反对要压过多数 | 改用 `canVeto` |

否决必须带理由。空理由的否决记 `invalid-veto`，不计入。

## 预算

| 检查点 | 行为 |
| --- | --- |
| 每次调用前 | 池内 token 超过 `maxPoolTokens` 时，丢弃最早的发言 |
| 每次调用后 | 记录用量，便于复盘成本 |

没有调用次数预算。输入成本由 `maxPoolTokens` 封顶：池子超长时丢弃最早发言，输入 token 恒定；输出成本由 `seat.maxTokens` 封顶。

预算耗尽不是错误，是**结论**：状态置 `aborted`，记录说明消耗。

## 失败与退路

| `fallback` | 行为 |
| --- | --- |
| `skip`（默认） | 该席位停止发言，记 `skipped`，其他席位继续讨论 |
| `retry` | 按 `@ci-kit/ai` 的 `retries` 重试；仍失败则按 `skip` |
| `abort` | 立即终止整场会，状态 `aborted` |

**默认 `skip`** 的理由：讨论中一个人掉线不该散会，但它的缺席必须被记录，不能被当成同意。

失败分类沿用 `@ci-kit/ai` 的 `AiError.kind`：

| kind | 是否重试 |
| --- | --- |
| `quota` / `server` / `network` | `retry` 下重试 |
| `auth` / `config` / `request` | 不重试，直接按 `fallback` |
| `output` | 不重试（付费调用可能已成功），按 `fallback` |

## 幂等与续跑

| 场景 | 行为 |
| --- | --- |
| 同一次会重复执行 | 已通过则直接返回结果，不再调用模型 |
| 中途中断 | `--resume <run-dir>` 从 `state.json` 记录的进度继续 |
| 已完成而重跑 | 复造记录，不重新调用 |
| 修改席位或 table | 视为**新的一场会**，不续跑 |

### 续跑怎么做

讨论是一段连续的时间，不是可数的步骤。续跑的做法是：

- 已产生的发言保留在池里，作为前序发言
- 剩余时间 = `durationMs - (now - startedAt)`
- 剩余时间不足则直接进入裁决

这避免「聊到一半崩了，全部重来」的浪费。

### 状态机

| 状态 | 含义 | 是否终态 |
| --- | --- | --- |
| `running` | 正在讨论 | 否 |
| `passed` | 裁决通过 | 是 |
| `rejected` | 轮次用尽仍未通过 | 是 |
| `aborted` | 触发 `abort` 或预算耗尽 | 是 |
| `failed` | 配置或环境错误，未进入正常执行 | 是 |

`finishedAt` 只有终态才写。

## 上下文（context）

圆桌不采集。`context` 由调用方传入，原样分发给所有席位，作为「桌上摆的材料」：

| 形态 | 说明 |
| --- | --- |
| 字符串 | 直接作为文本上下文 |
| 数组 | 逐条编号后分发 |

`context` 与发言池是两回事：前者是外部材料，后者是讨论过程。

## CLI 形态

```bash
ci-kit-roundtable run --config .ci-kit/roundtable --topic "这篇能不能发" --out roundtable-out
ci-kit-roundtable run --config .ci-kit/roundtable --topic "…" --resume roundtable-out/2026-11-06T08-00-00
ci-kit-roundtable init  .ci-kit/roundtable
ci-kit-roundtable check --config .ci-kit/roundtable
```

`--topic` 必填。`--brief` 与 `--context-file` 可选。

`check` 不产生任何付费调用，适合放进 CI 前置检查。
