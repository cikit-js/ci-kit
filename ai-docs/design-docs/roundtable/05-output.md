# 产出

一场会产出三样东西，放在一个以开始时间命名的目录里：

```
roundtable-out/
└── 2026-11-06T08-00-00/
    ├── record.json      # 结构化发言序列，程序接口
    ├── record.md        # 人可读会议纪要
    ├── state.json       # 运行状态：断点与预算消耗
    └── artifacts/       # 席位产出的大块内容（可选）
```

目录名用本地时间到秒，不用自增编号：无需锁，天然不冲突，便于按时间排序与清理。

## record.json（唯一稳定接口）

程序只读这个文件。任何下游（发布、审批、告警）都应该通过它取结果。

```json
{
  "schema": 2,
  "title": "文章审核圆桌",
  "topic": "这篇《昨天的服务，为什么今天才看到评价》能不能发",
  "brief": "刚通过机器审核，需要四个人从不同角度再过一遍。",
  "startedAt": "2026-11-06T08:00:00+08:00",
  "finishedAt": "2026-11-06T08:01:14+08:00",
  "status": "rejected",
  "attempts": 1,
  "verdict": { "passed": false, "vetoed": ["uther"], "score": 0.33 },
  "statements": [
    {
      "seat": "grom",
      "name": "格罗姆",
      "role": "门店读者视角",
      "at": "2026-11-06T08:00:09+08:00",
      "status": "completed",
      "content": "文章说的是我遇到的问题，但我还是不知道第一步做什么。",
      "verdict": "reject",
      "usage": { "input": 2431, "output": 31 },
      "model": "glm-5.3-flash",
      "durationMs": 8214
    },
    {
      "seat": "jaina",
      "name": "吉安娜",
      "role": "品牌与表达",
      "at": "2026-11-06T08:00:11+08:00",
      "status": "completed",
      "content": "开头太平，读者会划走。",
      "verdict": "reject",
      "usage": { "input": 2410, "output": 14 },
      "model": "glm-5.3-flash",
      "durationMs": 9603
    },
    {
      "seat": "medivh",
      "name": "麦迪文",
      "role": "事实核查",
      "at": "2026-11-06T08:00:14+08:00",
      "status": "completed",
      "content": "「平均寿命 15 个月」这句没给出处。",
      "verdict": "reject",
      "durationMs": 11240
    },
    {
      "seat": "grom",
      "name": "格罗姆",
      "role": "门店读者视角",
      "at": "2026-11-06T08:00:31+08:00",
      "status": "completed",
      "content": "同意吉安娜，开头应该直接是不知怎么办的那个店长。",
      "verdict": "reject",
      "durationMs": 7418
    },
    {
      "seat": "thrall",
      "name": "萨尔",
      "role": "主持",
      "at": "2026-11-06T08:01:05+08:00",
      "status": "completed",
      "content": "三条问题指向同一处：文章没给出门店能做的第一步。先补这一处再发。",
      "verdict": "reject",
      "durationMs": 34120
    }
  ],
  "usage": { "input": 41230, "output": 2880 }
}
```

### 字段约定

| 字段 | 说明 |
| --- | --- |
| `schema` | 固定 `2` |
| `topic` / `brief` | 本次讨论的输入，原样记录，便于复盘 |
| `status` | `passed` / `rejected` / `aborted` / `failed` |
| `attempts` | 实际轮次，≤ `maxAttempts` |
| `verdict.vetoed` | 给出否决的席位 id 列表 |
| `verdict.score` | 加权通过率，0–1 |
| `statements` | **按实际产生顺序**排列的发言序列 |
| `statements[].at` | 该句进入发言池的时间 |
| `statements[].status` | `completed` / `skipped` / `failed` / `invalid-veto` |
| `statements[].verdict` | 席位投出的判断；`output: text` 的席位省略 |
| `statements[].usage` | 来自 `@ci-kit/ai` 的 `AiResult.usage`，缺失则省略 |

