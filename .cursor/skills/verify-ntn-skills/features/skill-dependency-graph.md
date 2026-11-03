# Skill 依赖图

跨 Skill 图复用既有 CLI 与 Broker 验证链。先读同目录 [request-engine](request-engine.md) 的 Launch/Doctor/Drive/Evidence/Cleanup，再使用 Broker 的 `.agents/skills/verify-notion-skills-integration/features/skill-dependency-graph.md`；后者定义 observer trace/oracle 合同。AH-560 单 Skill 与资源的旧 pass 不覆盖本地图。

## 后续切片的稳定 feature ID

| Feature ID | Issue | 必须通过的行为 |
| --- | --- | --- |
| NG-SG-06 | AH-567 | 普通 Skill 与 Router 的原生 Members/Requires，准确同库身份、完整关系分页、重复/禁用/越库失败。 |
| NG-SG-07 | AH-568 | 上游刷新仅写白名单；本地关系、手工删除、附加字段、正文/custom/资源和旧 pin 保留。 |
| NG-SG-08 | AH-569 | mention/page link/Link to page 编译准确 Skill/File ref；重名、未受管/越库/无权限目标不猜测。 |
| NG-SG-09 | AH-570 | Pstack 实际原生关系和引用校准；保护已有字段与版本，有变更计划和直接 readback。 |
| NG-SG-10 | AH-572 | 无 shell 的 Agent 通过原生发现/read 取得准确成员和资源，无本地插件副本兜底。 |
| NG-SG-11 | AH-573 | Gate A，只选 Pstack Router，自主选择并读取验收成员主文与 feature-map。 |
| NG-SG-12 | AH-571 | 统一 prepare，use 完成必需闭包、inspect 不采用流程；环、缺失、版本/预算冲突明确失败。 |
| NG-SG-13 | AH-574 | Pi `$`、native `/skill:`、read 和多目标入口共享准备/注入/取消，首次 provider 请求前前置齐备。 |
| NG-SG-14 | AH-576 | Gate B，只选 poteto-mode 类 Kind=skill；不再选择 Router，模型自行继续成员引用链。 |
| NG-SG-15 | AH-577 | 实际选择图的 A/B 版本向量、resume/fork/rewind/compaction 与重复注入边界。 |
| NG-SG-16 | AH-575 | metadata/Files/Records 批量共享、在途复用、正文hash/关系摘要/parser版本绑定的局部图失效。 |
| NG-SG-17 | AH-578 | 完整闭包 manifest，空机器按 Records 恢复精确历史；缺失/坏hash拒绝，不能回退 current。 |
| NG-SG-18 | AH-580 | manifest_complete 与 local_files_ready 分离；固定完整清单可按需物化，完整 export 仍拿齐字节。 |
| NG-SG-19 | AH-579 | 预取默认预算零、低优先可取消、不决定可选版本、不写 loaded/selected 或扩大授权。 |
| NG-SG-20 | AH-581 | 全冷/暖/会话/故障/安装矩阵；仅覆盖缺口需要时选一个 Matt 小图验证通用性。 |

## 两条冻结用户路径

Gate A 的选择只有真实 Pstack Router；Gate B 的选择只有 poteto-mode 类普通 Skill。两者使用同一自然任务：为项目建立可复跑验收流程，覆盖用户入口、正常/失败路径、证据与清理。目标成员名、ref、答案、资源路径只进入私有 oracle，不进入用户提示、首轮 provider 输入或强制工具参数。

`baseline` 的 `prompts.json` 保存默认根选择和精确提示/hash。真实运行须从实际只读目录回执取得根 alias/ref/kind，再以 `--router-selection` / `--ordinary-selection` 冻结该选择；禁止凭名称推测稳定身份。未绑定真实根的模板不算 Gate 已执行。选中 Router 不预读候选正文，且不得读取普通 Skill 充当桥梁；普通 Skill 也不得改 Kind 或把目标叶子加 Requires 来强迫通过。

## 身份、缓存与证据

oracle 与消费者各自隔离配置和内容根，在同一明确授权身份下原位使用凭据，不复制 secret、不交叉暖化。消费侧 CLI/Broker/session 三层的实路径彼此独立，冷场景启动前为空。身份包括 connection/library scope、稳定 Skill/File ID、公开 ref、实际 snapshot、完整字节数和 SHA-256；oracle 不能替消费侧预热，也不能决定模型选择。

离线契约会拒绝隐藏 Pstack/Matt 插件副本、猜名、错误 ref/hash/scope/snapshot、不完整主文/资源、预置叶子、强制工具、HTTP 200 许可消息、缺 final、无真实 provider 字节和缺失进程退出。`contract-valid` 不认证 trace 来源；审阅实际原生调用、provider、HTTP账本和产物后才能作对应层的结论。

新增实现时保持上表 ID，更新此地图和 Broker 对应入口，把精确命令及实际结果加入外部证据。不得仅凭 schema、静态扫描、零测试、目录存在、模型自述或编译通过把后续切片记 Done。
