# 运行模型

## 一次会的生命周期

```
load      读取 table.md 与 seats/*.md，校验，构建运行计划
  ↓
exec      按阶段顺序执行席位发言
  ↓
judge     程序裁决（投票 / 否决 / 阈值）
  ↓
loop      未通过时按 onVeto 与 maxAttempts 决定重来或收手
  ↓
finalize  写会议记录四件套，返回结构化结果
```

每个阶段结束都落一次盘（`state.json`），因此任何时刻中断都能定位到「停在哪个阶段、消耗了多少调用」。

## 状态机

一场会只有五种状态：

| 状态 | 含义 | 是否终态 |
| --- | --- | --- |
| `running` | 正在执行 | 否 |
| `passed` | 裁决通过 | 是 |
| `rejected` | 轮次用尽仍未通过 | 是 |
| `aborted` | 触发 `abort` 或预算耗尽 | 是 |
| `failed` | 配置或环境错误，未进入正常执行 | 是 |

`finishedAt` 只有终态才写。`running` 状态下重跑会走续跑逻辑，不会重头再来。

## 可见性（sees）

这是圆桌最重要的机制，决定「讨论」是否成立。

| 取值 | 含义 |
| --- | --- |
| `all`（默认） | 看见本阶段内所有前序发言 |
| `none` | 看不见任何人的发言，只看得到上下文与自己的任务 |
| `lead-only` | 只看见主持的发言 |
| `[id, ...]` | 只看见指定席位的发言 |

### 为什么必须控制可见性

如果所有席位都能看见所有发言，会出现两个退化：

1. **审核变附和** — 审核方读到作者的自我论证，会顺着接受。
2. **讨论成回响室** — 后发言者倾向于贴合多数意见，观点多样性消失。

因此独立审核类席位应写 `sees: none`。它只拿到「要审的东西」和「判定标准」，拿不到「作者为什么这么写」。

### 可见性作用域

`sees` 只作用于**当前这一轮**的发言。跨轮的完整历史需要显式开启（见「上下文」一节）。

## 裁决由程序做

**模型永远不返回 `approved`。**

| 谁 | 产出 | 不产出 |
| --- | --- | --- |
| 席位 | `verdict`（如 `pass` / `reject`）、`score`、`issues`、`suggestions` | 最终通过与否 |
| 圆桌程序 | 依据 `vetoable`、`canVeto`、`weight`、阈值算出通过与否 | — |

理由：模型说「通过」不可靠，且会与文字建议矛盾。程序裁决保证同一份记录永远得出同一结论。

### 裁决算法

```
本阶段结论 =
  若任一 canVeto 席位给出 veto       → 否决
  否则若 加权通过票 / 加权总票 ≥ threshold → 通过
  否则                                → 否决
```

`threshold` 默认 `0.5`（简单多数），可在 `table.md` 覆盖。

单个席位失败（`fallback: skip`）不计入总票数，并记一条 `skipped` 记录——失败不等于反对。

## 一票否决

`canVeto: true` 是强权力，**任一否决即否决**。多人表决用 `weight` 表达，两者不混用：

| 需求 | 用哪个 |
| --- | --- |
| 某席位说了不就不能过 | `canVeto` |
| 多数人同意就能过 | `weight` + `threshold` |
| 少数人反对要压过多数 | 不建议，改用 `canVeto` |

否决必须带理由。空理由的否决被视为无效，记 `invalid-veto` 并继续——防止模型随手否定。

## 预算

| 检查点 | 行为 |
| --- | --- |
| 调用前 | 若 `total` 或该席位 `budget` 已用尽，跳过该席位，记 `budget-exhausted` |
| 调用后 | 立即累加并落盘 |

预算耗尽不是错误，是**结论**：状态置 `aborted`，记录说明「在哪个阶段耗尽」。

`budget` 计数单位是 AI 调用，一个席位一次发言可能消耗多次（例如草稿 + 自检）。

## 失败与退路

| `fallback` | 行为 |
| --- | --- |
| `skip`（默认） | 跳过该席位，记 `skipped`，继续 |
| `retry` | 按 `@ci-kit/ai` 的 `retries` 重试；仍失败则按 `skip` 处理 |
| `abort` | 立即终止整场会，状态 `aborted` |

**默认 `skip`** 的理由：无人值守时，一个席位失败不应该拖死整场会；但它的缺席必须被记录，不能被当成同意。

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
| 修改席位或 table | 视为**新的一场会**，不续跑（规则变了，进度不可比） |

规则变化不续跑是刻意的：与「修改提示词不重写已完成日期的草稿」同一思路——已经按旧规则产出的内容，不应该在规则变化后被静默替换。

## 上下文（context）

圆桌不采集。`context` 由使用者传入，原样分发给需要它的席位：

| 形态 | 说明 |
| --- | --- |
| 字符串 | 直接作为文本上下文 |
| 数组 | 逐条编号后分发 |
| 函数 | 延迟求值，用于按阶段取不同输入 |

`context` 只进不退：所有阶段都能看见「最初给的上下文」，但看不见「别人中间产生的临时思考」——除非该席位 `sees` 允许。

## 并发

| 模式 | 实现 |
| --- | --- |
| `serial` | 顺序 `await`，后一位的输入包含前一位发言 |
| `parallel` | `Promise.all`，发言互不可见，结束后一次性合并 |

`parallel` 只在本阶段 `mode: parallel` 时生效；即使席位写了 `sees: all`，并行阶段内也拿不到同阶段的其他发言（因为它们还没发生）。

## CLI 形态

```bash
ci-kit-roundtable run --config .ci-kit/roundtable --out roundtable-out
ci-kit-roundtable run --config .ci-kit/roundtable --topic "要不要做会员积分互通"   # 可选覆盖
ci-kit-roundtable run --config .ci-kit/roundtable --resume roundtable-out/2026-11-06T08-00-00
ci-kit-roundtable init  .ci-kit/roundtable                                          # 生成示例
ci-kit-roundtable check --config .ci-kit/roundtable                                 # 只校验，不调用模型
```

`--topic` 是人工校准入口。无人值守的定时任务不传它，靠席位在 `propose` 阶段自行提议题。

`check` 不产生任何付费调用，适合放进 CI 前置检查。