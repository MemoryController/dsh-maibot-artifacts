# 上游接口核查记录

本记录将源码证明、隔离测试和真实部署验证分开。源码能够证明接口与权限边界；它不能证明某个部署已经连通、文件已经入库或 QQ 已经收到文件。

## 核查基准

| 项目 | 固定版本 / 提交 | 核查范围 |
| --- | --- | --- |
| DeepSeek Harness | `0.2.2-alpha.2` / [`ce7073d51254c26cd63b22a60835b8f948deb447`](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447) | Cordis 生命周期、工具定义与执行、MCP 注册、ACP 挂载、bundle/profile 安装 |
| maibot-dsh-artifacts | `0.2.0` / [`ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8) | README、handoff.py、plugin.py、tools/dsh_handoff.py、compatibility、DSH_INSTRUCTIONS |
| maibot-dsh-artifacts 配套请求入口 | `0.2.1` / [`27d6c00784557128ebb9c57edf04a0a5c1382bd6`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/27d6c00784557128ebb9c57edf04a0a5c1382bd6) | 新增共享请求确认工具；[配套草稿 PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2)，未以合并或发布为前提 |
| MaiBot | `v1.3.18` / [`2a9af62cec37035d29237acbe2cf3adceb700b27`](https://github.com/Mai-with-u/MaiBot/tree/2a9af62cec37035d29237acbe2cf3adceb700b27) | 对端兼容文档引用的 ACP、MCP、agent_talk 与消息排队实现 |

首次调查时克隆到的 maibot-dsh-artifacts 远端 HEAD 正好为协议基准提交 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`，因此当时与该基准没有差异。后续配套 `0.2.1` 草稿变更新增 `dsh_import_request` 和严格请求读取，保留 manifest v1 与原有 `dsh_import_handoff` 入库逻辑。本项目不随未来远端更新自动变更协议；升级须重新比较源码和测试。

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

Native executor 支持通过上述 API 执行可见工具。**官方 `acp` profile 默认启用 Native executor，PTC 行默认禁用**，不能将 PTC 限制误报为标准 ACP 的默认行为。PTC executor 对 root batch 只接受 `run_code`；插件内部再次调用 `ctx.tools.execute()` 仍是一个 root batch。`ToolBatchInput` 没有可供插件设置的 `parent` 字段，因此不能假设在 PTC 中直接分派 MCP 名称一定成功。

- [Native executor](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-native/src/index.ts)
- [PTC 对非 run_code root 调用的拒绝](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-ptc/src/index.ts#L33)
- [基础层默认 Native、禁用 PTC](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/bundle/base/cordis.patch.yml#L496)

可选可信目标通知分支必须允许 `prepared_only` 降级，不能把未执行的通知记为 queued，也不能通过切换到无作用域执行器绕过拒绝。默认共享请求分支只发布本地清单，不依赖程序化调用 agent_talk；它仍须通过当前执行器实际调用产物工具。PTC 的 `run_code` 若因宿主沙箱不可用而拒绝，产物工具尚未执行，不能声称已准备或提交。

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

这不只是缺少文档约定：DSH `AcpSession.prompt()` 只把 `params.prompt` 传给内容准入，随后创建 `createUserMessage({content, source:{kind:'user'}})`。它没有把 ACP 请求的 `_meta` 转存到消息 source、Session 或可供工具读取的原任务元数据中。`session/new` 传递 cwd 和 MCP servers，也没有注入 MaiBot 聊天来源。已安装的官方 npm `dsh-acp/lib/index.js` 与固定源码的这一行为一致。即使自行向 ACP `_meta` 添加 target，普通插件也无法据此取得经过验证的原聊天授权。

- [MaiBot relay 文本构造](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L61)
- [MaiBot 普通 ACP prompt 组装](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/acp_agent.py#L208)
- [DSH ACP prompt 只创建普通 user 消息](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/session.ts#L262)
- [DSH ACP session/new 的参数传递](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/index.ts#L199)

本项目接受的可选可信 Host resolver 是明确声明的本地扩展契约，不是官方 DSH 已提供的功能；部署者须在 Host 受信任边界内按真实 Agent 和原始任务绑定目标。当前标准 ACP 链路没有提供可直接接入它的生产来源钩子。不得通过“最近一个聊天”、`agent_chats` 的任意条目、提示词解析或伪造 session_id 来补齐授权。

要在未来支持安全的自动路由，上游至少须共同定义并实现：Host 签发的原任务来源与路由授权契约；ACP 传输及 DSH 工具上下文中的可信元数据保留和身份关联；有效期、并发任务隔离与重放处理。即使完成自动传话，文件入库仍需 Host 在原聊天授权 scope 内派发插件工具；单独增加 `_meta` 透传或获得聊天 ID 都不能替代这一权限步骤。本项目当前没有通过修改上游、拦截 stdin 或伪造上下文提供这些能力。

### 默认共享请求与人工确认

缺少可信目标的默认 publish 现在使用共享文件请求：将严格 manifest v1 写入 `outbox/.dsh-handoffs/<task_id>.json`，返回 `result: submitted`、`shared_request.path/sha256` 及原聊天确认参数（本轮0.2.1默认完整manifest的dsh_import_handoff，显式request才使用配套0.2.1的dsh_import_request）。**submitted 只证明清单已在共享目录中完成本地发布**；本地 lifecycle 仍为 prepared，不是 queued、imported 或“MaiBot 已收到”。请求不包含 target、chat_id、session_id 或 send，不创建授权身份。

操作方须在原聊天明确确认该 task_id 和请求 SHA-256，由 MaiBot Host 在真实文件 scope 中调用配套插件的 `dsh_import_request`。该工具校验共享请求后复用现有入库逻辑，默认不发送 QQ 文件。入口来自配套 `0.2.1` 的 [`27d6c00784557128ebb9c57edf04a0a5c1382bd6`](https://github.com/MemoryController/maibot-dsh-artifacts/blob/27d6c00784557128ebb9c57edf04a0a5c1382bd6/plugin.py)，相关改动在[草稿 PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2)供审查；没有声称它已合并或发布。基准 `ba8a5fb` 的 v0.2.0 已有 manifest 导入能力，但**没有**该确认入口，不能将它冒充为基准版本已有 API。仅使用基准版本时，操作方仍须在原聊天使用原有 `dsh_import_handoff` 提交同一清单。

MaiBot 官方连接文档明确说明：ACP `session/update` 的普通文本只保存到独立 Agent 执行记录、显示在其 WebUI；不会自动转发到普通聊天。`session/prompt` 最终回执只包含停止原因。因此即使模型在 ACP 中打印确认参数，也不能声称原 QQ 聊天已看到它；默认路径需要任务持有者从执行记录取得确认信息并带回原聊天。

- [MaiBot 官方“回复、身份与暂停”说明](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/docs/agent-connections.md#L85)

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

**`dsh --profile acp`（简写 `dsh acp`）才是官方 stdio ACP 入口**；该 app 无额外运行选项，`--help` 只打印 ACP 帮助，stdin EOF 结束进程。不存在本项目另造的 ACP HTTP 服务或 `dsh acp --server` 启动方式。

已命名的内置 `acp` profile 首次使用会从 base + acp-app 模板初始化。反之，对不存在的任意自定义名字直接执行 `dsh plugin --profile maibot add ...`，只会创建 base-backed profile；这能注册工具，却没有 ACP transport。可为一个**尚不存在的自定义 profile 名称**先执行：

```sh
dsh --profile maibot --from-default-profile acp --help
dsh plugin --profile maibot add ./dsh-maibot-artifacts-0.2.1.tgz --ignore-scripts
dsh --profile maibot --dump-config
dsh --profile maibot
```

`--from-default-profile` 替换整个目标 profile（包括用户 patch 和依赖），因此不要对已有配置重复运行初始化命令。也可以直接向现有内置 acp profile 安装 bundle，随后继续使用原有 `dsh --profile acp` 启动命令。MaiBot `connection="dsh"` 使用其固定 ACP 启动路径；选择自定义 profile 时应按官方 custom/SSH 参数配置真正启动所选 profile，不能只将插件装到一个不会启动的名字中。

- [官方打包、GitHub 安装及预构建分发说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/user/develop/basic/publish.md)
- [官方 profile 模板与 argv 规则](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/cli/reference/README.md#profile-boot)
- [ACP app 的标准入口与 EOF 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/bundle/acp-app/src/index.ts)
- [MaiBot 官方 CLI / SSH 启动配置](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/docs/agent-connections.md)

## 验证边界

本记录中的 API 结论来自固定源码和 npm 元数据调查。测试报告以项目实际测试运行结果为准。模拟 ACP/MCP 的隔离集成测试只能证明插件与所测试接口的交互；不能替代真实连接验收。

新增 `scripts/test-acp.mjs` 在真实官方 CLI 子进程上，通过官方 ACP SDK 完成 NDJSON `initialize`、`session/new`、`session/prompt`、`session/close`。测试 profile 从 acp 模板初始化，通过官方 plugin 命令安装预构建 tarball，并在真实 Agent loop 中使用明确标记为测试专用的确定性 LLM adapter。Native 已验证三项产物工具实际执行（prepare、publish、local_status，另重复一次 publish）、中文文本 / PNG 二进制 / 空文件、共享请求哈希与确认参数、默认 XDG 私有状态目录、重复提交维持相同任务、prompt 与 `_meta` 伪造目标未被采信。测试 MCP server 经真实 stdio transport 挂载到该会话，并通过独立 ping 验证传输；默认提交流程未调用 agent_talk。

`--clean-install` 还在全新临时 npm prefix 与缓存中安装官方 `@deepseek-ai/dsh@0.2.2-alpha.2`、pnpm，再安装同一预构建 tarball。安装均使用 `--ignore-scripts`，Native ACP 流程通过。它证明真实 DSH 安装和协议路径可用，不代表真实 MaiBot 已连接。

本环境的 PTC 在 `workspace-write` 下明确返回 `sandbox-unavailable`：没有可用的 Landlock / bubblewrap 后端。测试确认官方拒绝发生在产物工具之前，产物工具和 MCP 调用均为零；默认报告 **1 项受限 PTC 工作流跳过**。`--require-ptc` 在同样条件下明确非零退出。**这个本地受限 PTC 工作流未通过**，不能将本地跳过称为通过，也不能通过关闭沙箱、提权或扩大文件权限使其变绿。随后 [GitHub CI 41012901225](https://github.com/MemoryController/dsh-maibot-artifacts/actions/runs/41012901225) 在官方沙箱可用的 Runner 上以同一 workspace-write 配置完成 Native 与 PTC 两个真实 ACP 场景，三个产物工具、共享请求、重复提交和模拟 MCP 传输均通过；这补齐了受限 PTC 的隔离验证，仍不能代替实际生产主机或真实 MaiBot 的验收。

**尚未验证真实 MaiBot ACP + DSH + Docker 挂载 + QQ 文件通道全链路，也没有获得真实原聊天 file_ref 或 QQ 投递回执。** 未执行的真实部署检查不能报告为通过；无法确认的远端结果应报告 unknown，禁止自动盲目重发。

本轮仅作版本与本地恢复修复；上述固定上游的来源/权限限制没有新证据变化。默认manifest确认兼容对端main，显式request依赖Draft，详见 [兼容矩阵](compatibility.md)。没有修改任何MaiBot/DSH上游核心或配套PR元数据。
