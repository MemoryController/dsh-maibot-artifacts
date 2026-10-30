# 验证记录：已合并基线与本轮自动通知审计

日期：2026-10-30（Asia/Shanghai）。当前DSH已合并基线为0.2.1 `f008cdc039122d360dee67b86e1e2004083ba019`，本轮新增能力候选为0.3.0。只修改DSH仓库；没有连接或改变生产服务器，没有修改MaiBot源码、分支或PR元数据。

## 本轮0.3.0实际本地结果

| 检查 | 实际结果及边界 |
| --- | --- |
| `npm run check` | 通过；类型、lint、单元、dist一致性、独立安装、普通profile及默认ACP均执行 |
| 单元及隔离运行时测试 | **134 passed，0 failed，0 skipped**：112项既有基线 + 17项auto-notify + 5项auto-plugin |
| build / verify:dist | 通过，18个JS/声明文件与独立重建的集合和字节相同 |
| 独立tarball安装 | 临时独立缓存，禁用安装脚本，入口加载通过；不是目标服务器安装 |
| 官方普通profile | 安装、启动和三个工具注册通过 |
| 默认确认真实ACP | 官方CLI/SDK/Native Agent loop通过；模型及MCP服务器为明确fixture |
| 显式request真实ACP | Native通过，agent_talk调用0次，保留手动confirmation |
| 显式fixed真实ACP | Native通过，实际官方执行管线agent_talk fixture调用1次，queued、准确confirmation与重复不重发断言通过 |
| 本地受限PTC | 对应ACP工作流因官方sandbox-unavailable各跳过1项，产物/MCP副作用0次；未关闭沙箱，不记作PTC成功 |
| `npm run test:version` | 通过，真实官方CLI拒绝错误engines.dsh |
| 新peer交接 | 固定8018552，实际新built TS → 实际peer request/Handoff，12项通过，7请求/7本地状态核对；仅Files API为scope double |
| 旧peer协议/导入 | 固定ba8a5fb：1次manifest校验、2项文件元数据验证、1次helper参数比较通过；实际旧Handoff另4项通过，零发送 |
| 历史请求实现 | 固定27d6c007额外兼容12项通过，不作为当前部署推荐点 |
| clean-install fixed ACP | 全新临时目录安装官方DSH 0.2.2-alpha.2及pnpm，禁用生命周期脚本；预构建插件安装后Native真实ACP固定通知排队一次通过。PTC仍明确sandbox-unavailable跳过，0产物/MCP副作用 |
| 本轮远端CI | 配置已更新，尚未以push后的运行结果作通过声明 |

自动通知是独立阶段：先可靠本地submitted，之后才有通知尝试栅栏和queued/not_dispatched/unknown。固定配置只授权待确认文本，不取代当前聊天用户批准，也不保证Planner导入。timeout只请求取消，工具等待官方dispatch收尾；迟到结果不升级unknown。所有真实Host/Docker/SSH/QQ登记和投递仍未验收。

## 已合并0.2.1基线结果

下表112项及恢复检查是已合并修复的历史验证记录，不直接作为0.3.0新通知能力的测试总数或生产证据。

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
| 旧peer兼容 | 固定 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`，实际旧版Handoff处理默认完整manifest：**4项通过**，重复/重启/状态查询不补上传、零发送 |
| 初审请求兼容 | 历史 `27d6c00784557128ebb9c57edf04a0a5c1382bd6`，实际request.py + Handoff：**12项通过**，7个实际DSH提交任务及状态核对 |
| 初审SDK/Host | 历史286项与Ruff、真实SDK安装声明及未修改官方Host ManifestValidator通过；286不是当前peer总数 |

新增44项 = 22恢复 + 7记录 + 9只读检查/阶段错误 + 6模式。原作用域隐私测试改用稳定error.code断言；原并发源文件修改测试的gate精确绑定源文件inode/dev，避免误拦新增的私有记录读取。历史错误断言按新语义检查historical_error，未取消断言或用空测试替代。

对端4项与12项均执行真实文件快照/哈希/账本代码，**Host Files API 使用明确的scoped double**；不能把其中模拟file_ref作为真实文件库证明。对端工作目录在检查前后git status不变，Python使用-B，暂存不在对端源码目录。

CI继续要求完整check、默认与显式request的真实ACP、错误版本拒绝及旧manifest兼容，当前请求主peer已固定8018552；27d6仅作历史额外检查。CI配置本身不证明新提交已运行或通过。

## 本轮0.3.0与当前peer审计

配套PR #2已合并为main v0.2.1 `8018552bc82ee5fada38f6792a1721410adf5bc8`。本轮独立只读审计：**303项正式测试通过，无失败/跳过，Ruff通过**；另用固定原始DSH dist `f008cdc…` 和`0958d8a…`分别运行6项协议检查，共12项，单独报告。比较初审27d6后的11个变更文件，新增安全暂存父目录及保守错误结果，Handoff/safe_files/manifest和账本不变。

本仓库更新CI后，实际执行 `node scripts/test-handoff.mjs /tmp/peer-current-main 8018552bc82ee5fada38f6792a1721410adf5bc8`：**12项通过、0失败**，7个真实built TypeScript提交请求、7次DSH本地状态核对；真实peer request/Handoff产生4个正常模拟引用，另1次故意未知上传，模拟发送0次。这是本仓库交接检查，与peer自己的12项双DSH版本协议检查分别计数；两者Files API均为scope double。CI YAML解析通过，保留当前801主检查、ba8旧manifest及27d历史额外检查。

上面的本轮结果与112项旧DSH基线、303项peer套件分别报告，不混为一个测试总数。固定目标只授权带回待确认请求，queued不等于导入。所有真实Host/QQ项目仍Pending。

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

可以在部署者审核固定提交、核实真实Runner权限并保留全部账本后，安排隔离测试聊天的受控试运行；不能宣布正式生产验收完成。当前peer main0.2.1同时支持manifest/request，旧0.2.0仅manifest。fixed通知默认关闭，只有专用单聊天显式授权后才减少手工抄参；它不证明原始来源、不取代用户确认、不保证Planner调用或入库，非工具上下文仍无文件权限。

现场步骤见 [Ubuntu24 / core 部署指南](deploy-ubuntu24-core.md)，版本与只读审阅见 [兼容说明](compatibility.md)，跨仓事项只作[后续记录](cross-repo-todos.md)。0.2.1基线及配套PR已合并；本轮0.3.0未发布Release。
