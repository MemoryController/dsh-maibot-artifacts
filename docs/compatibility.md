# 两端版本与兼容范围

核查日期：2026-10-30（Asia/Shanghai）。DSH 插件当前已合并基线为 **0.2.1 / `f008cdc039122d360dee67b86e1e2004083ba019`**；配套 [PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 已合并为 **0.2.1 / `8018552bc82ee5fada38f6792a1721410adf5bc8`**。两仓 main 已同时具有请求生产和确认入口。包版本、合并 main 与 Release 是不同事实；本轮 **DSH 0.3.0 自动通知候选尚未发布 Release**。

## 版本矩阵

| DSH 插件与模式 | MaiBot 配套插件 | 实际确认工具与限制 |
| --- | --- | --- |
| 当前基线 0.2.1 `f008cdc…`，默认 manifest | 当前 main 0.2.1 `8018552…`，或旧 0.2.0 `ba8a5fb…` | 返回完整 `dsh_import_handoff(manifest, send=false)` 参数，手动在原聊天确认 |
| 当前基线 0.2.1，显式 request | 当前 main 0.2.1 `8018552…` | 返回 `dsh_import_request(task_id, request_sha256)`，手动在原聊天确认 |
| 本轮 0.3.0 候选，autoNotify 未配置 | 同上 | 保留原有 manifest/request 手动流程；默认没有自动通知 |
| 本轮 0.3.0 候选，显式 fixed 通知 | 推荐当前 main 0.2.1 `8018552…` + request 模式 | 专用单聊天配置可自动发送文本入库请求；Native 排队不保证 Planner 选择工具，更不证明入库 |
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

## 当前配套 main 的只读审阅

已只读检查 `8018552…`，并与首次请求实现 `27d6c007…` 比较全部 11 个变更文件（681 行新增、22 行删除）：

- `request.py` 增加暂存父目录安全检查，读取请求前拒绝错误所有者、可被组/其他用户写入或带符号链接的 runtime；之后仍使用既有私有快照和严格字节校验。
- 请求包装及插件入口补齐保守错误字段，不把参数失败、冲突或禁用状态说成已登记。公开参数签名和 manifest v1 不变。
- 增加请求取消、暂存边界、部分失败、旧发送任务冲突及固定 DSH dist 协议检查；文档明确“人类批准”不能由 SDK 代码证明。
- `handoff.py`、`safe_files.py`、账本格式、依赖及 Host/SDK 声明未改变。正式路径没有导入历史 `integrations/` 补丁，也没有后台上传或新特权 API。

本轮使用独立审计 clone，只读运行当前 peer **303 passed，0 failed，0 skipped**，Ruff 通过；仓库无差异。独立协议检查使用原始固定 DSH dist：`f008cdc…` 与历史 `0958d8a…` 各 **6 passed**，共 **12**，与正式 303 分开报告。首次 `27d6…` 的 286 和官方 ManifestValidator/真实 SDK 安装加载结果保留为历史依据，不替代当前总数。

## 官方权限与自动通知边界

仍限定 [MaiBot v1.3.18 `2a9af62…`](https://github.com/Mai-with-u/MaiBot/tree/2a9af62cec37035d29237acbe2cf3adceb700b27) / [SDK v2.19.0 `c2a039a…`](https://github.com/Mai-with-u/maibot-plugin-sdk/tree/c2a039a7f4bcb367c7d770e88d6e034337be6b12)。没有新 current-chat 凭证、人类批准事件或自动文件 scope Hook：

- Host 在 [`component_query.py`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/plugin_runtime/component_query.py#L972) 按真实聊天签发文件 scope，工具完成后撤销；模型 kwargs 不能选择权限。
- [`agent_talk`](https://github.com/Mai-with-u/MaiBot/blob/2a9af62cec37035d29237acbe2cf3adceb700b27/src/agent/messaging.py#L61) 将文本送到已加载目标的 Planner 队列，不直接执行插件。只有 Planner 选择工具并经 Host 派发后，当前文件 scope 才允许官方 upload 返回 file_ref。
- SDK [files 文档](https://github.com/Mai-with-u/maibot-plugin-sdk/blob/c2a039a7f4bcb367c7d770e88d6e034337be6b12/docs/files.md) 不允许生命周期、事件或后台任务继续使用文件权限。peer 的“用户明确确认”是操作及模型策略要求，不能说代码已验证人类批准。

0.3.0 fixed 模式的本地配置只授权**专用单聊天部署**通知一个固定真实目标，不证明它是当前任务的原始聊天，也不取代peer要求的当前聊天用户导入确认。它不从文件、清单、prompt 或工具参数推导目标。先成功持久提交请求，才通过官方 Native `ctx.tools.execute` 尝试一次文本待确认请求；PTC 官方拒绝时保留手动确认，不换执行器绕过。通知要求MaiBot展示请求、取得用户确认后实际选工具。排队只能记 queued，异常或无法确认的远端结果记 unknown，禁止自动重试。DSH 不据共享 receipt JSON 或排队回执标记 imported。

## 固定部署来源

复用现场 `/home/fish/dsh-runtime/node_modules/.bin/dsh`，先查版本为 **0.2.2-alpha.2**，再使用原有 SSH 实际 `DSH_HOME` 和 ACP profile。下面固定的是已合并 **0.2.1 手动流程基线**，不包含本轮新自动通知模式：

```fish
set DSH /home/fish/dsh-runtime/node_modules/.bin/dsh
$DSH --version
set DSH_HOME_ACTUAL /home/fish/.dsh # 必须与现有 SSH 环境一致
env DSH_HOME=$DSH_HOME_ACTUAL $DSH plugin --profile acp add 'github:MemoryController/dsh-maibot-artifacts#f008cdc039122d360dee67b86e1e2004083ba019' --ignore-scripts
env DSH_HOME=$DSH_HOME_ACTUAL $DSH --profile acp --dump-config
```

本轮 0.3.0 的安装来源须在审核提交形成后固定完整 SHA；不以浮动分支或裸 latest 冒充可复现版本。配套当前推荐固定 `8018552bc82ee5fada38f6792a1721410adf5bc8`，完整目录提供给真实 Runner，不能漏掉 `request.py`。不重新安装 runtime、不重置现有 profile、不覆盖原配置或私有账本。Ubuntu 24 / fish / Compose core 的实际路径及操作边界见 [部署指南](deploy-ubuntu24-core.md)，真实 Host/QQ 项仍需 [现场验收](production-acceptance.md)。
