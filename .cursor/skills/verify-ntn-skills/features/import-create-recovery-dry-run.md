# 完整当前树导入与恢复

复用 [当前管理 Skill](../../verify-notion-management/SKILL.md) 和 [当前恢复 Skill](../../verify-notion-operation-recovery/SKILL.md)。本旅程只使用当前 `ctl library import`，输入为完整替换树。

## 必要样本

选一个授权 Skill，含主文、子文档、代码、相对链接和一种 opaque 原件。需要验证不支持的上传类型时用字体单原件 ZIP。每种变更只补它影响的边界，不为所有 Skill 重跑矩阵。

~~~sh
bun test packages/core/test/load-import.test.ts packages/cli/test/current-import.test.ts packages/core/test/shared-current-write.test.ts packages/core/test/shared-current-projection.test.ts packages/core/test/shared-current-upload.test.ts --timeout 60000
~~~

这组执行真实文件输入与受控 Notion 变更、下载和导出。它不能证明业务库已转换或真实 Notion 接受所有格式。

## Members 的真实库验收

`scripts/members-live.ts` 复用 EMPTY 初始化留下的 library descriptor 和 scope guard。先用既有 paired launcher 的 packed 安装包、独立 config/state/cache 和 `empty-library.ts` 初始化专用测试库；本脚本不创建另一套库，不读取生产关系来准备自动导入结果。显式传入当前选中的安装包入口及 Node，每次使用新输出目录和新 prefix。

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/members-live.ts \
  --cli "$INSTALLED_CLI_ENTRY" --runtime "$NODE_ENTRY" \
  --scope "$EMPTY_LIBRARY_STATE_JSON" \
  --corpus "$FIXED_CORPUS_JSON" --output "$NEW_EVIDENCE_DIRECTORY"
~~~

调用环境必须显式设置本 run 的 `NTN_SKILLS_CONFIG_HOME`、`NTN_SKILLS_HOME` 和 `NTN_SKILLS_CACHE_HOME`。凭据仍只通过 launcher 已授权的 `--pass-env` 进入，不复制日常配置。`--scope` 接受 `empty-library/state.json`、含 `library` 的初始化结果或完整 `SharedLibrary` 描述；所有管理和消费命令继续显式选择该库。脚本通过选定包的只读 `ctl api v1/pages/ID` 独立核对实际 Members / Requires，拒绝截断关系。其他 Supporting Files 的截断不影响这两组完整关系的读回。

`--corpus` 是 version 1 JSON，记录 `repository_url`、`source_checkout` 和六项 `skills`。每项包含 `name`、`commit`、`repository_path`、绝对 `input_path`、`file_count`、`total_bytes`、`main_sha256`、`manifest_sha256` 和完整 `files`。文件项为 `path`、`bytes`、`sha256`、`git_blob`、`mode`（100644 或 100755）。脚本在任何远端操作前重验完整 inventory、原字节、Git blob ID 和 mode，并对 `source_checkout` 执行只读 `git ls-tree -r -z --full-tree COMMIT -- PATH/`，将每项 blob/mode/path 绑定到真实固定提交。禁用 lazy fetch 和 optional locks，缺少 commit/tree 即停止；不会下载缺失 blob，也不会回退到自报 manifest。manifest digest 为按路径排序后拼接 `path + NUL + sha256 + LF` 的 UTF-8 SHA256。

这条旅程使用 cursor/plugins 的两个固定提交：`aaeb0ea3a0584995aa8f55ce44c6c5259414b896` 的 poteto-mode（41 files）与 unslop，以及 `c742dd61706fbacc1b95f1a20b7b988cf096ce6c` 的 principle-minimize-reader-load、principle-guard-the-context-window、architect、arena。原始 poteto 名称和代码示例必须得到自动 Members=0、Requires=0；另一个明确标注的 portable 副本才设置两项 Members 和 unslop Requires。minimize 的跨根链接和 architect 子文档中的 `../../arena/SKILL.md` 使用真实目标页的精确 bindings，各验证一个 Member；不会用 synthetic 同名页冒充真实 target。

