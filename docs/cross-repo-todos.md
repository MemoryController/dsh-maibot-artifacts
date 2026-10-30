# 跨仓审阅与发布待办

本轮权限限定为 **dsh-maibot-artifacts 仓库**。配套 [maibot-dsh-artifacts PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 只做源码、CI、状态及版本的读取；没有对其文件、提交、分支、PR 元数据或发布状态作任何修改。

2026-10-30 核查时，该 PR 为 OPEN / DRAFT，head 是 `27d6c00784557128ebb9c57edf04a0a5c1382bd6`，main 仍为 0.2.0 的 `ba8a5fb4dc9857982f9cf5518b746ed0f9c282c8`。完整矩阵和固定安装命令见 [兼容说明](compatibility.md)。当前 DSH main `0958d8ac788ebbea5f2c507f3b024de3dd06cb24` 默认返回对端 main 不存在的请求工具；本轮 DSH 0.2.1 候选改为默认 `confirmationMode: manifest`，直接返回已有 `dsh_import_handoff` 的完整参数，因此不需要等待配套 PR 才能提供可执行的默认受控流程。候选尚未合并，不能提前宣布当前 main 已修复。

## 交给配套维护者

源码与隔离验证未发现阻止评审的兼容性缺陷。**建议维护者将 PR #2 标为 ready for review，开始人工审阅；本轮没有远程执行此操作。** 不建议因为测试绿灯直接合并或发布。

- [ ] 核对 PR 全部 10 个文件与确切 head；若 head 改变，重新审阅完整差异并重跑测试，不能继续沿用旧提交的结论。
- [ ] 确认 `dsh_import_request(task_id, request_sha256)` 两个参数均必填；固定路径 `outbox/.dsh-handoffs/<id>.json`，请求 ≤64 KiB，准确字节 SHA、严格 manifest v1 和任务标识校验齐全。
- [ ] 确认请求入口在真实 Host 工具 scope 内复用原 `Handoff.import_manifest(..., send=False)`；不接受聊天、目标、路径或发送参数，不监听目录、不后台上传。
- [ ] 保留 `handoff.py` 和 `safe_files.py` 的既有 claim、私有快照、哈希复验、unknown、去重与授权查询。历史 `integrations/` 不能成为正式部署依赖；不修改 MaiBot 核心、不 monkeypatch、不伪造 scope。
- [ ] 保留插件 ID、manifest v1、原公开工具签名和账本格式；以实际运行环境的 SDK 2.19.0 核验新工具声明，安装完整文件集合，不能漏掉新增 `request.py`。
- [ ] 审阅本轮只读重跑的 286 项测试及 PR CI Python 3.10/3.12 结果；正式 Host v1.3.18 ManifestValidator 通过只证明声明兼容，不能代替运行验收。
- [ ] 可选增强测试：请求加载期间取消后的私有暂存清理。目前复用现有 `_io` 取消保护，未发现阻塞缺陷；新增断言应在配套仓库另行进行。
- [ ] 在真实部署中记录当前聊天实际工具结果、逐项 file_ref、files_list、重启后只读状态与 unknown 不重试；未完成之前保留“真实 Host/QQ 未验证”的说明。
- [ ] 人工决定是否合并；若批准，将合并后的确切提交及发布状态提供给 DSH 维护者。合并与 Release 是两件事，不能仅凭 0.2.1 manifest 宣称版本已发布。

当前未发现必须修改配套代码才能继续评审的阻塞项。配套 PR 仅关系到显式选择的 request 确认模式；DSH 新候选的默认 manifest 模式使用已合并入口，不以其合并为前置条件。上述建议均为交接给其维护者的待办，本轮不代为执行，也不请求用户提供管理员 Token。

## DSH 仓库需要跟进

- [ ] 交付本轮 DSH 0.2.1 修复 PR，并准确记录其测试、安装及 dist 一致性结果；不把既有 main 的结果直接写成新提交的验证结果。
- [ ] 默认配置保持 `confirmationMode: manifest`，实际返回完整 `dsh_import_handoff({manifest, send:false})` 参数；用已合并对端 main `ba8a5fb…` 的真实 Handoff 内核验证，不能只比对 schema。
- [ ] 另用固定草稿 `27d6c007…` 验证默认 manifest 模式和显式 request 模式。只有后者要求新工具；README、安装示例和 CI 须清楚区分模式与对端提交，不能要求默认用户升级草稿。
- [ ] 标明原版 ACP 不列出第三方插件工具，配置模式不能伪装成远端能力自动探测；显式 request 的部署者须自行核实安装版本。
- [ ] 安装沿用用户 `/home/fish/dsh-runtime/node_modules/.bin/dsh`、实际 `DSH_HOME` 与 ACP profile；审核修复提交形成后固定新 SHA，不重复安装 runtime 或重置现有 profile。
- [ ] 配套批准合并后，重新核对其工具 schema、manifest/账本兼容和完整差异，用新的确切 SHA 重跑 DSH 跨语言交接测试，再更新版本矩阵、CI 和安装示例。
- [ ] 若配套 PR 被拒绝、撤回或接口变化，默认的原聊天 `dsh_import_handoff(manifest, send=false)` 流程应继续可用；只停止或调整显式 request 模式，不伪造新工具成功或自动转向其他聊天。
- [ ] 真实 Host、Docker 挂载、SSH ACP、QQ 文件库和图片工具依照生产验收逐项记录；没有实际 file_ref 时保持 unconfirmed，不读取共享 JSON 充当官方回执。

完整无人确认自动路由仍需要上游提供可信任务来源、授权目标和真实文件工具派发契约。仅增加聊天 ID、解析传话文本或透传未经验证的 `_meta` 都不足以解决这一问题；此类上游工作另开设计讨论，本轮不修改任何 MaiBot/DSH 上游源码。
