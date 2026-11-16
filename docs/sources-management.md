# Sources：可编辑来源与固定内容分层

## 所有权

Sources 是第四张独立全页面 Database。它拥有来源身份、Provider、Location、Ref、选择范围、显式转换选项、启停与更新策略。Skills 通过 Origin Relation 关联它，并保存 Source Member；现有 Source 属性仍保存精确内容 pin，显示为 Selected Version。Files 继续通过 Skill Relation 确定唯一归属，来源可从该关系显示；不维护另一份可分叉的来源字段。Records 的 Origin Relation 连接来源版本与操作审计，原有归档仍不可变。

| 字段或内容 | 权威来源 | 显式来源刷新可做的修改 |
| --- | --- | --- |
| Selected Version（注册属性 ID 为 Source） | 审阅后的固定候选 | 选择完整验证的固定 Git 清单或保留源；不保存浮动 HEAD |
| following 文件与源资源 | 选中的固定 Source + 原有文件归属事实 | 按新 pin 合成；删除仍在 following 的绑定文件会阻止刷新 |
| custom 主文、资源与额外 frontmatter | Notion 作者与原有 custom 事实 | 保留完整字节；主文中同名额外 frontmatter 覆盖来源默认值 |
| Members / Requires | Notion 作者显式选定的完整关系集合 | 不写入、不重建；空集合也是明确选择 |
| Name / Description / Tags / Enabled / Default Context / 未注册属性 | Notion 作者 | 不写入；源名称差异只进入候选审阅 |
| View 配置 | Notion 数据库 View | 不访问写入端点、不重置 |
| Sources 的 Last Checked / Last Revision / Last Result / Status | 已完成的来源检查及其应用结果 | 完整检查后更新，并明确待确认、已应用、部分或阻塞；失败检查不冒充完成 |
| 历史 pin、归属事件、原始未知操作 | 不可变 Records 与原始操作凭据 | 保留，不把当前可见状态当成未知请求的成功回执 |

目标 Skill 的 PATCH properties 只包含 Source 的注册 ID。Records 只附加该次来源审计所需的 Origin；Sources 状态只使用表中列出的四项。刷新不会把读到的旧整行属性回写，因此在 Source PATCH 前发生的无关关系编辑仍保留。这是字段级写入边界，不是 Notion 原子 compare-and-swap；正文、归属或选中 pin 漂移仍需要重新准备。

Sources 单独保存可编辑配置，Records 保留不可变历史。普通 Skill 消费只依赖当前 pin、文件与已确认归属，不扫描 Sources，也不重新发现分支或成员。缺少所需字节时可以按冻结的 acquisition 位置读取精确 Git 对象、HTTP 资源或保留对象；只有来源管理命令读取可编辑配置并启动候选发现。

## 来源适配

适配器输出统一的完整文件集合、member key 与解析后的 revision。通用 Git acquisition 使用精确 commit/tree，支持 GitHub、GitLab 和自托管 HTTPS/SSH Git，不以 GitHub API 作为领域模型。Registry 复用已有明确版本的资源读取。Linear 使用只读 GraphQL issue/document 到文件的显式映射；updatedAt 加实际字节摘要固定一次观测，并不冒充可回溯的服务端历史版本。

本机认证与共享配置分离。Linear 使用 LINEAR_API_KEY，Git 使用本机正常认证。Shared JSON 不接受 token/password/authorization/header；不保存凭据，不执行脚本，不让 Notion 配置指定任意命令或本机文件路径。

原生 Selection 接受既有四字段对象，也接受含 `version: 1` 的同结构封装；两者具有相同
语义指纹，读取不改写页面。未知版本、额外字段及无效路径仍拒绝，不能借版本字段忽略过滤条件。

## 工作流

`ctl library sources list/show` 查询可编辑来源；`put --expect FINGERPRINT` 保存完整配置；`bind` 将一个精确 Skill/member 关联来源且不改变当前 pin。`check` 执行只读发现，`fetch` 导出指定成员的完整目录。显式 prepare/apply 将经过核对的版本冻结到 Records 后选择它；用户 custom 正文、旧 pin 和未结清操作不被来源更新覆盖。

存在“显示配置已改，但当前选择仍是原固定版本”的正常状态。更改 Sources 不自动更新正文；Disable 来源也不删除已发布内容。源配置、成员或当前 pin 在预演后变化必须重新准备。复杂旧共享发布标签留存但不能重新激活旧发布器；不支持的执行选项明确失败，不能静默丢弃。

## 数据库迁入约束

从保留的原始记录恢复 Sources 行时，原档案仍留在 Records。先建立稳定 ID 与关系，再逐项核对 Skill 的来源和成员；原生主文、支持页、资源包、custom/following 事件及旧 pin 不变。以当前完整审计报告计数，不把历史配置数量当作当前库存。已有来源过滤 View 需按审阅后的计划切到 Origin 关系；旧归档关系仍可解释历史。Sources、Skills、Files、Records 均在指定父页下，内部身份不依赖表名。

## 验证边界

来源列表必须完整分页，长配置需完整属性读取，重复 Source ID 或多重 Origin 不能以第一条兜底。核心、Node SQLite、公开 CLI、独立安装与真实服务分别留证。每次运行都使用明确 Source 和目标范围；真实外部 Provider 与受控测试分别报告。

## 日常命令

`ENTRY` 始终是 Skills 数据库 ID，不是 Sources 表 ID；`SOURCE` 可用稳定 Source ID 或来源页面 ID。

```bash
# 只发现、读取管理配置；members 走完整正向关系查询
ntn-skills ctl library sources list --entry ENTRY
ntn-skills ctl library sources show SOURCE --entry ENTRY
ntn-skills ctl library sources members SOURCE --entry ENTRY
ntn-skills ctl library sources providers

# 读取上游候选，不改变 Notion 正文、当前 pin 或来源状态
ntn-skills ctl library sources check SOURCE --entry ENTRY
ntn-skills ctl library sources fetch SOURCE --entry ENTRY --member skills/example --output ./source-files

# 保存完整来源配置；已有条目使用 show 返回的 fingerprint
ntn-skills ctl library sources put --entry ENTRY --input ./source.json --expect FINGERPRINT --dry-run
ntn-skills ctl library sources put --entry ENTRY --input ./source.json --expect FINGERPRINT

# 精确绑定，不改变当前文件内容；首次绑定期望值为 none
ntn-skills ctl library sources bind SOURCE --entry ENTRY --target SKILL_PAGE_ID --member skills/example --expect-origin none

# 单个已绑定 Skill 的显式版本推进
ntn-skills ctl library sources prepare SOURCE --entry ENTRY --target SKILL_PAGE_ID --output ./refresh.json
ntn-skills ctl library sources apply ./refresh.json --entry ENTRY --dry-run
ntn-skills ctl library sources apply ./refresh.json --entry ENTRY

# 原始选择操作核对；不重发写入
ntn-skills ctl library sources reconcile ./refresh.json --entry ENTRY
```

