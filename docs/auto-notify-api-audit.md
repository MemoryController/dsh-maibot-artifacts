# 自动传话的官方接口与授权审计

本轮以官方 DSH **0.2.2-alpha.2** 固定源码 [`ce7073d51254c26cd63b22a60835b8f948deb447`](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447) 及已安装的同版本 npm 包为依据。本仓库起点为 `f008cdc039122d360dee67b86e1e2004083ba019`（0.2.1）；配套仓库 main 由任务指定为 [`8018552bc82ee5fada38f6792a1721410adf5bc8`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/8018552bc82ee5fada38f6792a1721410adf5bc8)。本文不修改 DSH、MaiBot 或配套插件，不将本地配置扩展称为官方接口。

结论：**官方 Native 工具执行 API 可以调用当前 Agent scope 内可见的 MaiBot MCP agent_talk；标准 ACP 仍没有给本插件提供可验证的原 QQ 聊天授权目标。** 可在操作员明确授权的单聊天部署中自动传话；这代表管理员在部署时指定的路由，不是从 ACP 证明原始聊天身份。PTC 或其他执行器拒绝时保持未派发，不能另建执行管线绕过。

## 路径一：ACP 请求元数据与返回通道

DSH ACP `session/new` 生成自己的 DSH Session ID，向 Agent factory 传递 `cwd`、`mcpServers`、模型配置。它把客户端声明的 MCP servers 挂在新 Agent scope 中。这个 DSH Session ID 不是 MaiBot 原聊天 session_id，不能互换。

`AcpSession.prompt()` 仅读取 `params.prompt` 作内容准入，然后创建 `createUserMessage({content, source:{kind:'user'}})`。`params._meta` 没有被传入此 source、原任务记录或公开的工具执行上下文。当前调用的 `ToolRunContext.agent` 能确认执行发生在哪个真实 DSH Agent，`rootCallId` 能关联 DSH 工具执行树；二者不能推出 QQ 目标。

