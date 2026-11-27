# 智能缓存的证据与准入合同

本切片属于现有 `current-lifecycle` suite，由资源状态验证入口维护。
四组缓存合同和一组能力边界共 16 个配置，沿用同一 runner、严格结果判据和
`c742dd61706fbacc1b95f1a20b7b988cf096ce6c` 工具锁。它不建立新的缓存 owner 或验证平台。

## 事实与决定

CLI/Core SDK 持有持久证据；Broker 持有宿主意图、接收 ticket 和已接受的会话选择。
一项缓存不能仅由 fresh/stale 表示。至少分别判断字节、身份/权限、当前性、
集合及依赖覆盖、固定选择、在途工作和时间。新 current 可消费是这些事实的派生结果。

| 证据 | 可以改变的事实 | 不提供的保证 |
| --- | --- | --- |
| Hint | 安排相应复核 | 内容未变、完整集合或新成功时间 |
| 合格 metadata observation | 其精确对象、字段或完整查询范围的观察时间 | 其他依赖、未查询成员、实际正文验证时间 |
| 实际 body proof | 已验证字节及其真实验证时间 | 当前选择、权限或整个依赖闭包永远有效 |
| ChangeNotice | 相关旧依据失效；跨进程保留 | 失败后自动回到“未变” |
| KnownDenial | 对应 scope 或精确对象的受保护读取受限 | 将业务 Disabled 等同于权限 Denied |
| Unknown | 保留未被推翻且仍在原期限内的证据 | 续期、清 dirty 或清 denial |

证据记录绑定 credential/API origin/account scope、Library、逻辑身份和物理 owner，
并注明实际对象/字段或集合、分页完整性、观察时间和验证依据。相同 hash 或 locator
不能转移权限。新 schema 缺少字段只能补验或降为 Unknown，不能通过兼容解析升级强度。

Unknown 回退同时要求：无相关 dirty、无 known denial、原 read 与 body 期限仍有效、
身份/资格/字节和闭包完整。成功 metadata unchanged 仅更新对应观察；
缓存命中、失败和取消不推进时钟。native 的 `body_verified_at` 由实际正文验证更新。
模型中的 2/3 个时钟格只是边界取样，不是新的产品 TTL。

## 状态转换与本地接纳

| 边界 | 守卫与动作 |
| --- | --- |
| 开始检查 | 捕获相关事实依据；记录请求尝试身份，不把开始请求当作远端变化 |
| 接受变化 | 只推进相关 accepted-fact epoch，并保留 dirty/denial |
| 接受未变 metadata | 范围完整、身份有效、依据未失效；仅推进合格观察时间 |
| 准备闭包 | root、Requires 各节点及完整成员集合都被覆盖 |
| 最后接纳 | 比较完整相关读集和请求退休状态；root 成功不能替其他节点背书 |
| 固定读取 | 使用已接受的各节点版本；后台 current 更新不改写 pin，权限守卫继续适用 |
| 结束或重试 | 使用原请求总预算；提示不重置预算，最终 Ready 或 Unavailable |

`attempt generation` 排序尝试并阻止迟到/退休请求发布；
`accepted-fact epoch` 表示已接受的相关事实变化；远端 revision 表达其远端对象。
三者不能互换。两个进程反复得到 unchanged 不应彼此制造 dirty 或无限重试。

当前实现的 `CurrentEvidence` 分别保存事实指纹及其 epoch，以及 scope、物理页面和
显式逻辑记录及 current-evidence 尝试域的 `retired_through`。`capture` 核对候选实际使用的 expected fingerprints，
不能把此刻最新事实直接贴到旧候选上。`matches` 在同一 SQLite 读事务中核对全套事实、
退休边界和 known denial。权威成功发布只可消解它自己的逻辑记录拒绝，不能豁免
scope、物理页面或其他依赖的拒绝。

最终接纳边界保证候选不与此刻本地已知事实冲突。Notion 的多页读取不是远端原子快照。
已经接纳的历史决定也不会因随后合法编辑而被追溯改成当时错误。

## 模型与反例