`prepare` 会读取完整上游候选、当前自定义正文和绑定，并将待选字节写入私有本地计划。计划包含资源，可能有敏感业务内容；不要上传到公开仓库。`apply` 不再次追逐分支，用原计划中的字节、fingerprint、member、当前 pin 和快照核对后执行。内容变化需重新准备；未知写入继续核对原操作，不能通过改输入强行重发。普通 `read/files/export` 仍使用同一固定快照接口。

成功 `apply` 可以反馈该次显式推进。有限的 `run --mode policy` 在完整检查后反馈检查时间、精确修订、可取得的提交时间、应用状态和保留的自定义路径；即使需要确认，也能区分“检查完成”和“内容已应用”。`check/fetch`、`run --mode check` 和 `run --mode prepare` 保持远端只读。Router 的 Members/Requires、启停和分类不由来源检查重建。

`check` 与新建 `prepare` 返回 `member_review`，按精确 Source Member key 比较当前完整 Origin 绑定与上游候选，列出新增、缺失和待确认映射。这个比较基线是当前来源绑定，不是历史上游目录，也不是作者的 Members。缺失项要求明确决策；不能按显示名替换或清空 Requires。新增成员通过 `admit` 或完整库存导入计划接纳。来源刷新忽略上游包里的关系字段，不能通过来源内容取得修改本地关系的权限。

当前来源工作流没有持续托管 Members 的模式。旧发布档案及其中的 baseline、显式 add/remove 和未结清操作继续保留，不能从当前差异猜造旧 baseline，也不能据此恢复旧发布器。若迁入的旧工作流仍声称持续管理成员，先审阅它的完整基线和增删意图，再明确选择当前 Notion 集合；不提供隐式 reseed 或自动跟随。

### 一次检查完整来源，按原计划推进

`--all-bound` 冻结该 Source 的完整 Origin 成员观察，并为启用的 Skill 形成逐项候选。上游只获取一次；未启用的绑定仍参与成员和重复身份检查。它与 `--target` 互斥。

```bash
ntn-skills ctl library sources prepare SOURCE --entry ENTRY --all-bound --output ./source-batch.json
ntn-skills ctl library sources apply ./source-batch.json --entry ENTRY --dry-run
ntn-skills ctl library sources apply ./source-batch.json --entry ENTRY
ntn-skills ctl library sources reconcile ./source-batch.json --entry ENTRY
```

批次保存来源配置指纹、成员清单、每项原选择与原操作。结果逐项报告；一项未知不会把其他项改成成功，也不会重建整批。来源状态反馈和内容推进是两个独立结果。`reconcile` 只核对原操作；当前 Source 值恰好等于目标值，不能证明响应丢失的请求已成功。

`--storage auto` 默认外部直取：未转换、完整且经固定字节校验的 GitHub 树只保存精确
commit/tree、路径、Git blob OID、长度、SHA-256 和执行模式；脚本、图片及其他资源不
因为出现在成员树中就上传Notion。Notion保留管理状态、归属、可读文档与实际custom，
源文件实体仍由固定上游提供。普通消费不追逐HEAD。

非GitHub来源、显式补丁、Git链接展开或不完整固定清单会返回带原因的
`SOURCE_STORAGE_REVIEW_REQUIRED`，不再自动打包。确需完整保留时明确使用
`--storage retained`，或在Sources配置 `options.storage="retained"`；显式fixed-git和retained
参数覆盖本次auto选路，source级显式retention不会被存储对齐命令偷偷撤销。LFS指针、
子模块、缺资源、校验失败、网络暂时不可用均不构成归档或放宽校验的授权。旧冻结保留
计划、旧pin和历史字节依原合同读取，发布新默认策略不会重解释旧操作。

### 获取通道与内容身份分离

标准Node CLI及同包SDK可以通过原raw HTTP或本机Git读取同一固定来源。机器环境变量
`NTN_SKILLS_FIXED_GIT_TRANSPORT=auto|http|git` 不进入共享内容身份或Source配置。
auto优先显式配置的API或标准运行时可复用的GitHub认证；没有这类API选择时才按选定
规模使用Git批取。未显式配置API的HTTP传输失败可切到同一commit/tree/blob的Git，
批量Git传输不可用时可用精确HTTP；哈希、树、权限和限流错误不换通道。显式git/http
不切换通道，显式API失败也不会偷偷改用别的入口。没有Git服务的嵌入式核心继续走HTTP，
显式git则明确失败。

Git通道使用临时bare仓库、完整commit/tree校验和选定blob批取，无checkout、不执行仓库
脚本；验证长度/Git OID/SHA-256/模式后才写入已有本机内容地址缓存。未请求的资源不因
元数据树读取而自动成为消费内容，warm本地对象不重新访问Provider。Git网络传输字节
未计量时报告unknown，不把它伪装成HTTP零成本。Git认证和可信本机URL重写只属于本机，
不复制到Notion；冷机器需具备自己的获取权限和通道。

### GitHub API 与已有 gh 登录态

API地址与认证由本机环境选择，CLI和SDK使用相同核心。它们不写入Source配置、来源ID、
固定文件清单、Records或导出文件。完整SDK `env`决定本次操作的配置与gh子进程环境，
不会因缺少环境字段而读取另一个宿主HOME/账号的凭据。

| 环境变量 | 语义 |
| --- | --- |
| `NTN_SKILLS_GITHUB_API_URL` | 完整REST API基址，可含路径前缀；缺省官方API。只接受无凭据/查询/fragment的HTTPS，loopback测试可HTTP |
| `NTN_SKILLS_GITHUB_TOKEN` | 为本次所选API明确提供的专用token；不保存到配置或共享存储 |
| `GH_TOKEN`、`GITHUB_TOKEN` | 只对官方GitHub API有效，按此顺序优先于gh已有登录态 |
| `NTN_SKILLS_GITHUB_AUTH` | `auto`默认；`anonymous`明确禁用环境通用token和gh复用，与专用token同时设置会报冲突 |

