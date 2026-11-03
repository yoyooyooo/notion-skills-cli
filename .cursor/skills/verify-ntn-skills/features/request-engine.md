# 直连请求引擎

这份地图覆盖 AH-561 的请求层；产品名 `ntn-skills` 保留。当前生产、包和验收链不得调用官方 ntn、使用其登录/Keychain 格式或 stderr 协议。历史记录只标明当时实现，不改写成新引擎的证据。

## 功能与证明边界

| Feature ID | Issue | 用户入口和必须观察的结果 |
| --- | --- | --- |
| NG-VC-01 | AH-562 | 既有验证 Skill 的离线反例、两条冻结提示、独立 oracle 与原生 CLI fail-before。自检通过只证明评估器。 |
| NG-RE-02 | AH-563 | 自有 CredentialProvider，经公开 list/views/read/files/export/resolve 驱动直接 HTTP；分页、身份与正文完整。 |
| NG-RE-03 | AH-564 | create/apply/update、附件与原 operation 恢复；明确拒绝可恢复，超时/断连/不明 5xx 保留 unknown，不能重建或重放。 |
| NG-RE-04 | AH-565 | 不同 cache root 的多进程共享机器级准入；可信 connection/workspace/endpoint 冷却、公平优先级、取消与独立预算。 |
| NG-RE-05 | AH-566 | 两仓产品、doctor、安装、CI/helper/随包 Skill 无官方工具依赖；历史不可变回执单列。 |
| NG-RE-21 | AH-582 | 双仓实际交付产物、精确版本/hash、日用 Pi 重启后消费与文档一致。 |

## Launch

复用已构建的 `packages/cli/dist/ntn-skills.js`。在 Broker checkout 执行下列命令，CLI 路径必须指向本次候选产物。证据父目录须在两个 checkout 外。

```bash
node scripts/verify-skill-graph-contract.mjs --help
node --test scripts/verify-skill-graph-contract.test.mjs
node scripts/verify-skill-graph-contract.mjs self-test
```

这些入口没有服务、后台进程、认证读取或网络请求，不初始化生产配置。自检固定区分两个正例合同和拒绝假阳性的反例；输出 tests 必须大于零。

## Doctor

```bash
node scripts/verify-skill-graph-contract.mjs doctor --cli "$CLI_ENTRY"
```

`CLI_ENTRY` 为实际 Node bin 的绝对路径。Doctor 只读取该文件并记录实际 Node 版本与 SHA-256，不运行业务命令、不验证远端认证，也不暖消费缓存。

## Drive

```bash
node scripts/verify-skill-graph-contract.mjs baseline --cli "$CLI_ENTRY" --cli-root "$CLI_CHECKOUT" --evidence-root "$EVIDENCE_ROOT"
```

`CLI_CHECKOUT` 为本 CLI 仓库，`EVIDENCE_ROOT` 为外部持久证据目录。runner 新建 owned scratch，以白名单环境清除继承认证，在真实候选 CLI 上执行 `--version`、`schema prepare`、`schema update`。不存在的 prepare 或 Requires 保留 fail-before；schema 出现仅记 `schema-present-unverified`。源码扫描和提交基线只表明是否观察到旧路径，不能证明新 HTTP 行为。每次重新运行分配新目录，保留先前失败。

NG-RE-02～04 的 live/故障验证随对应实现切片接入既有 control/CLI；运行前用真实 schema 检查公开入口。生产只读验证使用明确授权凭据；429、request_blocked、超时/断连和未知写入在受控 HTTP fixture 注入，不故意撞生产限流。HTTP账本需记录每次 attempt 的 status、request ID、Retry-After、安全 additional_data、scope、queue/attempt/operation 耗时和结果，不能以 CLI 次数代替请求数。Retry-After 是最小等待；未知写必须保留原 operation 和证据。

## Evidence

新 run 固定保存 `run.json`、`prompts.json`、`contract-tests.json`、真实 CLI version/schema 回执、CLI HEAD、请求层源码 hash 与 `result.json`。artifact hash 防止清理后被替换，输出 `baseline-recorded` 不等于产品通过。分栏为 controlled、real_service、real_model、real_ui、installed_package；未执行项保持 not-run。

```bash
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

`RUN_EVIDENCE` 必须来自本次实际输出。保留失败、unknown 与未执行项，不能用新运行覆盖它们；凭据、认证头和原始 stderr 不落盘。工程目录内的既有索引和 Tern 产物不是验收 scratch。

## Cleanup

```bash
node scripts/verify-skill-graph-contract.mjs cleanup --evidence "$RUN_EVIDENCE"
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

只对 ownership 匹配的离线 scratch 使用系统 Trash，不删除证据、不触碰远端或按进程名清理。`preserved` 只证明证据仍在；functionalStatus 与产品结论保持原值。其它 live runner 继续使用自身已有的 process/owned-fixture cleanup，不借用这份离线 ownership。
