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

改变新创建的wire转换必须版本化，旧冻结policy保持。恢复只能使用支持该原计划类型的正式命令；普通native restoration不能代替带source_projection的创建恢复。尚缺这种能力时保持blocked并定位缺口，不能直接PATCH失败页面再称产品闭环。

## 完成判据

确定性保存/校验先于派发；原操作执行后独立冷客户端读取完整资源；正反例、原ACK/unknown和重复无增长都实测。源测试、独立安装、真实Notion读回、恢复可用性分别记录。结构检查和单次成功不构成全库完结。
