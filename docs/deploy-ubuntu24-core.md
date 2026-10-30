# Ubuntu 24：在现有 core 部署中安装两端插件

适用现场：宿主机用户 `fish`，已有 DSH 可执行文件 `/home/fish/dsh-runtime/node_modules/.bin/dsh`；MaiBot Compose 服务 `core`、容器 `maim-bot-core`；现有插件挂载 `./data/MaiMBot/plugins:/MaiMBot/plugins`；共享目录 `/srv/maibot-agent`。

**本文所有命令均为待操作员核对的示例，没有在你的生产机器执行。** 先复用已有运行时和 SSH 连接，不重新全局安装 DSH，不改 core 镜像、服务名或既有卷。本文不要求 Docker Socket 挂给插件、privileged、管理员 Token、新 HTTP 服务或 chmod 777。执行 Docker 检查需使用你已有的运维访问方式，插件自身不取得这些权限。

## 1. 只读确认现场

以下代码按 fish shell 编写；用户名 `fish` 本身不能证明当前 shell 类型。先确认：

```fish
id
id fish
getent passwd fish
set DSH /home/fish/dsh-runtime/node_modules/.bin/dsh
$DSH --version
command -s node
node --version
command -s pnpm
pnpm --version
head -n 1 $DSH
```

本包要求官方 DSH **0.2.2-alpha.2**、Node.js ≥24。若现有版本不符，先停下并审阅版本迁移；不要覆盖已有 `/home/fish/dsh-runtime`，也不要通过禁用版本检查继续。即使 DSH 路径固定，其 `env node` shebang 和插件管理用到的 pnpm 仍依赖实际非交互 PATH；`command -s` 的结果应一并记录。

在**实际现有 Compose 项目目录**执行，不另建一套项目：

```fish
pwd
docker compose version
docker compose config --services
docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' maim-bot-core
docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' maim-bot-core
docker inspect --format '{{ .Config.Image }}' maim-bot-core
docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination "RW=" .RW}}{{end}}' maim-bot-core
docker inspect --format '{{json .HostConfig.GroupAdd}}' maim-bot-core
docker inspect --format '{{ .Config.User }}' maim-bot-core
```

应确认服务确实是 `core`，原插件挂载的目标为 `/MaiMBot/plugins`，并记录其**实际宿主 Source**。Compose 相对路径以其项目配置为准，不能从当前 shell 工作目录猜测。不要把完整 `docker inspect`、`docker compose config` 或进程环境输出贴入公开记录；其中可能包含凭据。上面只查询部署必需字段。

### 找到真正的 Runner 身份

```fish
docker exec maim-bot-core id
docker top maim-bot-core -eo pid,ppid,user,group,comm
docker exec maim-bot-core ps -eo pid,ppid,uid,gid,comm
```

第一个 `id` 只说明 docker exec 的默认身份，`.Config.User` 也只是容器默认值；**都不证明插件 Runner 的身份**。根据现有 Host 的插件运行诊断、进程树及 Runner 启动记录确定容器命名空间内的真实 Runner PID。不要把宿主 `docker top` 的 PID 直接用作容器内 PID，也不要猜 PID 1。

取得真实 PID 后再检查（先把示例值换成诊断所得数字）：

```fish
set RUNNER_PID 实际容器内RunnerPID
docker exec maim-bot-core awk '/^(Name|Pid|PPid|Uid|Gid|Groups):/' "/proc/$RUNNER_PID/status"
docker exec maim-bot-core readlink "/proc/$RUNNER_PID/cwd"
```

记录实际 UID、主 GID、补充 Groups。若容器没有 ps/awk，使用现有 Host/Runner 诊断取得相同证据；不要为了显示进程而修改镜像或安装工具。Runner 还有独立挂载/沙箱时，须继续验证其实际视图；仅 docker exec 能看见文件不算 Runner 已获权限。

## 2. 对齐既有 SSH、DSH_HOME 和 profile

在现有 MaiBot 官方配置界面或你持有的配置中，**只核对** `connection`、`acp_command`、`acp_args`、`acp_remote_cwd` 和相关非秘密运行路径。保留原 SSH 用户、地址、已确认主机密钥、`-T`、`ExitOnForwardFailure` 和反向 MCP 转发，不复制 Token 到本文或仓库。

必须得到三项实际值：SSH 运行用户为 fish；真正的 DSH_HOME；真正启动的 profile。`DSH_HOME` 未设置时默认 fish 实际 home 下的 `.dsh`（例如 `/home/fish/.dsh`），已有显式值优先。不要只把插件安装到一个没有被 SSH 启动的 profile。

以核实后的值检查；下面的 `/home/fish/.dsh` 与 `acp` 是**示例**，若现场不同须替换：

