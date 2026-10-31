# 两端版本与兼容范围

本轮候选为 **dsh-maibot-artifacts 0.3.1**，适配多版官方runtime。当前main [`028f35476a216f2b89ea5333fa444e709ae19ccc`](https://github.com/MemoryController/dsh-maibot-artifacts/commit/028f35476a216f2b89ea5333fa444e709ae19ccc) 已合并PR #3、包版本0.3.0，仅声明精确runtime0.2.2-alpha.2；不能把旧提交当成本轮新准入范围。配套已验证固定基准为0.2.1 [`8018552…`](https://github.com/MemoryController/maibot-dsh-artifacts/tree/8018552bc82ee5fada38f6792a1721410adf5bc8)，其PR #2已合并。包版本、main合并与Release分开记录，本轮不自动发布。

## Runtime准入、元数据和验证分层

插件统一要求Linux及Node.js **≥24.9.0**，当前执行环境为24.19.0。五版本地矩阵已执行：Native的manifest/request/fixed实际ACP均PASS；**必需PTC三模式均因sandbox-unavailable而BLOCKED，各版整体仍为BLOCKED，不能称完整矩阵通过**。远端强制PTC结果另行记录。

| 官方runtime | 其Cordis要求 | 其Schemastery要求 | CLI自己的Node字段 | 本轮实际矩阵 |
| --- | --- | --- | --- | --- |
| 0.2.1-rc.2 | ~4.0.5 | ~3.18.5 | 未声明 | Native三模式PASS；PTC三模式BLOCKED；整体BLOCKED |
| 0.2.1-rc.3 | ~4.0.5 | ~3.18.5 | 未声明 | Native三模式PASS；PTC三模式BLOCKED；整体BLOCKED |
| 0.2.1-rc.4 | ~4.0.5 | ~3.18.5 | 未声明 | Native三模式PASS；PTC三模式BLOCKED；整体BLOCKED |
| 0.2.1-rc.5 | ~4.0.5 | ~3.18.5 | 未声明 | Native三模式PASS；PTC三模式BLOCKED；整体BLOCKED |
| 0.2.2-alpha.2 | ~4.0.6-alpha.1 | ~3.18.6-alpha.1 | ≥24.9.0 | Native三模式PASS；PTC三模式BLOCKED；整体BLOCKED |

### 本地十类检查及证据边界

每版记录在本轮生成的`compat-<version>.json`；每个Native确认模式都创建并关闭4个实际ACP会话。每版安全/生命周期runner为15项PASS、1项不适用NOT TESTED：RC不适用alpha step-admission，alpha不适用RC公开parent检查，不能把这项写成通过。下表分类不另行增加测试数量。

| 检查类 | 本地结果 | 使用的真实接口与double边界 |
| --- | --- | --- |
| 1. 发布包、安装/profile与三个工具注册 | 五版PASS | 精确npm host、官方CLI/Cordis与profile，非生产现场安装 |
| 2. manifest/request/fixed代表性工具流程 | 五版Native均PASS | 实际ACP/Agent loop；模型与MCP对端为fixture，fixed只得queued证据 |
| 3. ACP创建、使用及关闭 | 各Native模式4/4关闭，PASS | 实际官方ACP session生命周期 |
| 4. MCP错误传播 | 五版Native各模式PASS | 真实ACP/MCP传输到模拟对端，非MaiBot服务 |
| 5. 两会话并发及交叠 | 五版Native各模式PASS | 实际2个ACP会话、2次交叠MCP调用 |
| 6. 取消传播及清理 | 五版Native各模式PASS | 实际ACP取消、模拟远端观察取消，资源清理断言 |
| 7. 所有权、scope、guard及模式准入 | 五版公开运行时检查PASS | 真实Cordis/Tools API，Agent scope为doubles；不是签发真实MaiBot scope |
| 8. 错误身份、超时unknown、不重试及drain | 五版公开运行时检查PASS | 模拟回调注入故障，实际官方运行时与通知账本 |
| 9. 工具卸载、事件effect与进程清理 | 五版公开运行时检查PASS | Cordis生命周期及CLI子进程；安全runner不是实际ACP Agent |
| 10. 不兼容引擎拒绝 | 五版PASS | 实际官方CLI错误退出与要求/运行版本诊断 |

本地必需PTC的manifest/request/fixed均在运行产物工具前BLOCKED，实际artifactToolCalls、agentTalkCalls、mcpCalls均0。它不与运行时double中的合法parent检查混同，也不能用Native或历史0.3.0 CI代替；因此总体不提升为PASS。根套件另为**138项单元通过、0失败/跳过**，build/类型/lint、20个dist一致性、独立安装/profile、错误版本和固定peer12项交接通过。

四版RC没有CLI `engines.node` 字段，不等于其依赖或本插件认证更低Node；不据此声明Node22或24.0可用。已核查的npm包未提供gitHead，官方tag ref不是npm声明的gitHead；实际验证应固定npm版本、完整性及其匹配依赖。

候选 `engines.dsh` 与dsh-tools/dsh-llm peers使用同一范围：

```text
>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-alpha.2 <0.3.0-0
```

Cordis peer为`>=4.0.5 <4.0.6-0 || >=4.0.6-alpha.1 <4.1.0-0`；Schemastery peer为`>=3.18.5 <3.18.6-0 || >=3.18.6-alpha.1 <3.19.0-0`，不再把alpha Schema直接依赖强塞进RC host，开发依赖仍可固定用于构建。原版boot存在`engines.dsh`时优先检查它，npm/pnpm仍独立解析peers，两层都须满足，不能只放宽一层。

五版官方boot均用`semver.satisfies(...,{includePrerelease:true})`。上述分段范围既让普通npm匹配目标五版，也排除rc.1、alpha.0/alpha.1以及0.3.0的预发布和正式版本；直接`<0.3.0`在官方匹配器下会接纳0.3.0-alpha.1，不能代替`<0.3.0-0`。

**未来准入不等于已测。** 该范围为能力适配保留未来小版本空间，例如后续0.2.1 RC、0.2.2 alpha/正式版或0.2.3正式版；当前没有这些版本的验证结论。未来0.2.3预发布在官方includePrerelease规则下可能准入，而普通npm peer规则会排除，须以实际依赖解析及能力检查为准，不能强装或跳过检查。未来缺少必需API仍须fail closed；未测版本不并入上表通过数量。

### 源码能力与预期执行路径

RC.2–RC.5公开single-call `ctx.tools.execute`，可转发**真实**token、parent/rootCallId，经同一官方executor与guard合法嵌套；本轮公开运行时double检查通过，不等于真实PTC ACP程序通过。alpha.2 batch没有公开parent，不伪造或补入该字段，通知拒绝语义保持。RC的tools.Config.mode与alpha独立executor配置不混用。真正PTC执行本地仍BLOCKED，待远端证据。

适配不能新建私有执行管线、伪造parent、直接调用工具body或绕过guard。固定发布源码、实际npm包及接口差异详见[DSH API兼容审计](dsh-api-compatibility.md)。

## 两端文件协议矩阵

| DSH 插件与模式 | MaiBot 配套插件 | 实际确认工具与限制 |
| --- | --- | --- |
| 当前基线 0.2.1 `f008cdc…`，默认 manifest | 固定基准 0.2.1 `8018552…`，或旧 0.2.0 `ba8a5fb…` | 返回完整 `dsh_import_handoff(manifest, send=false)` 参数，手动在原聊天确认 |
| 当前基线 0.2.1，显式 request | 固定基准 0.2.1 `8018552…` | 返回 `dsh_import_request(task_id, request_sha256)`，手动在原聊天确认 |
| 已合并0.3.0 main028f354，精确alpha.2 | 同上 | 已有fixed通知及手动流程；历史134项仅对应该基线 |
| 本轮0.3.1候选，autoNotify未配置 | 同上 | 同一manifest/request手动流程，五版Native通过；本地必需PTC仍BLOCKED |
| 本轮0.3.1候选，显式fixed通知 | 固定基准0.2.1 `8018552…` + request | 五版Native实际ACP通过；PTC本地BLOCKED；排队不证明Planner选工具或入库 |
| 任一 request 模式 | 旧版 0.2.0 `ba8a5fb…` | 不支持：旧版没有 `dsh_import_request`，使用 manifest 模式 |
| 历史 DSH 0.2.0 `0958d8a…` 默认 request | 当前配套 0.2.1 | 字节协议可读；旧 DSH 的提交恢复缺陷不会被对端升级修复，不建议回滚未知任务 |
| 同一历史 DSH 0.2.0 | 旧配套 0.2.0 `ba8a5fb…` | 默认返回不存在的请求工具；只能人工提交完整 manifest |

首次请求入口提交 `27d6c00784557128ebb9c57edf04a0a5c1382bd6` 仍作为历史兼容检查，**不再作为当前部署推荐点**。其 286 项测试是历史基线；当前 peer `8018552…` 正式套件为 303 项。

## Manifest 与公开工具

manifest v1 不变：顶层只有 `type`、`version`、`task_id`、`files`；每项只有 `path`、`size`、`sha256`。任务 ID 为随机 32 位小写十六进制，SHA 为 64 位小写十六进制，size 为非负整数。不能添加聊天、目标或发送字段。默认 50 MiB / 8 个文件；两端配置共同允许的硬上限是 1 GiB / 32 个，实际还受 Host 配额限制。

| MaiBot 工具 | 旧 0.2.0 | 当前 0.2.1 | 行为 |
| --- | --- | --- | --- |
| `dsh_import_handoff(manifest, send=false)` | 有 | 不变 | 在实际当前 Host 文件 scope 导入；真实逐项 file_ref 才是入库证据 |
| `dsh_handoff_status(task_id)` | 有 | 不变 | 当前 scope 分页验证已有引用后只读返回；不重传或恢复副作用 |
| `dsh_import_request(task_id, request_sha256)` | 无 | 有，均必填 | 固定路径、准确字节 SHA、严格 manifest，复用原 Handoff，固定不发送 |

请求固定为 `outbox/.dsh-handoffs/<task_id>.json`，≤64 KiB，内容就是 UTF-8 原始 manifest v1。SHA 必须对应准确字节，重新排版或追加换行后不能沿用旧哈希。默认 manifest 模式及显式 request 模式都使用同一共享请求和持久证据，没有协议重设计。原版 ACP 不列出第三方插件工具，DSH 不假装自动探测对端插件版本。

## 配套固定基准与当前 main 的只读审阅

已只读检查 `8018552…`，并与首次请求实现 `27d6c007…` 比较全部 11 个变更文件（681 行新增、22 行删除）：

- `request.py` 增加暂存父目录安全检查，读取请求前拒绝错误所有者、可被组/其他用户写入或带符号链接的 runtime；之后仍使用既有私有快照和严格字节校验。
- 请求包装及插件入口补齐保守错误字段，不把参数失败、冲突或禁用状态说成已登记。公开参数签名和 manifest v1 不变。
- 增加请求取消、暂存边界、部分失败、旧发送任务冲突及固定 DSH dist 协议检查；文档明确“人类批准”不能由 SDK 代码证明。
- `handoff.py`、`safe_files.py`、账本格式、依赖及 Host/SDK 声明未改变。正式路径没有导入历史 `integrations/` 补丁，也没有后台上传或新特权 API。

上一轮0.3.0对固定801的独立审计记录为 **303 passed，0 failed，0 skipped**、Ruff通过；这是历史结果，本轮不把它当作新peer套件结果。独立协议检查使用原始固定 DSH dist：`f008cdc…` 与历史 `0958d8a…` 各 **6 passed**，共 **12**，与正式 303 分开报告。首次 `27d6…` 的 286 和官方 ManifestValidator/真实 SDK 安装加载结果保留为历史依据，不替代当前总数。

2026-10-31另查得当前main为 `8365fcedc93fcb6dcc2bc9f92ed7a65e53d474d2`（仍0.2.1）。本轮只读比较：manifest、request、handoff、safe_files及Host声明与801字节相同；plugin工具描述放宽为可识别用户原任务中的预先授权，不能信任Agent自称批准；新增CLI请求转发参数生成器不自行调用网络或上传。额外使用当前built TypeScript对8365实际请求/Handoff运行 **12项通过、0失败**，Files API仍为scope double。该peer README报告的331/24/8不是本轮亲自重跑结果，也不是生产验收。本轮不需要改MaiBot插件或核心源码；CI继续固定801防止上游漂移。

## 官方权限与自动通知边界

仍限定 [MaiBot v1.3.18 `2a9af62…`](https://github.com/Mai-with-u/MaiBot/tree/2a9af62cec37035d29237acbe2cf3adceb700b27) / [SDK v2.19.0 `c2a039a…`](https://github.com/Mai-with-u/maibot-plugin-sdk/tree/c2a039a7f4bcb367c7d770e88d6e034337be6b12)。没有新 current-chat 凭证、人类批准事件或自动文件 scope Hook：

- Host 在 [`component_query.py`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/plugin_runtime/component_query.py#L972) 按真实聊天签发文件 scope，工具完成后撤销；模型 kwargs 不能选择权限。
- [`agent_talk`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L61) 将文本送到已加载目标的 Planner 队列，不直接执行插件。只有 Planner 选择工具并经 Host 派发后，当前文件 scope 才允许官方 upload 返回 file_ref。
- SDK [files 文档](https://github.com/Mai-with-u/maibot-plugin-sdk/blob/c2a039a7f4bcb367c7d770e88d6e034337be6b12/docs/files.md) 不允许生命周期、事件或后台任务继续使用文件权限。peer 的“用户明确确认”是操作及模型策略要求，不能说代码已验证人类批准。

fixed策略从0.3.0提供，本轮0.3.1保留。它仅授权**专用单聊天部署**通知固定真实目标，不证明原始来源，也不代替peer要求的当前聊天用户确认。不从文件、清单、prompt或模型参数推导target。先可靠submitted，才通过该runtime公开的正式工具管线尝试通知；PTC的接口和准入规则须逐版核查，拒绝时手动处理，不换执行器绕过。queued仅排队，未知远端结果unknown且禁止重试，不据共享receipt自证imported。

ACP客户端应观察真实会话更新与Agent可见工具并执行代表性调用，证明DSH bundle工具实际加载。原版MaiBot MCP不暴露第三方插件工具，不能用其tools/list声称发现dsh_import_request；它的存在由固定peer源码/实际Host安装与原聊天调用证据核实。真实QQ和Host文件服务仍未验收。

## 固定部署来源

复用现场`/home/fish/dsh-runtime/node_modules/.bin/dsh`，先记录准确版本及Node。矩阵内runtime采用本轮0.3.1审核提交，不因旧版精确alpha声明而覆盖现场运行时。使用原SSH实际DSH_HOME与ACP profile，保留配置与全部私有证据。

```fish
set DSH /home/fish/dsh-runtime/node_modules/.bin/dsh
$DSH --version
set DSH_HOME_ACTUAL /home/fish/.dsh # 必须与现有 SSH 环境一致
set DSH_PLUGIN_COMMIT DSH_COMPAT_REVIEWED_COMMIT
env DSH_HOME=$DSH_HOME_ACTUAL $DSH plugin --profile acp add "github:MemoryController/dsh-maibot-artifacts#$DSH_PLUGIN_COMMIT" --ignore-scripts
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile acp --dump-config
```

`DSH_COMPAT_REVIEWED_COMMIT`必须替换成本轮0.3.1最终审核的完整SHA后执行；旧0.3.0不含新范围，不能作为该命令的替代pin。配套推荐固定`8018552bc82ee5fada38f6792a1721410adf5bc8`并向真实Runner提供完整目录。不重装runtime、不重置profile、不覆盖配置或账本。Ubuntu24/fish/core边界见[部署指南](deploy-ubuntu24-core.md)，真实Host/QQ仍须[现场验收](production-acceptance.md)。
