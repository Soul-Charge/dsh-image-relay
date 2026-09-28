# dsh-image-relay 施工记录

日期：2026-09-27

## 需求演进

1. 让 DSH 里的模型能调用工具生图，走已实测通过的中转站 Image API。
2. **追加**：用户平时用 **PTC 模式**，不希望工具污染思维链 → 必须**明确解锁**后才可用。
3. **追加（线上故障）**：用户报告"模型说画好了但看不到" → 加**工作区落盘**兜底。

## 第三轮：PTC 图片不可见的根因追查

用户现象："模型说画好了但是我看不到"。

### 证据链（解码 `session-76d3f559` 得出）

1. **图确实生成了**：`attachmentId=sha256:b0973324...`，`image/png`，
   1024×1024，1,540,902 字节；落盘对象经校验是**有效 PNG**。
2. **已写进会话日志**：`agent/inbox/spliced` → `user/message`（event 35），带完整 image 块。
3. **但来源是 plugin**：`{"kind":"plugin","plugin":"tools-ptc"}`。
4. **渲染器丢弃非 user 来源的图片**：
   `dsh-client-ui-chat/lib/client.js`：
   `if (event.data.source.kind !== "user") return { kind: "context", ... }`；
   只有 `kind:"user"` 才进 `UserStyleBubble`，那里才有 `renderMessageImages`。
5. **来源是 DSH 核心写死的**：`dsh-tools/lib/index.js` 的 PTC 图片回流
   `exec.deferContext(createUserMessage({ content: result.content, source: { kind: "plugin", plugin: "tools-ptc" } }))`。

### 结论

**不是插件 bug，是 DSH 核心的 UI 兼容问题**：任何插件经 PTC 回流的图片都不可见
（codex 那个 `codex_image_generate` 若走 PTC 同样如此）。模型"看到"成功结果，
但人看不到图。

### 修复（方案 A）

`execute` 里生成成功后，用 `writeFileAtomic` 把 PNG 写到
`<session cwd>/<saveTo>/YYYYMMDD-HHMMSS-<slug>.png`，并把路径放进 `render` 的**文本**部分
（文本是"注入上下文"分支唯一会渲染的内容）。
写盘失败不阻断生图，走 `savedError` 字段。

### 已抢救的图

`temp/20260927-generated-apple.png`（1,540,902 字节，1024×1024）——
从 attachment store 直接复制出来的用户那只苹果。

## 第二轮：PTC 门控设计

- PTC 下**每个可见工具都被投影进 `tools:sdk`**（`sdkSection` → `sdkSchemas(scope)` → `view(scope).visible`）。
- `view(scope)` 把 **agent 自己 scope 层注册的工具无条件加入 visible**。
- `tools:sdk` 的 text 是**每次装配重算的函数**，`agent/pre-step` 每步都 `assemble()` → 中途解锁下一轮生效。
- `ctx.commands` 是人类 UI 注册表，**不是模型可见工具，零上下文成本**。

最终：默认 `defaultLocked: true` → 全局不注册；`/image` 用 `agent.ctx.tools.register()`
注册进该会话 scope；其他会话不受影响。

## 实测验证

| 测试 | 结果 |
|---|---|
| `test/smoke.mjs` | **20 通过 / 0 失败** |
| `test/gate.mjs` | **22 通过 / 0 失败** |
| `test/save.mjs` | **29 通过 / 0 失败** |
| `test/live.mjs`（真中转站端到端） | **通过**：1,821,807 字节 PNG，1448×1086，36.1s，落盘成功 |
| `dsh --dump-config` | 插件在合成树第 593 行，含 `saveTo` |
| 真实会话 `cwd` 存在性 | 已确认（`/mnt/f/Unbound_AI`） |

## 累计修掉的 5 个真 bug

1. `credentials.getRecord()` **不存在** → `readRecord(credentialKey('llm-pi-ai', provider))`，字段 `record.key`
2. `Config` 必须是 schemastery schema，不是普通对象
3. `apply(ctx)` 不带 config 时不套默认值
4. 安装后依赖解析失败 → 补 `node_modules` 符号链接
5. 测试里 `saveTo` 未配合 `defaultLocked:false`，工具没注册（测试自身 bug）

## 前置实测数据（方案推导依据）

| 探测 | 结果 |
|---|---|
| `POST /v1/images/generations` + `gpt-image-2` | **200，真 PNG**（1.1–3.0 MB，23–36s） |
| 5 次连续 | 4 OK / 1 失败（`503 No available compatible accounts`） |
| `POST /v1/responses` + `{"model":"gpt-image-2"}` | 502（DSH 原配置报错来源） |
| 文本模型（gpt-5.5 等 8 个） | 全部 404 `not available on this group` |
| `gpt-image-1` / `gpt-image-1.5` | 均 502 |

该 key **图片专用**，只有 `gpt-image-2` 可用。

## 安装状态

- 源码：`/home/nae/.dsh/plugins/dsh-image-relay/`（含 `node_modules` 符号链接）
- profile `package.json`：已加依赖 + bundles 条目
- 已建 4 个手动快照

## 渲染链路定位（2026-09-27 实测闭环）

用真实会话日志（1201 个 zstd frame、2828 条事件）逐条验证，**图从未丢失**，
只是被降级。三处观察点全部命中预期：

| 位置 | 结果 | 代码位置 |
|---|---|---|
| `读取图片` 行 | ✅ **内联出图** | `dsh-client-ui-tool/lib/client.js:2116`（唯一注册图片卡的工具） |
| 交付物面板（`present`） | ⚠️ 只有文件名，可点开侧栏预览 | 不内联 |
| 上下文注入行 | ❌ 降级成「未知内容块」JSON | `dsh-client-ui-chat/lib/client.js:396` `ModelFacingContent` 只处理 `"text" in run` |
| `relay_image_generate` 行 | ❌ 完全无图 | `GenericToolCard`（同 UI 包 `1400`）只认 terminal/diff/read/search/web |

日志证据（当前会话）：`tool/ptc-dispatch` seq 2610/2788/2815 与对应
`user/message` seq 2616/2794/2821 **都带 image 块**，且 `parentCallId` 存在、
官方图片卡的正则 `IMAGE_ENVELOPE` 实测 `matches: true`。
结论：**问题在客户端展示层，不在工具、不在附件存储、不在 PTC 传递**。

## 待办

- [x] 定位渲染丢失点（见上）
- [x] 写浏览器半 `src/client.js` + `test/client.mjs`（19 项全绿）
- [ ] **安装 + 重启 DSH**（需用户批准）
- [ ] 重启后 `/image` 解锁 + 画图，确认**工具行内联出现图片**
- [ ] 可选：给上游提 issue —— PTC `source.kind:'plugin'` 的 image 块不应被渲染器丢弃
- [ ] 回退 DSH 里走不通的 `cool-coffee-image` provider

## 安全

- 中转站 key 只在命令内联使用，未写入任何文件
- key 曾出现在对话记录中（用户主动提供），**建议轮换**
