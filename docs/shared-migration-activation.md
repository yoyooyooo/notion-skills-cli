# 旧普通页面的活动状态迁移

旧 `notion_page` 协议没有 `Enabled` 开关：`recordFromPage` 不读取或返回该字段，普通目录会纳入未归档、未删除且 metadata 合法的页面。shared 库单独读取并按 `Enabled` 过滤。迁移需要保留这个协议差异，不能把原字段缺席改写为原页面曾保存 `Enabled=true`。

新候选采用 `conversion_policy:legacy_page_to_native_v2` 时，可以显式使用下列活动状态策略。候选的 `activation` 会展示目标 `enabled:true`、`original_enabled:absent`、原 page/database/data-source 身份，以及两份原证据的 retention reference、SHA-256 和 size。原 record 与原 metadata 的字段缺席保持不变；完整原 JSON 继续保留在 `legacy_entry.metadata.legacy_catalog_activity`。

| 活动状态策略 | 原证据解释 |
| --- | --- |
| `legacy_catalog_active_page_v1`，`version:1` | 保留旧契约：原 row 必须同时有 `archived:false` 与 `in_trash:false`；`is_archived` 若存在也必须为 false。 |
| `legacy_catalog_active_page_v2`，`version:2`，`api_version:2026-03-11` | 按明确的 API 版本解释 `in_trash:false`；不要求已移除的 `archived`。原 row 的 `archived` 或 `is_archived` 若存在，仍须为 false，不能与活动状态矛盾。 |

[Notion 的 2026-03-11 升级指南](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11#step-2-replace-archived-with-in_trash) 明确将 `archived` 改为 `in_trash`。这不意味着将 `is_archived` 当作它的新名称：该原字段继续保留并参与冲突检查。v2 必须显式冻结 API 版本；旧 v1 候选不会重新解释。

## 接受的证据

在原冻结 input 的相应 entry metadata 中增加以下结构。这是新取得并明确冻结的证据；不修改原批准数组，不把字段插入原 row。

```json
{
  "legacy_catalog_activity": {
    "version": 1,
    "policy": "legacy_catalog_active_page_v1",
    "catalog_row": {
      "json": "完整原 catalog page row JSON",
      "sha256": "原 JSON UTF-8 字节的 SHA-256",
      "bytes": 0,
      "retention_ref": "原保留位置"
    },
    "data_source_schema": {
      "json": "同一原 data source 的完整 schema JSON",
      "sha256": "原 JSON UTF-8 字节的 SHA-256",
      "bytes": 0,
      "retention_ref": "原保留位置"
    }
  }
}
```

示例中的 size 和 hash 必须替换为实际值。catalog row 可以来自原完整查询的已保留行；它不被声称为一次新的 page GET transport response。两份原 JSON 各自按实际保留字节核对，不重新序列化后冒充原件。

对于 API `2026-03-11` 的新证据，将示例中的策略字段明确设为 `version:2`、`policy:legacy_catalog_active_page_v2` 并增加 `api_version:2026-03-11`。保留取得它们的原请求版本和 query 行来源；不要给缺席的 `archived` 补值。完整 raw row/schema 与新策略/API 版本一起进入候选和 review digest。

验证只接受已明确为 `ordinary_page` 的旧 Skill 或 Prompt：

- 原 record 本身没有 `enabled` 属性。显式 `false`、null、错误类型不能使用缺席策略。
- 原 row 的活动状态字段必须满足上表中显式选择的版本；缺少 `in_trash`、字段类型不正确或任何已提供归档字段为 true 都不能通过。
- page、database、data source 均为原 canonical UUID，row parent 和 schema parent 精确一致。
- 完整 row 与 schema 的属性名称集合相同，每个 property ID 与 type 相同，二者没有 `Enabled` 定义。过滤后的 row 不能证明属性缺席。
- 使用原 `recordFromPage` 重新得到的全部核心 record 字段必须与原冻结 record 相同。目录后补的 `upstream` 标签继续保留，但不作为活动状态证据。

显式旧 `enabled:true` 继续使用 `legacy_page_to_native_v1`。原 v1 candidate 的验证规则不变；不会套用新策略重新解释已经冻结的旧候选。没有活动状态证据的缺席字段仍失败，generated subscription Router 和普通 Router 均不在这项小策略中。

## 审阅与执行

公开 `ctl library migration review` 会在完整候选中展示该策略。原始证据变化会改变 candidate/review digest；批准后 `apply` 必须重新验证相同原输入与实际 bytes。普通 create 的最后 enable、完整正文读回、原 outcome 以及只读最终 snapshot 验证继续复用，没有新建状态机。

本策略只解决旧活动状态的协议映射。它不推断文件 following/custom、不豁免旧 Source options、不把缺失 References 或未知 operation 终局变成已完成，也不修改批准范围。
