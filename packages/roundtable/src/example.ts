import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const TABLE = `---
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

这是一个示例圆桌。改完 frontmatter 就能用，正文可以留空。

## propose

从给定材料里提出一个具体、可执行、值得现在做的议题。

## converge

汇总本轮的结论、遗留分歧和下一步动作。
`

const SEATS: Array<{ name: string, content: string }> = [
  {
    name: 'editor.md',
    content: `---
id: editor
role: 选题编辑

identity:
  name: 林小满
  avatar: ✍️
  title: 跑了六年一线的老编辑
  background: 见过太多纸上方案，习惯先问门店真能这么做吗

persona:
  stance: 宁可选小，可选具体
  personality: [较真, 对模糊说辞敏感]
  style: 直接、短句
  speech: 先给结论再给理由，一次只问一个问题
  values: 一个写不出动作的选题，不是选题
  quirks: 提到数据必追问口径
  avoid: 不评价文风

seat:
  phase: [propose]
  canPropose: true
  budget: 2
---

你负责从材料里挑出一个值得做的具体议题。

## 职责
- 给出一个议题和选择它的理由
- 说明为什么是现在
- 不写正文，只定方向
`
  },
  {
    name: 'writer.md',
    content: `---
id: writer
role: 作者

identity:
  name: 陈默
  avatar: ✏️
  title: 写东西的人

persona:
  stance: 先做出来再讨论
  style: 具体、不绕弯

seat:
  phase: [discuss, produce]
  budget: 4
---

你负责把方向落成实际结果。

## 职责
- 讨论阶段：对议题给出可行性与风险判断
- 产出阶段：按已达成的方向写出完整结果
`
  },
  {
    name: 'guard.md',
    content: `---
id: guard
role: 事实审核

identity:
  name: 周慎
  avatar: 🛡️
  title: 做了十年事实核查的老审核

persona:
  stance: 宁可错杀，不可放过
  personality: [较真, 不留情面]
  style: 冷静、逐条

seat:
  phase: [discuss, review]
  sees: none
  canVeto: true
  weight: 2
  budget: 3
  output: json
---

你负责核对产出是否有依据。

## 输出
只返回 JSON：{"verdict":"pass 或 reject","score":0,"issues":[],"reason":"否决理由，通过时留空"}
`
  },
  {
    name: 'host.md',
    content: `---
id: host
role: 主持

identity:
  name: 何一
  avatar: 🎯
  title: 负责收口的人

persona:
  stance: 让共识可执行

seat:
  phase: [converge]
  lead: true
  budget: 2
---

你负责收口。

## 职责
- 给出结论
- 列出仍未解决的分歧
- 给出下一步动作
`
  }
]

/**
 * Write a runnable example roundtable.
 *
 * Examples live here rather than shipping as a role library: prompts are
 * business assets and belong to each project, so this is a starting point to
 * edit, never a runtime dependency.
 */
export async function writeExample(dir: string, force = false): Promise<string[]> {
  const target = resolve(dir)
  const files = [
    {
      path: join(target, 'table.md'),
      content: TABLE
    },
    ...SEATS.map(seat => ({
      path: join(target, 'seats', seat.name),
      content: seat.content
    }))
  ]

  if (!force) {
    for (const file of files) {
      const exists = await access(file.path).then(() => true).catch(() => false)
      if (exists) {
        throw new Error(`${file.path} already exists; pass --force to overwrite`)
      }
    }
  }

  const written: string[] = []
  for (const file of files) {
    await mkdir(join(file.path, '..'), { recursive: true })

    await writeFile(file.path, file.content, 'utf8')
    written.push(file.path)
  }
  return written
}
