# 实际验证记录

日期：2026-10-30（Asia/Shanghai）。Linux，Node.js 24.19.0，npm 11.9.0，pnpm 11.25.0。

## 已执行并通过

| 命令 / 检查 | 结果 |
| --- | --- |
| `npm install --ignore-scripts` | 精确版本依赖安装成功；未执行依赖生命周期脚本 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | **45 项通过，0 失败，0 跳过，0 取消** |
| `npm run build` | TypeScript 生成 JS 与声明文件成功 |
| `npm run verify:dist` | 10 个预构建文件与独立临时目录重建逐字节相同，文件集合相同 |
| `npm run test:install` | npm pack 后禁用生命周期脚本独立安装；实际导入预构建插件入口成功；本机另外通过 `node scripts/test-install.mjs --offline` 验证已有完整缓存的离线安装 |
| `npm run test:profile` | 官方 DSH 0.2.2-alpha.2 plugin add、配置层合成、base-backed profile 启动；探针确认全部 3 个工具注册成功，随后停止自启验证进程 |
| GitHub 固定提交安装 | 官方 `dsh plugin --profile github-check add github:MemoryController/dsh-maibot-artifacts#f23f5d93ad52279eddf5f289a476e6d6dcbccf74 --ignore-scripts` 成功；dump-config 与实际启动探针均确认 3 个工具注册；未开放安装脚本执行 |
| `node scripts/verify-protocol.mjs /tmp/maibot-protocol` | 真实固定对端 Python 验证器接受 1 份 manifest；2 个中文二进制/空文件大小与哈希核对通过；1 次真实 relay helper 指令 JSON 对比通过 |

`npm run check` 包含类型、lint、45 项测试、重建一致性、无安装脚本的独立包安装及官方 profile 检查。CI 另外取得并检出固定 MaiBot 协议提交运行真实 Python 协议验证；远端 CI 运行结果与本地执行记录分别报告。

45 项分布：核心协议/记录/并发 24；派发（真实官方 Native/PTC/MCP bridge + 模拟远端回调）11；插件生命周期及来源绑定端到端隔离场景 1；文件安全 7；可信来源绑定 2。

确定性回归测试覆盖哈希时修改、路径替换、强制随机 ID 碰撞、并发一次性通知、超时后迟到成功、崩溃栅栏恢复、同 Agent 不同原任务拒绝接管、旧校验失败不覆盖新排队证据。文件安全覆盖中文、二进制、空文件、限量、遍历、绝对路径、软硬链接及 FIFO。

开发过程中曾因新增必填来源字段导致旧测试类型错误，以及 lint 对路径控制字符表达式报错；已更新测试并为专门拒绝控制字符的安全表达式配置定向规则。首次远端 CI 中 45 项测试、类型、lint、产物一致性均通过，但独立安装检查因缺少 npm 离线 registry metadata 而失败（ENOTCACHED）：`npm ci` 只需缓存锁文件 tarball，不保证缓存该 metadata。安装检查现默认正常获取精确依赖的 metadata、保持禁用安装脚本，离线模式作为完整缓存下的额外选项；不跳过安装或入口加载断言。

## 未验证 / 限制

- 未运行真实 MaiBot v1.3.18 / SDK Runner，没有真实 ACP 网络交互、Planner 选工具、files_list/file_ref、Docker/QQ 接收或发送结果。
- 模拟 MCP 回调使用官方 bridge 和官方执行器，不能替代网络传输和 MaiBot Host 授权测试。
- 官方 ACP 的原聊天目标只在普通 prompt 文本中；未提供结构化可信来源适配。因此默认人工交接，不能声称安装即自动通知。
- PTC 内部原生工具批次被官方执行器拒绝；已验证安全降级，未通过绕过策略实现自动通知。
- 不保证恶意同 UID、挂载/祖先目录管理者、被删除或回滚的本地账本、文件系统故障下的跨主机原子性。
- GitHub 安装在当前机器新的临时 profile 中完成，复用该机器已安装的 DSH 和 package manager；这不等同于另一台新机器或发布后的云环境恢复验收。pnpm 报告 git 包构建脚本被忽略及 Host peer 警告；实际加载已证实使用提交内 dist 成功。