```fish
set DSH_HOME_ACTUAL /home/fish/.dsh
set ACP_PROFILE acp
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile $ACP_PROFILE --dump-config
```

SSH 非交互 shell 不保证读取交互 fish 配置或 fish_add_path。可在运维已确认的原 SSH 命令中以 `-T` 执行一次绝对 `/usr/bin/env` 检查 `node --version`、`pnpm --version` 和该 DSH 的 `--version`；PATH 只填上一步实际查到、已审核的可执行目录。不要依赖登录终端中碰巧生效的 PATH。未来启动命令的形式应为：

```text
/usr/bin/env DSH_HOME=<实际路径> PATH=<审核后的非交互PATH> /home/fish/dsh-runtime/node_modules/.bin/dsh --profile <实际profile>
```

这段是参数结构示意，不是可直接粘贴的 shell 命令。保留原有 `-R 127.0.0.1:{mcp_port}:127.0.0.1:{mcp_port}`；容器回环和宿主回环不同，不能删隧道或将 MCP 改为公网监听。ACP stdout 只允许协议 JSON，诊断走 stderr。

已有内置 `acp` profile 包含 base + acp-app。给任意新名字单独 plugin add 只创建 base-only profile。只有确定需要**尚不存在的**新 profile 时，才先执行 `--from-default-profile acp --help` 初始化；该选项会替换目标 profile，禁止对现有现场配置照抄执行。

## 3. 共享挂载与最小权限

先只读检查宿主和容器：

```fish
namei -l /srv/maibot-agent/outbox
stat -c '%u:%g %a %n' /srv/maibot-agent /srv/maibot-agent/outbox /srv/maibot-agent/inbox
docker exec maim-bot-core stat -c '%u:%g %a %n' /srv/maibot-agent /srv/maibot-agent/outbox /srv/maibot-agent/inbox
```

共享目录必须是真实挂载、无软链接；两个环境应读取同一测试文件得到相同 size/SHA。DSH fish 需要写 outbox，真实 Runner 需要遍历目录、读取请求和产物。使用现场专用共享组的**数字 GID**，验证它已在真正 Runner 的 Groups 中；宿主 `id fish` 含该组或 Compose 写了 group_add 均不能替代实际 Runner 证据。

若共享根尚未预置，由现有运维按部署策略一次性配置专用目录和组；不要递归 chown/chmod 已有数据。新目录可采用共享组、setgid 与 2770，产物生成器采用 `umask 0027`、文件组可读；本插件新请求目录 0750、请求文件 0640。私有 state 使用 fish 默认的 `$XDG_STATE_HOME/dsh-maibot-artifacts`（有效绝对值）或 `/home/fish/.local/state/dsh-maibot-artifacts`，不放共享根，不挂进 core，不创建 root 拥有的 `/srv` 私有 state。

若缺少共享挂载，只在既有 core 定义中合并最小增量；**不要用下面片段替换整个 Compose 文件**：

```yaml
services:
  core:
    # 保留已有 image/build、user、environment、ports、depends_on 和全部卷。
    # group_add 仅在真实 Runner 缺少现有共享组时追加该数字 GID。
    group_add:
      - "实际专用共享组数字GID"
    volumes:
      - ./data/MaiMBot/plugins:/MaiMBot/plugins  # 原有项：保留且不要重复添加
      - /srv/maibot-agent:/srv/maibot-agent    # 仅在原配置尚无此项时增加
```

容器主进程已有补充组不代表 Runner 启动后仍保留，必须重查 Runner。不得更改 core 用户为 root、添加 privileged 或 Docker Socket 来解决读权限。

## 4. 固定提交，先备份再安装

两个插件的发布状态须分开：