`content` 保留原始文本，不裁剪不摘要——它是可追溯的最后一道凭据。

### 为什么发言是一条平铺的序列

讨论是并发的，每人说几句不确定，也没有「第几轮」的概念。所以：

- **不按席位分组**，按实际发生顺序排列
- **不记录轮次**，时间戳足以还原过程
- **同一席位出现多次是常态**，那就是它在一场讨论里说了好几句

读者读 `record.md` 时看到的是一段自然对话，而不是四份并排的意见书。

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
# 文章审核圆桌 · 2026-11-06

**议题**：这篇《昨天的服务，为什么今天才看到评价》能不能发
**结论**：未通过（通过率 33%，乌瑟尔否决）
**用时**：1 分 14 秒 · 调用 9/60

## 讨论

**格罗姆 🏪 门店读者视角**
文章说的是我遇到的问题，但我还是不知道第一步做什么。

**吉安娜 ✍️ 品牌与表达**
开头太平，读者会划走。

**麦迪文 🛡️ 事实核查**
「平均寿命 15 个月」这句没给出处。

**格罗姆 🏪 门店读者视角**
同意吉安娜，开头应该直接是不知怎么办的那个店长。

**萨尔 🎤 主持**
三条问题指向同一处：文章没给出门店能做的第一步。先补这一处再发。

---

**缺席**：无
```

### 渲染规则

| 规则 | 说明 |
| --- | --- |
| 按 `at` 排序 | 还原真实的你一言我一语 |
| 同一席位连续发言也各占一段 | 这就是讨论的样子 |
| 用 `name` 不用 `id` | 人读得懂 |
| 保留 `avatar` | 快速区分席位 |
| 跳过 `skipped` 的席位 | 但文末列出「缺席名单」 |
| `content` 原样进 | 不摘要，摘要会失真 |

## state.json（运行状态）

用于续跑，不供外部消费。

```json
{
  "schema": 2,
  "runId": "2026-11-06T08-00-00",
  "status": "running",
  "attempt": 1,
  "startedAt": "2026-11-06T08:00:00+08:00",
  "pool": 7,
  "usage": { "input": 18400, "output": 1520 },
  "fingerprint": "sha256:…"
}
```

| 字段 | 用途 |
| --- | --- |
| `startedAt` | 这场讨论的开始时间，续跑时据此重算剩余时长 |
| `pool` | 发言池已产生的条数，续跑时作为前序发言保留 |

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
{ "seat": "writer", "artifacts": [{ "path": "artifacts/a1-draft.md", "bytes": 4823 }] }
```

路径相对运行目录，永远用正斜杠存，便于跨平台消费。

同一轮重来时文件名带时间前缀，不覆盖上一轮产物——旧产物是复盘依据。

## 库接口

```ts
import { checkRoundtable, loadRoundtable, runRoundtable } from '@ci-kit/roundtable'

const plan = await loadRoundtable({ configDir: '.ci-kit/roundtable' })

const result = await runRoundtable({
  configDir: '.ci-kit/roundtable',
  topic: '这篇《昨天的服务，为什么今天才看到评价》能不能发',
  brief: '刚通过机器审核，需要几个人从不同角度再过一遍。',
  context: [文章正文, 素材],
  outDir: 'roundtable-out',
  env: process.env
})

result.status // 'passed' | 'rejected' | 'aborted' | 'failed'
result.record // record.json 的对象形式
result.recordPath // 落盘位置
```

`topic` 必填，缺失直接抛错。`runRoundtable` 不抛业务失败：否决、超预算、席位全挂都通过 `status` 表达；只有配置错误和用法错误会抛异常。

## CLI 输出

正式结果走 stdout 一行摘要：

```
roundtable: rejected · 9/60 calls · 1m14s · roundtable-out/2026-11-06T08-00-00
```

失败时 stderr 一行同样的格式。退出码：`0` 通过，`1` 未通过，`2` 配置或环境错误。CI 可以只依赖退出码。
