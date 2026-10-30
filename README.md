# DSH → MaiBot 文件产物交接

正式 Cordis / TypeScript bundle。保留已验证的路径、哈希、去重和通知保护，在 **MaiBot 1.3.18 核心零修改**的条件下提供可用的原聊天受控确认流程：

```text
DSH 生成 outbox 文件 → prepare → publish 写入固定共享请求
    → 用户在原 QQ 聊天确认 publish 返回的 confirmation
    → 默认 dsh_import_handoff；显式 request 模式用 dsh_import_request → 现有 Host 文件库 → 真实 file_ref
```

**默认不需要 `maibotArtifactTarget` 或自行编写适配器。`submitted` 只证明请求已写入共享目录；不是 MaiBot 已接收或入库。** 自动通知默认关闭，手动流程由操作员从独立 Agent 执行记录取得确认参数并带回原聊天。本轮 0.3.0 提供专用单聊天部署的显式固定目标通知；它只发送文本入库请求，不能保证 Planner 调用工具或文件入库。当前官方 ACP 没有可信原聊天身份，成功 ACP 文本本身也不会自动转发到 QQ，不能把提示词中的回复目标当作授权。见 [自动通知与权限审计](docs/auto-notify-api-audit.md)。

## 版本与实际验证

| 组件 | 要求 |
| --- | --- |
| 本插件 | 0.3.0 自动通知候选 [`12a9e7c`](https://github.com/MemoryController/dsh-maibot-artifacts/commit/12a9e7cd36464acce554ccdf243ee76cb51d1eed)，未合并/发布 Release；已合并手动基线为 0.2.1 `f008cdc…`；Linux `/proc/self/fd`，Node.js ≥24 |
| DSH | **0.2.2-alpha.2**，Cordis 4.0.6-alpha.1；不要使用落后的 npm latest 标签替代 |
| MaiBot / SDK | 原版 v1.3.18 / v2.19.0 |
| 配套插件 | 推荐已合并 main **v0.2.1 [`8018552`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/8018552bc82ee5fada38f6792a1721410adf5bc8)**；[PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 已合并，不是 Draft |
| 旧协议兼容 | manifest v1 与 `ba8a5fb…` v0.2.0 不变；旧 peer 使用默认 manifest，request 模式要求 v0.2.1 |

本轮本地 **134项测试通过、0失败/跳过**，类型/lint/构建、18个dist文件一致性、独立预构建安装、官方profile及真实Native ACP检查通过；fixed模式经真实官方执行管线对模拟MCP排队1次，重复不重发。跨语言检查执行实际两端源码，Files API为scope double，不是真实MaiBot/QQ。本地PTC因沙箱不可用明确跳过且零副作用；已合并基线的历史CI曾验证受限PTC，本轮新CI结果须以推送后的运行记录为准。详见 [验证记录](docs/validation.md)。

## 安装到真正运行的 ACP Profile

现场使用既有 `/home/fish/dsh-runtime/node_modules/.bin/dsh`，先核对版本，匹配 **0.2.2-alpha.2** 才继续；不覆盖已有 runtime。以下只是部署示例，未在生产服务器执行。先核实实际 `DSH_HOME`、SSH 非交互 PATH 与 profile，完整步骤见 [Ubuntu24 / core 专用指南](docs/deploy-ubuntu24-core.md)。

```fish
set DSH /home/fish/dsh-runtime/node_modules/.bin/dsh
$DSH --version
# 以下示例仅在实际 DSH_HOME 为 /home/fish/.dsh、profile 为 acp 时使用：
set DSH_HOME_ACTUAL /home/fish/.dsh
# 安装到 MaiBot 原连接实际运行的 acp profile：
env DSH_HOME=$DSH_HOME_ACTUAL $DSH plugin --profile acp add 'github:MemoryController/dsh-maibot-artifacts#12a9e7cd36464acce554ccdf243ee76cb51d1eed' --ignore-scripts
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile acp --dump-config
```

上述命令固定本轮 **0.3.0 实现提交 `12a9e7c…`，包含默认关闭的 autoNotify**；这是待审查提交，尚未合并或发布 Release。不要安装浮动分支后把结果当成固定版本。包提交了 `dist`，没有 prepare/install/postinstall 钩子，安装不需要执行构建脚本。pnpm 的通用 git-build 警告不代表要授权脚本；实际入口为预构建 JS。CI 对源码与全部产物作逐字节比对。

官方 `acp` profile 初始化时包含 base + ACP bundle。**任意新名字（如 `maibot`）仅执行 plugin add 时只有 base，不继承 ACP**。若确需独立 profile，首次初始化用：

```fish
# 只在新 profile 上执行；--from-default-profile 会重置已有 profile 配置！
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile maibot --from-default-profile acp --help
env DSH_HOME=$DSH_HOME_ACTUAL $DSH plugin --profile maibot add 'github:MemoryController/dsh-maibot-artifacts#12a9e7cd36464acce554ccdf243ee76cb51d1eed' --ignore-scripts
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile maibot --dump-config
# SSH 启动命令也必须相应使用 --profile maibot。
```

检查合成配置包含 `@deepseek-ai/dsh-acp`、`dsh-maibot-artifacts`。插件更新使用相同 `plugin ... add <新固定SHA> --ignore-scripts`，不要重复重置 profile。**安装或更新后停止旧 ACP 进程、重新连接 MaiBot 的外接 Agent**；单独安装不会使已运行进程加载新模块。先核查在途任务，不自动重放未知任务。

## 普通用户状态与共享目录

bundle 默认 `workspaceRoot: /srv/maibot-agent`。状态目录默认有效的绝对 `$XDG_STATE_HOME/dsh-maibot-artifacts`，否则 `$HOME/.local/state/dsh-maibot-artifacts`；由进程创建为 0700，文件 0600。现存宽权限、错误所有者、软链接目录均拒绝，不自动 chmod 用户目录。无需在 `/srv` 创建状态目录。

例如用户 `fish` 的实际 home 是 `/home/fish`，可在 `$HOME/.dsh/profiles/acp/cordis.patch.yml` 完整覆盖：

```yaml
- id: maibot-artifacts
  config:
    workspaceRoot: /srv/maibot-agent
    stateDir: /home/fish/.local/state/dsh-maibot-artifacts
    maxFileBytes: 52428800
    maxBatchFiles: 8
    notificationTimeoutMs: 30000
    confirmationMode: manifest
```

`stateDir` 可省略以用用户默认值；显式路径须规范绝对、无软链接、在共享根之外。DSH 的 config 是整个值替换。默认单文件 50 MiB / 每批 8 个；两端同时配置后最多 1 GiB / 32 个。状态、MaiBot 私有账本都须持久保留；删除或回滚不能作为安全重试理由。

共享根由管理员一次性预置；以下为 **bash 管理命令**，既有目录/权限应先检查，勿覆盖部署策略：

```sh
getent group maibot-files || sudo groupadd --system maibot-files
sudo usermod -aG maibot-files fish
sudo install -d -o fish -g maibot-files -m 2770 /srv/maibot-agent /srv/maibot-agent/outbox /srv/maibot-agent/inbox
getent group maibot-files
```

让实际 MaiBot Runner 获得该组的数字 GID（重新登录/启动后生效）。DSH 新建 `.dsh-handoffs` 为 0750，清单请求为 0640，并继承共享父目录组；产物生成器也应使用共享组和 `umask 0027`。不使用 chmod 777。生成器必须关闭写句柄后再 prepare。现有目录可由管理员按相同权限预置，不能改用软链接。

## Docker 与已有 SSH ACP 连接

在现有 Compose 服务中增加/保留片段，替换实际插件路径与共享组 GID：

```yaml
services:
  core:  # 既有服务 core，容器 maim-bot-core；保留全部原配置
    group_add: ["实际 maibot-files 数字GID"]
    volumes:
      - ./data/MaiMBot/plugins:/MaiMBot/plugins  # 现有卷：保留，不重复添加
      - /srv/maibot-agent:/srv/maibot-agent
      # 保留原 MaiBot data 持久卷；不挂给 DSH。
```

实际 Runner 也必须看见上述目录并保留该补充组。先从实际容器 Mounts 核实该现有卷的宿主 Source。用新 staging 目录审阅配套插件的**整个固定提交目录**，不能只复制 plugin.py，也不能直接覆盖已有插件：

```sh
git clone https://github.com/MemoryController/maibot-dsh-artifacts.git ./maibot-dsh-artifacts-review
git -C ./maibot-dsh-artifacts-review checkout --detach 8018552bc82ee5fada38f6792a1721410adf5bc8
```

把审阅后的完整目录通过原 Host 部署流程放入现有宿主插件根下的 maibot-dsh-artifacts（映射到 `/MaiMBot/plugins/maibot-dsh-artifacts`）。上述当前 main 同时支持 manifest/request；旧 v0.2.0 仅支持前者。现有安装先备份私有账本与配置，不重新克隆覆盖用户目录。启用官方 `[capabilities] files = true` 并授权该插件 files.list/upload/download/send；插件配置 `[workspace] root = "/srv/maibot-agent"`，大小/数量限制与 DSH 一致。其账本仍由 Host 私有 `ctx.paths.data_dir` 管理。

保持现有 SSH 密钥、已确认主机密钥和反向 MCP 隧道。官方 MaiBot `[agent] connection="dsh"` 固定运行 ACP；自定义 profile/SSH 用 `connection="custom"`。下面摘自固定官方机制，主机名、用户名路径必须对应现有部署：

```toml
[agent]
enabled = true
connection = "custom"
acp_command = "ssh"
acp_args = [
  "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-R", "127.0.0.1:{mcp_port}:127.0.0.1:{mcp_port}",
  "fish@你的宿主机SSH地址", "/usr/bin/env", "DSH_HOME=/home/fish/.dsh",
  "/home/fish/dsh-runtime/node_modules/.bin/dsh", "--profile", "acp",
]
acp_remote_cwd = "/srv/maibot-agent"
mcp_port = 0
```

容器中的回环地址是容器自身，保留上述反向转发才可让宿主 DSH 访问 MaiBot 现有 MCP；不新开公网端口，不增加特权 HTTP 服务。SSH 不分配 TTY，启动脚本 stdout 只允许 ACP JSON-RPC；日志走 stderr。DSH 模型及凭据沿用其官方配置，插件不需要管理员 Token、root 或 Docker Socket。更多背景见 [MaiBot 官方连接说明](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/docs/agent-connections.md)。

## 实际交接与回执

1. DSH 工具：`maibot_artifact_prepare({"paths":["outbox/job/中文 结果.png"]})`。
2. 保留返回的随机 `manifest.task_id`，调用 `maibot_artifact_publish({"task_id":"该ID"})`。
3. 默认返回 `result: submitted`、`shared_request` 和准确的 `confirmation`。请求是 `outbox/.dsh-handoffs/<id>.json` 内的**原始 manifest v1**，无 chat/session/target/send 字段。复制返回的 confirmation，不凭路径自行猜哈希。
4. 操作员从独立 Agent WebUI/执行记录取得结果，在**原 QQ 聊天**明确要求调用实际返回的 `confirmation`。默认是 `dsh_import_handoff`，arguments 包含实际完整 manifest 和 `send:false`，兼容配套 main；不要复制示意哈希。

如果已审阅并部署配套 v0.2.1，可在 DSH 配置中显式设置 `confirmationMode: request`，此时才返回 `dsh_import_request(task_id, request_sha256)`。DSH 无法从 ACP 自动发现第三方插件版本，不会假装已探测。完整版本组合见 [兼容说明](docs/compatibility.md)。

5. 原聊天 Planner 必须真正调用已安装的 MaiBot 插件。只有实际结果 `registered: confirmed` 及每项真实 `file_ref`，并能在同聊天 `files_list` 中核对，才能确认入库。后续读取图片、下载或发送使用现有 MaiBot 工具；本流程不发送文件。
6. 回执丢失/重启：在同一原聊天调用 `dsh_handoff_status(task_id)`，原账本通过当前 Host 文件 scope 验证已登记引用；查询不重新上传。`unknown/unconfirmed` 不能解释为未执行，不自动重试或换 ID。

任务 ID/请求哈希只标识准确内容，**不是聊天授权或不可伪造的原聊天证明**；当前真实 Host scope 决定导入的聊天。没有权限时拒绝；不要把任意聊天作为“原聊天”。共享目录内容和文件文字不执行、不当指令。

| 本地结果 | 证据 |
| --- | --- |
| state=prepared | 清单已计算；已确认共享发布也保持此本地 state，是否提交须结合 result/submission，不能据此断言未提交 |
| submitted | 请求文件已持久提交；MaiBot 接收与入库仍 unconfirmed |
| prepared_only | 此次调用确定发生在共享 link 尝试前的失败；不表示旧调用从未发布。后续已有意图只读核对 |
| result=queued | 旧可信 Host 集成路径的 agent_talk 排队回执；不是入库；新 fixed 模式使用下述独立通知状态 |
| unknown | 共享发布或通知可能发生，缺少可靠完成证据；禁止自动重试或换 ID |
| needs_target | 旧的显式来源绑定无法匹配；不会猜目标或降级跨聊天通知 |

`maibot_artifact_local_status` 只读本地历史，不查看 MaiBot 文件库，不把共享回执 JSON 当证明。ACP 会话恢复保持同一 Agent ID 才能继续查询其记录；新会话不能冒充旧 Agent。MaiBot 端实际登记状态应在原聊天查询，特别是 SSH/ACP 超时、MaiBot 重启或本地账本丢失时。

新 fixed 模式另返回 `automatic_notification.state` 及 `stages`：publication、notification 与 registration 分开。`result: submitted` 可以同时有通知 queued、not_dispatched 或 unknown，`maibot_registration` 仍为 unconfirmed；不覆盖旧核心状态来制造导入成功。

## 提交恢复与历史诊断

0.2.1 已合并的恢复保护不改变 manifest v1。写共享请求前先持久化私有 `<id>.submission-intent`，保存真实 Agent owner、原 manifest 与准确字节哈希；只有首次成功创建该意图的调用可执行发布。link 尝试开始后的异常、发布完成后状态加载/保存异常均返回 unknown，不再错误返回“确定未提交”。

共享文件和目录 fsync 成功后，先保存私有 `<id>.submission-complete`，再更新主 `<id>.json`。主记录丢失/损坏时，完整且权限正确的 intent + complete 可只读恢复同一任务；不会覆盖损坏记录。只有意图但没有完成证据时，即使看见匹配文件也保持 unknown；只显示当前 matching/missing/conflict/unreadable 观察，不重新发布、不补写完成标记。旧版0.2.0已成功保存的、严格校验通过的 private submission 仍可作为既有完成证据；旧版 prepared 记录旁已有请求而无完成证据时保守冻结 unknown。

`.error` 文件保留首次诊断；较新的成功 submission/notification 不再被旧错误覆盖，工具结果把旧诊断放入 `historical_error`。任何不确定状态都使用原 task_id 只读核对，不能删 intent/complete、回滚账本或换 ID 来重做。原聊天的真实登记状态仍只能由 MaiBot 官方工具结果确认。

旧版0.2.0不识别新提交栅栏；有未知在途任务时，不能回滚后用旧版继续publish这些任务。保留全部证据，用本补丁只读核对，详见专用部署指南的回滚限制。

## 可选：自动带回单聊天的待确认请求（0.3.0）

**默认关闭。** 仅在该 DSH 部署专用于一个已授权聊天时启用。它自动带回待确认请求，减少从 WebUI 手抄 ID/SHA；固定配置只授权通知，**不取代配套插件要求的当前聊天用户导入确认**。它不是 ACP 原始来源识别：配置错目标、或让多个不互信聊天共用此授权范围，会把请求带到错误聊天。它不从模型参数、文件内容、manifest 或传话文字猜目标，也不因为文件中写了“已批准”而授权。

先取得真实目标：在 **MaiBot 实际创建、已挂载 `maibot-agent` MCP 的同一个 ACP Agent scope**，由部署者明确发起只读工具调用：

```json
{"tool":"mcp__maibot-agent__agent_chats","arguments":{}}
```

人工核对返回 `chats` 的 `session_id`、`name`、`platform`、`last_active`，确认是专用目的聊天，再复制真实 `session_id`。不要填 QQ 号、`private123qq` 一类自造串或自行计算 MD5；目标须已被 MaiBot `chat_manager` 加载。新建的独立 headless/global Agent 通常没有该会话 MCP，不能在那里冒充原连接查询。列表只证明聊天存在，不授权模型选最近聊天、自动挑目标或改配置。对应 [官方 schema](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/provider.py#L19) 和 [真实聊天解析](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L18)。

在实际 ACP profile 的受保护配置中完整设置，例如：

```yaml
- id: maibot-artifacts
  config:
    workspaceRoot: /srv/maibot-agent
    stateDir: /home/fish/.local/state/dsh-maibot-artifacts
    maxFileBytes: 52428800
    maxBatchFiles: 8
    notificationTimeoutMs: 30000
    confirmationMode: request
    autoNotify:
      mode: fixed
      target: "<人工核对后复制的真实 session_id>"
      toolName: mcp__maibot-agent__agent_talk
      acknowledgeSingleChat: true
```

此配置只适用于含新能力的 0.3.0 审核提交，`f008cdc…` 基线没有 autoNotify。`acknowledgeSingleChat: true` 是操作员对范围的明确声明，不是代码查证原聊天的证明。推荐配套 main `8018552…` 和 request 确认；旧版 peer 只能使用 manifest。删除 autoNotify 整段即保持默认关闭，不再为新任务启用通知。

新任务在 prepare 时绑定配置策略，publish 必须先可靠完成本地 submitted，再通过独立持久通知记录及官方 Native `ctx.tools.execute` 尝试一次 agent_talk。旧任务不会因后来启用配置而补绑；目标或策略变化不能把旧任务转发给新目标。重复、重启、超时、异常或不确定结果都不自动重发，保留原 task_id 和证据。

共享提交与通知是两份证据：**submitted + queued 仍不等于 imported**。通知请求 MaiBot 展示待导入内容，遵守配套策略，在当前聊天取得用户确认后实际调用导入工具。queued 只表示文本已排队；Planner 仍可能拒绝、漏调或失败，只有它在真实 Host 文件 scope 中调用配套导入、取得逐项真实 file_ref，才能确认入库。代码不能证明人类批准，纯无人确认自动入库仍未实现。本插件不会发送 QQ 文件，也不读取共享 JSON 充当入库回执。通知 `unknown` 时先核对原聊天，不能换 ID 重做；`not_dispatched` 时保留返回的手动 confirmation。PTC 官方拒绝内部 MCP root batch 时同样手动处理，不更换执行器、不关闭沙箱、不绕过 guard。

`notificationTimeoutMs` 是取消预算，不是强制终止远端调用的保证。超时按 unknown 处理，持久尝试栅栏保留，再等待官方 dispatch 收尾后工具才返回；迟到的排队回执不会改成成功。若工具提供者忽略取消，返回可能延迟，可从另一调用只读查询本地未知状态；不能据等待时间自动重发。

## Native / PTC / 扩展集成

标准 ACP profile 默认 **Native**。默认共享请求路径不需要调用远端工具，两种执行模式均使用同样的安全文件逻辑；但受限 PTC 必须有官方可用沙箱才能执行 `run_code`。已合并基线的历史CI曾完成受限工作流，不能当成本轮新通知模式的远端结果；本轮本地沙箱不可用时明确跳过并验证零副作用。实际生产主机仍须单独验收，没有放宽沙箱或绕过策略。

保留 `TrustedTargetBindings` / `maibotArtifactTarget` 供已有可信 Host 集成使用，仓库不声称标准 ACP 提供该服务。该扩展要求 prepare/publish 的真实 Agent、rootCallId 绑定及同一 originId/target/toolName；Native 经官方 execute 保留 guard/toolSet。PTC 会拒绝插件内部原生 MCP root batch。普通用户使用默认两插件确认路径，不需要安装或编写此扩展。

文件读取仍逐级 `O_NOFOLLOW` / FD 锚定，拒绝软硬链接、越界、特殊文件；哈希期间变化和提交前变化会拒绝。请求限 64 KiB、精确字段、原子不覆盖发布。单次远端通知栅栏和两端去重保留。文件检查不是不可变快照；共享根祖先、挂载和同 UID 进程须可信，最终入库仍由对端私有快照复验。保留私有状态和 Host data，不支持靠删账本重做。

## 当前架构限制

固定版本结论未变：ACP 未保留可验证的原聊天来源；DSH 的官方工具 API 虽能在 Native 调用 agent_talk，但缺少原目标授权，不能据模型文字提交可信的自动导入请求；MaiBot 插件在非 Host 工具派发上下文中不能合法获得文件库权限。

跨聊天、绑定真实原始任务且确定性执行的全自动交接，仍需上游提供任务级回复/导入授权、ACP 对可信上下文的保留，以及 Host 在合法文件 scope 内派发指定导入工具的契约。固定 sink 是明确的单聊天部署授权，不替代原始来源证明；它能够自动请求 Planner，但不能保证 Planner 执行。增加普通聊天 ID、解析提示词或透传未认证 _meta 均不足。本轮不修改两端上游源码。

## 开发、验收与排错

```sh
npm ci --ignore-scripts
npm run build
npm run check
npm run test:version
npm run test:acp:clean
npm run test:acp -- --fixed-notification
node scripts/test-legacy-peer.mjs /path/to/peer-main ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8
node scripts/test-handoff.mjs /path/to/maibot-dsh-artifacts 8018552bc82ee5fada38f6792a1721410adf5bc8
```

类型、lint、单元、预构建一致性、包安装、普通 profile 和真实 ACP 检查都纳入 CI。跨语言测试执行实际对端 `request.py` + `Handoff`，只对 Files API 使用明确标注的模拟。两仓版本与评审结论见 [兼容说明](docs/compatibility.md)，配套变更需求仅列 [跨仓待办](docs/cross-repo-todos.md)。真实部署的可执行生成器和逐步验收见 [生产验收清单](docs/production-acceptance.md)。不要将 mock 成功当作 Host/QQ 验收。

| 问题 | 排查 |
| --- | --- |
| ACP 启动无响应/工具不在列表 | 核对 SSH 实际命令、用户、DSH_HOME 和 profile；查看 dump-config；重新连接旧进程 |
| 版本不匹配 | engines.dsh 精确匹配；官方错误列出运行版本/要求版本，装指定 alpha 及匹配 peers |
| permission_denied/unsafe_state_permissions | stateDir 属于 fish 且 0700；共享真实目录/文件按共享组配置，实际 Runner 也有权限 |
| not_found/unsafe_file/source_changed | 原文件被删除、链接/替换或仍在写入；停止并核查，不能当作已提交 |
| request_hash_mismatch/request_conflict | 请求字节变化或冲突；不覆盖旧请求，不用新 ID 自动重做 |
| 只有 submitted，原聊天没文件 | 正常地尚未确认；ACP 文本不自动回 QQ，必须真正调用配套确认工具 |
| queued/unknown 后无回执 | 原聊天查询账本/file_ref；禁止盲目重发或整批重导 |
| fixed 通知超时后工具仍在等待 | 取消不等于远端强杀；等待官方调用收尾，另一调用可只读查通知unknown，不补发 |
| sandbox-unavailable | 受限 PTC 未启动；按官方沙箱要求修复主机，不改成无沙箱模式 |

MIT 许可。未自动合并 PR 或发布 Release。
