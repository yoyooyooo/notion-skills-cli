# 从保留的完整发布证据派生单个迁移候选

`derive-migration-publication.ts` 为 `legacy_committed_publication_v1` 做离线装配。它只读原文件，在新目录写出完整的新 draft、证明和原生正文副本；不调用 CLI、Notion 或 Git，不修改批准数组，也不重放或终结旧操作。

```sh
bun scripts/derive-migration-publication.ts --config PRIVATE_CONFIG
```

配置的 `format` 为 `migration-retained-publication`、`version` 为 `1`。`output` 必须是尚不存在的绝对目录；`input`、`snapshot`、`fixed_source_inspection`、`source_archive` 和 `parent_rows` 的两个元素均为 `{ "path": "ABSOLUTE_PATH", "sha256": "EXACT_SHA256" }`。`legacy_id` 只选一个原普通 Skill。`authored_export` 必须给出原 `request`、`receipt`、`completion`、`inventory` 的同形路径摘要和原导出 `directory`。完整输入的 `approved_legacy_ids` 必须为空。

原输入中每个文件的 `body.retention_ref` 和 `raw.native_preimage.retention_ref` 必须仍指向实际完整保留的 authored 字节与原始响应 JSON。脚本核对所有 SHA 和长度，在输出前再次检查原文件及配置。输出已存在或任何证据不符都会停止；保留原尝试，不能覆盖后重跑。

## 该 policy 实际证明什么

核心解析器复用现有旧页面 materialization、发布 manifest/ownership guard、Source member selection、固定 Git binding 和完整文件引用检查。它要求：

- 原完整 row/schema 支持明确版本的旧 catalog 活动映射；原记录没有显式 Enabled，且确为普通 tracked Skill。
- 原 References、snapshot 的全部页面和文件一一对应，ZIP 是唯一附件；原完整 manifest 和 tracked ownership guard 精确重建 committed marker。
- 两份保留的完整父页对所选 Source、筛选规则和 Published Members 给出相同事实。仅所选 member 的 revision/root 和完整固定 Git 文件树被绑定；不会将整个父 Router 或 Source namespace 标为完整。
- 原 offline source export 的 request、成功 receipt、固定 pin、完整 inventory、实际文件和 portable identity 一致。每个 authored 文件与该固定 Source 对应文件精确相同；有差异就保留未决。
- 每个完整 native response 的 page、API/Markdown 版本、原 JSON 字节和描述符准确匹配；raw Markdown 等于原 snapshot reference，再以 normalization-v1 得到旧 following 比较基线。

`source_semantics: legacy_fixed_git_member_v1` 只描述这个固定 member 的新 Source 解释。原 roots/include/exclude/strip-prefix、完整父发布列表、额外资源及原 Source 保存在证明中。补入一个已证明的 Source 不改变原 `preservation.sources.complete`。

## 输出及公开入口

`draft-input.json` 保留原完整 catalog 与 preservation，只替换所选 entry 的已证明字段并追加这个固定 member Source。原操作、其它条目、coverage、backup、批准和旧 readiness receipts 均不变。

`proof.json` 保留全部原 observation；`entry-proposal.json` 和 `source-proposal.json` 显示具体解释。`native/` 存放原生 Markdown 经 normalization-v1 得到的正文；旧 authored body 描述符仍在 entry 和证明中，原文件也保留。`summary.json` 明确标记 retained observation、`current_terminal_verified:false`、`human_edit_intent_inferred:false`。这既不证明旧系统以后不再写，也不执行 cutover 或迁移。

实际公开 review 使用新的原生比较基线目录，并继续提供原 raw response 和原 Source 字节：

```sh
ntn-skills ctl library migration review \
  --input NEW_OUTPUT/draft-input.json \
  --legacy-id EXACT_LEGACY_ID \
  --entry EXACT_REGISTERED_LIBRARY_ENTRY \
  --files NEW_OUTPUT/native \
  --preimages ORIGINAL_COMPLETE_PREIMAGE_DIRECTORY \
  --source-files ORIGINAL_FIXED_SOURCE_ZIP
```

`--preimages` 中的文件名须为 `PAGE_UUID.default.json` 或 `PAGE_UUID.v2.json`，与原输入描述符一致。公开 review 在显式 publication descriptor 下选择 `copy_to_new_native_v2` 并重新验证实际证据；仅有 policy 名称、完整性布尔值或隔离 receipt 不能替代证明。已有候选继续使用其保存的 policy。

review 成功后仍需审查具体内容、Source、目标及 review ID，明确批准原输入中的该目标，再使用原公开 `apply --dry-run` / `apply`。未决的新 create 只能按原 operation 使用只读 reconcile；不能重复发送。本文脚本不执行这些步骤，不把原历史 unknown 操作改成 terminal。

当前范围不包含 generated Router、未闭合的跨 Skill 引用、非空 patch/mapping、额外附件或不同 authored 字节的所有权解释。其它目标保持其原事实和阻断。

## 验证

```sh
bun test packages/core/test/shared-migration-legacy-publication.test.ts \
  packages/core/test/shared-migration-publication-derivation.test.ts
```

受控 fixture 的原 native 文本和 Source 字节独立于新投影器。测试覆盖原生比较域、完整 committed manifest、固定 member revision、原 export/pin、截断和缺页，以及离线派生保留完整 input/unknown history/空批准和 namespace 不提升。测试临时目录保留。
