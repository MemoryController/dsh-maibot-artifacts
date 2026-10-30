# 本轮实际验证记录（0.2.0）

日期：2026-10-30，Asia/Shanghai。Linux，Node.js 24.19.0，官方 DSH 0.2.2-alpha.2，pnpm 11.25.0。以下将实际官方 ACP、模拟 Host 文件 API 和真实部署边界分开，不合并为“全链路生产通过”。

| 检查 | 实际结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | **68 通过，0 失败，0 跳过，0 取消**；保留原 45 项测试，新增默认目录、错误码、文件删除/替换、请求发布等 23 项 |
| `npm run build` / `verify:dist` | 通过；14 个 JS/声明文件与独立重建的文件集合及字节相同 |
| `npm run test:version` | 真实官方 CLI 拒绝错误 engines.dsh，错误包含要求版本与运行版本 |
| `npm run test:install` | 临时独立 npm 缓存，预构建 tarball 独立安装；安装脚本禁用；实际插件入口导入成功 |
| `npm run test:profile` | 真实普通 profile 安装、配置层、启动和三个工具注册通过；这是补充检查，不替代 ACP |
| `npm run test:acp` | 真实官方 stdio ACP initialize/new/prompt/close、真实 Agent loop：Native 三工具共 4 次调用、正确默认 XDG 状态目录、中文文本/PNG/空文件、请求 SHA/确认参数/重复提交通过；真实 stdio MCP fixture ping 1 次，agent_talk 0 次 |
| `npm run test:acp:clean` | 全新临时 npm prefix/cache 安装官方 DSH + pnpm（ignore-scripts），再通过官方 plugin 命令安装本包预构建 tarball；Native ACP 同一流程通过 |
| 受限 PTC ACP | 本地返回 sandbox-unavailable，产物工具/MCP 均0次，1项工作流跳过；`--require-ptc` 明确失败。**GitHub CI 在 workspace-write 官方沙箱下完成真实 PTC 会话、三个工具、共享请求及 MCP fixture，全部通过**；未关闭沙箱 |
| 跨插件受控交接 | 固定 peer `27d6c00784557128ebb9c57edf04a0a5c1382bd6`；实际 built TS 生产 7 个 submitted 请求；实际 peer request.py + Handoff 执行 **12 项检查通过**，7 次 DSH 重启/本地状态核对 |
| MaiBot 配套插件 | 本地完整 286 项 Python 测试、Ruff 通过；真实 SDK 安装/声明加载、未修改官方 Host v1.3.18 ManifestValidator 校验通过；配套 PR CI 的 Python 3.10 / 3.12 均通过 |
| 人工验收文件生成器 | `scripts/manual-fixtures.mjs` 实际生成中文/空格、PNG、空文件及可核对元数据；未连接 MaiBot |

跨语言 12 项包含：准确 SHA 拒绝、无当前 scope 零上传、文本/PNG/中文空格/Unicode/空文件/多文件实际 peer 导入逻辑、重复确认、peer 与模拟 API 重启、丢失成功回执后同聊天只读恢复、其他或缺失 scope 不泄露缓存/不重导、产物被篡改、对端大小/数量上限、不确定上传副作用后不重试、私有暂存清理及零发送。正常主批次产生 4 个模拟 file_ref；另 1 次故意不确定的模拟上传用于验证未知状态，总模拟发送 0 次。

**Files API 是明确标记的 scoped double，真实 Host capability 签发、HTTP 文件服务、Planner 选工具、Docker 挂载、QQ 接收/发送及后续图生图没有在此环境验收。** 真实 ACP 检查使用测试专用确定性模型和模拟 MCP server，未用真实 MaiBot 服务替代；测试日志将此区别直接输出。

## 已诊断失败与修复

- 原测试脚本使用用户全局 npm cache，在此云实例只读 HOME 下 npm pack 报 EROFS。独立安装测试现默认使用自身临时 cache，保留脚本禁用及入口断言；重跑成功。
- 本地 PTC 失败是官方沙箱能力不可用，未当作该本地工作流成功，也未修改权限绕过。随后 GitHub Runner 的官方沙箱成功完成同一受限工作流，见 [CI 41012901225](https://github.com/MemoryController/dsh-maibot-artifacts/actions/runs/41012901225) 的 `ptc: real DSH ACP ... passed`；部署主机仍须验证自身沙箱。
- 错误版本测试的非零退出是预期拒绝，包含明确要求与实际版本；不是隐藏应用失败。

## 保留的限制

1. 官方 ACP 未保留可验证原聊天元数据，普通成功文本不自动回 QQ；因此默认是共享请求 + 原聊天明确确认，完整无人确认自动路由未实现。
2. task_id/SHA 只确认请求内容，不是聊天授权。Host 当前真实 scope 决定导入位置；操作员必须在原聊天选择工具。没有额外适配器可自动证明该选择。
3. DSH 本地 status 不能证明 MaiBot 接收或入库；只有原聊天真实工具结果及当前 files_list/file_ref 可确认。没有签名验证时不读取共享 JSON 当回执。
4. 并发相同请求遇到短暂硬链接发布窗口时，竞争者可保守返回 prepared_only；不会覆盖已有请求或重复远端操作。先查同一任务记录，不换新 ID。
5. `.error` 是保留的历史诊断，不覆盖较新的 submission/notification 证据；即使产物后来恢复，也不据旧错误自动重试远端任务。
6. 账本删除/回滚、损坏磁盘、同 UID 对手、可移动祖先目录/挂载者不在原子性保证内。新 ACP Agent 不能冒充旧 Agent 读取其记录；原聊天的 peer 状态查询仍是实际登记恢复入口。

本轮 [PR #1](https://github.com/MemoryController/dsh-maibot-artifacts/pull/1) 的 push / pull_request CI 均通过，含68项测试、真实Native/PTC ACP、旧版协议及配套12项交接检查；[配套 PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 的Python3.10/3.12检查均通过。

真实部署逐项执行 [production-acceptance.md](production-acceptance.md)，记录官方工具回执与 file_ref 后，才能将对应项目标为通过。没有发布本轮 Release，也未自动合并两端 PR。
