# 当前生命周期的有限模型

本套件由 [resource-lifecycle Skill](../../../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md) 维护。
它检查 C06/C07b 与 current 读取的一个有限交错切片，不恢复旧 ACK、永久 pin 或历史管理模型。
源码行为由实际 reader/operation 测试回放；模型与生产 guard mutation 各有独立结果。

## 运行

复用 [统一形式驱动](../../../scripts/verify-formal.mjs)，选择当前套件。工具字节继续使用
c742dd61706fbacc1b95f1a20b7b988cf096ce6c 的 statechart 与锁定 TLC 1.7.4；
较新的工具目录不能因版本更高而略过 [tool-lock.json](tool-lock.json) 的逐文件检查。

```sh
node scripts/verify-formal.mjs --suite current-lifecycle \
  --statechart /absolute/pinned-statechart --jar /absolute/tla2tools.jar \
  --out /absolute/new-lifecycle-model-run
python3 scripts/check-formal-mutations.py --suite current-lifecycle \
  --out /absolute/new-lifecycle-guard-run
bun test packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-projection-write.test.ts --timeout 60000
```

PSTACK_STATECHART_ROOT/TLA2TOOLS 可替代两项工具参数。使用本次新的外部输出目录；错误运行也保留。
正例为 content/projection/restore 三个配置；四个反例分别移除读回 fence、projection 分类、unknown 不重放和非内容完成资格。
每个配置检查同一份完整规则清单，expected_broken 独立维护。
缺工具、规则遗漏、cut、超时和解析异常都不算通过。

## 两条状态轴与有限范围

内容 owner 有 ready/applying/attention 及自己的 Operation。独立有限意图有 idle/active/unknown/observed/verified/retiring/retired/blocked。
projection 与 same-page restore 可以保留该意图，同时 owner 仍 ready 且没有内容 Operation。
模型不把这两条轴合并为一个 pending 标志。

有限域是一个 owner、两个抽象内容身份、一个固定种类的意图、一个非幂等产品动作、一个 current 读者及最多一个外部 writer。
动作有成功响应、接受但响应丢失、未观测到接受的未知结果三类。
未知未观察到结果时保留原意图并进入可解释 blocked；不由 absence 重发 CREATE/append。
restore 的 Trash 仅抽象为一位；正式命令的 exact page、四开关、policy、共享预算、两阶段和重跑由现行生产测试覆盖。

current 读分 metadata、body、publication。最终 ready 检查与完整消费 fence 都要成立；writer 已完成并重新 ready 仍不能放过身份变化。
publishedSafe 保存发布时刻的事实，后来的合法 writer 不会把过去的有效读取倒算为失败。
这不是 CAS、分布式锁或多个 Notion owner 的全局事务快照。

## 性质与真实 guard

| 性质/反例 | 实际 owner | 生产回放 |
| --- | --- | --- |
| NoMixedCurrentPublication / read-fence | shared-snapshot 最后 consumptionFence 比较 | writer 在 body 期间开始或完成，完整快照不发布 |
| NonContentPreservesReadiness / projection-owner | withCurrentOperation 的 projection 分类及 preserveReadyOwner 分支 | generated bodies 完成不改 owner metadata/readiness；去分类后行为断言失败 |
| UnknownNonIdempotentNeverRepeated / unknown-replay | dispatch 对既有 never-replay action 的拒绝 | unknown absent append 仍仅派发一次，保留 finite intent |
| NonContentCompletionQualified / completion-owner | ownerObservation 的非 ready 拒绝 | owner 在 projection 期间变 unready，不能宣布完成或退役意图 |
| ReadyHasNoContentOperation、NoFalseComplete、UnknownIntentRetained | 同一有限内核状态顺序 | ready 与 Operation 配对；完整核对后清意图；未知事实保留 |

projection 分类去除后，实际内核把该意图按内容操作处理，因此模型中 owner 会进入 applying；这条反例对应生产回放的真实 owner PATCH 断言。
仅去外层 activation 条件会被另一写入边界拒绝，不能把那种异常误称 readiness 已被更改。
真实 mutation 必须 baseline 通过、移除 guard 后出现行为断言失败、恢复原字节后通过；未执行测试、导入/解析异常不算杀死 mutant。
报告保留实际变异文件和前后 hash，原工作树不变。

## 条件进展

OperationEventuallyExplained 要求最终达到 retired 或 blocked；后者明确保留未解意图，不能算业务完成。
ReadEventuallyExplained 仅针对已经开始的读取，要求最终发布或明确拒绝。

这两条性质以模型列出的弱公平性为前提：已开始的外部调用返回，用户最终发起一次准确 resume，
验证/完成/退役与已开始的读继续得到执行。它们不证明永久断网下成功，不自动替用户恢复未知写，
也不保证 Notion 与 provider 的任意延迟。没有这些假设只声明 safety。NoDeadlock 不能替代这些进展性质。

## 图、源码对应及未覆盖范围

runner 为每次配置保留实际 TLA/cfg/view、TLC 原件、规则结果、报告和可生成的 Mermaid。
view 按内容 owner、finite intent 和 current read 展开并行区域；相同标签的内部转换会折叠。
超过工具图形状态预算时可能只生成反例路径，不能把图节点数当完整状态数量；TLC 完整探索仍须通过。

[coverage.json](coverage.json) 固定实际 source/test 输入和原子边界。
源码变更先审具体 diff；更新 hash 只表示对应关系已审，不是 refinement 或新的通过回执。
模型没有枚举 Source 父子游标、多个文件/owner、schema 升级、multipart、SQLite 崩溃、跨机 CAS、
精确 path/hash/mode、自然语言、Pi 会话及 provider 行为。它们沿各自现役入口验证，不由本套件代填。
