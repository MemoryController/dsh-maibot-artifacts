# 跨仓边界与后续事项

本轮仅修改 **dsh-maibot-artifacts**。配套 [PR #2](https://github.com/MemoryController/maibot-dsh-artifacts/pull/2) 已由维护者合并，merge commit 为 `8018552bc82ee5fada38f6792a1721410adf5bc8`，不是 Draft；不再要求维护者将它标为 ready 或重复合并。本轮未修改其他仓库文件、分支、PR 元数据、发布状态，也不将 main/包版本解释为 Release。

## 已有能力，无需上游改动

- DSH main 0.2.1 `f008cdc…` 默认 manifest 模式使用已有 `dsh_import_handoff`，兼容旧 peer `ba8a5fb…` 和当前 main `8018552…`。
- 当前 peer 0.2.1 已提供固定请求路径、准确字节 SHA 的 `dsh_import_request`，复用原 Handoff 和真实 Host 文件 scope，默认不发送。
- 本轮 DSH 0.3.0 可在专用单聊天部署中，按操作员显式静态授权通知固定目标。它请求MaiBot展示待确认内容、遵守peer策略在当前聊天取得用户确认后，再由Planner依法选择导入工具；不取代批准，不需要核心改动或背景文件权限，也不承诺Planner必定执行。
- 当前 peer 只读审计为 303 项正式测试 + 12 项独立固定 DSH 协议检查通过；286 是首次请求实现的历史数量。测试引用属于 scope double，不能替代生产 file_ref。

## 本仓库交付检查

- [ ] 默认不配置 autoNotify 时，原 manifest/request 手动流程和持久恢复结果不变。
- [ ] fixed 模式要求操作员确认专用单聊天范围；目标只来自受保护配置，新任务 prepare 绑定策略，旧任务不补绑，目标变化不能接管旧任务。
- [ ] 先取得可靠本地 submitted，再写独立通知尝试记录并经 Native 官方执行管线分派。拒绝、超时、未知、崩溃与重启不能盲重试或覆盖共享提交证据。
- [ ] PTC 拒绝内部 MCP root batch 时保留手动确认，不关闭沙箱、不更换执行器、不绕过 guard/admission。
- [ ] CI 主配套固定 `8018552…`，保留 `ba8a5fb…` 的原 manifest 兼容，`27d6c007…` 仅作历史额外检查。不得把旧 286 或旧 DSH 112 项基线直接当新候选的测试总数。
- [ ] 新 0.3.0 提交形成后更新精确安装 SHA，沿用用户 `/home/fish/dsh-runtime`、实际 DSH_HOME/profile，以及既有 core/maim-bot-core 挂载；不重装 runtime 或增加特权服务。
- [ ] 真实部署另验工具选择、官方 file_ref、同聊天 files_list、图片工具和未知结果恢复；没有这些证据前不声称无人确认入库已验收。

## 若未来要求确定性自动回原聊天

最小上游设计仍需共同提供：Host 签发并绑定原任务、原聊天、有效期与重放范围的回复/导入授权；ACP/DSH 对可信来源上下文的保留；Host 在合法文件 scope 内派发指定导入工具及可核对结果的官方契约。普通 `_meta`、解析提示词、任意 chat/session ID 或固定目标配置都不能代替这些契约。

这是未来另行讨论的接口需求，不是本轮 fixed 通知的安装前置条件。本轮不实施核心补丁、fork、monkeypatch、事件后台上传或管理员 API。若将来 peer/Host 提供正式新接口，先固定源码、核查授权与未知结果语义，再在本仓库独立适配和验证。
