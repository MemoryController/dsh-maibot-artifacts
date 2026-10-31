# DSH 多版本 API 兼容依据

本页核对官方 **0.2.1-rc.2、rc.3、rc.4、rc.5、0.2.2-alpha.2**，范围是本插件实际使用的 Cordis、工具注册、程序化通知和 ACP/profile 接口。版本支持须同时满足包声明与对应运行测试；不能仅凭 TypeScript 编译或源码相似就报告某版本真实流程通过。

## 固定来源与工具链

通过官方 Git tags 解析以下提交，并用 `npm pack --ignore-scripts` 下载相同版本的官方 `@deepseek-ai/dsh`、`dsh-tools`、`dsh-llm`、`dsh-acp` 实包。npm tarball 完整性验证保持开启；调查未运行包内安装脚本，也未替换生产运行时。

| 官方 DSH 版本 | 官方 tag / 源码提交 | CLI 声明的 Cordis / Schemastery |
| --- | --- | --- |
| 0.2.1-rc.2 | [`dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) | `~4.0.5` / `~3.18.5` |
| 0.2.1-rc.3 | [`dsh-v0.2.1-rc.3` / `1f81c047fc48fa190a683e469daa699857e9afe8`](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8) | `~4.0.5` / `~3.18.5` |
| 0.2.1-rc.4 | [`dsh-v0.2.1-rc.4` / `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`](https://github.com/deepseek-ai/deepseek-harness/tree/504a01a9578abc2c6f1fb896b1dc322c9fe24f66) | `~4.0.5` / `~3.18.5` |
| 0.2.1-rc.5 | [`dsh-v0.2.1-rc.5` / `b830ec950faba0a46dda564be3e2d854afed94f1`](https://github.com/deepseek-ai/deepseek-harness/tree/b830ec950faba0a46dda564be3e2d854afed94f1) | `~4.0.5` / `~3.18.5` |
| 0.2.2-alpha.2 | [`dsh-v0.2.2-alpha.2` / `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`](https://github.com/deepseek-ai/deepseek-harness/tree/f3803c96974ad4a94195fb97e5c637e9c2a3afe3) | `~4.0.6-alpha.1` / `~3.18.6-alpha.1` |

此前审计的 `ce7073d…` 是 alpha.2 tag 之后的 main，不能笼统视为 npm 发布源码。关键 tools/ACP 接口在二者相同，但 Cordis 后续源码已有差异；本页以发布 tag 和实际 tarball 为准，不将 main 当作所有历史版本的证据。

四个 RC 版本的已发布 `dsh-tools/lib/index.js`、`lib/types/index.d.ts`、`lib/types/schema.d.ts` 及 `dsh-acp/lib/index.js` 分别逐字节相同。例如 tools runtime 的 SHA-256 均为 `1e53932e7c4213ea` 开头，类型入口均为 `049df0624956583b` 开头。这证明本页列出的 RC 接口差异不是根据版本号猜测；它不替代每个 CLI/profile 的运行验证。

## 对本插件有影响的接口差异

| 使用点 | 0.2.1-rc.2–rc.5 | 0.2.2-alpha.2 | 兼容要求 |
| --- | --- | --- | --- |
| Cordis 插件 | 命名导出 `name` / `inject` / `apply` | 相同 | 使用公开生命周期，不读 Fiber 私有字段 |
| `defineTool` | `parameters`、`output.schema/render`、`execute(args, exec)` | 相同；另新增 `projectToolSchema` 等导出 | 继续使用两代共有 DSL |
| 注册 | `tools.register(definition)` | 增加可选条件注册参数 | 本插件使用无条件注册；不伪造 RC 条件准入 |
| 执行前查找 | `tools.get(name, agent)` | `tools.executable(name, agent, toolSet)`；另有 `get`、`resolve` | RC get 保留作用域过滤；alpha executable 保留步骤准入 |
| 程序化执行 | **单次、已解析** `ToolExecutionInput` → `ToolExecutionResult` | **原始调用批次** `ToolBatchInput` → `ToolBatchResult` | 必须在调用前选定正确签名，不能先试错再重发 |
| 入参身份 | `callId`、`name`、对象 `arguments`、`agent`、`signal`；支持真实 root/parent 身份 | 批次含 `calls`，每项为 `id`、`name`、JSON 字符串 `arguments`；批次含 `agent`、`signal`、`toolSet`，没有 parent 参数 | 不能把 alpha batch 直接传给 RC execute；RC 子调用保留真实调用树 |
| 返回的上下文 | 单次结果的 `additionalContexts?`、`concludesTurn?` | 批次的 `additionalContexts`、`concluded`，以及每项结果 | 规范化只处理确实返回的官方字段，不丢失上下文 |
| `tools/execute` | `(exec, next)`，next 返回规范 `ToolExecutionResult` | 相同 | 继续观察真实分派边界，body 失败不误作未派发 |
| `ToolRunContext` | 真实 `agent`、`rootCallId`、`token`、`signal`、`deferContext`、`concludeTurn` | 保留上述字段，增加可选 `toolSet` | 不从 DSH 身份推导 QQ target；alpha 准入原样转发 |
| Native/PTC 选择 | tools 自带 `mode` 配置与 scoped `presentAs` | 独立 Native/PTC executor 插件；tools.mode 已移除 | 测试/部署 patch 必须按版本选择，不能照搬 alpha 行 |

RC 的公共签名可概括为：

```ts
tools.execute({
  callId, name, arguments: { target, text }, agent, signal,
  parent: exec.token, rootCallId: exec.rootCallId,
})
// 返回单个 { isError, value?, content, additionalContexts?, ... }
```

alpha.2 的对应签名为：

```ts
tools.execute({
  calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify({ target, text }) }],
  agent, signal, toolSet,
})
// 返回 { results: [{ callId, result }], additionalContexts, concluded }
```

这些是接口形状说明，不是独立 CLI，也不是省略权限检查的调用实现。两代的执行入口都重新检查可见性、执行策略、guard 和取消状态；预查 schema 不能替代官方执行。

依据：

- [RC.5 ToolRuntime：Config、get、execute、事件及执行上下文](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts)
- [RC.5 defineTool / schema DSL](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/schema.ts)
- [alpha.2 ToolsService：executable、resolve、按 Agent 选择 executor](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/index.ts)
- [alpha.2 ToolBatchInput / ToolBatchResult](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/executor.ts)
- [alpha.2 ToolRunContext / canonical result](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/contracts.ts)

## 稳定公开子集与安全降级

所有五个版本都有 runtime `ToolCallId()` 导出；相关 brand 类型文件逐字节相同。`defineTool` 接受本插件使用的字符串 / 数组参数、JSON 输出和 renderer，参数根默认开放的规则也一致，因此仍须关闭不允许的模型附加字段。Cordis 的 `ctx.on(..., {prepend:true})`、effect disposer 和 `ctx.get` 均可继续使用。

兼容层应仅识别已核查的两种公开能力组合：RC 的 scoped `get` + 单次 execute；alpha 的 `executable` / `resolve` + 批次 execute。不能依赖 execute 函数形参数量，两代都可能只有一个参数；也不能通过错误回执探测 API 然后重新执行，第一次调用的远端结果可能已经不确定。未知组合必须在远端操作前拒绝，保留人工确认。

RC 没有 alpha 的条件注册 / `ResolvedToolSet` API，不能补造空集合并声称具备相同功能。alpha 提供 toolSet 时须原样交回执行服务；不能为适配旧签名而丢弃其准入。RC 的 get 只作作用域/schema 预查，真正的单次 execute 仍重新检查该调用可否执行。

### PTC 的真实版本差异

两代 PTC 都拒绝直接调用原生名称的 root 执行，但**程序化子调用的公开入口不同**：

| 版本 / 场景 | 正确调用方式 | 预期能力与边界 |
| --- | --- | --- |
| RC.2–RC.5 Native | 官方单次 execute，保留 Agent、signal 和真实 parent/root | 完整经过原 ToolRuntime 的可见性、guard 与策略，可尝试通知 |
| RC.2–RC.5 PTC | 同一官方 execute 支持 ToolExecutionInput.parent；从当前已获准工具上下文转发 `exec.token` 和 `exec.rootCallId` | 真正子调用不受 root collapse 拒绝，可尝试通知；不能跳过 scope/guard |
| alpha.2 Native | 官方 batch execute，保留 Agent、signal、toolSet | 当前 Native executor 分派，可尝试通知 |
| alpha.2 PTC | 官方 batch execute 没有 parent 参数，仍是 root batch | 明确拒绝原生 MCP 名称，通知为 not_dispatched；保留人工确认 |

RC 模式下 parent 来自当前官方工具执行上下文的**真实 token**，不是构造 Symbol、把任意字符串强转为 token，或伪造 DSH/QQ session。服务自己的 `execute` 仍负责 PTC mode、scoped lookup、pre-policy、guard、around/post-policy 和结果处理；没有新建 pipeline、切换 executor 或调用私有 scheduler。RC 源码 `collapses(name, scope, nested)` 明确只拒绝 `!nested` 的非 run_code 调用，`nested` 由 parent 是否存在判定。RC 的公开单次输入恰好提供了正确表达现有执行树的能力。

alpha 不能复制此做法：`ToolBatchInput` 没有 parent，传入额外字段不会使它成为受支持的 nested API。不得通过另建 Native executor 或共享 pipeline 来规避所选执行器的限制。RC 虽导出 `TOOL_RUNTIME_SCHEDULER`，源码明确标为 **@internal / not a plugin extension point**，不得调用；alpha 公开 pipeline 也不是继承当前执行器策略的委派服务。

因此 PTC 不能统一写成“各版本通知都成功”或“各版本都不支持”。RC.5 的隔离机制研究已用官方 ToolRuntime、公开 parent/root 输入和明确的 fake runtime/body 验证子调用可达、Agent 归属保留、guard 拒绝与无 parent 的 root 拒绝；它不替代真实 ACP/进程沙箱/模拟 MCP transport 的版本矩阵测试。各版实际成功记录仍以运行检查为准。

确定未进入远端分派时保留 `automatic_notification.state: not_dispatched`，不是 queued；若已进入远端调用后失败则 unknown，禁止自动重发。RC 单次 execute 与 alpha batch execute 都要求取消后等待已启动工作结束，不能用提前返回的 race 破坏通知栅栏与清理约定。

- [RC.5 root mode collapse、execute 与内部 scheduler 说明](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/tools/src/index.ts)
- [alpha.2 PTC root 拒绝](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tool-executor-ptc/src/index.ts#L33)
- [自动通知权限和取消契约审计](auto-notify-api-audit.md)

## ACP、profile 与重载

五版 `dsh --profile acp` 的 app 入口、无额外运行选项、stdio ACP、stdin EOF 生命周期相同；CLI 包入口均为 `lib/bin.js`。内置 acp profile 使用 base + acp-app；新建任意名字只 plugin add 仍是 base-only，不会自动成为 ACP profile。`--from-default-profile acp` 会替换目标 profile，只用于确认尚不存在的新名字。

RC 基础层只有 tools 行，省略 mode 即默认 Native，PTC 测试应配置 tools 的 `mode: ptc`；alpha 基础层有 `tool-executor-native` 与禁用的 `tool-executor-ptc` 行。不能把不存在的 alpha executor 行写入 RC patch 后把未命中警告忽略为成功，也不能把 RC tools.mode 填入 alpha 后关闭 schema 校验。

ACP 新会话仍将 MaiBot MCP 挂到实际 Agent scope；标准 prompt 仍只进入普通 user 消息，不提供可验证的原聊天 target。多版本兼容没有改变固定目标必须来自操作员明确授权、排队不等于入库、默认不发 QQ 的安全边界。

ACP profile 的 HMR 均默认禁用。安装包、写 patch 或改变通知配置不证明当前运行进程已加载更新；应使用现场原连接的正常断开 / 重连或进程重启，并保存私有任务与通知日志。两代 Cordis 的 effect 生命周期均负责注销旧工具/监听器；本插件不依赖 loader 私有 refresh 或 Fiber 私有 config 字段来实现热切换。

- [RC.5 base patch](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/base/cordis.patch.yml#L497)
- [alpha.2 base patch](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/base/cordis.patch.yml#L496)
- [RC.5 ACP app](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/bundle/acp-app/src/index.ts)
- [alpha.2 ACP app](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/acp-app/src/index.ts)

## 与本插件无关的上游重构

alpha.2 的 Session projection 注册改为等待异步注册结果，Agent/Session 内部投影句柄、生命周期公告和部分 Fiber config 访问方式也改变。它们需要上游消费者迁移，但本插件不注册 Session projection、不访问 Agent 内部投影、不调用 Session 私有方法、不自行创建 ACP Session，也不读取 Fiber 私有 `_config`。本插件只在官方工具实现收到的真实 Agent 上读取稳定的 `id`，因此不引入针对这些内部差异的 shim。

用于隔离测试的 `LlmAdapter` public 类型入口在五版逐字节相同；GenerateOptions、StreamChunk 和 ToolCallId 无本插件相关变化。alpha 的 LLM types 新增 models-updated 通知和模型 badge / 本地化展示信息，不影响产物工具或确定性测试流。测试 adapter 必须从被测 host 的依赖位置加载，不能无意复用开发 checkout 的 alpha 运行时来验证 RC。

本页记录的是接口证据和适配边界。最终通过/失败/跳过数量、各版本真实 CLI / ACP / 配置重启 / 模拟 MCP 检查以 [验证记录](validation.md) 和对应 CI 矩阵为准；真实 MaiBot Host 文件库、QQ 投递和现场 UID/GID 仍须另行验收。