未配置自定义API时，认证顺序为专用token → GH_TOKEN → GITHUB_TOKEN → 已有
`gh auth token --hostname github.com`活动账号 → 无gh/未登录时的公共匿名访问。
gh查找只读、无交互、五秒上限，每次操作懒执行一次并复用；warm内容缓存命中不启动gh。
不会执行login、refresh、setup-git，也不读写gh凭据文件或修改全局Git认证。

自定义API只使用专用token或匿名网关，不把GitHub官方登录态发送给另一域名。网关若
自己持有公共只读凭据，客户端不需要token。示例仅设置该次命令，不修改任何全局环境：

```bash
NTN_SKILLS_GITHUB_API_URL='https://gateway.example/v1/github' \
  ntn-skills read 'SKILL_REF'

# 独立固定版本元数据核对：access只返回API地址及认证来源类别，无凭据值。
ntn-skills ctl library source inspect 'https://github.com/OWNER/REPO' \
  --commit FULL_40_HEX_COMMIT --root PATH_IN_REPOSITORY
```

自定义API同时用于commit/tree与精确Git blob读取。兼容固定返回JSON的公共Broker：
解码标准base64 blob信封，验证sha、长度、编码与实际Git OID；不跟随返回的url或
download_url。官方已认证API使用raw blob媒体类型，无需把token发到raw CDN。
所有路径仍验证原SHA-256/模式并复用已有本机对象缓存，不改变固定来源身份。

重定向一律拒绝，token不跨域。401、权限403与带配额证据的403/429分开报告；保留安全
Retry-After/reset信息，不轮换账号、降为匿名或换通道来规避限流。缓存/请求合并按本次
配置和认证服务隔离；已验证相同内容地址可以复用，未完成请求不能跨环境混为一次。
自定义网关本身可能有更小的响应上限和共享配额；客户端不能宣称已配置网关就无额度限制。
Git发现/clone仍是独立Git通道，API地址不改写remote，也不改变Source的管理策略。

### 对齐现有库的来源存储

```bash
ntn-skills ctl library sources storage review --all --entry ENTRY
ntn-skills ctl library sources storage prepare --source SOURCE --target SKILL_PAGE_ID --entry ENTRY --output storage.json
ntn-skills ctl library sources storage apply storage.json --dry-run
ntn-skills ctl library sources storage apply storage.json
ntn-skills ctl library sources storage reconcile storage.json
```

review只读取完整正向元数据清单，分开报告fixed_git、retained_bundle、Router和未证明
状态；不把已选bundle或目录存在当作原创建完成。prepare从不可变原创建/refresh证据
解析原commit，逐文件验证旧清单与该commit的path/hash/bytes/mode完全一致，再冻结
原v4 source selection计划。无原commit、源树内容不同、显式retention或原操作未完成
时逐项受阻，不以当前main替代，也不重建同名页面。

apply复用原来源选择journal和库内单writer锁，只改Selected Version并添加必要的来源/
操作证明，不写正文、不启用条目、不改Members/Requires或其他业务属性，不新增ZIP/
二进制对象、不删除旧保留包。custom/tombstone按原归属层保留，过去的pin仍可读取。
原metadata响应unknown时重复apply不重发，reconcile只核原回执。显式disabled目标仅
在该条作者操作范围内可验证，不扩大普通Agent目录资格。

SDK同核入口为reviewSourceStorage、prepareSourceStorageAlignment、applySourceStorageAlignment、
reconcileSourceStorageAlignment。每个计划是一个原对象的存储选择，不替代来源版本更新。
完整迁移后应再执行独立冷消费并逐字核对源资源；历史包仍保留，所以物理Notion存储量
不会因选中pin变化立即下降。历史垃圾清理是另一项需要明确保留策略的操作。

### 有限运行与策略

```bash
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode check
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode prepare --output ./candidate.json
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode policy --due \
  --max-requests 2000 --max-bytes 134217728 --duration-ms 300000
ntn-skills ctl library sources run-list
ntn-skills ctl library sources run-status SOURCE_RUN_ID --output ./original-candidate.json
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --update-following
ntn-skills ctl library sources run-resume SOURCE_RUN_ID --update-following
```

每次 `run` 都有确定终点和本地 run ID。`check` 只检查，`prepare` 形成只读候选，`policy` 按来源配置执行：禁用来源跳过；`pinned` 不重新发现上游；`manual` 保留待确认候选；`auto` 只推进满足当前保护条件的候选。`--due` 使用所选共享 Profile 对这些成员的来源检查周期；有多个成员时取最短上界，未配置的成员回退到 `options.check_interval_ms`。Source 自身间隔最小一分钟，最大 366 天；`auto` 必须明确提供它。此周期与 Notion 正文读取 TTL 分开。未带 `--due` 的明确检查不受周期拦截，仍遵守禁用和 pinned 策略。

启用来源中的已登记文件请求，即使没有新 commit、尚未到期或策略为 pinned，仍会在 `policy` 运行中处理。请求和结果分别保留；受保护条件阻塞的请求不会消失。来源检查不会安装定时器、守护进程或 webhook。

默认预算为 2,000 次实际 HTTP 尝试、128 MiB HTTP payload 和五分钟总时长。重试计入次数，排队与等待计入时长；已放行响应造成的字节超额会如实报告。Git 子进程受超时和整次调用期限约束，其传输字节不冒充 HTTP 计量。相同 state root 内同库使用本地写锁；跨机器仍须安排单一管理写入者，这不是 Notion 原子事务或跨机器锁。

`run-status` / `run-list` 完全离线。仍处于 running 的 checkpoint 可能是运行中或被中断；请求计量仅是最近持久 checkpoint 的下界。`outcome` 分别给出完成类别、任务是否完成、证明范围、作者内容影响和远端保留影响；逐项错误、请求反馈未核实或未知结果不会被包装成完整成功。手动候选的 `needs_decision` 返回准确的 `run-resume` argv。

`run-resume` 继续同一个本地、同凭据范围的原任务。它复用冻结候选、Source 指纹、原选择和请求身份，不重新发现浮动上游；固定版本的缺失资源仍可按同一固定身份读取。原正文 operation 已存在时只核对它，不重新生成正文请求。已完成步骤不会重复写入，原失败和预算保留在 `continuations`；checkpoint 失败后的已知正文 ID 前缀也要保存。缺少原 journal、原 plan 或完整请求清单时保持受阻。来源、成员、文件或请求身份变化不能扩展原任务范围。

