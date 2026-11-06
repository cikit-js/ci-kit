# 圆桌配置（table）

`.ci-kit/roundtable/table.md` 只描述**议事规则**：阶段序列、裁决方式、预算与退路。它不写议题，也不写任何具体业务。

## frontmatter

```markdown
---
title: 每日例会
schedule: daily
budget:
  total: 12
  perSeat: 4

phases:
  - id: propose
    seats: [editor]
  - id: discuss
    seats: [writer, guard]
  - id: produce
    seats: [writer]
  - id: review
    seats: [guard]
    vetoable: true
  - id: converge
    seats: [host]

onVeto: re-propose
maxAttempts: 3
---
```

## 顶层字段

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 目录名 | 会议名称，写入 `record.md` 标题 |
| `schedule` | string | — | 声明性的人读提示（`daily` / `weekly` / 等），圆桌不解析调度，定时由外部 CI 负责 |
| `budget.total` | number | 不限 | 整场会允许的总 AI 调用次数 |
| `budget.perSeat` | number | 不限 | 单席位默认上限，席位 `seat.budget` 可覆盖 |
| `onVeto` | enum | `re-propose` | 被否决后的动作：`re-propose` / `revise` / `abort` |
| `maxAttempts` | number | `3` | 最多循环几轮，防止无限重来 |

### budget 的单位

**按 AI 调用计，按席位记账**：一个席位一次发言如果需要两次调用（先草稿、再自检），记 2 次。理由是最直接、最好核算，也与 `@cikit-js/ai` 的 `text()` 一对一对应。

预算在每次调用前检查并在调用后落盘。超预算即停，结果是「未完成」而不是「成功」。

### onVeto 的三种动作

| 值 | 行为 | 适用 |
| --- | --- | --- |
| `re-propose` | 回到第一个 `propose` 阶段，重新想议题 | 方向本身不对 |
| `revise` | 停在当前阶段，把否决意见回给产出方重做 | 方向对、做法不对 |
| `abort` | 立即结束，保留全部记录 | 不可接受即停 |

## phases

一组有序的阶段。**阶段是续跑与幂等的锚点**：知道停在哪一阶段，才知道从哪里继续。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 阶段唯一标识 |
| `seats` | string[] | 否 | 本阶段参与的席位 id；省略时按席位 `seat.phase` 反查 |
| `vetoable` | boolean | 否 | 本阶段可否决，默认 `false` |
| `requires` | string[] | 否 | 依赖的前序阶段 id，省略时依赖上一个阶段 |
| `mode` | `serial` \| `parallel` | 否 | 席位间执行方式，默认 `serial` |

### mode 的选择

| 模式 | 语义 | 适用 |
| --- | --- | --- |
| `serial` | 逐个发言，后一位看到前一位（受 `sees` 约束） | 讨论、质询、评审 |
| `parallel` | 同时发言，互相看不见，事后合并 | 发散、独立立论 |

默认为 `serial`，因为「讨论」的本质是后发言者能回应先发言者。`parallel` 是显式选择：它更快，但失去辩论。

## 典型的五阶段结构

```
propose ──> discuss ──> produce ──> review ──> converge
  议题         讨论        产出        审核        收口
```

| 阶段 | 通常做什么 | 谁来 |
| --- | --- | --- |
| `propose` | 从上下文里提出可做的事 | `canPropose: true` 的席位 |
| `discuss` | 附议、反驳、补充 | 参与讨论的席位 |
| `produce` | 真正产出（写文章、出方案、打补丁） | 执行席位 |
| `review` | 核对，可否决 | `canVeto: true` 的席位 |
| `converge` | 收口成人可读结论 | 主持席位 |

阶段名只是**约定**，不是硬编码：`table.md` 写什么就按什么跑。但 `propose` 和 `converge` 有特殊含义（分别对应「提议题」和「收口」），自定义名称时需要显式声明角色：

```markdown
special:
  propose: 议题阶段 id
  converge: 收口阶段 id
```

省略时按名字匹配，匹配不到则按「第一个阶段」和「最后一个阶段」推断。

## 阶段依赖与剪枝

`requires` 声明依赖。若某阶段的所有必需前置阶段都没有产出，该阶段整体跳过，并记一条 `skipped` 记录，不报错。

这与 `fallback` 的区别：`fallback` 管**单个席位失败**，`requires` 管**整个阶段无输入**。

## 校验

| 规则 | 行为 |
| --- | --- |
| 阶段 id 重复 | 报错 |
| `requires` 指向不存在的阶段 | 报错 |
| 存在循环依赖 | 报错，不尝试自动打破 |
| `seats` 引用不存在的席位 | 报错 |
| 没有任何阶段 | 报错 |
| `budget.total` 小于阶段数 | 只警告，不报错（可能某些阶段不耗调用） |

## 与席位的关系

| 谁定义 | 定义什么 |
| --- | --- |
| `table.md` | 这场会开哪些阶段、按什么顺序、什么规则 |
| 席位 md | 我参加哪些阶段、我有多大的权、我是什么人 |

两处都能声明「参与哪个阶段」，取**交集**；席位出现在 `table.md` 的 `seats` 里但自身 `seat.phase` 不含该阶段时报错，避免静默不生效。