# N15：只读 Router bootstrap 后续观察

适用情形：原三个条目的采集已经结束，订阅 Router 的唯一 `read` 因新本地配置没有 `upstream_database` 返回 `UPSTREAM_NOT_CONFIGURED`，没有 operation ID，也没有执行 Router 的 files/export。这个事实是本地入口配置缺口，不是 publication 失败。

`collect-migration-router-followup.py` 复用已提交采集器的 `Collector.capture`，只读取原 Router。原三项输入、运行证据、doc/shared 快照与批准集合不修改。

## 配置与执行

以原采集配置为基础新建一份配置，保留 `cliCommand`、三个输入及其 SHA；将 `output` 换成与原运行分开的新目录，再增加：

```json
{
  "previousRun": {
    "path": "/ABS/PRIVATE/ORIGINAL-COMPLETED-PILOT",
    "summary_sha256": "SHA256_OF_THE_FINAL_ORIGINAL_SUMMARY"
  }
}
```

必须等原运行的最终 `summary.json` 落盘，才能填写这个 hash 并执行。配置示例另见 `router-followup.config.example.json`。

```sh
python3 -B scripts/collect-migration-router-followup.py --config NEW_PRIVATE_CONFIG --check-config
python3 -B scripts/collect-migration-router-followup.py --config NEW_PRIVATE_CONFIG
```

后续入口先验证原最终摘要、输入绑定、唯一原 Router read 的完整 argv、stdout 和 completion。原错误必须精确为 `UPSTREAM_NOT_CONFIGURED`，非超时且没有 operation ID。若是 publication/unknown 错误或原运行尚未结束，就在调用 CLI 前停止。

新的 runtime/config/config.json 只写一个键：`upstream_database`，值必须同时来自原 Router locator 和对应保留 metadata 的 database ID。ConfigSchema 允许该键单独存在；Store 直接读取 `NTN_SKILLS_CONFIG_HOME/config.json`。不调用 database init，也不复制原用户配置、token、旧 cache 或 active SQLite。

随后只执行原 Router 的在线 read 与同一固定 snapshot 的离线 files/export，沿用完整身份、字节、hash 和 manifest 核验。doc/shared 不再次读取。原失败保持为原失败；新结果通过原 summary/receipt hash 关联。新的失败保留原响应并停止，不自动继续恢复。

## 此后应补齐的具体证据

当前 public snapshot 的文件字节和 raw native preimage 分别记录。已经取得的 doc/shared public read 不需要再次整链重读。

| 对象／证据 | 最小补齐路径 | 保留边界 |
| --- | --- | --- |
| 订阅 Router | 当前生成的 ROUTER.md 快照；完整 Source/Published Members/target/成员 metadata 关系。 | 它是订阅生成文件，不能把订阅页的普通 Markdown 冒充 Router 原正文。成员查询不是额外读取每个成员正文。 |
| 两个 Skill 的 native 文本页 | 优先复用已保留的原请求／响应；否则仅针对已知 root/reference page ID 补 raw Markdown GET、明确 API/Markdown 版本、`truncated=false`、`unknown_block_ids=[]`、完整 ID→path 关系及前后页面身份／属性稳定性。 | Snapshot.references 中的 Markdown 可能经过 typed-link materialization；缺乏原响应时不能直接声称是 raw preimage。新观察与原 public pin 分别保存，漂移不覆盖旧 pin。 |
| 可编辑 literal files | 由完整 block 分页和既有 `decodeMarkdownFiles` marker/layout 识别，保存 live code-block 字节和原 blocks 证据。 | 原 ZIP 不替代 live literal bytes；文件数量或有无 ZIP 也不能单独证明 layout。 |
| 已导出的 source ZIP | 离线核验 ZIP 实际 SHA/size、portable manifest、每个 entry 的实际 bytes/hash、资源到原 page/path 的映射。 | 不重新下载已有完整 ZIP；源 projection、当前 native body 与消费文件各自保留。额外 Git 资源不自动变成 Notion 页面。 |
| Source／ownership | 保留原 Source URL/ref、Roots/Include/Exclude/Mapping、member key/source path、精确原提交、publication ownership 和原投影证据；逐文件比对。 | 不以 `committed`、Sync Mode 标签或消费文件与 Source hash 的单次差异直接判 following/custom/fork。来源不清的偏差作为需保护的用户候选。 |

lark-doc 和 lark-shared 各自的 **40-hex Upstream Revision / Published Member revision** 不同。各页 **64-hex Publication.revision** 是发布内容摘要，与 Git revision 属于不同身份，不能交叉比较。Router 顶层 source revision 也不能覆盖成员各自的 revision。

只有精确固定 Source、路径、原投影规则和当前 native 观察都能对齐时，才形成 following 的待审证据。缺任一项，原 `legacy_mode`、`legacy_layout`、ownership 和未结清 operation 保持原事实及未知边界。这一后续观察不添加 approved ID，不执行迁移，不要求无关历史操作先全部终局。

## 验证

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s scripts -p test_collect_migration_router_followup.py -v
```

三个受控子进程测试覆盖：只执行 Router 的三条命令且原运行文件字节不变；publication/unknown 不能改称缺少 bootstrap；缺原最终摘要时零后续调用。测试不接触 Notion，临时证据保留。