准备候选时，结构化 `SHARED_REFERENCE_INVALID` 错误保留原 `code`、`message`、`details.from` 和 `details.href`，并在 `details` 标明 `target_page_id`、`source_member` 与 `preparation_stage`。阶段 `current_snapshot` 表示读取当前完整文件树时失败；`candidate_file_references` 表示合成候选与保留内容后的最终引用检查失败。这些字段随原 run 错误保存，可通过离线 `run-status` 回读；引用失败仍不生成可应用计划。旧 run 没有记录的成员或阶段不能据此补推。

| 退出码 | `sources run` / `run-status` / `run-resume` 含义 |
| --- | --- |
| 0 | 调用完成，没有阻塞或未知工作；检查或手动候选完成不表示已应用 |
| 3 | 有需要审阅、阻塞或失败的逐项结果 |
| 4 | 原结果未知或调用尚不完整 |
| 75 | 预算暂停，保留原计划与 checkpoint |
| 1 | 执行失败 |
| 2 | 参数错误 |

现有 Notion API 没有已证实的正文原子前置条件。自动运行遇到需要替换的可编辑正文时返回 `BODY_REPLACEMENT_UNSAFE`；需要建立的新 Markdown 页面返回 `INITIAL_PROJECTION_REQUIRED`。这类项不能报告为“Notion 页面已同步”。选择版本、实际页面表示、自定义基线与会话 pin 是不同状态，可用 `ctl library state` 核对。

### 一次显式来源维护

`run --update-following` 是本次任务的有限授权，仅用于 `policy` 模式。它先冻结完整候选和原 still-following 文件的 File/page/path、body hash、frontier、选定版本，再验证选择并逐文件使用现有 restore-follow 写入。每个正文只使用一次完整旧正文匹配，派发前必须仍是原 following 身份与前沿。最后新鲜读取完整文件树，核对固定候选与保留的 custom 字节。新 Markdown 没有已存在的原生页时仍受阻；此入口不负责接纳新成员或建立新页。

custom 即使字节恰好等于上游也保持 custom，不通过此标志解除。完整旧正文匹配缩小了覆盖窗口，但观察与 Notion 写入之间没有原子 CAS；默认自动策略仍拒绝正文替换。`run-resume RUN --update-following` 可对已保留的手动或只读 prepared 候选作同样明确决定，候选本身不换版。

同一来源任务也会处理已通过公开 `ctl file request ... --submit` 冻结的请求。Notion 下拉字段仅表达意图；没有原完整提交基线时不会擅自覆盖 custom。提交后的 request ID 固定，取消、改Source、改文件身份或改正文前沿都必须重新核对。正文成功但反馈失败时，下一次 `run` 或同一 `run-resume` 先核对原 restore ID，再仅补反馈。只有原 API 明确返回 `400 validation_error`、已分类为 definitive rejection 且负回执成功持久化，才允许随后显式调用开启新的反馈代。429、408、网关错误、未知代码和无响应保持未知；当前反馈字段相等不能补造原 ACK。

### 显式接纳和成员变化

#### 从手工追加的 Source 接手

在 Sources 中登记一个有效的来源配置，只建立发现范围，不会自动建立 Skills。
`Status=ready` 不代表所有成员均已入库。使用同一 CLI/SDK 纳管入口完成缺口对账，
不用手写稳定 Skill ID、预分配页面或直接补关系：

```bash
ntn-skills ctl library sources review --source SOURCE --entry ENTRY
ntn-skills ctl library sources onboard --source SOURCE --entry ENTRY --output ./onboarding.json
ntn-skills ctl library sources onboard-apply ./onboarding.json --entry ENTRY --dry-run
ntn-skills ctl library sources onboard-apply ./onboarding.json --entry ENTRY
ntn-skills ctl library sources onboard-reconcile ./onboarding.json --entry ENTRY
```

明确全库范围时用 `--all` 替换 `--source SOURCE`。每个被选来源只发现一次，准备时各成员
复用该完整观察。Skills 正向元数据完整分页，包括禁用条目；不依赖 View 或 Sources
反向关系的内联数量。`registered` 只表示已登记的当前身份和关联，正文健康仍为未观察。
重复成员、同名不同身份、未决创建、来源不可访问和不完整输入分别报告，不作为空库。
提供方已给出的不可取得资源/跨根引用不会被丢成一个泛化错误：失败details保留Source、
provider revision、原始from_path/href/reason、总数及前20项。截断标记说明诊断未全量展示，
不表示完整发现或允许接纳；可用原sources check读取完整提供方结果。

只处理一个来源中的指定成员时，重复传入 `--member EXACT_KEY`。它收窄本次对账与动作，
不修改 Notion 的共享 Selection；不能与 `--all` 混用。提供方仍取得完整配置范围，
不存在于该完整发现结果的成员明确失败。可将它与 `--bind EXACT_KEY=PAGE_ID` 组合，
只修复已审阅的旧页关联，不顺带接纳同一仓库的其他新成员。
没有 Source Member 的来源目录 Router 单独列在 `source_routers`，保留其作者管理的
Members，不冒充一个缺失上游 Skill。真正的 Skill 缺键仍须明确绑定决定。

固定 Git、保留包及其创建清单共用既有有界清单编码：完整逻辑清单上限 1 MiB，压缩封装
上限 180 KiB；文件内容继续使用既有独立对象与分块。普通事件、正文事实和未知记录仍受
64 KiB 上限约束，不通过截断文件目录或放大所有记录来让大 Skill 导入成功。

新的普通创建/来源接纳还可保留超过单条事实大小的完整 Markdown。原输入和阅读页基线
各自按既有 32 KiB 精确字节对象分块，每份文本最多 8 MiB；原始 CRLF/UTF-8 字节与
规范化页面正文分别校验，不合并为一份摘要。小文本继续使用原 v1 内联对象；新输入
分块头为 v2 `chunked_utf8_input`，正文复用既有 v2 `chunked_normalized_markdown` 读取协议。
块、整文与根记录均保持原 hash/长度/归属约束，缺块、篡改或未知派发不能由当前页面补造。
这不放宽 Notion 页面内容接纳，也不修改旧观察、正文更新和迁移操作的冻结政策。

