# 原 ACK 续接：局部图面修正

RV2 只修改 `AcknowledgedContinuation.view.mjs`。TLA、cfg、性质、有限域与产品源码未改；既有 10 个正负配置均完整执行并匹配原预期。生成图和报告来自原运行器，SVG 使用 Pele 1.9.0；输入及图件身份见 [manifest](manifest.json)。

[完整正图](AcknowledgedContinuation-cfg.svg) · [Mermaid](AcknowledgedContinuation-cfg.mmd) · [报告](AcknowledgedContinuation-cfg.report.md)

图中保留“服务端已应用本阶段 → 没有原 ACK，结果未知”，以及正文已变化后原证据又失效的路径。前者不能被折叠成“应用后必定收到 ACK”；后者不再隐藏第二种拒绝原因。阶段编号仍按同一有界循环聚合。

[未知续接被重发的反例](AcknowledgedContinuation-native-replay-cfg.svg) · [Mermaid](AcknowledgedContinuation-native-replay-cfg.mmd) · [报告](AcknowledgedContinuation-native-replay-cfg.report.md)

此反例仍只违反 `AtMostOneContinuationDispatch`；不是当前产品发生重复写入的证明。自环及同标签内部步骤按原工具规则省略，最短坏路径保留。历史图册及其原 manifest 保持原状，本页是当前 view 的精选图，不宣称重跑全部模型或真实 Notion。

从仓库根，按 [工具配置](../../../verification/models/resource-lifecycle/README.md) 和 [SVG 渲染](../../formal-verification-maintenance.md#图形产物定位与复现)复现：

```sh
node scripts/verify-resource-lifecycle.mjs --suite lifecycle --model AcknowledgedContinuation --out /absolute/new/continuation-results
node --test scripts/formal-view.test.mjs
```

完整 TLC 和输出留在此次运行目录；未把维护者私有路径作为复跑前提。`OldPinPreserved`、原页面/历史固定输入和真实权限的区别见 [模型范围](../../../verification/models/resource-lifecycle/README.md#assumptions-versus-checked-behavior)。
