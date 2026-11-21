---
name: verify-notion-management
description: "验证 Notion 当前完整树导入、文件权威、原件导出、独立阅读投影、同页 Trash 恢复、Profile、有限恢复和实际残留清理。修改 Skills/Files/Records 管理或清退时使用。"
---

# 当前管理验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 1、2、4 组。本入口不负责消费缓存，也不负责宿主投递。当前 import、真实业务库转换、全库治理和 Pi 日用分别报告范围。

## Launch

沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离。从任务已有授权确定 exact library、稳定 Skill ID 和完整输入。同一目标保持一个管理 writer，受控测试使用自有服务。

## Doctor

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-current-write.test.ts packages/core/test/shared-current-projection.test.ts packages/core/test/shared-profile.test.ts --timeout 60000
~~~

按改动选择必要文件。当前树测试包含实际页面、Records、正文变更和读回导出；Profile 测试仍只证明当前规则替换。受控通过不等于真实 Notion 已迁移。

## Drive

1. 先用 `ctl library import INPUT --entry DB --skill-id ID --dry-run` 读取当前目录与完整替换范围。确认 main 唯一、全部 supporting Files、stable ID、唯一 owner、路径、mode 和 authority。缺少当前 Content 的旧库必须先显式转换。
2. 对同一完整输入执行 import。默认保存精确 Notion resource 原件；生成阅读投影独立验收，不阻塞 ready 或消费。unsupported 类型是单原件 ZIP，读和导出恢复原字节。generated body 编辑不转移权威；native author body 仍直接编辑。
3. 从 Skills→Files 逐类查看 Markdown、代码和二进制。用实际 current reader、单文件读取和目录 export 核 hash/bytes/mode。不要只比较上传请求或属性占位。原输入在 prepare 后变动必须在远端写入前拒绝。
4. 用相同输入和新的 operation 重复 import，确认 semantic writes 为 0，没有新 Operation/Resource。修改一个文件并移除另一个，确认唯一 Skill 页、保留 File ID、最终完整树及旧 Files/无引用 Resource 已进入 Trash。重复导入不因投影缺失写入；原件和完整树必须在一次有限操作内收敛。
5. 覆盖时保持未指定的 Enabled、Default Context、Members 和 Requires。portable 关系省略保持、[] 清空、数组替换，导出携带两组完整集合。核同库唯一 ready/Enabled目标、完整分页、100条写入上限和 Requires 环；kind 变化与 Source 选择按各自明确入口。旧投影字段必须拒绝。完整本地导入是显式替换整个文件树。
6. 沿 [当前恢复](../verify-notion-operation-recovery/SKILL.md) 核 CREATE、append、退役响应丢失及半树拒绝消费。有限 Operation 完成后回收，不保留旧正文或永久 ACK。
7. Profile 用完整当前规则与 expect fingerprint 替换同一 Record；相等 0 写。全库 census、反向关系治理和实库转换仍单独验收。先移交唯一当前字节，再清旧字段、行、页、附件和导航；隐藏或平行旧库不算清理。
8. 同页 Trash 恢复使用 `ctl library projection PAGE_ID --restore --entry DB`，只选精确原页，不混 daily/dry-run/手工 operation/resume/cancel。按 [单条命令验收](../verify-ntn-skills/features/current-convergence.md#单条命令恢复已完成的投影) 清生成正文再 trash，核完整投影、原身份、四开关、native/resource 保留和重跑零写。自身阶段中断重跑同命令；旧 projection 未完又被外部 trash 则零写拒绝，不能覆盖 marker。

实际命令与限制见 [导入旅程](../verify-ntn-skills/features/import-create-recovery-dry-run.md)、[安装验证](../verify-ntn-skills/features/skill-maintenance.md) 和 [当前合同](../../../docs/current-contract.md)。

## Evidence

按 [当前合同与回执](../../../docs/verification-contracts.md) 记录所属场景、准确候选、真实运行层和原件 hash；历史 Done 不填作当前通过。

报告实际正文、原件、关系、清理 effects、HTTP 成本与剩余范围。局部受控 writer 不替代 AH-501 全量阅读或 AH-513 实库清退；没有执行就写 not_run。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 仅回收自有且已移交当前内容的对象。只保留未完成意图需要的状态，本地移除进入系统 Trash。