失败输出不重复携带完整子计划正文。`recovery.original_plan` 保留原 operation/skill
身份，并说明完整输入是否在本次父计划中；执行与核对仍使用原私有计划文件。创建后失败
会单独报告已知原页面 ID，不能把该页面的存在或当前值相等当作成功回执。

一次 CLI 错误不等于已持久化的 `needs_review` 终局。原生创建先取得主页面 POST/ACK，
再验证其完整读回，之后才保留清单与完整源对象。首次读回在清单前被拒绝时，原页面
可能已经存在，而共享清单仍不存在。修复校验器后，先用原 `onboard-reconcile` 定位
阶段；对精确绑定原计划的缺 manifest/outcome，`next.argv` 指向同一文件的
`onboard-apply --dry-run`，而非要求不断重复只读核对。

该预览不授予继续写入的权限。明确应用仍由原 dispatcher 核验同一凭据作用域的完整
原 journal 和 native ACK，复用原页面响应，只处理尚未派发的后缀；原正文变化、缺ACK、
unknown native写入或已记录的终局拒绝仍阻止继续。真正的 `needs_review` 要走支持该
原计划类型的独立恢复，不得通过换计划、重建主页面、当前值相等或反复重试清除。

`onboard` 输出完整冻结计划与逐项摘要。缺失成员通过原创建事务接纳，默认保持禁用；
已有页面只有在其不可变固定 Git 来源能证明相同仓库和 member 时，才生成补绑定动作。
名字、字节相等或描述文字不足以取得身份。原生/保留型内容没有来源证明时保留待审阅，
不会新建一个同名替代品。原定制正文、历史 pin、Members/Requires 和启用状态保持不变。

审阅一个确切的已有页面并决定建立新的发现关联时，单 Source 的 `onboard` 可重复传入
`--bind MEMBER=PAGE_ID`。SDK 对应 `bindings: [{member, target}]`。目标必须是本次报告中的
`existing_identity_needs_review` 候选，具有完整唯一身份且尚未绑定其他来源；未知操作、
缺失成员和不完整身份仍不能覆盖。计划明确标记 `explicit_binding_decision`，表示本次
新的关联决定，不伪造历史上游归属。应用只补 Origin/Source Member，原自定义内容和
Selected Version 不变；后续更新仍须按原 custom/following 规则单独授权。

应用使用操作级 journal、写前来源指纹和目标前像检查；未宣称多页事务或跨机器锁。
同一主库的不同机器仍须安排单一管理写入者。`onboard-reconcile` 不发现新版本，也不
重发原写。部分完成保留每个子操作和原失败，执行结果的完成范围仅为冻结动作；最终
成员覆盖通过新的 `review` 核对。命令使用现有请求/字节/时长预算，返回实际用量；
Git 子进程字节未测量，不算零。含受阻项的结果退出 3，原计划和所有成功项仍保留。

`--source-timeout-ms` 限制每个来源的发现时间：单个 Source 默认 120 秒，`--all` 默认
30 秒。慢仓库、请求失败和总预算内未观察的来源分别留在部分报告中，不记为零成员。
失败成员保留原错误的 code/message/details；零可执行动作的计划不会建议直接应用。
这些限额限制一次调用，不表示该仓库永久不可用或完整文件验证可被跳过。

### 明确审阅保留型来源的已知失败

#### 原主页面的表格字面量修复

原主页面已经得到真实POST/ACK，但在首个共享manifest建立前，其普通表格加号被提供方
改为圆点时，使用独立的原页修复决定。它不清除旧日志、不修改原policy14/原计划，
也不接管其他正文改动：

```bash
ntn-skills ctl library sources recovery repair review original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --entry ENTRY --output repair.json
ntn-skills ctl library sources recovery repair apply original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --entry ENTRY --review repair.json --review-id REVIEW_ID --dry-run
ntn-skills ctl library sources recovery repair apply original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --entry ENTRY --review repair.json --review-id REVIEW_ID
ntn-skills ctl library sources recovery repair reconcile original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --entry ENTRY --review repair.json --review-id REVIEW_ID
```

审阅确认原完整输入和实际原页只在已识别的普通表格加号位置发生 `+ → •`，包括仅部分
位置改变的情况；代码、明确链接、其他文字和已有圆点均不能被归一化接受。新policy17
只用于显式修复提交，以已验证的HTML加粗span保护这些普通表格加号；不改变默认作者
policy15、旧导入policy14或已冻结但在真实服务中未生效的policy16转义候选。
原SDK入口为 `reviewSourceProjectionRepair`、`applySourceProjectionRepair`、
`reconcileSourceProjectionRepair`，与CLI使用同一核心。

明确apply只对原页面进行一次完整old-string匹配的正文替换，保留原身份、所有属性和禁用
状态。先保留完整review/前像与原allocation证明，再由既有durable guard处理该独立PATCH，
完整响应ACK与完成事实另存。whole-preimage匹配不是Notion原子CAS或跨机器锁。

修复完成不代表原导入完成：先核对同一原计划，再明确继续原onboard-apply。原创建的最终
结果绑定修复review与完成的精确hash，冷客户端缺任一证据都会拒绝。修复响应unknown时，
即使页面当前字面量正确，原导入也被pending屏障阻止，不能换命令绕过。同一原操作的每个
已支持修复版本只有一个独立决定，不能覆盖未知决定；原已持久化终局、额外原派发、
人工改文、缺原ACK或明确400拒绝不属于
这个原主页面修复分支，不能用新repair来制造权限。

仅有一个受限的版本接续：原v16请求已有真实持久ACK，且完整响应与该次原前像、
当前前像逐字节相同，才能审阅新的v17请求。旧v16的review/request/ACK保持不变，不
生成虚构完成；新的review v2绑定旧review的hash和完整原ACK，使用独立v17记录身份。
没有ACK、响应未知、实际正文变动、旧成功完成或其他版本不满足此分支。明确新apply
前再次核对本机原派发/ACK，独立冷消费则验证共享完整前任review及其绑定的真实ACK，
缺前任证据也拒绝。此规则不授权Guizang的400拒绝文件或一般重试。

#### 已分配支持文件的局部表格代码修复

