# 三项 pilot 的离线 review 装配

`prepare-migration-pilot-review.py` 只读已有文件并在新目录保存装配结果。它没有网络或子进程入口，不执行 CLI，不写 Notion，不改变批准、原 ownership、legacy mode/layout、record 或 entry completeness flags。

```sh
python3 scripts/prepare-migration-pilot-review.py --config PRIVATE_CONFIG
```

正常模式读取 hash 冻结的完整 migration input，保留全部原 catalog entries、coverage、preservation、operation/isolation receipts，仅把三项的新增字节/映射事实纳入新的 `draft-input.json`。其它条目逐项保持不变。原 input 不被覆盖。若旧 readiness basis 因新事实而失效，脚本不会偷偷改它；后续仍由原 planner 与明确的依赖规则处理。

只有本地没有完整原 input、需要先核对现有字节时使用 `--evidence-only`。该模式不生成完整 input，不拿 subset 的 preservation 摘要代替原全量证据。

## 配置与现有输入

配置中每个 JSON/ZIP 输入都需要绝对 `path` 与实际 `sha256`；输出必须是新目录。需要：

- 原三项 subset、完整保留的 metadata property observation。
- 两个 Skill 的固定 snapshot JSON 与成功的 current observation。
- 两个原 Source ZIP、固定 Git inspect 成功响应、实际 offline source export 的 inventory/verification。
- doc 三项差异的原记录，以及三份实际不同的 authored export 文件。
- 51 页 native collector 成功 summary、逐项 descriptor 和原始 raw JSON。`original_root` 保留 collector 的原 retention root；在镜像目录读取原字节时也不重写 descriptor 的 retention reference。
- Router 的成功 followup observation；配置 `current_directory` 后会核对并复制其完整生成正文，但不把它变成 native page preimage。
- 正常模式另外需要完整原 frozen migration input；批准数组必须仍为空。

Source ZIP 按已固定 Git tree 的 path、size、Git blob OID 验证全部原字节。当前 authored export 中与 ZIP 字节相同的文件可直接复制 ZIP 对应项，前提是其 hash/size 与那次真实 public export 的独立 inventory 完全相同。差异项必须读取原保留的实际 export 文件，不能从 Source 回填。输出会记录每个文件的具体派生方式。

## 输出语义

每个 Skill 分别保存 `original-source.zip`、`fixed-source.json`、完整 `current-authored/` 和 `preimages/`。preimage 文件使用正式 CLI 接受的 `PAGE_UUID.default.json` 命名，原 response JSON 字节保持不变。

`entry-proposals.json` 保留原 main file legacy ID，新增参考文件以原 page/path 坐标建立明确 identity；已有 ownership 原样保留，新条目保持 `unknown`。原 `files_complete`、`metadata_complete`、legacy mode/layout 与 record 均不提升。新 body 的 complete/hash/size/retention_verified 只陈述实际已核对的完整保留字节。

`summary.json` 展示 Source 与当前 authored 的逐项差异、raw native 与旧 reference Markdown 的精确比较，以及 Router 的发布/源成员差额。它的 `prepared_with_explicit_gaps` 不表示迁移可执行或 public review 已通过。

这些材料可用于正式命令，但必须先明确该目标仍缺少的语义与证据：

```sh
ntn-skills ctl library migration review \
  --input FROZEN_REVIEW_INPUT \
  --legacy-id EXACT_LEGACY_ID \
  --entry EXACT_REGISTERED_LIBRARY_ENTRY \
  --files PILOT_OUTPUT/current-authored \
  --preimages PILOT_OUTPUT/preimages \
  --source-files PILOT_OUTPUT/original-source.zip
```

脚本不执行这条命令，也不改 `approved_legacy_ids`。只有明确选中 Source 的目标才传 `--source-files`；字节相同本身不授权 Source 选择或 following。

## 当前三项的具体状态

| 目标 | 已保留的实际证据 | 仍须明确 |
| --- | --- | --- |
| doc | 44 个原生响应完整；44/44 raw Markdown 与原保存 reference 字节相同；固定 Source 44/44 blob 验证；current authored 41/44 与 Source 相同 | 三个差异文件的 ownership/转换选择；完整保留当前文本，不能按 Source 覆盖。额外主文 frontmatter 也不能删除来绕过投影限制。 |
| shared | 7 个原生响应完整；7/7 raw Markdown 与原 reference 相同；固定 Source 7/7 blob 验证；current authored 7/7 与 Source 相同 | 明确的旧 selected Source 到目标固定 member Source 映射，以及 per-file following baseline 证明；不能只靠字节相同赋予 following。 |
| Router | 真实生成正文的固定 pin 已保留；Published Members 27，source manifest 28，缺 `skills/lark-apps`；原 Status partial | generated Router 转换策略与完整成员范围；实际新 member pages 尚未全部绑定。不能把 27/28 写成完整，也不能把生成正文当原页面 Markdown。 |

doc 的三个差异分别是：主文 YAML/格式未逐字节恢复；`references/lark-doc-md.md` 的当前原生内容缺 positional-escape 段及部分表格行；`references/lark-doc-whiteboard.md` 的标题层级、表格和链接等投影未恢复。三份当前文本、原 Source 文本和 actual native response 都独立保留。发生差异的原因与 ownership 不由此脚本推断。

两个旧 Skill 的 `Sync Mode=tracked` 是原属性的直接事实；shared 的 Source Type 为 null 也原样保留。同一旧 subscription 的两个 member revision 不同；旧 include/exclude/strip-prefix 规则继续保留，不能用其中一个 member 的固定子树覆盖整个旧 Source。

活动状态可用独立的 `legacy_catalog_active_page_v1` policy 解释旧协议缺席的 Enabled，但需要完整原 row 与 data-source schema。此装配器不伪造该证据。全量 input 的其它未知项仍保留；单目标 review 的依赖规则由正式核心处理，不能由脚本裁掉其它条目或把 coverage 改成完整。

## 验证

```sh
python3 -m unittest discover -s scripts -p test_prepare_migration_pilot_review.py -v
```

四个受控测试覆盖固定 Source 字节/额外路径、原 semantic flags 与 raw facts 保留、完整 input 的其它条目/unknown operation 不变，以及原生 response 身份错误即使包装 hash 自洽也拒绝。测试临时目录保留。
