# Agent 工具体系审查处理

日期：2026-11-11。用户已授权实施、采纳审查意见、通过测试后合并及本地部署。本文记录契约修正，不代表真实云连接或全部工作包已经验收。

| 审查组 | 采纳的契约及证据 | 实施位置 |
|---|---|---|
| 状态与恢复 | result_received 可归档前取消；failed 仅从完整已存响应本地重解析，追加解析审计；provider_unknown 可关闭 settled_unknown，旧预留仍占用，晚到账单仅幂等修正 | shared/research-runtime.interface.ts；runtime-journal.service.ts；runtime-recovery.service.ts；runtime-journal.integration.spec.ts、council-api-tools-daily.integration.spec.ts |
| 审批与批次 | 审批专属 runtime dispatch，SDK execute/toolApproval 关闭，拒绝 provider-executed writes；编辑预览 waiting_approval 自环，新 revision/hash 清除旧确认，不调用模型；混合批次 read 先运行，write 停放，恢复不重读 | common/agent-contract.ts 纯规则；research-runtime.service.ts；ai-sdk-model.adapter.ts；tool-actions.service.ts 与 PG 审批回归 |
| 模型协议与预算 | 每 step 一个模型 HTTP/dispatch；内部模型请求独立 child dispatch；JSON-action 非法 JSON/schema、未知工具、非法参数、重复 ID 形成结构化 tool-result，稳定 ID，下一 step 受显式上限及预算控制；available=limit-settled-inflight，未知预留不退款 | common/agent-contract.ts action/identity/budget；runtime-dispatch.service.ts；llm-budget.service.ts；tool-budget.service.ts 及集成回归 |
| 冻结事实与时间 | datasetVersionIds + 每版内容 hash + 持仓/现金/来源私有 payload 快照，整体 frozenInputHash；原 asOf 保持兼容，新业务 dataAsOf 未知仍为 null | shared 数据/产物/计算契约；council-tool-runtime.service.ts；data-dataset.service.ts；council-api-tools.integration.spec.ts；research-portfolio.integration.spec.ts |

审查提案中以下含义不能采纳：把 settled_unknown 当确认失败并释放预算；把解析失败变为重新发送；确认写入时重跑已完成只读工具；由 SDK 与 runtime 同时拥有审批；错误触发自动换供应商付费；只冻结证券代码而不冻结事实。这些解释分别破坏未知费用、调用唯一性、审批边界或复算语义，已在总体设计及计划中明确排除。

P0 离线契约先观察 20 个用例因未实现失败，再实现为 20/20 通过，无 skip。测试命令：`node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.node.json --test server/modules/research-runtime/runtime-contract.spec.ts`。该证据只覆盖共享契约和纯规则；实际 HTTP 次数、数据库并发、供应商能力和真实写入仍须对应工作包独立验收。

实现期另要求检查当前来源政策收紧、迟到解析任务 ID、孤儿产物、零值用量占位、额外
total tokens、计算撤权/清理及浏览器可引用证据。这些回归分别归属 tool-actions、document-jobs、
research-artifacts、model-step/runtime-dispatch、research-compute 与 research-tools 的测试。
具体测试结果以最终交付验证记录及 PR CI 为准；本表不把真实供应商、OCR 或检索质量标为已验收。