对已经保存原needs_review的保留型来源导入，原文件可能实际出现表格行内代码
`•` 被补为 `  • `。普通导入比较继续逐字核对代码，不能将空白一律忽略。
`sources recovery repair-file review ORIGINAL_PLAN --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --path CHEATSHEET.md --entry ENTRY --output FILE_REPAIR.json`
读取原清单、失败、所有已分配页面的真实ACK、完整当前前缀及目标文件的物理表格。
只有整个文件仅有一个已识别的表格代码标记变动，且原表格行和其他富文本保持时才形成审阅。

沿返回的repair-file apply命令，以保存的review/review-id做dry-run，再明确执行。
它通过既有durable guard只PATCH原table-row的cells，除唯一代码span正文外保留全部
文字、注释、链接和格式；不重新提交完整Markdown，不创建替代File或Skill，不改原
源文件/policy/旧失败。原行所有字段及完整页前像在派发前重新核对；该局部guard不
宣称Notion原子CAS。完整前像、独立review及原分配证明先保留，真实row响应ACK、
完整页复验结果和独立完成后保留；长正文仍复用既有分块协议。

repair-file reconcile只读验证历史证据。修复完成后另行执行原sources recovery review。
原恢复review绑定完整file-repair证明hash集合；缺ACK、未知结果、缺完整正文或更换
命令都不能跳过。独立冷消费核验同样证据，不依赖作者Store。多处标记、其他代码
改变、错误父块、缺原ACK及未分配文件均写前拒绝。SDK同核入口为
reviewSourceFileRepair、applySourceFileRepair、reconcileSourceFileRepair。

物理更新后，提供方可能仅将该行已存在的裸主机自动链接序列化成带根斜杠的形式。
`physical_row_root_url_v1`完成策略要求原物理href不变、全文件原语义一致、修复行以外
逐字不变；作者原文存在明确URL时不适用该容差。旧无此策略的完成事实继续要求精确
候选字节。该规则不允许协议/路径变化、代码空白变化或行外格式变化。

当原row PATCH已有完整真实ACK、但后续读回或完成记录中断时，repair-file reconcile
返回completion_pending及同一计划的只读preview；preview明确table_row_patches=0。
下一次明确apply仅补写该原ACK支持的缺失不可变证明，不再经过行更新调用。缺ACK或
未知派发仍拒绝，当前页面相等不能制造完成权限，完整前像/review若丢失也不能重建代证。


#### 明确拒绝文件的独立新提交

原支持文件的 native POST 已明确返回 `400 validation_error`、完整负回执与原冻结请求
匹配且没有分配ACK时，可使用独立的审阅入口：

```bash
ntn-skills ctl library sources recovery resubmit-file review ORIGINAL_PLAN \
  --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --path EXACT_FILE \
  --entry ENTRY --output FILE_RESUBMISSION.json
```

完整review文件保留原dispatch、负回执与候选承诺；公开结果只给身份、hash和改动计数。
跟随返回的 `resubmit-file apply --dry-run`，核对后明确apply，再只读reconcile。
当前仅支持显式 `native_image_blocks_v1`：将纯图片段落中的相邻图片分为独立段落，
原image和外层链接token、完整文字/代码/明确目标保留。混合正文、列表、表格、代码与
HTML不改；旧policy14和默认15不变。不能手动改review或旧wire来扩张提交形式。

新请求有独立身份与真实ACK，不重发原拒绝POST、不把新ACK填入旧操作。缺完整负回执、
原ACK状态不明、原输入/Source/owner/确认前缀漂移均拒绝。未知新请求只能只读核对，
不能换review或命令重发。单文件完成后先只读核对原创建与保存的恢复审阅，再继续剩余工作，
不计为全Skill完成；不要求重新生成已有的原恢复审阅。
真实新ACK已存在但完成凭据尚未发布时，reconcile返回 `completion_pending`，下一步
仍先dry-run。预演结果的 `native_pages_to_create: 0` 表示后续apply只补完成凭据，
不再执行native POST；未知请求仍拒绝进入这一分支。
SDK同核入口为 `reviewSourceFileResubmission`、`applySourceFileResubmission`、
`reconcileSourceFileResubmission`；apply/reconcile的 `review` 参数接收完整保存文件对象。

#### 有界的API拒绝诊断

新400 validation_error回执保留已净化request ID和有限结构提示：公开body-schema
字段名、Markdown语法分类及可识别的行/列位置。原提供方message、用户属性名、正文、
签名URL和凭据均不保留。提示只用于定位，不改变明确拒绝/unknown或重发权限；来源
层包装及原拒绝journal保留同一安全信息。旧拒绝缺字段时保持未知，不补猜或为取诊断重发。

#### 已知语义终局的续接

已记录 `needs_review` 的保留型来源导入不能由普通 `onboard-apply` 自动越过。
在当前已分配页面仍完整、语义与原输入一致时，复用原 Sources recovery 命令族：

```bash
ntn-skills ctl library sources recovery review original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --entry ENTRY --output recovery-review.json
ntn-skills ctl library sources recovery apply original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --entry ENTRY --review recovery-review.json \
  --review-id EXACT_RETURNED_REVIEW_ID --dry-run
ntn-skills ctl library sources recovery apply original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --entry ENTRY --review recovery-review.json \
  --review-id EXACT_RETURNED_REVIEW_ID
ntn-skills ctl library sources recovery reconcile original-onboarding.json \
  --operation ORIGINAL_CREATE_ID --target ORIGINAL_MAIN_PAGE --entry ENTRY
```

不需要 Agent 抽取、重写或重新生成子计划；`--operation` 从完整冻结父计划选择唯一原创建。
单独原 admission plan 也保留原调用方式。命令会核对父/子摘要、来源、成员和库绑定。
普通 `onboard-reconcile` 仅在唯一精确的已知保留型语义失败时，提供原计划的只读review
下一步；unknown、非语义失败、错scope或多个混合失败不会获得自动执行权限。

本分支限定为原 v1 create、保留型 source_projection v2、native import policy14、初始
禁用且尚未发布任何文件归属事件的已知语义失败。先核对原失败事实、完整保留源/输入、
原本机journal及每个前缀页面的真实POST/ACK，再冻结原页实际完整读回与语义等价的审阅。
review/dry-run零业务写；明确apply仍由原创建执行器完成，只发送已审阅原计划的未派发
后缀。不PATCH已有正文，不换page/File ID、不解除禁用，不用当前值相等补造ACK。