| 模型 | 配置 | 有限范围与反例 |
| --- | ---: | --- |
| ObservationSafety | 6 | 一个对象、一个检查、最多两个变化/拒绝，时间 0..4；失败续期、metadata 续正文、旧结果发布、忽略 dirty、忽略 denial |
| ClosureEvidence | 3 | root、一个 Requires、一个 Files/Sources 集合，一次尝试且旧 TTL 始终有效；局部覆盖续全图、遗漏完整读集 fence |
| SelectionPins | 3 | 两个版本、一个会话；普通读追上游、后台 current 改写 pin |
| AdmissionProgress | 2 | 一次请求、最多两次失败或失效尝试；提示重置预算导致无限循环 |
| InformationLimit | 2 | 无隐藏编辑的对照，以及允许一次隐藏编辑的预期反例 |

每个模型的配置使用同一份独立审阅的完整规则清单。十个故意缺陷只应失败声明的规则；
语法错误、工具异常、未检查规则、cut 和超时不算有效反例。InformationLimit 的反例
是信息能力边界，不能算作生产缺陷或要求产品杀死的 mutation。

AdmissionProgress 在 Start 和 FinishAttempt 的弱公平假设下保证结束：
每个开始的检查最终返回或超时，并且可运行步骤最终被调度。Unavailable 也算解释完成，
不承诺永久网络故障下仍能成功。NoDeadlock 不能代替该时序性质。

原设计分析有 15 个配置；现役接入只为 InformationLimit 补了“没有隐藏编辑”的
对照，不改变原反例，也不放宽现役每模型须有正负配置的检查。其余 14 个配置保持
原合同。各模型分层检查义务，不构成自动组合或生产代码 refinement proof。

## 运行与 statechart

按套件 README 配置锁定工具，输出使用本任务新的外部目录。一个 `--model` 会运行
该模型的全部正负配置，适合在实现过程中定位；正式套件仍包含现有全部 61 个配置。

```sh
node scripts/verify-formal.mjs --suite current-lifecycle \
  --model ObservationSafety --out /absolute/new-observation-run
node scripts/verify-formal.mjs --suite current-lifecycle \
  --model ClosureEvidence --out /absolute/new-closure-run
```

同样可选择 SelectionPins、AdmissionProgress、InformationLimit。
现役 runner 从同一 TLA+ 结果生成 statechart、规则报告和原始 TLC 输出。
大状态空间可能超过图绘制预算，此时保留完整探索结果与实际反例图；不能把图折叠
或未绘全图解释成少检查了状态。ClosureEvidence 的 view 保留逐项覆盖和准备后变化，
不隐藏会影响性质的路径。

## 实现对应与证明结束点

`coverage.json` 的 `smart_cache_review` 和模型 `status` 分开记录合同接入与实现绑定。
`reviewed_bounded_contract_with_production_correspondence` 表示已经核对实际守卫、行为回归
和必要 mutation 的对应，不是执行通过的替代回执。最终候选仍须运行现役完整套件；
不能以旧实现 hash 未变或开发副本通过来声称该候选已验收。

ObservationSafety 对应缓存证据和持久失效，ClosureEvidence 对应完整图准备及本地接纳；
SelectionPins 对应显式 Source 选择与 Broker 已接受 pin；AdmissionProgress 对应原调用预算。
既有 SQLite generation/retired_through、known denial、native 正文独立期限继续保留。
实现绑定需指向实际函数和测试，而非为每条性质虚构一个可删除的 if。

现役 mutation runner 增加 `source-ref-late-result-return`，移除
`reuseSourceRefObservation` 在 SQLite 拒绝迟到写入后的最终返回检查。
对应 Node 回归使用真实 Git、SQLite 和两个独立 OS 进程，断言旧进程不能覆盖或返回
早于新接受观察的结果。这条回放绑定 `NoOldResultPublication`；实现验收仍要求原件通过、
删除守卫后行为断言失败、恢复后通过的完整记录。

`current-evidence-publication-fence` 移除 SQLite 当前观察发布事务中的 `evidenceMatches`
判断。对应回归先保存合格观察，再由另一个进程接受新事实，要求旧候选发布失败且
原观察保持不变。`current-evidence-closure-fence` 删除 `graph-prepare` 实际调用的
`assertCurrentEvidenceSet(currentReadSets)`。它复用原生图 fixture 和真实 Store，先成功
准备 root + Requires，再在热缓存 Requires 的派生目录读取期间接受 root 新事实。
删除最后守卫会返回 Ready，正常实现必须返回 `CACHE_INVALIDATED`。这条回放覆盖
实际调用点，不以 helper 单测代替图准备接线。

