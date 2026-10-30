# 上游接口核查记录

本记录将源码证明、隔离测试和真实部署验证分开。源码能够证明接口与权限边界；它不能证明某个部署已经连通、文件已经入库或 QQ 已经收到文件。

## 核查基准

| 项目 | 固定版本 / 提交 | 核查范围 |
| --- | --- | --- |
| DeepSeek Harness | `0.2.2-alpha.2` / [`ce7073d51254c26cd63b22a60835b8f948deb447`](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447) | Cordis 生命周期、工具定义与执行、MCP 注册、ACP 挂载、bundle/profile 安装 |
| maibot-dsh-artifacts | `0.2.0` / [`ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8) | README、handoff.py、plugin.py、tools/dsh_handoff.py、compatibility、DSH_INSTRUCTIONS |
| MaiBot | `v1.3.18` / [`2a9af62cec37035d29237acbe2cf3adceb700b27`](https://github.com/Mai-with-u/MaiBot/tree/2a9af62cec37035d29237acbe2cf3adceb700b27) | 对端兼容文档引用的 ACP、MCP、agent_talk 与消息排队实现 |

调查时克隆到的 maibot-dsh-artifacts 远端 HEAD 正好为协议基准提交 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`，因此与该基准没有差异。本项目不随未来远端更新自动变更协议；升级须重新比较源码和测试。

通过 npm 元数据确认 `@deepseek-ai/dsh@0.2.2-alpha.2` 和 `@deepseek-ai/dsh-tools@0.2.2-alpha.2` 均已发布。调查时 `latest` 标签与 main 不一致，不能用裸 `latest` 代替精确版本。本项目将验证范围限制为声明的 alpha 版本；没有推定其他版本兼容。

## Cordis 与工具 API

官方插件使用命名导出 `name`、`inject` 和 `apply(ctx, config)`。`inject = ['tools']` 会等待 tools 服务；插件卸载时会清理通过上下文登记的 effect，包含 `ctx.tools.register()`。异步初始化采用明确的 `async function apply`，不能把启动工作遗留为不等待的后台 Promise。

- [官方生命周期说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/user/develop/framework/index.md)
- [官方工具示例与程序化执行示例](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/cordis-tutorial/07-into-the-harness.md)
- [工具定义和执行上下文类型](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/contracts.ts)

`defineTool({name, description, parameters, output, execute})` 是官方 typed helper。它校验输入参数；`output.schema` 描述规范 JSON 输出，`output.render` 生成模型可见内容。文件安全规则和跨字段约束仍由插件检查。

`ctx.tools.execute({calls, signal, agent?, toolSet?})` 接收完整工具批次，其中调用为 `{type:'tool-call', id, name, arguments:JSON.stringify(...)}`。服务依据 `agent` 选择相应作用域的 executor。组合工具必须保留原始 `exec.agent`、`exec.toolSet` 和取消信号，否则可能查不到 ACP 会话工具或丢失该步骤的准入约束。不能直接执行 `ctx.tools.get(...).execute(...)`，那会绕过官方策略管线。

- [ToolBatchInput 与结果类型](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/executor.ts)
- [按作用域分派 execute](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/index.ts#L369)
- [作用域和准入查询](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/index.ts#L231)

### Native 与 PTC 的不同

Native executor 支持通过上述 API 执行可见工具。PTC executor 对 root batch 只接受 `run_code`；插件内部再次调用 `ctx.tools.execute()` 仍是一个 root batch。`ToolBatchInput` 没有可供插件设置的 `parent` 字段，因此不能假设在 PTC 中直接分派 MCP 名称一定成功。

- [Native executor](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-native/src/index.ts)
- [PTC 对非 run_code root 调用的拒绝](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-ptc/src/index.ts#L33)

因此 publish 必须允许 `prepared_only` 降级。PTC 下可由操作方核对已准备的清单，在现有 `run_code` 中通过 DSH 提供的工具 SDK 调用当前可见的 agent_talk；不能把插件未执行的通知记为 queued，也不能通过切换到无作用域执行器绕过拒绝。

## MCP、ACP 与 agent_talk

DSH MCP bridge 将远端 raw 工具名注册为 `mcp__<serverName>__<rawName>`。仅当规范化或截断导致信息丢失时，名称才追加身份哈希。`serverName` 来自本地配置 / ACP 声明，不来自远端 serverInfo。

- [MCP 名称及注册实现](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/src/tools.ts#L81)
- [DSH ACP 将会话 MCP 挂载到 Agent 上下文](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/mcp.ts#L26)

固定 MaiBot 版本在 ACP 会话中提供名为 `maibot-agent` 的 MCP server。因此标准连接下的 DSH 工具名是 **`mcp__maibot-agent__agent_talk`**；自定义配置仍应以实际注册名为准。DSH 本身没有叫 agent_talk 的内置工具，也没有专用的 MaiBot API。

MaiBot raw agent_talk 输入为 `text: string`（必填）、`target?: string`、`images?: string[]`，schema 禁止额外字段。本项目仅使用 `{target,text}`。从独立 Agent 回复时，target 必须能解析为真实已加载聊天；普通聊天调用时有另一路由限制。此工具只是传话入口，并不授予原聊天的文件库权限。

- [MaiBot agent_talk schema、调用上下文](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/provider.py#L19)
- [MaiBot MCP 服务的真实 context 与服务器名](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/mcp_server.py)
- [ACP 仅注册 Agent、Computer、File provider](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/acp_agent.py#L132)

### 原始目标不能由普通输入推断

MaiBot 把原任务的回复目标写入 relay 文本，再作为普通 ACP prompt 发送。当前核查的 DSH ACP 接口没有提供 MaiBot 原聊天目标的结构化、不可伪造授权字段。prompt 中看起来像“回复目标”的文本、文件内容、manifest、模型工具参数和任务 ID 都不能据此成为可信来源。

- [MaiBot relay 文本构造](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L61)
- [MaiBot 普通 ACP prompt 组装](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/acp_agent.py#L208)

默认行为是缺少可信目标时返回 `needs_target`。本项目若接受可信 Host resolver，它是明确声明的本地扩展契约，不是虚构的官方 DSH 接口；部署者须在 Host 受信任边界内按真实 Agent 和原始任务绑定目标。不得通过“最近一个聊天”、`agent_chats` 的任意条目或伪造 session_id 来补齐授权。

### 只确认排队，不能确认入库

MaiBot MCP 服务将结果编码为 content 中的 JSON 文本，当前实现没有传 structuredContent。agent_talk 成功响应包含 `delivered: true`、`relay_id`、`target`、`name`、`images`，再合入原聊天 `enqueue_internal_task` 的回执。`delivered` 表示传话交给队列，不能解释成 QQ 文件投递或文件库入库。

DSH MCP bridge 的 canonical 成功值为 `{content, structuredContent?}`，并非直接的 MaiBot payload；MCP `isError` 会转为工具错误。泛化的 `isError:false` 或任意文本不构成本项目的成功排队证明。

- [MaiBot 入队与回执](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L85)
- [DSH MCP 回执校验与错误处理](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/src/tools.ts#L278)
- [对端文件插件兼容说明](https://github.com/MemoryController/maibot-dsh-artifacts/blob/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8/docs/compatibility.md)

原聊天 MaiBot 还必须由 Host 在真实文件 scope 中派发 `dsh_import_handoff`，实际返回 `file_ref` 才有入库证据。DSH 的 local_status 只记录 prepared、queued 或 unknown；它没有跨聊天文件库查询能力，不能自行推出 imported。

## Manifest v1

根对象仅允许 `type`、`version`、`task_id`、`files`；每项文件仅允许 `path`、`size`、`sha256`。`task_id` 是 32 位小写十六进制，SHA-256 是 64 位小写十六进制；size 为非负整数，空文件是合法文件。不能添加 `target`、`chat_id`、`session_id`、`send`。本项目默认单文件 50 MiB、每批 8 个；对端 v0.2.0 配置所允许的硬上限为单文件 1 GiB、每批 32 个，双方配置应一致。

- [严格 manifest 校验](https://github.com/MemoryController/maibot-dsh-artifacts/blob/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8/handoff.py#L50)
- [对端配置范围](https://github.com/MemoryController/maibot-dsh-artifacts/blob/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8/plugin.py#L22)
- [DSH 操作指引](https://github.com/MemoryController/maibot-dsh-artifacts/blob/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8/docs/DSH_INSTRUCTIONS.md)

## Bundle、profile 与安装

官方 bundle 是 package.json 声明 `dsh.bundle.patch` 的 npm 包；patch 用 `- insert:` 插入 Cordis 插件行。profile 的 `dsh.profile.bundles` 是有序 bundle 列表，两者不能混同。`engines.dsh` 声明支持的 DSH 范围；profile 层可覆写插件 config，但覆写替换整个 config，不是深合并。

官方命令为 `dsh plugin --profile <name> add <包或路径>`；`dsh --profile <name> --dump-config` 可检查组合层。GitHub 来源可用 `github:MemoryController/dsh-maibot-artifacts#<固定提交>`。只有源码但没有预构建 JS 的 Git 安装通常需要 prepare 构建脚本及 pnpm 的 build allowance；本项目提交预构建入口且不依赖安装时构建。CI 必须重新构建并比较产物，不能仅依赖已提交文件的存在。

- [官方打包、GitHub 安装及预构建分发说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/user/develop/basic/publish.md)

## 验证边界

本记录中的 API 结论来自固定源码和 npm 元数据调查。测试报告以项目实际测试运行结果为准。模拟 ACP/MCP 的隔离集成测试只能证明插件与所测试接口的交互；不能替代真实连接验收。

**尚未验证真实 MaiBot ACP + DSH + Docker 挂载 + QQ 文件通道全链路，也没有获得真实原聊天 file_ref 或 QQ 投递回执。** 未执行的真实部署检查不能报告为通过；无法确认的远端结果应报告 unknown，禁止自动盲目重发。
