# @nestim/koishi-plugin-qqgm-private

Koishi 私聊插件，配合 [`@nestim/koishi-plugin-qq-group-manager`](https://www.npmjs.com/package/@nestim/koishi-plugin-qq-group-manager) 使用。

**私聊自动回话，还会隔一段时间主动找你聊两句。**

## 相关插件

| 插件 | 说明 |
| --- | --- |
| [`@nestim/koishi-plugin-qq-group-manager`](https://github.com/Miseat/koishi-plugin-qq-group-manager) | **主插件**：群管、AI 回复、记忆库、识图、定时提醒 |
| **`@nestim/koishi-plugin-qqgm-private`** | 本插件：私聊回复 + 主动私发 |
| [`@nestim/koishi-plugin-qqgm-chat-style`](https://github.com/Miseat/koishi-plugin-qqgm-chat-style) | 聊天风格：主风格 + 按概率叠加的追加风格 |
| [`@nestim/koishi-plugin-qqgm-meme`](https://github.com/Miseat/koishi-plugin-qqgm-meme) | 表情包：按情绪标签抽图补发 |

## 特性

| 能力 | 说明 |
| --- | --- |
| **私聊自动回复** | 只处理私聊消息，绕过群聊逻辑；带冷却 |
| **共用主插件** | 复用主插件的模型、人设、风格 skill、表情包钩子，不用重复配置 |
| **上下文** | 每个用户独立维护一段私聊历史（条数可配） |
| **定时主动私发** | 每隔一段时间主动发一条，按用户独立计算间隔与每日配额 |
| **免打扰时段** | 支持 `0-8`、`23-7`（跨零点）等区间，可配多条 |
| **活跃感知** | 距对方上次说话太近就不发，避免插话 |
| **白/黑名单** | 只回哪些人、不回哪些人 |

## 安装

```sh
npm i @nestim/koishi-plugin-qqgm-private
```

需要先启用主插件（`>= 1.2.5`，提供 `qqgmAiRuntime`）。

## 配置

### 基础

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 启用私聊回复 | `true` | |
| 允许用户 | `[]` | 留空 = 所有人 |
| 屏蔽用户 | `[]` | |
| 回复最小间隔 | `2` | 秒 |
| 上下文条数 | `20` | |
| 单条字数上限 | `120` | |
| 额外人设 | 空 | 追加给主插件的私聊规则 |
| 调试日志 | `false` | |

### 主动私发

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| 启用主动私发 | `false` | 需要你主动开 |
| 目标 QQ | `[]` | 留空 = 只发给「主动私聊过机器人的人」 |
| 间隔分钟 | `180` | 两次之间至少隔这么久 |
| 最小空闲分钟 | `60` | 距对方上次说话至少这么久才发；`0` = 不判断 |
| 免打扰时段 | `['0-8']` | 格式 `起-止`，支持跨零点 |
| 每日上限 | `3` | 每人每天最多几条 |
| 提示词 | 空 | 留空用内置 |
| 字数上限 | `60` | |

## 主动私发怎么决定发什么

提示词只让它输出**一句**话，要求：

- 像日常闲聊，可以分享小事、问近况、提一句之前聊过的
- 不要「在吗」「打扰了」「好久不见」这类开场白
- 不要重复最近说过的
- 实在没话说就输出 `NONE`，那就不发

这样不会出现"每天固定问候"那种机器人味儿。

## 与主插件的接口

只依赖 `ctx.qqgmAiRuntime`（主插件用 `ctx.root.set` 挂出来的对象）：

- `chat()` —— 调模型
- `hooks` —— 风格段、输出过滤、afterReply（表情包）

**注意**：本插件**不写 `inject`**。因为 `qqgmAiRuntime` 不是 Koishi 的 Service，
写 `inject` 会让 Koishi 一直等一个不会注册的服务，配置页就会显示
「必需服务：qqgmAiRuntime（未加载）」。这里改为运行时探测 + `ready` 重试。

## 开源

MIT。欢迎改、欢迎提 PR。

- GitHub: <https://github.com/Miseat/koishi-plugin-qqgm-private>
- 主插件: <https://github.com/Miseat/koishi-plugin-qq-group-manager>
