# 原生导入子模块

归属 [verify-notion-management](../SKILL.md)。本模块将源文件保留、页面阅读投影和固定消费视图分开。页面内容校验与源字节校验缺一不可；不新增通用恢复器。

## 选择原入口

```sh
bun test packages/core/test/shared-import-markdown.test.ts packages/core/test/shared-source-projection-retained.test.ts packages/core/test/shared-create-projection-continuation.test.ts packages/core/test/shared-create-restoration.test.ts --timeout 60000
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/shared-record-codec.node.test.ts
```

安装代表用 [来源接手Skill](../../verify-notion-source-onboarding/SKILL.md) 的真实Git/Node/SQLite入口。普通创建/修复/真实Notion依 [原规程](../../verify-ntn-skills/features/import-create-recovery-dry-run.md)。不要用一种架构路径的成功替代另一种。

## 必须保留的三类反例

| 层 | 可接受 | 必须拒绝 |
| --- | --- | --- |
| 物理记录 | 已知有界清单压缩、原32 KiB字节分块、完整冷重建 | 缺块、错hash/长度/模式、非canonical布局、普通事实越界 |
| 页面语义 | 既有版本化标题/列表/样式转换 | 加号变圆点、代码变化、明确链接换目标、文本丢失 |
| 原操作 | 完整原ACK证明的已发送前缀和未发送后缀 | 当前页面相等补造ACK、换policy修改旧plan、重建新页规避失败 |

具体语义回归至少包含表格字面量加号、代码内相同字符、显式链接、自动域名链接、代码围栏。错误应能定位原file/path/page与不匹配成分，输出不携带完整正文或签名URL。任何“修复”还须有相邻负例：合法表现变化可通过，真实内容变化仍失败。

## 真实失败到修复

先用原失败返回的真实page_id读取完整原生正文；不要从人工说明转抄另一页面ID。把原输入、实际输出及独立比对留在私有证据中，只将最小无私有数据的复现加入仓库。保留原业务失败和写入权限，先判断代码/转换器缺陷还是提供方实际改义。

改变新创建的wire转换必须版本化，旧冻结policy保持。先核对实际失败阶段和持久事实，不能仅凭一次CLI错误推断已经存在终局 `needs_review`：

| 原事实 | 合法路线 | 禁止推断 |
| --- | --- | --- |
| 主POST已获原ACK，首次读回被拒绝，manifest尚未写入 | 原plan的reconcile→原plan只读预览→明确apply；原dispatcher核查完整journal/ACK，只执行未派发后缀 | 错误返回等于终局；缺manifest等于缺主页面 |
| native POST/PATCH结果unknown或原ACK/日志不全 | 保留原操作，只读核对；不以当前页面代替ACK | 现在看得到页面即可重复写入 |
| 已有不可变needs_review终局 | 使用确实支持该原计划类型的明确恢复入口；当前正文变得相同仍不能抹除失败 | 原plan重试自动越过终局 |
| 完整原结果已确认 | 同plan重复只读复用，独立冷读取完整树 | 重复创建替代页或重新发现上游 |

`shared-source-projection-retained.test.ts` 同时覆盖上述可继续与必须拒绝的分支。普通native restoration不能代替带source_projection的已终局创建恢复；确实缺能力时保持blocked，不能直接PATCH失败页面再称产品闭环。只读预览只是前置诊断，不能授予原状态机没有的写入权限。

## 完成判据

确定性保存/校验先于派发；原操作执行后独立冷客户端读取完整资源；正反例、原ACK/unknown和重复无增长都实测。源测试、独立安装、真实Notion读回、恢复可用性分别记录。结构检查和单次成功不构成全库完结。

## 原主页面的有限字面量修复

执行 `bun test packages/core/test/shared-import-table-literals.test.ts packages/core/test/shared-source-projection-repair.test.ts --timeout 60000`。
policy17只改显式修复wire，旧policy14与默认15不变；审阅识别原表格普通文本加号的部分
`+ → •`变化，原代码/链接/其他文字必须一致。该诊断不能进入普通import成功判断。

原主POST/ACK和未建manifest的原journal授权独立review；一次完整preimage PATCH
只改原正文。测试必须覆盖：两种unknown可见性、从另一个original apply入口绕过的尝试、
缺ACK/日志、源/owner/正文漂移、同计划重复无写，以及冷消费者缺review/完成仍拒绝。
原create完成绑定独立修复证据hash，不能只由当前值变正确就放行。已经持久化的终局或
明确未应用的文件POST是不同授权分支，不为了跑完测试而复用这个修复。


## 保留型来源的明确终局审阅

同一原dispatcher负责新的retained native import审阅：执行
`bun test packages/core/test/shared-create-retained-recovery.test.ts --timeout 30000`。
覆盖真实已知body-mismatch→独立review→零写preview→仅原未派发后缀→普通原操作reconcile→
清空本地缓存后的完整消费。缺journal、错ACK、body/owner/Source/definition漂移、篡改审阅、
未知后缀（可见/不可见）、丢失完成响应、冷读缺review/完整ACK证明都必须有断言。

现有fixed-Git/native模型与命令不能被这条分支替换。应用仅限定初始disabled、policy14、
Source v2且无已发布file_event的已知语义拒绝；原失败事实保持，独立完成不补造原成功。
SDK与CLI必须共用原计划选择、锁、请求预算和producer。原安装Git/Node/SQLite旅程
同时验证清单前拒绝和已持久化终局，拿真实返回的原ID/argv/审阅摘要执行，不注入产品状态。

还须覆盖已审阅恢复在新的native文件POST遭到明确400拒绝：移除受控拒绝后，再执行
原review仍不能重发；原正文/旧失败保持，content audit不得因为review记录存在就判完成。
同核错误投影保留HTTP分类、原operation与具体file/path，但不重复完整父/子计划或资源字节。
CLI返回exact只读reconcile，不以“参数帮助”或新计划替代原操作。安装包与真实服务的
失败回执分别保留，实际服务未提供详细原因时只声明已知状态和文件。

原v16转义在实库未生效，其真实ACK完整正文等于原前像。新v17必须保留原review，并
只在精确持久ACK证明该no-op时生成独立审阅。回归覆盖缺ACK/unknown两种可见性、
正文漂移、篡改ACK、冷读缺旧review；原输入和旧wire逐字不变。实际Notion验证的
加粗表示与受控fixture分开记录，受控fixture必须重放已观察到的v16无效行为，不能
继续假定反斜线转义有效。原apply的错误不是旧操作完成；不能改断言来接受圆点。
