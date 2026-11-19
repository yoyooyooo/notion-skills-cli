# 请求引擎有限合同

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。SharedProducer 与 RequestAdmission 保留既有 21 个配置和完整规则，当前源码映射见 [README](../../../../verification/models/request-engine/README.md)。

## 运行

在 CLI checkout 安装锁定依赖，配置与 `verification/models/request-engine/tool-lock.json` 相同的工具，输出到本次新的外部空绝对目录。

```sh
PSTACK_STATECHART_ROOT=/absolute/pinned-pstack/pstack/skills/statechart \
TLA2TOOLS=/absolute/tla2tools-1.7.4.jar \
node scripts/verify-request-engine.mjs --out /absolute/new-request-models

python3 scripts/check-request-engine-mutations.py --out /absolute/new-request-guards
bun test packages/core/test/request-engine-contract.test.ts packages/core/test/shared-immutable-read.test.ts packages/core/test/shared-current-invocation.test.ts --timeout 60000
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-immutable-read.node.test.ts
```

按变更选择必要实现回归；受影响模型运行全部原正负配置。旧生命周期与 ACK 恢复套件已退役，没有 `--suite` 兼容路由。

## 对应边界

| 模型 | 必须观察 |
| --- | --- |
| SharedProducer | 取消单一 waiter 不影响其余 owner；最后 owner 离开中断请求；service、credential、queue 与 invocation budget 隔离；完整当前字节身份允许独立 SDK runtime 共用 pending 只读请求；creator Scope 关闭不取消 survivor；settled result 不缓存；旧清理不删除替代 producer；慢 finalizer 保留容量 |
| RequestAdmission | 一个逻辑请求的冷却、排队、有限次数重试与 attempt deadline；等待不占网络 permit；取消释放队列；未知 mutation 没有第二次 attempt |

两个正配置必须完整通过，19 个负配置必须精确打破声明的规则。真实代码回放也有 19 个 guard，每个都检查原件通过、突变行为断言失败、恢复通过和产品 checkout 未变。当前 immutable case 修改 current resource reader，并通过公开 SDK 观察取消。

## 未建模范围

模型的容量是有限抽象；实际 64 条和 16 MiB 准入、字节计费、默认管理总预算、嵌套调用、provider 下载、multipart 和 writer partial/resume 由实际测试检查。RequestAdmission 只有一个逻辑请求的重试链，不证明整次多步骤 import。

传输共享在同一 Notion service 内。当前 exact bytes 可在同进程、身份一致的标准 SDK runtime 间使用独立只读 producer；每个调用者自己检查当前资格。自定义 transport 和带 RequestBudget 的调用绕过该共享域。同机多个 CLI 进程仅共享 SQLite 准入。

## 结果与结束

读取 summary、完整规则、TLC 原始结果和实际测试结果。工具错误、未执行测试、cut、额外 broken 和未经审阅的源码漂移都必须失败。运行产物仅用于本次诊断，不作为内容版本或永久签收。模型通过不能证明 live Notion、清退、安装或 Pi 日用。