新审阅和独立完成事实分开保存，原失败仍原样存在。冷客户端需核完整原失败、review、
原native ACK事实、所有文件事件、保留正文/资源和完整完成关系，才放行普通固定消费；
某条完成标签、当前页面或作者缓存不能单独构成成功。未知后缀不重发；精确可见的
不可变完成记录可只读核实。源码仍不承诺Notion CAS或跨机器exactly-once。

SDK 对应 `reviewSourceRecovery`、`applySourceRecovery`、`reconcileSourceRecovery`，
参数使用同一 `entry/plan/operationId/target/review/reviewId` 合同及已有凭据、取消和预算。
普通native restoration与旧fixed-Git恢复保持原版本边界。真正正文已改义、缺原ACK、
已有未知请求、变更来源或不支持的历史类型均拒绝；不能用新review“接受”丢失的原事实。

恢复过程中的新拒绝也保持原状态：某个尚未派发文件的 native POST 收到明确
`400 validation_error` 后，本次原创建不会自动重发或改写wire。该拒绝不是已确认的
成功页面，也不能用另一个review清除。错误返回原provider operation、完整创建operation、
文件身份/path、HTTP分类和 `native_retry_allowed:false`；不附带原文、资源base64或整份
大计划。旧回执没有保留的提供方说明不能补猜。需要改变该原输入的提交形式时，必须另有
支持该原计划类型的审阅/明确新请求合同，不能直接修改已有私有journal。

`recovery apply` 的错误与已执行结果都给出原计划/原主页面的只读reconcile argv；成功
dry-run才提供同一review的明确apply argv。argv按数组传递，路径含空格或特殊字符也不
拼成shell。只读预览、原状态确认和继续派发仍是三个独立决定。

SDK 的四个 Promise 入口直接调用同一 Core 和运行环境，不启动 CLI 子进程：

```ts
import { reviewSources, prepareSourceOnboarding, applySourceOnboarding,
  reconcileSourceOnboarding } from "ntn-skills/sdk"
import { writeFile } from "node:fs/promises"

const input = { entry, scope: { kind: "source" as const, source } }
const review = await reviewSources(input)
const { result: plan, budget } = await prepareSourceOnboarding(input)
await writeFile("onboarding.json", JSON.stringify(plan), { flag: "wx", mode: 0o600 })
await applySourceOnboarding({ entry, plan, dryRun: true })
// Only after reviewing the exact actions:
await applySourceOnboarding({ entry, plan })
await reconcileSourceOnboarding({ entry, plan })
```

各入口的第二参数沿用 SDK 的 `env`、`cwd`、`signal`、请求 metrics，并可设置 `budget`。
计划含原始输入，必须存入自有私密目录；不上传到公共仓库。下方逐成员 `admit` 仍用于
明确的单成员、高级来源或已有原操作处理；一般来源接手无需由 Agent 手工编排它们。

```bash
ntn-skills ctl library sources admit SOURCE --entry ENTRY --member EXACT_MEMBER \
  --skill-id NEW_STABLE_ID --output ./admission.json
ntn-skills ctl library sources admit-apply ./admission.json --entry ENTRY --dry-run
ntn-skills ctl library sources admit-apply ./admission.json --entry ENTRY
ntn-skills ctl library sources admit-reconcile ./admission.json --entry ENTRY

ntn-skills ctl library sources member-prepare SOURCE --entry ENTRY --target SKILL_PAGE_ID \
  --member EXACT_NEW_MEMBER --output ./member-decision.json
ntn-skills ctl library sources member-apply ./member-decision.json --entry ENTRY
ntn-skills ctl library sources member-reconcile ./member-decision.json --entry ENTRY
```

`admit` 使用现有创建事务保存完整输入、建立可读 Markdown 页与资源，并验证完整目录。默认新条目保持禁用；只有准备时显式 `--enable` 才在验证后启用。已存在的相同 Source/member，包括禁用条目，不能重复创建。来源提供的 Members/Requires 不获得本库关系写权限。

新 `admit` 计划与库存导入使用相同的 Notion 读回接纳规则。标题层级、空行、强调和
列表包装可以变化，初次完整读回会记录为阅读页基线。未接管文件仍消费固定来源的
原始内容，不能因阅读页排版不同自动变为 custom。正文缺失、代码或明确链接目标
被改动、原始资源不完整仍会阻塞。已冻结的历史计划继续使用原规则。

若 v1 固定 Git 接纳计划因已知的原生 Markdown 表示差异中断，可审阅同一原操作的有限恢复。支持的原状态与固定投影转换如下：

| 原创建状态 | 恢复转换 | 必须保留的原事实 |
| --- | --- | --- |
| v8 主页已确认、尚无创建清单 | v8 → v9 | 唯一原主页 ACK，原创建结果仍为空 |
| v9 主页已确认、尚无创建清单 | v9 → v10 | 唯一原主页 ACK，原创建结果仍为空 |
| v9 已有清单且记录 `SHARED_CREATE_BODY_MISMATCH` | v9 → v10 | 原 `needs_review` 结果、完整清单与已确认页面的有序前缀 |

```bash
ntn-skills ctl library sources recovery review ./admission.json --entry ENTRY \
  --target ORIGINAL_MAIN_PAGE_ID --output ./recovery-review.json
ntn-skills ctl library sources recovery apply ./admission.json --entry ENTRY \
  --review ./recovery-review.json --review-id REVIEW_ID --dry-run
ntn-skills ctl library sources recovery apply ./admission.json --entry ENTRY \
  --review ./recovery-review.json --review-id REVIEW_ID
ntn-skills ctl library sources recovery reconcile ./admission.json --entry ENTRY \
  --target ORIGINAL_MAIN_PAGE_ID
```

先检查 `review` 返回的完整决定、`review_id` 和 dry-run 写入上界，再执行原决定。首次恢复要求原凭据范围内的完整本地 journal、与原请求一致的全部派发记录和 ACK、原主页仍禁用、Source 与身份未变，以及每个已有页面的完整当前正文恰好符合对应的新投影。v10 前向预测已观察到的普通文本转义与创建文档的段落到代码块分隔；原输入、提交的 Markdown 字节和旧投影政策保持固定。

恢复保留每个已确认页面，只创建原计划尚未派发的支持页，并另存审阅、归属事件和完成事实。无原创建结果的操作继续保留这个事实；已有的 `needs_review` 结果也不会改写。独立客户端通过共享清单、原结果和完整归属事件核验完成，不需要原执行机器的本地 journal。只有完成记录与归属验证成功后，执行端才退休原 journal；历史输入继续保留。

