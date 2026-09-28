# dsh-image-relay

给 DSH 加一个**可解锁的生图工具**：模型在对话里调用 `relay_image_generate` 出图，
底层走 OpenAI 兼容中转站的**标准 Image API**（`POST {baseURL}/images/generations`）。

## 为什么需要它

DSH 的 LLM 适配器只支持三种协议 —— `openai-completions` / `openai-responses` /
`anthropic-messages`，**没有 Image API 协议**。把"只有图片权限"的中转站配成 provider
（`api: openai-responses` + `model: gpt-image-2`），DSH 会把生图模型当**对话模型**发出去，
中转站回 `502`。实测：

```
POST /v1/responses          {"model":"gpt-image-2",...}  ->  502   （DSH 原配置的报错）
POST /v1/images/generations {"model":"gpt-image-2",...}  ->  200 + PNG
```

本插件把后一条路补成真工具。

## 设计一：默认锁定，显式解锁（PTC 友好）

**PTC 模式下每个"可见"工具都会被投影进生成的 `tools:sdk` 提示词区块。**
全局注册的工具会从第一轮起占据模型上下文 —— 所以要锁定。

```
/image          解锁本会话的生图工具（等价 /image on）
/image on       解锁
/image off      锁定
/image status   查看状态
```

解锁走 `agent.ctx.tools.register()`，只注册进**该会话自己的 scope 层**；
`tools:sdk` 在每次装配时按调用方 scope 重新生成，**其他会话完全不受影响**。
命令本身注册在 `ctx.commands`（人类 UI 注册表），**不是模型可见工具，零上下文成本**。

| `defaultLocked` | 行为 |
|---|---|
| `true`（默认） | 所有会话默认看不到；`/image` 解锁后仅该会话可见 |
| `false` | 全局注册，所有会话立即可见；`/image off` 可单会话隐藏 |

## 设计二：产物落盘（`saveTo`）

**这是必需的，不是可选项。** 在 PTC 模式下，DSH 把工具返回的图片重新注入为一条
`user/message`，其来源是 `{ kind: 'plugin', plugin: 'tools-ptc' }`
（`dsh-tools/lib/index.js` 的 PTC 图片回流分支，来源写死）。

而聊天渲染器对**任何非 `user` 来源**都走"注入上下文"分支
（`dsh-client-ui-chat/lib/client.js`：`if (source.kind !== "user") return { kind: "context", ... }`），
**该分支只渲染文本，不渲染 image 块**。结果就是：模型看到"成功"，人什么也看不到。

所以插件在生成后**同时把 PNG 写到工作区**，并把路径放进渲染的文本部分：

```
Generated image for: <prompt>
Saved to: /path/to/workspace/temp/imagegen/20260927-195153-a-red-apple.png
```

路径基于会话的 `cwd`（`exec.agent.session.header.cwd`）+
工作区相对的 `saveTo` 目录。**含 `..` 或绝对路径的 `saveTo` 会被收敛回工作区内。**
写盘失败不会让生图整体失败 —— 会额外返回 `savedError` 字段。

设 `saveTo: ''` 可关闭落盘（此时 PTC 下你可能看不到图，请自行确认渲染路径）。

## 结构

| 文件 | 职责 |
|---|---|
| `src/relay.js` | 纯逻辑核心：请求构造、重试判定、响应解析、PNG 校验、路径计算。**不 import 任何 DSH 模块** |
| `src/index.js` | 宿主半：工具定义、per-session 门控、`/image` 命令、附件回流、工作区落盘 |
| `src/client.js` | 浏览器半：向 `tool.call.toolview` 注册 `relay_image_generate` 的图片卡，**内联显示生成结果** |
| `cordis.patch.yml` | 挂载进 profile 的 patch 层 |

## 配置

```yaml
- id: image-relay
  name: dsh-image-relay
  config:
    enabled: true
    defaultLocked: true                 # 默认锁定，/image 解锁
    provider: cool-coffee-image         # 复用该 provider 的已存凭据
    apiKeyEnv: COOL_COFFEE_IMAGE_API_KEY
    baseUrl: https://api.openai.com/v1  # 换成你的中转站地址；注意带 /v1
    model: gpt-image-2
    maxRetries: 4
    saveTo: temp/imagegen               # 工作区相对目录；空字符串=关闭落盘
```

凭据解析顺序：先 `credentials.resolve(apiKeyEnv)`，失败再读
`credentials.readRecord(credentialKey('llm-pi-ai', provider))`。
每次调用重新解析 —— **轮换 key 后不需要重启**。

## 行为

- **重试**：`408 / 425 / 429 / 5xx` 退避重试（`2.5s → 5s → 10s → 20s` 封顶）；
  401/403/404 等**立即失败**。中转站账号池会偶发 `503 No available compatible accounts`。
