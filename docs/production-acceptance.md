# 生产部署人工验收

本清单用于真实 Linux `fish` 用户 + Docker MaiBot 1.3.18 + SSH DSH；本仓库的 CI **没有**运行你的 MaiBot/QQ。命令中的宿主机地址、实际 Runner 路径和共享组 GID 需要对应现有部署。两端固定提交须核对并审阅后部署，不自动合并或发布。

## 1. 安装与权限

复用已有`/home/fish/dsh-runtime/node_modules/.bin/dsh`并记录准确版本；本轮0.3.1候选目标为0.2.1-rc.2/rc.3/rc.4/rc.5及0.2.2-alpha.2，各版Native三模式已通过，PTC本地受官方沙箱阻塞；完整远端矩阵结果见兼容说明，统一Node≥24.9.0（当前执行环境24.19.0）。未来范围准入不代表已测，不关闭检查或为旧0.3.0的alpha精确声明重装runtime。当前main028f354已合并0.3.0通知，本轮新范围须固定0.3.1审核提交。peer推荐已合并0.2.1 `8018552bc82ee5fada38f6792a1721410adf5bc8`；manifest/request及通知语义不变。真实现场仍为Ubuntu24/fish/core/maim-bot-core与既有`/MaiMBot/plugins`挂载。

DSH 安装到 SSH 实际使用的 `acp` profile，或显式从 `acp` 模板创建的新 profile。检查实际用户运行的命令：

```fish
id
set DSH /home/fish/dsh-runtime/node_modules/.bin/dsh
$DSH --version
# 下列 DSH_HOME/profile 须替换为已核实的 SSH 实际值：
env DSH_HOME=/home/fish/.dsh $DSH --profile acp --dump-config
```

合成配置应含ACP bundle和本插件；不能只检验base-only profile。须由真正ACP客户端观察工具调用更新及Agent可见工具并代表性调用，不能把MaiBot MCP tools/list当第三方插件发现API。安装后在现有Agent管理入口重连实际ACP进程，保留在途/unknown，不自动重放。

在宿主及实际 Runner 环境检查共享路径 `/srv/maibot-agent` 都是同一挂载、无软链接，DSH 能写 outbox，Runner 能读产物与请求文件。不要将 MaiBot 私有 data 或 DSH state 挂到共享目录。容器非 root Runner 的补充组必须真正生效，不能仅在宿主机 `id fish` 中看见。

配置状态目录省略即可用 fish 用户默认值。若显式配置 `/home/fish/.local/state/dsh-maibot-artifacts`，确认 fish 的真实 home 与此相符。首个 prepare 后检查目录 0700、记录 0600；宽权限或不属 fish 的旧目录应先由管理员核查，插件不会静默改权限。

## 2. 生成真正可核对的文件

在本仓库审核后的 checkout、已经存在共享 outbox 的宿主机上，以 fish 用户运行：

```fish
umask 0027
node scripts/manual-fixtures.mjs /srv/maibot-agent
```

脚本创建不覆盖旧文件的随机验收目录，包含中文/空格文件名、正确编码的 1×1 PNG、空文件，并输出每个文件的 size/SHA-256 与 prepare 参数。它只生成文件，**不会调用 MaiBot，也不会宣称任何文件已入库**。

## 3. 真正的 ACP 调用与明确确认

1. 在原 QQ 测试聊天让 MaiBot 通过现有 Agent 连接交给 DSH 任务，使用上步路径实际调用 `maibot_artifact_prepare`，然后用其真实 task_id 调用 `maibot_artifact_publish`。
2. 在独立 Agent WebUI/执行记录中保存这两次真实工具结果。正常默认结果为 `prepared` → `submitted`，带 `shared_request` 和 `confirmation`；不能只有模型口头说“已提交”。
3. **成功 ACP 文本不会自动返回原 QQ 聊天。** 默认手动模式由操作员将准确的 confirmation JSON 复制到原聊天，明确要求核对并调用其中的实际工具，不发送 QQ 文件。默认是 dsh_import_handoff；request 配置才是 dsh_import_request。不要从提示词猜 session_id，也不要将 JSON 发到其他聊天作为授权。显式 fixed 模式按下方单独流程记录通知。
4. 检查 MaiBot 真正执行的是配套插件工具，而非把 JSON 当作回复文字。保存原工具回执：`tool_called`、`registered`、每项 status、真实 file_ref、size、sha256。需要全部成功时每项都须有匹配的真实 file_ref，registered 为 confirmed。
5. 在**同一聊天**用现有 `files_list` 核对相同引用、名称、大小/哈希。再由 MaiBot 的既有图片/下载工具使用 PNG 的 file_ref，验证图片可读取。图生图依赖已部署的相关工具能力；本插件只提供文件库引用，不伪称下游模型已处理。
6. 本验收默认不发送 QQ 文件。如需验证发送，另行由该聊天用户明确授权，使用 MaiBot 原有发送工具，单独检查发送回执；入库不等于发送。

请求 id/SHA 仅确认内容，原聊天归属来自操作员的明确确认和 Host 当前真实工具 scope；本插件不能密码学证明操作员选对了最初聊天。这是当前官方接口下的受控降级，不是完全自动路由。

