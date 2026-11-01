# N15：三个代表条目的只读当前文件采集

本轮只为 Lark Router、lark-doc、lark-shared 补齐**公开消费快照的完整文件树、实际字节与 SHA-256**。输入来自既有只读盘点和保留证据，批准集合仍为空。此采集不生成迁移输入、不迁移内容、不修改 Source 或 ownership，也不结清旧 operation。

## 已有证据与本轮缺口

| 条目 | 已保留的具体事实 | 本轮取得的事实 |
| --- | --- | --- |
| Lark Router | `notion_subscription`；Published Members 有 27 项，source manifest 有 28 个成员及 1 个外部资源；Status 为 partial、Sync Status 为 running。 | 正式消费者当前生成的完整 `ROUTER.md`、固定快照和文件 hash；成员依赖由原读取入口验证，采集器不额外逐个调用其他成员的 `read`，内部依赖请求以产品 trace 为准。 |
| lark-doc | 43 个 References 路径；原 Files 有 `ntn-skills-source.zip`；对应 source manifest 有主文加 43 个资源。保留的两条 pin 索引分别含 44、45 个文件。 | 当前实际完整逻辑文件集合及每个文件的确切字节；原 source ZIP 若在当前快照中，也作为原始二进制文件保留。 |
| lark-shared | 6 个 References 路径；原 Files 有 source ZIP；对应 source manifest 有主文加 6 个资源。保留的两条 pin 索引分别含 7、8 个文件。 | 同上；不因与历史 Source hash 不同而推断用户编辑、fork 或 following。 |

这些数量来自保留观测，不作为当前文件数的预设。Reference 纯文本派生值保留路径标签，完整链接身份仍在原始 metadata 行中；采集器让现有产品读取完整 References/blocks/attachments，不另写一套路径解析器。

原 Source 指向 `larksuite/cli.git` 的 `main`，保留 `strip_prefix=skills`、manual target，以及独立的 Roots、Include、Exclude 和 Mapping 原值。lark-doc 与 lark-shared 的 Published Member/Upstream Revision 不同，不能把整个订阅改称同一提交已发布。两页的原 Sync Mode 都显示 tracked，只作为原生属性事实；迁移输入里的 `legacy_mode`、`legacy_layout`、文件 ownership 继续保持原值。

选出的旧 pin 是**保留集合顺序中末两条匹配行**，不是经过时间排序认定的最新 pin。该集合中 Router 没有匹配行，不证明某个用户 pin 已丢失。旧 pin 的 bytes 已有独立保留核验；此脚本仅比较其已保留索引，不再次声称重哈希旧对象。

## 最小执行入口

`collect-migration-current-files.py` 只调用现有公开命令。每项顺序固定：

```text
ntn-skills read ORIGINAL_RECORD_REF --database CONTENT_DATABASE --refresh --output NEW_MAIN_PATH --metrics
ntn-skills files RETURNED_SNAPSHOT_ID --offline --metrics
ntn-skills export RETURNED_SNAPSHOT_ID --offline --projection snapshot --format directory --output NEW_DIRECTORY
```

`ORIGINAL_RECORD_REF` 直接来自冻结输入，不按名称重新选择。普通页面使用其原 `database_id`；订阅 Router 使用 `target_database_id`。成功时共 3 次在线内容读取和 6 次固定快照离线命令；这是 CLI 调用数，**不是 9 次远端请求**。完整 References、blocks、成员元数据、附件读取的实际请求由产品执行。保留 read/files 的公开 metrics；export 没有 metrics flag，附件 HTTP 下载不冒称已完整计数。

采用 `snapshot` 投影可导出订阅生成 Router，保留其 Members 展示和精确消费字节。这个 Router 没有普通 authored root，不能对它套用 source export。Source 的仓库 ref、原提交、manifest 和原 ZIP 另有保留证据，不从当前消费快照反推。

配置参考 `config.example.json`。替换 CLI argv、工作目录、official ntn 和私有输入/新输出路径，保留三个输入的 SHA-256。不要在配置中放凭据。

```sh
python3 -B scripts/collect-migration-current-files.py --config PRIVATE_CONFIG --check-config
python3 -B scripts/collect-migration-current-files.py --config PRIVATE_CONFIG
```

脚本复用相邻的 `verify-migration-pin-retention.py` JSON/hash 和已知 Router 展示格式 helper；该既有文件不需修改。它在全新输出目录中建立独立的 config/state/cache/data，继承既有 official ntn 认证，不复制认证资料或原 active SQLite。命令与 stdout 原样保存在私有证据目录；stderr 只保留长度和 hash，不写环境变量。

## 判定与停止边界

每个成功条目核对原 record、locator、kind、scope、entrypoint，要求在线 refresh 不是 metadata-only 复用。后续 `files/export` 必须属于同一固定 snapshot/version。逐项验证全部导出路径、长度、文件 hash，核对 `files` 的完整集合与 portable manifest，并将导出主文和 `read --output` 原字节直接比较。

当前元数据或文件集合可以与旧观测不同；新观察单独保留，不覆盖旧输入。输出按 path/hash 与已保留的旧 pin 索引列出差异，不自动解释差异来源。已知 Router 展示格式可用既有 helper 提取成员 refs；不能识别时记 `router_members_observation=unparsed`，完整文件 bytes 仍保留，不能据此宣称关系已迁移就绪。

公开读取失败、未知/未完成 publication、响应不完整、身份不符或 hash 不符时，停止该条目并保留原响应与局部文件。没有重试、resume、reconcile、补写、换名或替换 operation；其他两个明确独立的只读目标可继续观察。命令超时终止该命令的进程组。结束前重新检查全部输入和 helper/collector hash 未变。

`summary.status=complete` 仅表示三个**公开当前文件快照**都取得并核对成功；不表示 N15、AH-498 或迁移计划完成。raw native Markdown preimage、完整当前 Source 选择、用户修改归属和迁移物理绑定均未由本脚本宣称。生成 frontmatter、相对链接、Router footer 与原 native body 必须分别理解，不能直接剥离或投影后冒称原字节。

## 本地受控验证

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s scripts -p test_collect_migration_current_files.py -v
```

测试运行一个独立的合成 CLI 子进程，覆盖完整固定 pin 链、错误 pinned ref、原 unknown 回执保留且不重放、导出 hash 错误、跨 scope 响应、冻结输入漂移，以及未知 Router 展示格式。测试不调用 Notion，临时证据保留。真实三项采集需另记实际命令、产物版本和结果。
