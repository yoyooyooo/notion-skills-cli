# Skill 引用与导入关系的有限模型

本套件由 [资源状态验证 Skill](../../../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md)
维护。[执行配方](../../../.cursor/skills/verify-ntn-skills/features/skill-reference.md)
连接消费、管理和实际安装验证。产品约定见
[Skill reference contract](../../../docs/skill-reference-redesign.md)。

## 运行和结果

复用仓库现有 formal runner 与锁定的 pstack statechart、TLC 1.7.4。
工具目录和 jar 必须逐项匹配 [tool-lock.json](tool-lock.json)，不因本机安装了较新版本而跳过检查。
在已有双仓隔离环境选择明确 build，每次运行使用新的外部绝对输出目录。

    node scripts/verify-formal.mjs --suite skill-reference --out /absolute/new-reference-model-run
    python3 scripts/check-formal-mutations.py --suite skill-reference --out /absolute/new-reference-guard-run

PSTACK_STATECHART_ROOT 与 TLA2TOOLS 提供机器上的绝对工具路径，也可使用现有
runner 的 --statechart / --jar 参数。读取每项 pstack /statechart 报告、最短反例、
原始 TLC 输出和完整规则清单。图只展示检查后的状态，不替代实际源码回放。

ReferenceSelection 有 1 个正配置、12 个故意破坏守卫的配置；
ImportRelations 有 1 个正配置、10 个故意破坏守卫的配置。
所有配置保留各自模型的同一份完整规则清单，包括 NoDeadlock 和条件进展。
负例必须精确等于 coverage.json 中独立记录的 expected_broken。
工具错误、规则未执行、cut、超时和额外 broken 都必须失败。

## 引用模型

ReferenceSelection 分开 parsed、bound、selected、returned/rejected。
输入先获得可靠 Library 上下文，再查稳定身份或固定 manifest，最后返回引用。
模型允许默认 Library 与当前 entrypoint 在绑定、选择之间变化。

有限域包括两个 Library、两个重叠的稳定 Skill ID、一个仅同名的干扰目标、
六个固定 selection、三个文件路径、十五种输入场景。
每种环境变更至多一次。相同 Skill ID 和路径可以同时存在于 test 与 production。

| 规则 | 要阻止的结果 |
| --- | --- |
| ContextIsAuthoritative | 测试库正文里的短引用随默认配置跑到正式库，或缺上下文仍被解析 |
| ExplicitScopeConstraint | 完整 ref 指向 B，调用者却显式限定 A，仍继续选择 B |
| StableIdentityIsExact | 同名对象或其他 Library 的 manifest 冒充完整稳定身份 |
| DuplicateClaimRejected | 重复身份被任意选中一条 |
| MissingManifestRejected | 固定选择缺失后读取 current |
| FixedSelectionUsesManifest | 固定引用换 selection、借用实时 entrypoint 或补查实时路径 |
| SourceAuthorityRequired | 缺少或歧义 Source 映射时使用碰巧同名的缓存路径 |
| CrossSkillSelectionIsTargetOwned | 跨 Skill 后把来源 snapshot 当成目标 snapshot |
| ResolutionDoesNotWrite | 解析引用时顺便建立关系或执行管理写入 |

Resource 抽象的是已选权威与字节身份。它可以是 native/resource 的 File binding，
也可以是冻结 Source revision、原始路径与 hash/bytes/mode。Source 文件不必有
Notion 阅读投影行，因此模型和实现都不能强求或伪造 File ID。

模型把 manifest 的完整性、唯一 path 及 Source evidence 作为准入事实。
实际 parser、物理 owner、完整分页、权限和字节校验仍须独立测试。
选中 manifest 不代表所有字节已经缓存，也不授予访问权限。

完整 ref 自带 Library 可以覆盖 ambient default；这不等同于忽略显式 call scope。
`explicit-conflict` 把完整 ref 的 production 与独立显式约束 test 分开，
要求在 binding 前返回 `LIBRARY_SCOPE_MISMATCH`。它不禁止从 A 正文显式引用 B。
Library 字符串在本模型中抽象 canonical root UUID；具体 URL/UUID 规范化由 parser
回归验证，根页面及四表归属沿 current-lifecycle 的 LibraryLifecycle。

## 导入模型

