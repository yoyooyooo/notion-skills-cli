# 完整当前树导入与恢复

复用 [当前管理 Skill](../../verify-notion-management/SKILL.md) 和 [当前恢复 Skill](../../verify-notion-operation-recovery/SKILL.md)。本旅程只使用当前 `ctl library import`，输入为完整替换树。

## 必要样本

选一个授权 Skill，含主文、子文档、代码、相对链接和一种 opaque 原件。需要验证不支持的上传类型时用字体单原件 ZIP。每种变更只补它影响的边界，不为所有 Skill 重跑矩阵。

~~~sh
bun test packages/core/test/load-import.test.ts packages/cli/test/current-import.test.ts packages/core/test/shared-current-write.test.ts packages/core/test/shared-current-projection.test.ts packages/core/test/shared-current-upload.test.ts --timeout 60000
~~~

这组执行真实文件输入与受控 Notion 变更、下载和导出。它不能证明业务库已转换或真实 Notion 接受所有格式。

## 输入与 dry-run

确认 exact current Skills database、稳定 Skill ID 和实际本地路径。目录/ZIP 必须在根保留 `SKILL.md`；只有明确选择一个 Markdown 文件时才把入口命名为 `SKILL.md`。当前 portable v2 的 Router/Prompt 使用各自规范入口。

拒绝 symlink，包括父目录别名；先用真实物理路径。完整上限为 10,000 文件、128 MiB，单个原件 64 MiB。保留 executable mode，拒绝读取过程中变化的完整输入。

~~~sh
ntn-skills ctl library import "$INPUT" --entry "$CURRENT_ENTRY" --skill-id "$SKILL_ID" --dry-run
~~~

检查将移除的 Files 和权威变化。dry-run 不创建 operation，也不宣称正文已核验。portable 的 Members/Requires 以同库 stable ref 表示；省略保持、[] 清空、数组完整替换。Prompt 关系、旧 projection/materialization 和未知字段必须拒绝。

## 写入、读回与 no-op

~~~sh
ntn-skills ctl library import "$INPUT" --entry "$CURRENT_ENTRY" --skill-id "$SKILL_ID"
ntn-skills ctl library files "$PAGE_ID" --entry "$CURRENT_ENTRY"
ntn-skills read "$PAGE_ID" --database "$CURRENT_ENTRY" --refresh --metrics
ntn-skills files "$PAGE_ID" --database "$CURRENT_ENTRY" --refresh
ntn-skills export "$PAGE_ID" --database "$CURRENT_ENTRY" --output "$EXPORT_DIR"
ntn-skills ctl library import "$INPUT" --entry "$CURRENT_ENTRY" --skill-id "$SKILL_ID"
~~~

使用实际返回的 PAGE_ID 和后续文件 refs。Source/resource 比对导出路径、bytes、hash、mode；native 比对完整读回的内容结构及实际当前正文+frontmatter/mode，不把格式规范化说成原字节保真。从 Skills→Files 检查全文和下载。第二次写入即使使用新的 operation，也应语义 0 写，active Operation 为零。

本地完整导入默认 resource authority，原件保存在当前 Records；不支持直接上传的类型使用只含该原件的 ZIP。导入后显式运行 `ctl library projection PAGE_ID --entry DB`，验证 main 与全部文本 Files 的实际全文，再重复核零写。Native 正文只读验证，非文本报告 skipped；不得把 import 成功代称投影已完成。

## 覆盖与清理

用一个明确修改后的完整输入覆盖相同 Skill ID。保留 Skill 页和仍在用的 File ID；被移除的 Files 和不再引用的当前 Resource 进入 Trash。共享原件的多个投影必须一次收敛。遗漏 Enabled/Default Context/关系不隐式重写。导出→本地修改→再导入必须保留两组完整关系；覆盖超过25条分页、超过100条原样保留和写前拒绝变更、错库/重复/停用/非ready目标、Requires环、unknown关系PATCH及完成前漂移。复用 `shared-current-relations.test.ts`；未实现的跨对象治理单独报告。

## 恢复

~~~sh
ntn-skills ctl library import "$INPUT" --entry "$CURRENT_ENTRY" --skill-id "$SKILL_ID" --operation "$OPERATION_ID" --resume
~~~

重传原输入并核同一指纹。覆盖 CREATE 响应丢失、完整 append 响应丢失和已归档行退出查询。不得重发未知非幂等请求，不得暂时改 ready。部分 append 未能收敛时保留 pending，明确记录这个限制。

预算沿 `shared-current-invocation.test.ts` 核实：初始库查询、重试、provider、multipart、正文和退役共用额度；耗尽后不再发 attention 或 cleanup。新一次显式 resume 使用新额度，不重置同一调用的预算。

完成后重新查询当前树与有限状态，确认只有当前内容。复用已有 runner 的临时输出即可；不保存版本库、永久 ACK、历史 body review 或清理证明档案。
