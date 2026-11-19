# 当前请求引擎与成本

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。本页覆盖实际传输、在途共享、调度、取消和调用预算；有限模型沿现有 [request-engine-formal](request-engine-formal.md)，不建立另一套 runner 或固定结果档案。

## 选择必要检查

普通读取、重试、预算或共享请求改动，选择受影响的现有测试：

~~~sh
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/request-metrics.test.ts packages/core/test/shared-read-coalescing.test.ts --timeout 60000
~~~

机器级调度或跨进程准入改动，再使用实际 Node 检查：

~~~sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-request-scheduler.node.test.ts packages/core/test/notion-scheduler-multiprocess.node.test.ts
~~~

固定来源或跨 SDK runtime 的在途获取发生变化时，选择现有 `shared-source-materialization.test.ts`、`shared-immutable-read.test.ts` 与 `sdk-immutable-read.node.test.ts`。这些文件分别位于 packages/core/test，不要求每次消费改动全部重跑。

## 当前不变量

- 一个 invocation 的子请求与重试共用 attempts、bytes 和 deadline。不同调用不能借用额度；请求体必须先准入，已准入响应造成的 byte overshoot 如实记录。显式新 resume 才有新额度。
- 每次真实 HTTP attempt 只计一次，队列等待与 transport timeout 分开。取消或 deadline 到期后不再派发新请求；未知写入结果不能按普通重试补发。
- 只合并完整身份相同的在途读取。credential、endpoint、请求 body、scope、Store/client、固定内容与预算的差异不能跨界共享；消费整段、写入与未知结果不合并。
- 一个 waiter 取消不破坏其他 waiter。最后 waiter 离开后 producer 不再吸引新请求，cleanup 完成才释放其容量；慢 finalizer 不能误删替代 producer。
- 成功与失败完成后不保留为全局 response cache。固定 bytes 复用仍要满足当前 owner/descriptor 和本地对象校验；损坏不能靠重新下载掩盖。
- 调度遵守既有并发、速率、冷却、队列与取消合同。暂停请求不能占用实际网络 permit；重试、provider、multipart 和派生读取不能绕过本次预算。

Notion query POST 是语义读取，其他请求按实际行为分类。消费结果只描述当前零写或未知，不以历史保留写作为另一种成功消费。

## 测量与停止条件

使用实际 `--json --metrics` 或 SDK metrics 和既有受控 HTTP ledger。区分冷读、metadata 复核、有效 TTL 命中、单文件变化与精确按需获取。比较必须保持完整内容、scope、权限、freshness 与预算相同；少解码不等于少 HTTP。

部分响应或取消时只报告真实观察到的 prefix 和 attempts，完整 bytes/hash 保持未知。共享 producer 尚在运行时，某个取消 caller 的 metrics 也只是它结束瞬间的观察，不代表全部流量。不得通过延 TTL、提高 limit 或减少正文制造收益。

安装层沿 [package check](portable-export-package-consumption.md)，真实 Notion/Pi 分别报告。当前形式化入口保留既有配置与反例，按改动运行；源码、模型或受控计数足以证明本次边界后就停止，不补新的多层证明流程。
