# 本轮验证记录：DSH 0.2.1 修复候选

日期：2026-10-30（Asia/Shanghai）。基于已合并 main `0958d8ac788ebbea5f2c507f3b024de3dd06cb24`；只修改 DSH 仓库。生产服务器没有连接或改动，MaiBot 源码、分支和 PR 元数据没有修改。

| 检查 | 本轮实际结果与边界 |
| --- | --- |
| 类型检查 / lint | 通过 |
| 单元及隔离运行时测试 | **112 passed，0 failed，0 skipped**；在原68项基础上新增44项 |
| 恢复故障注入 | 22项，覆盖发布前失败、link成功后异常、目录fsync失败、完成证据/主状态加载/保存失败、诊断保存也失败、真实子进程exit74/73、重启、并发、主记录缺失/损坏与旧版未落账请求；检查实际磁盘字节、inode/nlink、0600权限及文件清单 |
| 私有记录验证 | 7项，覆盖可选字段损坏、错误SHA/路径/时间、错误owner、权限及硬链接；保留真实旧版 markerless 完成记录的只读升级兼容 |
| 请求只读检查 / 阶段错误 | 9项，验证 matching/missing/conflict/unreadable、路径替换与目录竞态，以及检查不创建、不chmod、不fsync、不修复文件 |
| 确认模式 | 6项，默认/显式manifest、显式request、无效配置、实际Schemastery默认值，以及模式切换不重写请求 |
| build / verify:dist | 16个JS/声明文件与独立重建的文件集合及字节一致 |
| 独立包 / profile | 预构建tarball在独立临时缓存安装、禁用安装脚本、入口导入通过；官方普通profile安装/启动/三个工具注册通过 |
| 真实 ACP（本地） | 官方CLI + ACP SDK initialize/new/prompt/close + Native Agent loop，通过默认manifest及显式request两种确认参数；测试模型和stdio MCP server均明确为fixture，未连接MaiBot |
| 受限 PTC（本地） | 官方sandbox-unavailable：每轮对应工作流明确跳过1项，产物工具/MCP副作用0次；未关闭沙箱。当前提交的真实受限PTC结果应以远端CI为准，不复用旧提交绿灯 |
| 官方版本拒绝 | 错误engines.dsh被真实CLI拒绝，错误包含要求版本与实际版本 |
| 对端main兼容 | 固定 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`，实际旧版Handoff处理默认完整manifest：**4项通过**，重复/重启/状态查询不补上传、零发送 |
| 对端Draft请求模式 | 固定 `27d6c00784557128ebb9c57edf04a0a5c1382bd6`，实际request.py + Handoff：**12项通过**，7个实际DSH提交任务及状态核对 |
| MaiBot PR #2只读审查 | 全部10个变更文件审查；只读重跑286项测试和Ruff通过，真实SDK安装声明及未修改官方Host ManifestValidator通过。其Draft/main状态、兼容条件及维护者待办另列文档 |

新增44项 = 22恢复 + 7记录 + 9只读检查/阶段错误 + 6模式。原作用域隐私测试改用稳定error.code断言；原并发源文件修改测试的gate精确绑定源文件inode/dev，避免误拦新增的私有记录读取。历史错误断言按新语义检查historical_error，未取消断言或用空测试替代。

对端4项与12项均执行真实文件快照/哈希/账本代码，**Host Files API 使用明确的scoped double**；不能把其中模拟file_ref作为真实文件库证明。对端工作目录在检查前后git status不变，Python使用-B，暂存不在对端源码目录。

CI现在要求完整check、默认与显式request的真实ACP、错误版本拒绝、旧manifest基准以及对端main四项和Draft十二项兼容检查。此前PR #1 Native/PTC绿灯仅作为历史依据，本轮结果以本轮PR的实际运行状态为准。

## 关键状态判定

| 磁盘证据 | 返回 / 恢复 |
| --- | --- |
| 源验证或共享link尝试前失败 | 当前调用prepared_only，不声称旧调用从未发布 |
| 已有intent，无有效complete | unknown；即使看见准确字节也不当作此前fsync完成；只读核对，不重新发布 |
| writer成功且complete持久化，随后主记录保存失败 | 当前调用unknown；重启后可从完整且owner/schema/权限/准确SHA均正确的intent+complete恢复submitted视图 |
| 主.json丢失/结构损坏，私有证据有效 | 只读恢复原task_id及manifest，不覆盖损坏主记录、不补写共享文件 |
| 缺少可信私有证据、owner错误、内容冲突 | unknown或明确的fail-closed错误；不合成manifest，不换ID |
| 旧0.2.0有效private submission | 作为旧writer成功后保存的完成证据只读保留；字段损坏不能冒充成功 |
| 旧prepared旁已有共享请求但无完成证据 | unknown；publish只保存防重发意图，删除共享文件后也不重新发布 |

`.error`只保留历史诊断。已有较新submission/notification时放入historical_error；当前unknown原因不被旧错误覆盖。诊断写入失败也不能掩盖发布的不确定性。

## 现场未通过项及试运行边界

没有真实Docker + SSH ACP + MaiBot + QQ环境证据，现场十项表全部Pending，**第5–8项：原QQ实际调用确认工具、真实file_ref、同聊天files_list、图片工具使用引用均未通过验收**。不能将模拟结果填入这些项。

可以在部署者审核固定提交、核实真实Runner权限并保留全部账本后，安排隔离测试聊天的受控试运行；不能宣布正式生产验收完成。默认manifest模式兼容配套main；只有明确审阅部署0.2.1才启用request模式。官方ACP缺少可信原聊天来源、非工具上下文无文件权限、无完全自动路由的限制未变。

现场步骤见 [Ubuntu24 / core 部署指南](deploy-ubuntu24-core.md)，版本与只读审阅见 [兼容说明](compatibility.md)，跨仓操作只列为[维护者待办](cross-repo-todos.md)。未合并或发布Release。
