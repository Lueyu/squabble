# 团队模拟盘验证记录

日期：2026-11-12。开发基线：`3a561b18bacbef8557996d18977e69b1f63380e8`。状态：功能实现与下列本地验证已完成；最终提交的CI与合并状态以GitHub PR检查记录为准。本文件不把设计要求当作已通过证据。

已完成的聚焦证据：10模板的结构/空授权测试；真实PostgreSQL资产读取隔离；账户/策略来源客户端测试；真实1440/390浏览器的账户与组织操作；原始模型响应解析前留存回归；目标重试后继失效、来源撤销、派生依赖、最终发布和费用未知的独立审查。

浏览器使用虚构API fixture，截图保存在本地 `output/playwright/`；它验证布局与交互，不代替真实API/事务验证。研究集成使用独立PostgreSQL与虚构provider传输，不调用个人模型、真实登录会话或真实投资账户。

第一轮Windows全量服务端测试：1298项，1282通过、16失败、0跳过；此轮不是通过证据。后续Linux同VM复现确认了主要兼容回归：Drizzle以关联表的首列判定空关联，新增可空团队字段置于首列使普通Council会话/任务被投影成null。已恢复identity-first字段顺序，真实左关联测试红→绿，原日报失败也已通过专项复验。另修复精确目录查询以避免并行schema清理导致pg_indexes OID竞争，并给历史来源fixture明确时间，不放宽真实来源截止检查。

本机客户端最终完整回归526/526通过、0跳过。原生助手本机串行202通过、1项因Windows无POSIX进程组信号明确跳过；Linux另完整203/203通过、0跳过。实际Chromium采集35/35通过、0跳过。Docker测试以非root、零额外capabilities运行，采用官方Playwright最小namespace seccomp profile保留浏览器沙箱；未使用privileged、SYS_ADMIN或no-sandbox。

Linux最终完整服务端单次回归1350/1350通过，0失败、0跳过、0取消。Node reporter用时996.99秒，进程墙钟1078.64秒。此轮之后仅增加canonical `parentVersionId`来源祖先检查与对应现有测试断言；该最终增量另以真实PG的12/12通过验证。PR CI将对最终提交重新运行完整服务端套件。

| 检查 | 本地已完成结果 | 本地原始记录（不入库） |
|---|---|---|
| 完整Linux服务端 | 1350通过，0失败/跳过 | `output/team-linux-server-tests.log` |
| 最后来源祖先增量 | 12通过，0失败/跳过 | `output/team-linux-parent-policy-final.log` |
| 完整客户端 | 526通过，0失败/跳过 | `output/team-merge-client-tests.log` |
| 完整Linux原生助手 | 203通过，0失败/跳过 | `output/team-linux-local-agents.log` |
| 实际Chromium | 35通过，0失败/跳过 | `output/team-linux-browser-tests.log` |
| 最终串行记忆评估 | status=passed；99通过，0失败/跳过；墙钟154.90秒 | `output/team-linux-memory-evaluation.json` |
| 最终编译后provider wiring | 通过；不启动任务/生命周期钩子 | `output/team-linux-wiring.log` |
| 最终Web运行镜像 | Docker build exit0；包含最终来源祖先检查 | `output/team-linux-docker-final.log` |
| ESLint、双端TypeScript、Stylelint | 全部通过 | `output/team-merge-lint.log` |
| 新增服务端spec显式TypeScript检查 | 24文件，0诊断 | `output/team-release-spec-typecheck.log` |
| Contributor context / 模块边界 | 15 / 10通过，context校验无错误 | `output/team-merge-context-tests.log`、`output/team-merge-architecture.log` |
| Compose与发布配置契约 | 4通过；两个开关独立透传 | `output/team-final-compose-contracts.log` |

最终本地镜像标识：`sha256:b908b5a2477830a73927e6f699d08a3fd5e75026b30e9b233a240d06dce4bc6e`。镜像只用于构建验证，未替换个人运行实例。PR保留三个必需检查：Lint & typecheck（含完整服务端、记忆评估、客户端、原生助手等）、Agent tests、Docker image build；不得用本地结果绕过这些检查。

