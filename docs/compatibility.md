# 两端版本与兼容范围

核查日期：2026-10-30（Asia/Shanghai）。已合并到 DSH main 的 0.2.0 默认要求对端尚未合并的新请求工具；本轮 **DSH 0.2.1 修复候选改为默认返回已有 `dsh_import_handoff` 的完整清单确认参数**，使配套 main 0.2.0 也有可执行的受控流程。请求文件协议不变；显式选择 `confirmationMode: request` 才要求配套草稿 0.2.1。修复候选尚不能冒充已经合并的 main。

## 版本矩阵

| DSH 插件与确认模式 | MaiBot 配套插件 | manifest v1 | 实际确认工具 | 结论 |
| --- | --- | --- | --- | --- |
| main `0958d8ac788ebbea5f2c507f3b024de3dd06cb24`，包 0.2.0 | main `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`，0.2.0 | 兼容 | 默认返回的 `dsh_import_request` **不存在** | 旧版默认参数不可直接执行；须手动向已有 `dsh_import_handoff` 提交完整清单 |
| 同一 DSH main / 0.2.0 | PR #2 `27d6c00784557128ebb9c57edf04a0a5c1382bd6`，0.2.1 | 兼容 | `dsh_import_request` | 固定两端源码的隔离链路已验证；对端 PR 仍为 draft、未合并，真实部署待验收 |
| 本轮 DSH 0.2.1 修复候选，默认 `confirmationMode: manifest` | 对端 main / 0.2.0 | 不变 | 已有 `dsh_import_handoff(manifest, send=false)` | 默认返回完整参数，无需对端新工具；本轮两端真实内核的隔离检查以最终测试记录为准 |
| 同一修复候选，默认 `manifest` | 同一 PR #2 / 0.2.1 | 不变 | 同一 `dsh_import_handoff` | 新旧对端共用已有入口，不依赖草稿新工具 |
| 同一修复候选，显式 `confirmationMode: request` | 同一 PR #2 / 0.2.1 | 不变 | `dsh_import_request(task_id, request_sha256)` | 可选请求入口；必须由部署者核实并固定对端提交 |
| 同一修复候选，显式 `request` | 对端 main / 0.2.0 | 兼容 | `dsh_import_request` **不存在** | 不支持此模式；改用默认 `manifest`，不能声称工具自动探测成功 |