- **超时**：默认 180s（真实出图约 23–36s）。
- **尺寸上限**：`min(maxImageBytes, maxMessageImageBytes)`，超限报 `IMAGE_TOO_LARGE`。
- **只接受 PNG**：落附件与落盘前都校验魔术字节。
- **原子写**：落盘用 `writeFileAtomic`（临时文件 + rename），不会留下半截文件。
- **文件名**：`YYYYMMDD-HHMMSS-<prompt slug>.png`，prompt 只保留 ASCII 字母数字。

## 错误码

| code | 含义 |
|---|---|
| `IMAGE_RELAY_INVALID_PROMPT` | prompt 为空 |
| `IMAGE_RELAY_CREDENTIAL_MISSING` | 没解析到 key |
| `IMAGE_RELAY_ATTACHMENT_UNSUPPORTED` | 环境未启用 PNG 附件 |
| `IMAGE_RELAY_TIMEOUT` | 超时 |
| `IMAGE_RELAY_FAILED` | 中转站返回不可重试错误（含 status/detail） |
| `IMAGE_NETWORK_FAILED` | 重试耗尽仍连不上 |
| `IMAGE_RESPONSE_INVALID` | 响应不是合法 base64 / 非 PNG |
| `IMAGE_RESPONSE_URL_UNSUPPORTED` | 中转站只回 URL 不回内联 base64 |
| `IMAGE_TOO_LARGE` | 超出附件字节上限 |

落盘失败不抛错，走 `savedError` 字段。

## 测试

```bash
node test/smoke.mjs    # 20 项纯逻辑单测（无需 key）
node test/gate.mjs     # 22 项门控测试（锁定/解锁/多会话隔离）
node test/save.mjs     # 29 项落盘测试（slug/时间戳/路径/端到端写盘）
node test/client.mjs   # 19 项浏览器半测试（注册 + 渲染树 + 异步加载 + 路径回读）
RELAY_KEY=sk-xxx node test/live.mjs   # 真实中转站端到端（出图+落盘）
```

## 设计三：浏览器半 —— 工具行内联显示

DSH 的工具行通过 keyed slot `tool.call.toolview` 按**工具名**分发，未注册的工具
回落到 `GenericToolCard`。而该通用卡只认 terminal/diff/read/search/web，
**没有 image 分支** —— 全 DSH 唯一会渲染内联图片的是 `read_image`
（`imageCardModel` 里硬编码 `call?.name !== 'read_image' → return null`）。
所以一个自带图片块的工具结果在默认情况下**什么图都不显示**。

`src/client.js` 就是修这个：它为 `relay_image_generate` 注册一个 keyed 工具行，
直接把结果里的 image 块渲染成 `<img>`。

三个关键实现决策：

1. **不声明 `tool.call.images` 子槽**。那个槽是 `kind:'single'`，`read_image`
   已经声明过了；槽契约明确规定「第二个声明同一子槽的 toolview 会在加载时抛错」。
   因此本插件从 owner props 直接取 `loadImage`（会话授权的加载器，和官方画廊
   用的是同一个）自己渲染。
2. **不依赖 `presentationMeta`**。DSH 只对**根调用**投影 `presentationMeta`，
   而 PTC 下每次调用都是嵌套子调用 → `block.meta` 恒为 `undefined`。
   所以落盘路径改为从自己的渲染文本里回读（`Saved to: …`，兜底 `<path>` 信封）。
3. **手写预构建格式**。`client.js` 是 `window.__ModuleLoader__.load({id, factory})`
   形式，无编译步骤、无构建依赖，只 `require("react")`（平台单例种子）。

## 已知限制

- 只接受 PNG 响应；中转站换回 JPEG 需扩展 `decodePng`。
- 只支持单张（`n: 1`）。
- 中转站只回 URL（不回 `b64_json`）会被明确拒绝。
- 解锁状态存在内存（`WeakMap` + scope effect），**重启 DSH 后需重新 `/image`**。
- **PTC 回流消息里的图片仍不可见**：DSH 把带图结果重新注入为
  `user/message`，来源写死 `{kind:'plugin', plugin:'tools-ptc'}`
  （`dsh-tools/lib/index.js`），而聊天渲染器对任何非 `user` 来源只渲染文本，
  image 块降级成「未知内容块」的 JSON。这是上游行为，插件无法修。
  浏览器半解决的是**工具行**的内联显示，那条路完全可用。
- `present()` 交付物面板只显示文件名 + 可点开侧栏预览，不做内联图。

## 回退

装前已建手动快照；出问题用 undo 回退，或删掉 profile `package.json` 里的
`dsh-image-relay` 依赖与 bundles 条目。