新增真实HTTP错误契约、精确执行归因、普通日报左关联及Team报告不混入实仓Today的回归。后者使用真实Council/数据库和虚构provider HTTP，分别验证已保存指针、团队快照、来源会话和派生报告；用户的报告历史读取仍可用。

合并前独立审查另补岗位来源权限交集、依赖交付/工具上下文隔离，以及用户派生Team报告不得继承原采纳授权。用户历史论点复核另有真实PG回归：期限结束和解除绑定后可修订；来源撤回后拒绝新增正面内容和解除排除，但保留驳回、到期、排除及原团队归因。原Agent迟到发布仍按原期限阻断。

## 需求覆盖核对

下表为源码入口与验证归属核对，不代替63条验收场景各自的执行记录。原产品规格、原型及验收条件继续保留。

| 规格 | 实现入口 | 对应证据 |
|---|---|---|
| P01 导航 | app、workspace-navigation、移动更多菜单 | 导航/布局客户端回归与1440/390浏览器 |
| P02 首页 | PortfolioComparisonPanel、TeamDecisionComparison | 原曲线/账户卡回归，团队研究状态与真实判断对比 |
| P03–P04 账户资产 | AccountAssetsPage、account-context、PortfolioAssetsService、PaperAccountAssets | 真实PG账户隔离/只读、客户端切换与深链、导入屏障 |
| P05 团队列表 | TeamsPage、TeamsService、team-templates | 创建/复制/筛选与10模板结构/空授权 |
| P06 工作区 | TeamWorkspacePage | 已发布/草稿分离、真实组织编辑浏览器 |
| P07–P08 岗位与关系 | TeamInspector、TeamRelations、前后端team-graph | 部门归组、30岗位边界、矩阵汇报与环路校验 |
| P09 执行能力 | TeamRuntimeAdapter、连接检查 | 连接不等于能力，未证实隔离能力阻断 |
| P10 图形操作 | TeamCanvas、TeamOutline | 拖拽/归组/多选、列表等价操作、撤销重做 |
| P11 保存恢复 | use-team-draft、TeamStore、session storage | CAS、离线恢复、保存期间的新输入保留、归一化不误报dirty、登录切换清理 |
| P12 发布交接 | LifecycleDialogs、PublicationChanges、TeamVersionService | 逐字段差异、预览过期/幂等、在途清单、绑定竞争与归档 |
| P13 输入与委托 | TeamSources、CommissionDialog、TeamCommissionService | 精确来源版本、冻结账户事实、预览不调用模型 |
| P14 工作执行 | TeamGraph、Council workflow/store/executor | 真实Council单人/多岗/独立复核、工作去重、全委托修订额度 |
| P15 判断与追溯 | TeamWorkHistory、TeamDecisionService、execution links、ExecutionProvenance | 采纳/应用分离、实际signal claim、换队归因、报告/论点版本、账本反向链接 |
| P16 权限变化 | team-context、team-source-context、report-source-fence、investment-policy.fence | 撤销/派生来源防绕过、迟到发布阻断、旧规则交接边界 |
| P17 异常恢复 | CommissionRecovery、worker、原始响应回执 | 未知不重发、原结果再解析、取消结算、预算只能收紧 |
| P18 小屏与键盘 | teams CSS、Outline、Workspace | 1440/390真实浏览器、文字关系与核心表单路径 |

## 验证范围

真实供应商计费、个人原生CLI登录与实仓数据不用于自动验收。原生岗位只有实际能力元数据通过检查才能运行；未知能力显示阻断。标准A2A、资料自动触发研究和受控实验属于已批准的后续范围。

本次范围是Web实现及通过PR合入主干，不发布桌面安装包、不切换个人运行实例。启用方式见使用说明中的两个独立开关。最终CI与合并结果由该PR的检查和提交记录确认。