| 仓库 | 已知固定点 | 状态 / 用途 |
| --- | --- | --- |
| dsh-maibot-artifacts 已合并基线 | [`f008cdc039122d360dee67b86e1e2004083ba019`](https://github.com/MemoryController/dsh-maibot-artifacts/commit/f008cdc039122d360dee67b86e1e2004083ba019) | 0.2.1，已合并提交恢复和默认 manifest；不含新 autoNotify |
| dsh-maibot-artifacts 本轮候选 | 0.3.0 / [`12a9e7cd36464acce554ccdf243ee76cb51d1eed`](https://github.com/MemoryController/dsh-maibot-artifacts/commit/12a9e7cd36464acce554ccdf243ee76cb51d1eed) | 新增显式单聊天通知，默认关闭；未发布 Release |
| maibot-dsh-artifacts 当前 main | [`8018552bc82ee5fada38f6792a1721410adf5bc8`](https://github.com/MemoryController/maibot-dsh-artifacts/commit/8018552bc82ee5fada38f6792a1721410adf5bc8) | v0.2.1，[PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 已合并；manifest/request 均可用，包版本不代表 Release |
| maibot-dsh-artifacts 旧协议 | `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8` | v0.2.0 manifest v1 基准；无请求工具，可继续默认 manifest 手动确认 |

本轮只维护 DSH 仓库；配套插件如需后续代码修正，记录在跨仓 TODO / 原 PR 中另行审查，不在此操作它的 API 或源码。

安装前按现有部署备份方式保存：DSH 实际 profile 的 package.json、锁文件、用户 patch 与版本记录；已安装配套插件的完整目录和现场配置；Host 持久 data（含插件私有账本、哨兵）；DSH 私有 state。备份置于各自私有位置，不放 outbox、不提交公开仓库。先停住新任务，保留在途/unknown 记录；需要一致性备份时按现有维护流程停止相应进程。代码回滚不得回滚账本来制造“从未执行”的假象。

### DSH 端：复用已有 runtime

在 fish 的已核实 DSH_HOME/profile 中安装审阅的固定源码提交（预构建 dist 已包含，不运行安装脚本）：

```fish
set DSH_COMMIT 12a9e7cd36464acce554ccdf243ee76cb51d1eed
env DSH_HOME=$DSH_HOME_ACTUAL $DSH plugin --profile $ACP_PROFILE add "github:MemoryController/dsh-maibot-artifacts#$DSH_COMMIT" --ignore-scripts
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile $ACP_PROFILE --dump-config
```

上述 SHA 是本轮0.3.0实现候选，含默认关闭的 autoNotify，尚未合并或发布Release；先审查再部署。0.2.1手动流程基线仍为f008cdc，不含新模式。确认组合中有 `@deepseek-ai/dsh-acp`、`dsh-maibot-artifacts`，共享根为 `/srv/maibot-agent`，私有 stateDir 可省略。当前配套 main 0.2.1 同时支持 manifest/request；旧0.2.0保留默认manifest。不要通过 root 安装新的 DSH 副本，也不要为了 pnpm 的通用 Git build 警告授权脚本。若版本不匹配，先审阅兼容运行时迁移，不关闭 engines 检查。

### MaiBot 端：使用现有插件挂载

目标只能是经 Mounts 核实的宿主插件目录下的 `maibot-dsh-artifacts`；它已通过原挂载映射到 `/MaiMBot/plugins/maibot-dsh-artifacts`。**不新增单插件到 `/app/...` 的替代卷。** 首次安装可在非挂载的临时 staging 中 clone 并 checkout 上表完整配套 SHA，检查 git HEAD 与完整目录后，按 Host 现有插件安装流程将整个插件目录放入原插件根。升级先保留现场配置及 Host data，不在已有插件目录执行 reset/clean 或盲目覆盖。

确认真实 Runner 使用官方 SDK 2.19.0、MaiBot 1.3.18，并通过既有插件管理方式加载该固定版本；不得在宿主机 pip 安装后假定容器 Runner 已有依赖。配套插件 `[workspace] root` 为 `/srv/maibot-agent`，限额与 DSH 一致；文件能力与插件授权使用现有官方 Host 配置，不伪造 scope。默认不发送 QQ 文件。

该步骤是配套部署操作说明，不代表本文已安装或修改了你的配套插件。PR #2 已合并，推荐固定8018552，而非初审27d6。未部署0.2.1时继续使用已有 dsh_import_handoff(manifest,send:false)，不能调用缺失请求工具。

### 可选单聊天通知：减少 WebUI 手工抄参

此项需要0.3.0审核提交，默认关闭。只在该 DSH 部署专用于一个授权聊天时，按 README 的完整 `autoNotify` 配置显式启用 `mode: fixed`、准确 target/toolName 和 `acknowledgeSingleChat: true`；推荐 `confirmationMode: request` 与当前 peer main8018552。固定配置只授权通知待确认请求，不代替用户导入确认，不证明当前任务来自该聊天。

目标从已有 MaiBot ACP Agent 的 `mcp__maibot-agent__agent_chats({})` 只读调用取得，由操作员逐项核对 name/platform/session_id；目标必须是已经加载的真实聊天。不要填 QQ 号、自造 ID 或计算 MD5，不让模型自动选最近聊天。新 headless/global Agent 没有同一会话 MCP 时不能在那里查询。完整操作及官方依据见 README 的自动通知段。

先在隔离聊天生成**新任务**：prepare 绑定配置策略，publish 先持久 submitted，再发一次文本待确认请求。旧任务不会补绑，改目标不会转发旧任务，重复或 unknown 不补发。Native 经官方执行器与 guard；PTC 拒绝时返回未派发，保留手动 confirmation，不改执行器或沙箱。看到 queued 后仍需该聊天展示请求、用户确认、Planner 实际工具调用及真实 file_ref，不能把队列回执记作入库。

## 5. 重载、升级与回滚

先暂停新任务并核查 unknown，在 MaiBot 现有 Agent 管理入口断开旧 ACP 连接，保留 state/data。插件 source 更新本身不改变已加载模块。使用已有 Host 插件重载/重启流程；若现场以容器重启生效，确认当前项目与服务后仅重启 core：

```fish
docker compose restart core
```

仅在增加了挂载/group_add 等 Compose 配置时，restart 不会应用这些变化；维护窗口中审阅实际 diff 后，可使用现有 Compose v2 支持的 `docker compose up -d --no-deps --no-build --pull never core` 重建该服务。保留原镜像和所有卷，不 down -v、不删除 data、不更新其他服务。重启后重新读取实际 Runner 身份和挂载，再通过原入口重连 ACP；不要盲目重发上个任务。

升级 DSH 插件：以新审阅完整 SHA 重复同一 profile 的 plugin add，比较 dump-config，然后重连旧 ACP 进程；不要重跑 profile 初始化。升级配套插件：按同一 staging / 备份 / Host 重载流程更换完整固定版本，跨仓代码修改仍单独审查。

回滚 DSH 插件：用记录的前一完整 SHA 执行同一 plugin add，必要时仅恢复已审查的 profile 配置/锁；回滚配套插件：按原 Host 部署流程恢复前一完整代码目录及兼容配置，再重载。**两端私有账本和已发布请求保持当前内容**，不要用旧快照覆盖新状态；旧代码无法读取新记录时停止回滚并保留证据。回到配套 v0.2.0 将失去 dsh_import_request，须明确退回人工 manifest 流程，不能把功能缺失伪称成功。

DSH 0.2.0 不识别本补丁新增的 submission-intent / submission-complete 防重发证据。存在未知或未完成提交时，**不能把这些历史任务交给0.2.0继续publish**；它可能忽略新栅栏。先保留新版本做只读核对并在原聊天确认副作用，不能为了回滚删除标记、恢复旧账本或换task_id。仅代码回滚不等于旧版本能安全恢复新版本的在途状态；未解决的任务保持隔离，暂停处理。

## 6. 十项现场验收记录

以下状态均针对**你的现场**；CI / scoped double 的成功不是现场通过。测试素材可用 [生产验收清单](production-acceptance.md) 中的生成器；真实执行前选择隔离 QQ 测试聊天，保留返回原文，不保存凭据。

本表以显式 `confirmationMode: request` 和已合并配套0.2.1 `8018552…` 为例。手动 manifest 流程也可单独验收，须记录实际调用的工具。启用新 fixed 通知时，第4项另记录独立通知结果；通知排队不替代第5–8项。

| # | 验收项与最低证据 | 现场结果 | 日期/操作者/证据位置 |
| --- | --- | --- | --- |
| 1 | 实际 SSH/DSH_HOME/profile 下 ACP 会话加载本插件，真实三个工具可见并可调用 | Pending | — |
| 2 | DSH 生成中文名 PNG，实际可解码，记录大小和 SHA | Pending | — |
| 3 | prepare 实际返回严格 manifest v1，32位 task_id、每项路径/大小/64位SHA正确 | Pending | — |
| 4 | publish 实际返回 submitted 和准确 confirmation；不把 unknown 当未提交 | Pending | — |
| **5** | **原 QQ 测试聊天明确确认，Host 真正派发 dsh_import_request** | **Pending：真实 Host/QQ 未验收** | — |
| **6** | **MaiBot 真正返回逐项 file_ref 及 registered:confirmed** | **Pending：真实 Host/QQ 未验收** | — |
| **7** | **同一聊天 files_list 能查到该引用、名称和大小/哈希** | **Pending：真实 Host/QQ 未验收** | — |
| **8** | **原有图片工具实际使用该 file_ref，能够读取图片** | **Pending：真实 Host/QQ 未验收** | — |
| 9 | 同聊天重复确认引用不变、不新增上传；不发送 QQ 文件 | Pending | — |
| 10 | 隔离实例中 SSH 断线、成功回执丢失、服务重启后只读查询，不误判/补传/盲重试 | Pending | — |

第 5–8 项在取得真实证据前必须保持 Pending。默认模式仍由操作员带回准确 confirmation；显式 fixed 模式可自动请求指定聊天展示并确认，但这不是原始来源证明，也不保证 Planner 入库。另记录：缺授权零通知、改目标或旧任务零补绑、重复/重启零重发、Native 排队、PTC 拒绝及手动兜底。task_id/SHA不签发聊天权限。unknown/unconfirmed 停止自动重试，保留日志并在原聊天核对真实工具回执与 file_ref。

背景依据：[官方接口审计](upstream-audit.md)、[实际验证记录](validation.md)、[MaiBot 官方 ACP/SSH 连接说明](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/docs/agent-connections.md)。