合成样本单独覆盖：canonical 首次自动关系；同名、foreign、missing、disabled 和错误 File ID 不被推断；嵌套路径、BOM、CRLF、binary 和 executable mode；未确认绑定或共享 image definition 不输出 portable；显式 `[]` 优先；已有集合和人工删除保留；完整树更新保留 File ID，再导出并重复检查零写。最后用真实显式 poteto 执行 read、inspect、use：Members 保持候选，use 只准备 root 与明确 Requires。此项只证明真实 CLI 消费结果，不声称模型已收到或激活内容。

每个首次 import 的成功回执之后、任何人工关系修改之前，立即保存实际页面独立读回。缺失或错误自动关系会立即停止，不能补写后宣称自动成功。dry-run、no-op 和消费的零写断言必须有实际 `request_metrics.requests.notion_write`；缺 metrics 不作零写。命令、独立观察和报告仅保存在 task 私有输出目录；保留脱敏 stderr、非 JSON stdout 和退出 signal 便于追踪首个失败，token、Authorization 和附件 URL 查询参数不进入报告。未知结果或非零退出停止当前流程，保留原 operation/state，不自动换 operation 重试。

脚本回归使用 injected driver/probe 验证这个验收顺序，不访问 Notion，也不替代上述 live 结果：

~~~sh
bun test ./.cursor/skills/verify-ntn-skills/scripts/members-live.test.ts
~~~

### 超过 25 个 Members 的实库边界

这是 core 验收全部通过后的后置旅程；实际 adapter 放在 E2E 的私有 run 中，复用同一安装包、测试库、driver 和证据目录约定。不要把它加入已冻结的 core helper，也不要把下面的步骤当成已经执行的结果。重跑时保留上次实际目标 ID 和完整选择集合，先读回，再决定是否还需要补充样本。

1. 从 core 报告取得实际创建的 enabled、ready Skill targets，逐项核对仍属于这个测试库，排除 explicit-poteto owner、自身重复 ID 和 disabled target。仅为不足的数量创建简单叶子 Skill，最终选择 26 个唯一 Members。可将真实 unslop 包含在这 26 个候选中，明确记录是否选入。
2. 读取并记录 explicit-poteto 当前 Requires 恰为真实 unslop。使用公开 `ctl library skill update OWNER --entry ENTRY`，重复 26 个 `--members TARGET` 显式替换 Members，省略 `--requires`。保存完整 argv 和第一次写入结果；本步骤验证显式关系维护，不计为自动 Members 发现。
3. 独立读取 owner 的 raw Notion page，按 library descriptor 注册的 Members property ID 找到关系属性，确认 `has_more: true` 并记录 inline 返回数量。然后由独立只读 probe 按该 property ID 读取 page-property endpoint，显式使用 `page_size=25`，沿 `next_cursor` 读到 `has_more: false`。保留每页响应，核对最终正好 26 个唯一页面 UUID，并与显式选择集合精确相等。单独核对 Requires 仍只有原 unslop；不能用 import/update 的成功回执代替这些读回。
4. 对 exact owner ref 执行 `read --refresh --metrics`、`ctl prepare --purpose inspect --refresh --metrics` 和 `use --refresh --json --metrics`，每次显式选择测试库。read 的 Members 与 inspect 的 root candidates 都必须完整包含同一组 26 个目标；inspect 仅准备 owner。use 只准备 owner 与明确 Requires 的 unslop。如果 unslop 同时在 Members 中，它应是同一个 prepared node；其余 Members 仍为 known，不加载它们的正文或依赖。核对全部消费命令的实际 `request_metrics.requests.notion_write` 为 0。
5. 原样重放第 2 步的公开 update，要求实际 Notion 写请求为 0，再独立核对 Members 和 Requires 的完整集合。任何不确定结果都保留原 operation/state，沿既有恢复流程处理，不换 operation 盲重试。

这组 26 条实库样本跨过的是 Notion page response 的 inline 25 条截断分支。独立 oracle 用 `page_size=25` 跨两页读回，不能据此声称产品使用 `page_size=100` 时也经历了多页请求；报告应分别记录实际产品请求与 oracle 请求。更大的分页和关系写入上限继续由已有受控测试证明。

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
