# FV07：RequestEngine 有限合同

适用 Issue：AH-1013。它为现有请求引擎补充模型与真实源码守护，关联原 [request-engine 地图](request-engine.md) 的 SC15、NG-RE-03、NG-RE-04；不替代它们的真实 SQLite、多进程、HTTP 或已安装产物验收。

## 快速入口

从 CLI checkout 执行，输出使用本轮新的外部绝对目录：

```bash
PSTACK_STATECHART_ROOT=/absolute/pinned-pstack/pstack/skills/statechart \
TLA2TOOLS=/absolute/tla2tools-1.7.4.jar \
node scripts/verify-resource-lifecycle.mjs --suite request-engine --out /absolute/new-fv07-models

python3 scripts/check-request-engine-mutations.py --out /absolute/new-fv07-guards
bun test packages/core/test/request-engine-contract.test.ts
```

工具和依赖先按仓库 lock 安装。模型配置目录、源码哈希和完整规则清单在 `verification/models/request-engine/coverage.json`；详细边界与 source/guard 映射见 [RequestEngine README](../../../../verification/models/request-engine/README.md)。

## Drive 和独立观察

| 子合同 | 必须观察 |
| --- | --- |
| SharedProducer | 取消一个 waiter 不停止其他 owner；最后 owner 离开释放 producer；身份、service、queue budget 与 invocation budget 均独立；已完成结果不缓存；旧清理不删除替代 producer |
| RequestAdmission | 冷却、排队期限、operation deadline、attempt timeout、次数预算分别有效；等待不占网络 permit；取消释放 queue entry；未知写入没有第二次 attempt |

模型正例必须完整通过；16 个负配置各自只破坏声明的规则。真实代码回放独立检查 16 处 guard，每组都需原件通过、突变触发实际断言失败、恢复通过，并确认共享 checkout 未变。回放没有真实凭据或远端 mutation。

## Evidence

模型 run 保留 `summary.json`、完整规则结果、TLC 原始回执、输入快照、图和工具清单。guard run 保留逐组 baseline/mutant/restored 日志、原件/变体、source/依赖/执行器 hash 与 `summary.json`。遇到导入/工具错误、未执行测试、截断、额外 broken 或 coverage 漂移立即停在失败，不补写通过结论。重新运行使用新目录并保留旧目录。

本模型的正文共享仅在同一个 Notion service 内。同机多个 CLI 的 SQLite 共享的是准入，不共享 producer/正文。模型启用了 opt-in RequestBudget，不把普通 admission deadline 等同于整次 operation timeout。Effect 4.0.5 仅验证两个 Cache 生命周期守护的有限对应；不声称证明整个库。

## 图和退出

图来自同一 TLA+/cfg 的 `/statechart` 输出，并按该 skill 渲染 SVG。详情和已渲染图位于 `verification/models/request-engine/charts/`。该离线流程无后台服务；保留 owned fixture 与失败原件，结束后不要清理用户工作区或远端对象。