`current-files-complete-pagination` 移除 Files query 的分页结束条件，让查询在第一页
提前结束。正常初次读取仍可完成；之后的两页查询若把首个空 partial 页当作完整集合，
必须在现有 Native 回归中触发行为断言。这条回放绑定 `FullClosureEvidence`。
外层 `request_status` 检查与公共 list schema 仍是冗余防御；只删其中一层后安全拒绝，
不能仅凭错误码不同把它记成内容错误的 mutation 检出。
原有 25 条生产回放和这四条合计 29 条。

原 `current-read-final-fence` 回放现在同时移除 root page fingerprint 与原
`consumptionFence` 的比较。只删后者时，现有 writer 反例仍被新增 page 比较拒绝；
这个存活结果是冗余防御证据，不记作 mutation 检出。组合变体仍检验原来的
`NoMixedCurrentPublication`，没有添加新的生产缺陷数量。

| TLC 最短坏路径 | 对应的生产边界 | 决定性回归 |
| --- | --- | --- |
| 开始检查 → 接受变化 → 旧检查完成 | Git 接受 slot 的最终重读，SQLite current fact 的尝试排序 | 新 ref 被接受后旧进程不能返回旧 ref；旧 current fact 不能覆盖新事实 |
| 完整闭包准备 → Requires 或集合变化 → 旧读集发布 | 事务中的 `expectedCurrentEvidence`，图准备最后的完整 read set | 写前变化保留旧 observation；Requires、完整 Files 集合与图末端变化均阻断接纳 |
| 已知拒绝 → 新会话仍消费 | scope、页面和逻辑记录的拒绝及退休记录 | 跨进程写入拒绝或退休后，事实未变也不能通过 read set 或根节点发布 |
| 远端隐藏修改 → 在原期限内读取 | 信息不可见的能力边界 | 不声明可由生产 guard 检出；保留原期限和真实远端验证边界 |

同一 CI suite 也运行 `shared-target-snapshot.test.ts` 的 metadata/body 独立期限回归、
`shared-current-source-check.test.ts` 的选择和配置比较，以及
`shared-source-ref-cache.node.test.ts` 的真实进程共享与迟到结果回归。
`current-evidence.node.test.ts` 使用真实 SQLite 和独立进程覆盖 unchanged epoch、ABA、
旧尝试、expected fingerprint、同事务发布、完整读集和上述 actual graph 调用点。
同一图 fixture 还覆盖固定版本在派生目录读取期间新收到页面拒绝：snapshot 返回与
图最终接纳前重复原有权限检查，必须拒绝 Ready；仅 metadata 变化的配对用例仍保留
相同 pin 和字节。固定版本不承担 current 指纹检查，这个晚到拒绝的时序边界也不声称
已被 SelectionPins 的有限状态枚举。

不可变 snapshot 的存储值与 tree proof 另有真实实现义务：相同 snapshot ID 的重复
refresh，以及两个首次写者都观察到 missing 的交错，必须以实际 Store 中的不可变赢家
绑定完整 manifest 摘要。`created_at` 保留该 manifest 的首次值；本次真实远端观察仍
推进自己的 `validated_at`，本地命中不续期。真实 SQLite 回归与三个独立 Node SDK
进程检查双 refresh 后的五分钟暖读 0 HTTP、原正文/ref/验证时间及未选资源仍惰性；
Broker 的 `source-materialize-native-root` 负责管理前后重复选择接入实际 Pi 的交接。
这些序列化字段、SQLite 首次写入和实际进程的性质没有被本切片的有限时间格建模，
不能由现有模型通过代填，也不减少 manifest 校验或改变独立正文期限。

生产回归负责真实 SQLite/进程重启、多检查并发、时钟异常、权限恢复、任意实际图和
动态成员变化。真实 Notion 负责元信息、分页及实际 API 观察边界；安装后两个新 Pi
及普通 $ 入口负责完整 root + Requires 进入 provider 和全部前后台 HTTP。
这些边界不由本切片的抽象验证动作替代。

