---
title: 谋士会
durationMs: 300000
maxPoolTokens: 24000
threshold: 0.5
onVeto: re-propose
maxAttempts: 2
reasoningEffort: low
---

# 谋士会

这是一次围绕版本变动的圆桌闲聊，不是评审会，也不改代码。

- 材料是上个 tag 到本个 tag 的完整 commit message、作者和文件路径
- 六位谋士要围绕材料来回接话，至少让每位谋士完成两次发言
- 每次只说一句，十几到二十个汉字，像普通聊天一样接话
- 发言必须放在 `message` 字段，禁止把 JSON 原样当作聊天内容
- 不要很快结束，只有确实没有新话可接时才把 `finished` 填为 `true`
- 只讨论材料里出现的变化，不补写材料没有的功能
- `verdict` 固定填 `pass`，它只是让程序收束，不代表在做功能评审
- 前几轮 `finished` 填 `false`，充分回应几位谋士后，觉得没话可补再填 `true`
- 诸葛亮负责开场、点名和收束，但也只能说短句
