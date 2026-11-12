# 原操作恢复生成图册

本页只索引真实锁定工具生成的图与报告。完整模型、边界与源码对应见 [上级说明](../README.md)。

| 模型与配置 | TLC 状态 | 图状态 / 箭头 | 原图 | SVG | 报告 |
| --- | ---: | ---: | --- | --- | --- |
| AcknowledgedRecordPrefix / cfg | 77 | 19 / 25 | [Mermaid](AcknowledgedRecordPrefix-cfg/chart.mmd) | [SVG](AcknowledgedRecordPrefix-cfg/chart.svg) | [报告](AcknowledgedRecordPrefix-cfg/report.md) |
| AcknowledgedRecordPrefix / missing-ack.cfg | 115 | 20 / 26 | [Mermaid](AcknowledgedRecordPrefix-missing-ack-cfg/chart.mmd) | [SVG](AcknowledgedRecordPrefix-missing-ack-cfg/chart.svg) | [报告](AcknowledgedRecordPrefix-missing-ack-cfg/report.md) |
| IndependentAcceptance / cfg | 216 | 19 / 23 | [Mermaid](IndependentAcceptance-cfg/chart.mmd) | [SVG](IndependentAcceptance-cfg/chart.svg) | [报告](IndependentAcceptance-cfg/report.md) |
| IndependentAcceptance / equal-current-is-old-success.cfg | 216 | 15 / 19 | [Mermaid](IndependentAcceptance-equal-current-is-old-success-cfg/chart.mmd) | [SVG](IndependentAcceptance-equal-current-is-old-success-cfg/chart.svg) | [报告](IndependentAcceptance-equal-current-is-old-success-cfg/report.md) |
| RestoreFeedback / cfg | 45 | 23 / 30 | [Mermaid](RestoreFeedback-cfg/chart.mmd) | [SVG](RestoreFeedback-cfg/chart.svg) | [报告](RestoreFeedback-cfg/report.md) |
| RestoreFeedback / repeat-body-after-feedback-loss.cfg | 99 | 24 / 35 | [Mermaid](RestoreFeedback-repeat-body-after-feedback-loss-cfg/chart.mmd) | [SVG](RestoreFeedback-repeat-body-after-feedback-loss-cfg/chart.svg) | [报告](RestoreFeedback-repeat-body-after-feedback-loss-cfg/report.md) |

本次完整运行含 28 配置；三个正例无违例，25 个故意反例只命中预期集合。完整 report/TLC 临时输出保存在原件根。少量正图超过 20 条箭头，是为了保留入口拒绝、原子派发、ACK、未知停止和冷读边界；最短反例动作没有隐藏。

独立接受的本 Record 循环投影三个有序阶段。正文动作完成、独立接受完成、业务反馈完成是三个不同事实，不能互相替代。

本图册的 manifest 汇总有限模型、149 条公共函数回归与四个实际 guard 对照；独立冷 Agent 回执由批次验收另行附加，在拿到回执前不得将新 guardian 标记为 ready。图不证明生产 Notion、安装 CLI、任意长度前缀、provider CAS 或跨机器 exactly-once。