ImportRelations 单独表示输入、冻结计划、对象创建、未知结果、
关系应用、验证、完成/阻塞。两个本地 Skill 可以形成循环 Members；
先建立全部对象，再应用冻结关系。这个分期不宣称 Notion 提供跨对象事务。

模型保留 Members 的 omitted、显式空集合、显式集合语义。
首次 omitted 可使用已确认的 active links；更新 omitted 保留当前作者选择。
Requires 只来自显式声明。再次导入发生在一次人工清空 Members 之后，
必须保留该选择，且相同完整输入不产生新的语义写。

有限域为一个明确的目标 Library、一个正式库干扰值、两个批次对象、
九种输入场景、每个对象的一次原 CREATE 和故意重放反例、
一次人工修改及一次重复导入。每次 CREATE 可以已知成功、接受后丢响应，
或结果仍未观察到。原意图恢复可以观察到结果或明确 blocked；absence 不授权重发。

| 规则 | 要阻止的结果 |
| --- | --- |
| ImportScopeRemainsBound | 恢复或后续阶段改用新的默认库 |
| ForeignRelationsBeforeWrites | 显式跨库关系在拒绝之前已经创建对象 |
| FrozenMembersIntent | 重试按后来观察到的候选重算关系 |
| ExplicitEmptyMembers / ExistingMembersOnOmission | 空集合或更新时的人工选择被推断结果覆盖 |
| RequiresOnlyExplicit | 从正文链接推断执行依赖 |
| RelationsAfterObjectCreation | 批次对象尚未就绪就应用最终关系 |
| UnknownCreateNotReplayed | 未知 CREATE 没观察到结果便再次发送 |
| ManualMembersPreserved / RepeatHasNoWrites | 重复导入恢复了人工删除的 Member 或制造无谓写入 |
| CompleteWasVerified | 尚未验证目标就声称完成 |

进展性质只在本地动作和外部观察最终返回、原输入被明确恢复的弱公平假设下成立。
blocked 是保留意图的可解释终点，不是导入成功。
模型不证明自然语言作者意图：Members 是可发现的按需成员，链接只证明目标身份。

## 实现对应和维护

[coverage.json](coverage.json) 保存本次审查基线、源码 hash、边界说明及完整配置。
[mutations.json](mutations.json) 保存实际源码守卫与行为测试的对应。
先读覆盖文件从基线到当前的差异和相关调用路径，再更新对应记录。
不得批量刷新 hash 制造通过，不能把 design-only 检查描述为实现证明。

每个实际 mutation 在独立副本中执行原件、破坏守卫、恢复原字节三步。
原件与恢复必须有真实通过的测试；破坏后必须出现对应行为断言失败。
语法错误、模块加载失败、fixture 缺失和 timeout 都不算捕获。
保留首个失败和其原始输出，下一次使用新目录。

当前 16 个实际守卫覆盖作用域绑定、重复稳定身份、manifest owner、固定选择和路径、
Source 坐标、跨 owner 的 pin、Members 三态、Requires 禁止推断、冻结步骤、
完成后的只读核对、未知非幂等写与 SQLite 完整身份持久化。
导入模型中的 CREATE 不重放对应共同 operation kernel 的非幂等动作边界；
追加动作反例检查该 kernel，公开 batch 用例另行检查真实 CREATE 重试。
SQLite 地址编码和任意字节不在 TLA 变量中，持久化守卫检查实现对抽象完整身份的保持。
portable 原库上下文在导入前的正文归一化也属于具体实现边界。第 16 个守卫移除
原库绑定，用目标库的同 ID 对象重现误推断 Members；它关联 ContextIsAuthoritative
这一实现义务，不表示有限模型已枚举 portable 转换。single、batch 和 members-plan
分别检查原库保留、授权的精确改绑、固定引用和省略／空集合关系策略。
完成这些对应记录不代表已运行：以独立运行的 baseline、变异和恢复回执为准。

内容 writer、请求预算、MCP Auth/Search、会话 pin 与最终投递继续归现有模型和领域所有。
任意规模批次、真实 Notion 页状态、CLI 进程崩溃与 SQLite 持久化、打包模块及真实模型
的行为另行验证。通过本套件不能代填 live Notion、安装或 Pi 结果。
