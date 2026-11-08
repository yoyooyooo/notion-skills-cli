# AH-681 来源批次与固定资源验证

这里定义 NR11/NR14 的公开观察点。执行结果、真实页面、安装包 hash 和原始请求账本保存在 checkout 外；本文不把规程当成通过记录。

| Case | 公开入口和合同 | 必须失败的反例 |
| --- | --- | --- |
| NR11-schema | `ctl library init` / `sources init` 的 Files Origin 按实际 Notion rollup 合同核对：外层属性 ID 保留 URL 编码，嵌套 relation/rollup ID 与其一次解码后的值相等，function 必须为 `show_unique`；原 ACK 后读回误差沿同一 journal 补本地 receipt，不重写已创建字段 | 真正不同的关系、目标属性、function 或重复解码不得通过；仅当前值相等但原 ACK 缺失仍 unknown，不追加完成 descriptor |
| NR11-batch | `ctl library sources prepare SOURCE --entry ENTRY --all-bound --output PLAN` 对完整 Origin 分页只获取一次 provider snapshot；每个 enabled Skill 固定同一 revision、Source ID/fingerprint、member、旧选择、有效文件树与 custom 状态 | 缺失 member、截断/重复成员、不可用依赖、准备期间 Source 配置或绑定集合变化不得输出可应用批次；同 URL 不合并不同 Source ID |
| NR11-single | 原 `--target PAGE` 路径保留；`--target` 和 `--all-bound` 必须二选一 | 缺失/冲突选择在任何远程访问前失败 |
| NR14-partial | `sources apply PLAN` 按原子操作的成员边界执行；每个结果保留原 plan/selection ID，明确整批不原子；已有成功、失败和未知分别输出 | 一个成功、一个失败、一个未知不得显示全批 applied，不得用当前 Source 等于候选伪造原操作成功 |
| NR14-resume | 同一 frozen batch 再次 apply 复用各成员原 journal；reconcile 只核对原回执，零语义写入；本地批次结果按独立运行保存 | 未知 POST/PATCH 不重发；失去原始可见性不猜 applied；current body/source/frontier 变化拒绝过期选择 |
| NR14-preserve | 复用现有完整保留与选定内核，不覆写可编辑正文，不重置 Members/Requires、custom/tombstone 或旧 pin | 必需对象缺失、坏 hash、不完整树和未确认人工编辑不得推进选择 |
| NR17-fixed | 默认 auto 对完整无修改公开 GitHub 原树冻结 v4 候选，复用 source- 选择与按路径消费；--storage retained 明确选择保留副本 | 缺 Git manifest、patched/linked/portable 转换不得冒充原Git树；管理字节的Git OID/SHA256/长度均验证，LFS指针拒绝；公开传输不可达时不偷偷换HEAD |
| NR17-git-url | 新管理输入允许公开 GitHub 克隆 URL 的 `.git` 后缀；admit 与 refresh 复用原输入解析，在构造固定绑定时得到同一个 canonical URL，保留原 Source 定义、commit、tree、路径、SHA256 与 mode | 已持久化的非 canonical `.git` 描述符仍须拒绝；不能更改原 Source 配置、重新选分支、放松旧绑定身份校验或省略原字节验证来使准备成功 |
| NR25-create-spacing | 新 v9 创建投影前向冻结已独立观察的顶层单 LF 与 ATX heading/paragraph 分隔；原 input/wire 和旧 v1–8 均保持。已 ACK 的原 v1/v8 创建只能经同原操作的显式恢复审阅，完整原 journal/ACK、disabled owner 和精确当前正文均须可验证 | 不得 trim 返回正文、修改已派发 plan、猜测未知 ACK、重放 POST 或换页补建；code/list/quote 与未观察空白不泛化；非精确新预测的人工正文变化继续拒绝 |
| NR25-node-startup | 原生 Node 新进程从审计入口加载共享模型并通过真实 SQLite 启动、续跑和离线报告；复用 `shared-audit-sqlite.node.test.ts`，再运行完整 prefix recovery 与 Source 定义反例 | ACK schema 不得依赖来源执行模块的初始化顺序；Bun 或打包入口通过不能代替 Node 原生 ESM 冷启动；保留实际循环初始化失败，不能用动态导入或延迟校验绕过 |
| NR17-cold | 清空派生对象后 apply 仅按候选 commit/文件身份获取；read/files/use/export 消费同一选择，旧 bundle 与pin可恢复 | 一个必要资源取回失败或hash不符不得先选择；未知注册不重发；读取一个资源不能重新解析分支或枚举仓库 |
| NR15-run | `sources run SOURCE --target PAGE 或 --all-bound --mode check/prepare/policy` 是有请求/字节/时间预算的单次工作；disabled/pinned/manual/auto、due 与独立文件请求分别判定 | 无新commit或未到期不得吞掉显式restore请求；editable正文无原子条件时停止自动覆写；同state-root重叠执行不重复获取provider；跨机仍声明单writer部署边界 |
| NR15-original | `sources run-list` / `run-status ID` 离线恢复ID和原frozen plan；中断checkpoint的成本是下界，不能宣称已完成 | 失去stdout、SIGKILL、预算暂停、当前值相等不能授权重新派发未知写；Source Last Checked仅在完整成功检查后更新，与application结果分开 |
| NR16-admit | `sources admit`冻结新成员并复用原create kernel；`admit-apply/reconcile`接纳/核对；新成员缺省disabled，显式enable在完整性验证后生效 | 同Source精确member已绑定、缺文件、旧definition、初始POST响应丢失均不得同名重建；all-bound更新不自动接纳新成员 |
| NR16-member | `sources member-prepare`显式改绑或保留已移除成员；apply只改Origin/Source Member，Selected、正文、关系、custom/old pins保留 | 仍存在member不允许假称removed；不按同名/hash猜rename；原binding或selection漂移零写；当前binding相等但无原receipt仍unknown |

先跑 focused core 和 CLI parser cases，再驱动独立安装的 Node CLI 与自有三成员真实样本。记录 metadata/body/provider/semantic write 成本、完整输入输出和所有失败。受控故障只能证明被实际注入的分支，不能替代真实 Notion、全库存或 Pi/Mini 验收。