本轮只修改 DSH 仓库。没有将配套 PR 标记为 ready、更新其元数据、修改其分支、合并或发布。只读查询时 [配套 PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 为 **OPEN / DRAFT**，head 为上表 `27d6c007…`，base main 为 `ba8a5fb…`；Python 3.10、3.12 的 CI 检查均成功。这些状态只是核查时的快照，后续改动需要重新审阅。

## 稳定协议和工具签名

manifest 顶层仅有 `type`、`version`、`task_id`、`files`，文件项仅有 `path`、`size`、`sha256`。`type="dsh_artifacts"`、`version=1`；任务 ID 是随机 32 位小写十六进制，SHA-256 是 64 位小写十六进制，size 是非负整数。不得添加 `chat_id`、`session_id`、`target` 或 `send`。默认单文件 50 MiB、每批 8 个；两端配置共同允许的硬上限是 1 GiB、32 个，实际还受 Host 配额限制。

| MaiBot 公开工具 | 0.2.0 main | PR #2 / 0.2.1 | 证据含义 |
| --- | --- | --- | --- |
| `dsh_import_handoff(manifest, send=false)` | 有 | 签名与内核不变 | 实际在当前 Host 文件 scope 导入；只有逐项真实 `file_ref` 是入库证据 |
| `dsh_handoff_status(task_id)` | 有 | 不变 | 只读账本，并用当前聊天 `ctx.files.list` 核验引用访问权；不补上传、不恢复副作用 |
| `dsh_import_request(task_id, request_sha256)` | 无 | 新增，两个参数均必填 | 固定读取请求并核对准确字节哈希；固定 `send=False`，不接受路径或聊天选择参数 |

`dsh_import_request` 只读取 `outbox/.dsh-handoffs/<task_id>.json`。文件内容就是原始 manifest v1，不包裹新协议对象；请求最多 64 KiB。DSH 返回的 SHA 必须对应文件的**准确原始字节**，不可格式化后沿用旧哈希。两种导入入口共享现有账本和去重依据。

本轮 DSH 候选始终保留同一共享请求文件及准确字节哈希，只调整返回给操作员的确认方式。默认 `confirmationMode: manifest` 返回 `{"tool":"dsh_import_handoff","arguments":{"manifest":完整清单,"send":false}}`；不需要从文件路径猜参数，也不要求升级对端。仅在部署者已验证安装了固定配套 0.2.1 后，才显式配置 `confirmationMode: request`。原版 ACP 不暴露第三方插件工具，DSH 无法通过列出 ACP 工具自动探测这些入口；它不会伪称完成远端版本检查。两种模式都必须由用户在原聊天明确确认，并以真实工具结果核验。

task_id 和请求哈希只确认内容，不授予原聊天身份。用户必须在原聊天明确选择导入；真正入库位置由本次 Host 签发的文件 scope 决定。默认不发送 QQ 文件。`submitted` 只表示共享请求发布，`queued` 只表示传话排队；DSH 本地状态不升级为 imported。未知上传、未知通知或丢失回执均不自动重试或换 ID，先在原聊天核对 `dsh_handoff_status`、原工具结果和 `files_list`。

## 对配套 PR #2 的只读审阅

已逐一审阅 `ba8a5fb…` → `27d6c007…` 的全部 **10 个文件，492 行新增、12 行删除**：

- `plugin.py` 增加官方 `@Tool` 声明和一个轻量入口。其公开 schema 只包含必填的 `task_id`、`request_sha256`；Host 传入的普通 kwargs 不作为目标或发送授权。
- 新增 `request.py` 复用现有 `Workspace.snapshot`：逐级无符号链接读取、普通单硬链接文件、大小及竞态检查、私有暂存、准确 SHA、严格 JSON、manifest 和任务标识校验。然后在同次调用内执行原 `Handoff.import_manifest(..., send=False)`，没有目录监听或后台上传。
- `_manifest.json` 仅将插件版本升为 0.2.1。插件 ID、MaiBot/SDK 范围、能力声明不变，没有追加特权能力或依赖。
- 三个测试文件更新工具清单及安装文件集合，增加 41 项请求确认检查和 3 项入口检查；其余四个文档文件说明原聊天确认、版本要求和验证边界。

`handoff.py`、`safe_files.py`、`integrations/`、依赖与 pytest 配置在该 PR 中均未修改。新入口沿用原来的大小/哈希复验、持久 claim、未知状态、引用授权与去重，没有复制另一套上传实现。生产入口没有导入或调用历史 `integrations/` Host 补丁；安装也不需要这些历史文件。未发现阻止人工代码审查的兼容性缺陷，建议由配套维护者将该 PR 转为 **ready for review**，再按 [跨仓待办](cross-repo-todos.md) 审阅；这里的建议不代表已经执行该状态变更或同意自动合并。

## 原版 Host 和 SDK 依据

验证范围限定为 [MaiBot v1.3.18 `2a9af62…`](https://github.com/Mai-with-u/MaiBot/tree/2a9af62cec37035d29237acbe2cf3adceb700b27) 和 [SDK v2.19.0 `c2a039a…`](https://github.com/Mai-with-u/maibot-plugin-sdk/tree/c2a039a7f4bcb367c7d770e88d6e034337be6b12)。

- SDK [files 文档](https://github.com/Mai-with-u/maibot-plugin-sdk/blob/c2a039a7f4bcb367c7d770e88d6e034337be6b12/docs/files.md) 要求文件能力只在 Host 派发的工具调用期间使用。没有官方可复用的 current_chat 凭证；模型 kwargs 不能代替 scope。
- Host [`component_query.py`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/plugin_runtime/component_query.py#L972) 依据真实上下文强制覆盖文件 scope，并在 finally 撤销。官方 [`files/capability.py`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/files/capability.py) 从该 scope 取真实 session；插件不能传参选择别的聊天。
- 原内核实际调用 SDK `ctx.files.upload(private_snapshot, name=...)` 并校验返回的真实 `file_ref`。第三方插件工具不在原版 ACP MCP 服务中；DSH 不能直接远端执行上述确认工具。`agent_talk` 只入队，不能代替文件 scope 或入库回执。

本轮以关闭字节码及 pytest 缓存、把测试暂存放在仓库外的方式，只读重跑了固定配套源码：**286 passed，0 failed，0 skipped**；Ruff 无缓存检查通过，仓库差异仍为空。测试包含真实 SDK 工具声明、临时插件安装（`plugin.py`、`handoff.py`、`request.py`、`safe_files.py`、`_manifest.json`）、import/create_plugin/on_load。还重新执行未修改官方 Host 的 `ManifestValidator`，0.2.1 manifest 通过且无 errors/warnings。

这些检查执行真实请求读取、快照、SQLite 账本和插件逻辑；Files API 是明确标记的聊天 scope double。没有在这里签发真实 Host scope、访问真实文件 HTTP 通道或取得真实 QQ/原聊天 file_ref。既有 DSH ACP、跨语言检查及其边界见 [验证记录](validation.md)；实际部署仍须执行 [生产验收](production-acceptance.md)。

## 精确固定的安装组合

本轮候选的推荐组合是 **DSH 0.2.1 默认 manifest 模式 + 已合并配套 main 0.2.0 `ba8a5fb…`**。配套草稿只作为可选 request 模式的依赖，不是默认流程的前置条件。发布修复安装说明时，将 DSH 来源固定为审核后的新完整 SHA，不能用 `main`、浮动分支或裸 `latest` 隐去差别。

先复用用户已有的 `/home/fish/dsh-runtime`，不另建 runtime 或重新初始化 profile。以实际 SSH 用户核对当前二进制版本为 **0.2.2-alpha.2**，并使用其真实 `DSH_HOME` 和 `acp` profile：

```fish
/home/fish/dsh-runtime/node_modules/.bin/dsh --version
# 下面的 /home/fish/.dsh 必须与现有 SSH ACP 启动环境一致。
env DSH_HOME=/home/fish/.dsh /home/fish/dsh-runtime/node_modules/.bin/dsh --profile acp --dump-config
```

本轮DSH0.2.1修复候选的固定安装命令如下（未宣称已合并main或发布Release）：

```fish
env DSH_HOME=/home/fish/.dsh /home/fish/dsh-runtime/node_modules/.bin/dsh plugin --profile acp add 'github:MemoryController/dsh-maibot-artifacts#c2cb0059ee222868c60c25597d8fa209e51d053f' --ignore-scripts
```

修复候选形成审核提交后，使用相同命令结构安装新完整 SHA；本节不把尚未生成的提交伪装成可安装版本。默认模式配套只需保留已合并的 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`。若操作员自行选择 request 模式，则必须先审阅并安装完整配套 `27d6c00784557128ebb9c57edf04a0a5c1382bd6`，不能只复制 `plugin.py`，也不能假定配套 main 已包含它。本轮不修改、切换或升级用户的 MaiBot 仓库。

两端共享根均为 `/srv/maibot-agent`，保留 Host 私有 data 与配置，启用官方文件能力及原有权限。更新 DSH 后重新连接实际 ACP 进程；先核查在途任务，不重放未知结果。完整 Docker/SSH/UID/GID 配置见 README 与生产验收。无论是新候选默认返回的 manifest 参数，还是旧版手工复制完整清单，都仍须实际 Planner 调用和 file_ref 核对，不能声称请求文件被自动消费。