### 可选 fixed 自动通知验收

只在专用单聊天部署启用README固定通知配置，默认关闭的普通流程先验收。本轮0.3.1延续该策略，五版runtime各自记录准入和分派结果。操作员在已有MaiBot创建的ACP Agent scope明确调用`mcp__maibot-agent__agent_chats({})`，人工核对真实session_id/name/platform后配置；不在新global/headless Agent猜目标，不使用QQ号或自造ID。

1. 以新任务 prepare，保存策略绑定证据；publish先有可靠submitted，再记录独立通知。只有匹配真实目标的正式队列回执才记queued，不能改共享状态为imported。
2. 核查指定聊天实际看到待确认请求，展示产物及确认参数。固定配置只授权通知；须遵守配套策略取得当前聊天用户确认后，Planner才选择实际导入。模型漏调不能写成成功。
3. 缺少显式授权、旧任务、配置变更或错误Agent/MCPscope都不自动通知。重复publish和进程重启不重发；超时或回执不确定保留unknown。
4. 通过当前runtime公开工具/guard/执行模式管线执行，逐版记录结果。源码上RC.2–RC.5 single-call execute可转发真实token/parent/rootCallId作合法PTC嵌套；alpha.2 batch无公开parent，PTC保持未派发。它们的配置入口不同，见API兼容审计。实际矩阵未跑前不标通过；拒绝保留手动confirmation，不关闭沙箱、伪造parent、换私有管线或绕过guard。
5. 只有真实配套工具返回file_ref并在同聊天files_list核验，才能勾选入库项；文件QQ发送仍为另行显式授权的独立验收。

这些项目在本环境没有连接真实MaiBot/QQ，全部保持Pending。它减少WebUI手抄ID/SHA，不是无人确认的确定性自动入库。

## 4. 幂等、回执丢失与重启

- 在 DSH 重复 publish，返回同一请求、task_id、SHA，不能创建新任务或多次 agent_talk。
- 在原聊天重复 `dsh_import_request`，应复用原账本结果；files_list 的原引用仍相同，不新增文件、不发送。
- 保存成功回执后当作“客户端未收到”处理，只调用原聊天 `dsh_handoff_status(task_id)`。状态查询须验证当前文件权限并返回原 file_ref；不能补上传。
- 正常停止/启动 MaiBot，保留完整 Host data（含插件账本与哨兵），在原聊天重新查询；引用应保持。DSH 重启须保留完整 state。ACP 恢复为同一 Agent 时可读原本地记录，新 Agent 不冒充旧 Agent；实际入库恢复以原聊天查询为准。
- 状态为 unknown/unconfirmed、账本损坏/丢失、远端调用超时或 SSH 中断时，停止自动重试。先保留日志并核查原聊天副作用，不能换 ID 整批重导。对确定上传前失败的项，也只在人工决定后处理最小必要范围。

## 5. 隔离异常验收

只在独立测试任务/聊天中执行，保留成功产物和真实账本：

| 场景 | 预期 |
| --- | --- |
| prepare 的绝对路径、`..`、outbox 外路径 | 工具拒绝，无提交请求 |
| 软链接、硬链接、FIFO、目录 | 拒绝，不读取为普通产物 |
| 生成过程中并发写入/替换；prepare 后修改或删除 | 哈希或提交复验失败；不得说 submitted/imported |
| publish 后修改产物再确认 | 对端私有快照 size/SHA 不匹配；不得登记错误字节 |
| 修改请求文件原始字节 | request_sha256 不匹配，零上传；不覆盖旧请求 |
| 超过已配置大小/批量 | DSH 或对端限量拒绝；两端按各自较低限制执行 |
| 省略确认 SHA、附带 target/chat/session/send | 请求确认无任意路由/发送参数，不授予其他聊天权限 |
| 其他聊天查询已导入任务 | 不泄露原引用/不重复上传；不能用管理员 API 补足 |
| 无 Host 文件 scope 的后台调用 | 不上传，不假造 scope |
| ACP/SSH 超时、回执丢失、异常重启 | unknown/unconfirmed 保留，查询不重试 |

真实超时/断线有不可回滚副作用，只能在隔离测试实例中故障注入，不能拿生产用户批次做试验。CI 的模拟超时测试不能代替这项真实验收。

## 6. 验收记录

记录两端版本/提交、实际 SSH 命令、profile、真实 Runner UID/GID、请求 task_id/SHA、原工具结果、file_ref 与 files_list 截图/结构化输出、重启后查询结果。不要保存管理员 Token、私密传输 URL 或原聊天敏感内容到公开仓库。

历史基线代码与隔离链路有既有验证；本轮0.3.1五版矩阵和本机真实Host/QQ分开记录，未执行项保持Pending，不能拿134项历史基线充当新结果。未来版本即使范围准入也未获认证。完整自动流程仍需可信ACP来源与Host授权派发契约，详见接口审计。

现场逐项结果表见 [Ubuntu24 / core 指南第6节](deploy-ubuntu24-core.md#6-十项现场验收记录)。当前第5–8项全部Pending，不能用CI或模拟file_ref填成通过。
