# 圆桌（roundtable）

为多个 AI 席位提供一张桌子，让它们按人设定的身份、性格和议事规则自行产生议题、讨论、产出并收敛。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-positioning.md](01-positioning.md) | 圆桌是什么、不是什么；包定位与边界 |
| [02-seat.md](02-seat.md) | 席位 Markdown：frontmatter 分组参数与正文约定 |
| [03-table.md](03-table.md) | 圆桌配置：阶段、裁决、预算、退路 |
| [04-runtime.md](04-runtime.md) | 运行模型：状态机、可见性、幂等与续跑 |
| [05-output.md](05-output.md) | 产出：会议记录四件套与接口契约 |
| [06-open-questions.md](06-open-questions.md) | 待定问题与默认取向 |

## 一句话概述

人只写**席位**和**议事规则**；圆桌自己决定**谈什么**、**谈成什么**。

```
.ci-kit/
└── roundtable/
    ├── table.md          # 议事规则
    └── seats/            # 席位，一个 AI 一个 md
        ├── editor.md
        ├── writer.md
        ├── guard.md
        └── host.md
```

## 已确认决策

| 编号 | 问题 | 结论 |
| --- | --- | --- |
| 1 | 包位置 | 新建 `@cikit-js/roundtable`，不并入 `@cikit-js/ai` |
| 2 | 包名 | `roundtable`，含义是「给 AI 们的圆桌」 |
| 3 | 是否支持阶段 | 支持，阶段是续跑与幂等的锚点 |
| 4 | `sees` 默认值 | `all`，独立席位显式写 `none` |
| 5 | 一票否决语义 | 任一 `canVeto` 席位否决即否决 |
| 6 | 裁决由谁做 | 程序裁决，模型只提供判断材料 |
| 7 | 预算单位 | 按 AI 调用计，按席位记账 |
| 8 | 发版 | 跟随 monorepo 统一发版，不独立版本 |
| 9 | 议题是否输入 | 不是输入，是席位在 `propose` 阶段的发言产出 |
| 10 | 席位 md 分组 | `id` / `role` / `enabled` 顶层，`identity` / `persona` / `seat` 分组 |