缺失或篡改 ACK、未知请求、人工正文变化、来源或归属变化、额外原始派发均保持待核对，不能靠换页、改计划或重试绕过。已有正文不在恢复中重写。已开始的恢复再次调用只核对原结果；恢复的历史完成结果不返回当前快照，消费前仍须重新读取。

确认上游已移除成员而要保留当前内容时，使用 `member-prepare ... --retain-removed`，与 `--member` 互斥。它只解除后续发现绑定，保留 Selected Version、自定义正文、资源、用户关系和历史 pin。明确重新绑定也不自动切换内容版本。相似名字或字节不会自动生成改名映射。

完整本地 Skill 的三类导入、逐项授权与源树漂移检查见[库存审计与导入](inventory-import.md)。

### 导出与重导入关系

同库 Skill 的现有 `.ntn-skills.json` 可携带可选 `relations`，包含 `ownership: "notion"`、稳定 `library_id` 以及明确的 `members` / `requires` 逻辑 Skill ID 集合。空数组保留删除意图，省略字段不产生覆盖请求。目录导出、ZIP 备份和读取该包使用同一清单，不需要手工维护额外关系 JSON；没有此字段的旧 v2 包保持原有格式与行为。

显式导入或 `apply --input` 才会把该集合交给现有冻结元数据计划。所有目标仍按同库 Library + Skill 身份解析；跨库、缺失目标、同名替身以及与显式关系参数冲突的集合在写入前失败。完整导出中未改变的文件不会被重新写成 native custom：源资源、额外 frontmatter 与原归属保持。改变的正文仍受原生作者入口的完整校验约束；重导入不是跨库克隆或任意 frontmatter 编辑接口。

## 配置示例

以下 GitLab 配置也可换成 GitHub 或自托管 Git 地址。名称是来源标签，不会覆盖已绑定 Skill 的人类标题。

```json
{
  "version": 1,
  "source_id": "team-skills",
  "name": "Team Skills",
  "description": "Reusable workflows maintained by the team.",
  "enabled": true,
  "policy": "manual",
  "adapter": {
    "type": "git",
    "url": "https://gitlab.example.com/team/skills.git",
    "ref": "main"
  },
  "selection": {
    "roots": ["skills"],
    "include": [],
    "exclude": [],
    "mapping": {}
  },
  "options": {}
}
```

新建使用 `--expect absent`。`policy=pinned` 的 Git 配置必须指定完整 commit；`manual` 允许分支，并在明确的检查或准备中解析当前 commit。`auto` 使用同样的冻结候选，再由有限 `run --mode policy` 按保护条件推进；配置例如 `"options": { "check_interval_ms": 3600000 }`。保留的 `accepted_ref` 是额外固定选择，不能在未检查它的情况下把 Ref 展示值当成实际推进版本。HTTP(S)/SSH 是 Git 传输边界；共享配置不能指向 `file://` 或本机目录，私有仓库由本机正常认证读取，并遵守明确的共享保留权限。

Linear 来源明确把 issue/document 映射成文件，主入口必须有 `SKILL.md`；附属文档可保存到任意安全相对路径。凭据不出现在配置中。

```json
{
  "version": 1,
  "source_id": "team-review-linear",
  "name": "team-review",
  "description": "Review a proposal against the maintained checklist.",
  "enabled": true,
  "policy": "manual",
  "adapter": {
    "type": "linear",
    "resources": [
      { "kind": "issue", "id": "TEAM-123", "path": "SKILL.md" },
      { "kind": "document", "id": "11111111-1111-4111-8111-111111111111", "path": "references/checklist.md" }
    ]
  },
  "selection": { "roots": ["."], "include": [], "exclude": [], "mapping": {} },
  "options": {}
}
```

将示例 ID 替换成有权限读取的真实对象。issue 支持精确 identifier 或 UUID；document 使用 UUID。GraphQL 任一错误、缺失正文、返回对象身份不符都会拒绝形成完整来源。读取支持最多80个明确资源，单次响应上限8MiB，有界并发为4；不会根据页面文本递归访问任意链接、执行指令或扫描整座 Linear 工作区。

## 边界与恢复

- 共享管理选择以 Notion 为权威；本地只保存派生缓存和原始写入凭据。已确认的历史配置更新可再次有意调整，未确认请求不可用不同输入绕过。当前协议不提供跨机器写锁或 Notion 原子 compare-and-swap，管理仍需单写者。
- 一个 Skill 的主 Origin/member 明确且唯一。原有 shared_target_set 配置及来源归档被保留；多贡献者合并不能由单来源 refresh 整体覆盖，需要明确的固定 composition。检查和导出来源本身仍可使用。
- `prepare/apply` 针对明确已绑定范围；新成员必须 `admit` 或完整库存导入。取得合法目录不等于任意 Markdown 都能无损写成原生页面，不能丢弃无法表示的文件后启用。
- 自定义文件保持其完整正文；上游删除尚在跟随的原生文件、最终链接破损、文件归属变化和本地权限限制均会阻止更新。二进制/脚本可在完整资源包中消费，不执行，也不强制创建可编辑文本页。
- 原生页面的自动投影回写仍是独立能力：推进当前固定版本不自动覆盖用户看到的 custom 页面。当前读取会按归属合成完整目录。
- 初始化或字段变更采用明确操作，不以显示名推断数据库身份。原3表合同及旧pin可读，日用正式库使用4表；这是原模型升级和历史解释，不是恢复旧Upstream运行链。

## 原始计划的版本

固定 Git refresh v4 保存完整固定清单；保留源继续使用 v3。两者都绑定精确 Source 选择、`member_review` 和同一来源审计，执行复用现有共享元数据日志。新准备的计划另冻结可选 `display_baseline`，只包含原 following 文件的选定版本、身份、完整正文 hash 和前沿。旧计划没有此基线时仍可按原语义核对选择，但不能从当前页面补造旧正文授权。保存的 v1/v2/v3 计划不获得虚构的历史成员基线；失败或未知结果不会因新版本发布被改写。候选清单、来源审计和字节块在远端派发前检查单记录限额；长资源使用已有有界分块。

新操作把原请求、成功响应 ACK 和验证结果分别持久化。收到并保存原 ACK 后发生读回失败，可以在后续精确核对中确认原结果。没有原 ACK 的旧未知操作仍保持未知；当前布局或属性相等不能补造回执。