- [session/new 及 Agent 创建参数](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/index.ts#L199)
- [ACP prompt → 普通 user 消息](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/session.ts#L257)
- [每个 Agent 挂载自己的 MCP clients](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/acp/acp/src/mcp.ts#L26)
- [ToolExecutionInput 与 ToolRunContext](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/contracts.ts#L184)

MaiBot v1.3.18 把回复目标写在 relay 文本中，再作为普通 ACP prompt 发送；该文本不是不可伪造授权载体。即使 `_meta` 未来被透传，仍需要 Host 签发来源、受认证的路由授权、有效期和任务关联契约，不能单凭字段名变成可信目标。

MaiBot 的官方文档也明确：ACP `session/update` 文本保存到独立 Agent 执行记录，`session/prompt` 最终响应给出停止原因；直接文本不会自动转发到普通聊天。**不能通过返回一段“完成”文字来实现自动 QQ 通知。**

- [MaiBot relay 构造](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L61)
- [MaiBot ACP prompt 组装](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/acp_agent.py#L208)
- [官方“回复、身份与暂停”](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/docs/agent-connections.md#L85)

## 路径二：真实 Host 上下文绑定

已有 `TrustedTargetBindings` / `maibotArtifactTarget` 是本项目的进程内扩展，不是 DSH 或 MaiBot 默认提供的服务。只有独立受信任 Host 真正持有来源时，才可把实际 Agent 对象、对应 rootCallId 与原任务的 target/originId 绑定。prepare 与 publish 的绑定须属于同一来源；这不能从模型参数或文件中补齐。

固定 DSH ACP 代码没有调用此扩展的生产钩子，也没有提供 MaiBot 原聊天目标。仅安装插件不会使此路径自动出现。读取提示词中的“回复目标”、选择 `agent_chats` 某一项、保存“最近一个目标”，或者把 DSH Agent ID 当聊天 ID，都不是这一绑定的实现。

未来若上游提供明确受认证的原任务身份与回传授权契约，可由独立适配层接入；当前不能宣称通用的“原聊天自动识别”已经实现。

## 路径三：操作员明确授权的固定单聊天路由

在**专用于一个聊天的部署**中，可由操作员在受保护的 DSH 配置中显式启用固定目标，确认真实目的聊天、工具名及适用范围。本插件不从工具参数接受该目标，不从 manifest / 文件 / prompt 中推断它。该配置必须与真正启动的 DSH_HOME、profile 和实际 Agent 使用边界一致，不能无意应用于复用多个聊天的全局 Agent。

这种授权的意思是“将本部署明确范围内的任务通知到操作员指定聊天”，不是“ACP 证明该聊天发起了当前任务”。目标填写错误或将多聊天工作混入同一授权范围，会通知错误聊天；不能靠 task_id、SHA 或队列回执纠正这一部署决定。没有明确授权时仍使用现有手工确认路径。

MaiBot 的 agent_talk 只接受 `text`（必填）、`target`、`images`。本插件只发送 `{target,text}`，不传图片内容，不添加清单路由或发送字段。原版 MaiBot ACP server 名是 `maibot-agent`，经 DSH 注册后通常为 `mcp__maibot-agent__agent_talk`；其他合法 serverName 须使用实际注册名。

- [MaiBot agent_talk schema 与可信执行上下文](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/provider.py#L19)
- [MaiBot MCP server 名称、scope 与 provider 调用](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/mcp_server.py)
- [DSH MCP publicToolName 与注册](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/mcp/mcp-client/src/tools.ts#L81)

固定路由也只自动送交一条文本任务。通知消息明确要求先按配套插件策略取得**当前接收聊天的确认**，不能把 Agent 提示、固定目标配置或清单本身冒充人类批准。MaiBot Planner 随后仍须真正选择 `dsh_import_handoff` 等已支持工具；Host 必须在真实聊天文件 scope 内派发，才能登记文件。当前 SDK 不提供可由本插件验证的人类批准事件，不能声称代码证明了批准已经发生。传话入队不是强制入库接口。请求消息使用严格 manifest v1、默认 `send=false`，不需要修改配套插件或新增特权服务。

## 路径四：当前官方执行器的 Native / PTC 分派

本插件继续使用 `ctx.tools.execute({calls, signal, agent, toolSet})`，把当前真实 Agent、该步骤准入集合及取消信号交给官方服务。服务按 Agent scope 选择最近的执行器。调用前只能检查注册 schema 和作用域，不能直接调用 `definition.execute()`。

官方 ACP profile 在 base 层启用 Native、禁用 PTC。Native 能程序化执行当前可见的 MCP 工具，完整经过 pre-policy、guard、around-dispatch、post-policy、canonical result 和取消处理。

PTC root batch 只接受 `run_code`。插件内部再用 `ctx.tools.execute` 创建的原生 MCP batch 仍是 root batch，不能设置一个不存在于 `ToolBatchInput` 的 parent 参数。当前插件不得把 PTC 的 `UNKNOWN_TOOL` 拒绝解释为通知成功：新增固定模式在没有进入远端分派时，独立返回 `automatic_notification.state: not_dispatched`；`prepared_only` 是原有可信 Host 通知分支的结果名，不能混同为新增模式状态。错误说明保留切换到已授权 Native 部署或人工路径的原因；一旦远端可能执行，通知结果只能保守记为 unknown，禁止重试。

本地 `result: submitted`、`stages.publication` 与 `automatic_notification` 分别描述请求发布和传话；无论传话为 queued、not_dispatched 或 unknown，MaiBot 登记仍为 unconfirmed。关闭自动模式不删除历史通知证据；任务从未建立独立通知日志且模式为 off 时，返回形状保持原有可信 Host 路径的行为，不用新增层的未知状态覆盖旧回执。

- [公开 ToolBatchInput](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/executor.ts#L20)
- [选择当前执行器后分派 execute](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/index.ts#L352)
- [Native 使用共享 pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-native/src/index.ts)
- [PTC 的 root 拒绝条件](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-ptc/src/index.ts#L33)
- [默认 Native profile 行](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/bundle/base/cordis.patch.yml#L496)

### 取消预算与已启动执行的清理

官方 `ToolDefinition.execute` 要求异步工作转发 / 响应取消信号，且只在自己拥有的工作结束后 settle；执行器不会丢弃尚未完成的工具 Promise。官方 timeout policy 的实现也是设置 deadline、`await next()`，在清理完成后再把超时结果映射为 `TOOL_TIMEOUT`，没有用提前返回的 race 替代等待。

新增固定通知层依照此契约：计时器只触发 AbortController，通知调用仍等待真实 `ctx.tools.execute` 的 dispatch Promise 完成。超时或取消一旦发生，即使清理后收到迟到的排队回执，也保持 unknown；已持久化的单次通知栅栏禁止重发。这里的 timeout 是**请求取消的预算**，不是强制杀进程或证明远端操作已停止。若第三方 provider 不响应取消，外层完成时间可能超过该预算；不得为尽快返回而另加提前逃逸的 Promise.race，或把这一延迟误记成安全可重试。

- [官方工具 owned-work / quiescence 契约](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/contracts.ts#L30)
- [官方执行器必须等待已启动工作](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/executor.ts#L74)
- [共享 pipeline 取消后等待 body](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/pipeline.ts#L253)
- [官方 timeout policy：deadline + await next，而非 race](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/guard/timeout-policy/src/index.ts#L61)

### 为什么没有另建 ToolExecutionPipeline

`@deepseek-ai/dsh-tools/pipeline` **确实是公开导出**，提供 `ToolExecutionPipeline.prepare/dispatch/complete` 和 `executeToolBatch`。`ToolExecutionInput` 也公开了真实执行 token 对应的 `parent`、`rootCallId`；官方 PTC 的 SDK 子调用用这些字段进入其自己持有的 pipeline。这些 API 存在，不能声称“官方完全没有嵌套执行管线”。

但它们是供执行器 / 程序调度器实现使用的机制，**不是向当前已选执行器委派嵌套调用的服务 API**。构造 `new ToolExecutionPipeline(ctx)` 默认只继承 registry 的 executable lookup；它不知道当前执行器的 `ToolExecutionSource.get/reject` 或调度安排。即使它会执行通用 guards，也不能据此证明保留了当前执行器所有策略。`ctx.tools.execute` 没有公开“取得当前执行器的 nested dispatcher”接口。

在固定 built-in PTC 的隔离研究 double 中，真正 parent token 的共享管线调用可以到达一个模拟 MCP body，并保留普通 guard；这只说明公开阶段的机制有效，不证明可以绕开当前执行器的拒绝。本项目按“不得绕过官方执行器”的约束不采用此做法，也不读取 PTC 的私有 pipeline、不自行新建 Native 执行器、不生成嵌套 run_code 来规避拒绝。将来只有官方增加保留所选执行器策略的嵌套委派入口，才应重新评估。

- [官方 package exports 中的 ./pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/package.json)
- [ToolExecutionSource 与默认 pipeline lookup](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/pipeline.ts#L15)
- [pipeline 供 batch/program schedulers 使用](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/pipeline.ts#L57)
- [官方 PTC 在自己的 pipeline 创建 parent/root 子调用](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tool-executor-ptc/src/ptc.ts#L502)
- [官方嵌套执行 / composite 类型说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/subsystems/tools.md#L313)

## 回执和验证要求

排队成功必须是真实工具执行结果中准确匹配目标的 MaiBot 队列 JSON 回执，不能是模型声称成功或模拟记录。即使得到 `delivered:true` 与合法 relay_id，也最多标记 queued。registered / file_ref / QQ sent 仍分别需要原聊天官方工具的真实证据。MCP 错误、超时、中断或无法判断的结果不得自动重发。

本记录包含固定源码与 npm API 核查，以及明确标记的隔离机制研究；不是新增自动路由生产验收报告。自动传话的实际通过/失败数量以本轮测试和验证记录为准。必须分别检查 Native 真实执行器成功、PTC 官方拒绝且零远端调用、错误 scope、缺少显式授权、guard/准入拒绝、目标不匹配、超时未知、重复 publish 不再分派。没有真实 MaiBot/Host/QQ 回执时不得声称无人确认入库已完成。
