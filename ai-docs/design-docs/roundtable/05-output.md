# 产出

一场会产出四件东西，放在一个以开始时间命名的目录里：

```
roundtable-out/
└── 2026-11-06T08-00-00/
    ├── record.json      # 结构化发言序列，程序接口
    ├── record.md        # 人可读会议纪要
    ├── state.json       # 运行状态：阶段、attempts、预算消耗
    └── artifacts/       # 席位产出的文件（可选）
```

目录名用本地时间到秒，不用自增编号：无需锁，天然不冲突，便于按时间排序与清理。

## record.json（唯一稳定接口）

程序只读这个文件。任何下游（发布、审批、告警）都应该通过它取结果。

```json
{
  "schema": 1,
  "title": "每日例会",
  "startedAt": "2026-11-06T08:00:00+08:00",
  "finishedAt": "2026-11-06T08:09:41+08:00",
  "status": "passed",
  "attempts": 1,
  "verdict": { "passed": true, "vetoed": [], "score": 0.67 },
  "rounds": [
    {
      "attempt": 1,
      "phases": [
        {
          "id": "propose",
          "status": "completed",
          "statements": [
            {
              "seat": "editor",
              "name": "林小满",
              "role": "选题编辑",
              "phase": "propose",
              "status": "completed",
              "content": "……",
              "structured": { "topic": "…", "reason": "…" },
              "usage": { "input": 1234, "output": 567 },
              "model": "glm-5.3-flash",
              "durationMs": 8123
            }
          ]
        }
      ]
    }
  ],
  "budget": { "total": 12, "used": 9, "perSeat": { "editor": 1, "writer": 2, "guard": 1 } }
}
```

### 字段约定

| 字段 | 说明 |
| --- | --- |
| `status` | `passed` / `rejected` / `aborted` / `failed` |
| `attempts` | 实际轮次，≤ `maxAttempts` |
| `verdict.vetoed` | 给出否决的席位 id 列表 |
| `verdict.score` | 加权通过率，0–1 |
| `rounds[].phases[].status` | `completed` / `skipped` / `failed` / `budget-exhausted` |
| `statements[].status` | 同上，加上 `invalid-veto` |
| `statements[].structured` | 席位 `output: json` 时的解析结果 |
| `statements[].usage` | 来自 `@ci-kit/ai` 的 `AiResult.usage`，缺失则省略 |

`content` 保留原始文本，不做裁剪或摘要——它是可追溯的最后一道凭据。原始模型输出不写进 `state.json`，只在 `record.json` 里保留可用内容。

### 不记录什么

| 不记录 | 理由 |
| --- | --- |
| API Key | 永不入盘 |
| 完整请求体 | 可能包含敏感上下文 |
| 模型原始错误响应 | 只保留 `AiError.describe()` 级别的一行 |
| 带签名的 URL | 会泄漏凭据 |

## record.md（人读纪要）

由 `record.json` 渲染，不额外调用模型：

```markdown
# 每日例会 · 2026-11-06

**结论**：通过（通过率 67%，无否决）
**轮次**：第 1 轮 · 预算 9/12 · 用时 9 分 41 秒

## 议题

> 门店高峰期交接班的记录缺口，是否值得单独成篇。

—— 林小满 ✍️ 选题编辑

## 讨论

**老周 🛡️ 事实审核**：这个说法有数据支撑吗？口径是什么……

**小陈 ✏️ 作者**：回应：……

## 产出

（正文摘要或链接到 artifacts）

## 审核

**老周**：缺证 2 处，见下方清单。

| 序号 | 哪句话 | 缺什么 | 怎么补 |
| --- | --- | --- | --- |
| 1 | …… | …… | …… |

## 收口

……
```

### 渲染规则

| 规则 | 说明 |
| --- | --- |
| 用 `name` 不用 `id` | 人读得懂 |
| 保留 `avatar` | 快速区分席位 |
| 跳过 `skipped` 的席位 | 但文末列出「缺席名单」 |
| `content` 原样进 | 不摘要，摘要会失真 |
| 结构化输出渲染成表格 | `structured` 是对象时按「键 / 值」两列展开 |

## state.json（运行状态）

用于续跑，不供外部消费。

```json
{
  "schema": 1,
  "runId": "2026-11-06T08-00-00",
  "status": "running",
  "attempt": 1,
  "phaseIndex": 2,
  "phaseId": "produce",
  "seatIndex": 0,
  "budget": { "total": 12, "used": 5, "perSeat": { "editor": 1 } },
  "fingerprint": "sha256:…",
  "resumable": true
}
```

### fingerprint

`table.md`、所有参与席位的 md、以及圆桌包自身版本，共同算一个指纹。

| 场景 | 行为 |
| --- | --- |
| 指纹一致 | 允许 `--resume` |
| 指纹不一致 | 拒绝续跑，提示「规则已变更，请开新的一场会」 |

这与「修改提示词不重写已完成日期的草稿」是同一思路。

## artifacts/

席位产出的大块内容（文章稿、补丁、生成的图）不塞进 `record.json`，而是写文件，由 statement 引用：

```json
{ "seat": "writer", "artifacts": [{ "path": "artifacts/attempt-1-draft.md", "bytes": 4823 }] }
```

路径相对运行目录，永远用正斜杠存，便于跨平台消费。

同一轮次重来时文件名带 `attempt-N-` 前缀，不覆盖上一轮产物——旧产物是复盘依据。

## 库接口

```ts
import { checkRoundtable, loadRoundtable, runRoundtable } from '@ci-kit/roundtable'

// 只加载与校验，不调用模型
const plan = await loadRoundtable({ configDir: '.ci-kit/roundtable' })

const result = await runRoundtable({
  configDir: '.ci-kit/roundtable',
  context: ['外部资讯……', '自有材料……'],
  topic: undefined, // 可选人工覆盖
  outDir: 'roundtable-out',
  env: process.env
})

result.status // 'passed' | 'rejected' | 'aborted' | 'failed'
result.record // record.json 的对象形式
result.recordPath // 落盘位置
```

`runRoundtable` 不抛业务失败：否决、超预算、席位全挂都通过 `status` 表达；只有配置错误和用法错误会抛异常。

## CLI 输出

正式结果走 stdout 一行摘要，细节在文件里：

```
roundtable: passed · 1 attempt · 9/12 calls · 9m41s · roundtable-out/2026-11-06T08-00-00
```

失败时 stderr 一行：

```
roundtable: rejected · 3 attempts · 12/12 calls · roundtable-out/2026-11-06T08-00-00
```

退出码：`0` 通过，`1` 未通过，`2` 配置或环境错误。CI 可以只依赖退出码。