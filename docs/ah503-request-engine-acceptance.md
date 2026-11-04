# AH-503 请求引擎补充验收

日期：2026-11-04。

本轮从已经完成的 [AH-561](https://linear.app/yoyooyooo/issue/AH-561) 继续核对承接范围，补掉 Linear 主动来源读取中的原生 fetch 业务路径，并完成新包安装与正常 Pi 新会话验证。**本次修复已交付；AH-503 整体保持 In Progress。** Generic Git/Registry 的来源获取成本观察尚未贯通，不能由 Notion/Linear 的结果推导为原票全部完成。

AH-561 及其 21 个子票的 Done 和原始验收结果保留。本轮也将 AH-578 的固定图历史恢复回填 AH-509，将 AH-573 的 Pstack Router 真实模型消费回填 AH-259；两张历史票的未覆盖范围和状态保留。

## 修复内容

原默认 Linear transport 在 Effect.tryPromise 内执行原生 fetch 和手工 reader 循环。现改用仓库已安装的 Effect 4.0.5 HttpClient、HttpClientRequest、Stream 和 Scope，没有新增依赖或第二套 HTTP 引擎。

- 一个 scope 覆盖请求发送、响应流和 JSON 解析。整个操作共用 45 秒期限，不在收到 headers 后重新计时。
- 按原始流式字节限制 8 MiB，在 UTF-8 解码前检查。保留完整资源最多四并发。
- 保留原始 API key 的 Authorization 值、固定 Linear endpoint、禁止重定向和显式非 2xx 拒绝；不新增隐藏 retry。
- 首个资源失败会取消其余活动请求，排队资源不继续启动，不返回部分 SourceSnapshot。
- 外部中断保持中断语义；超时、空 body、超限和网络错误分别归类，公开错误不包含凭据、响应正文或请求 headers。
- check、fetch、prepare 显式传入既有 RequestMetrics。Linear 只读 GraphQL POST 计为 provider 请求，不计为 Notion 写入。公开命令账本仍由 NTN_SKILLS_REQUEST_TRACE_LIMIT 按需开启。
- 底层 Linear adapter 没有新增对 Notion service 的业务依赖。现有 CLI runtime 提供官方 HTTP 服务。

源码提交为 [03bf68895716034529c30f7600c213daf011aa38](https://github.com/yoyooyooo/notion-skills-cli/commit/03bf68895716034529c30f7600c213daf011aa38)。涉及三个正式调用文件、一个新增边界测试文件，以及共享架构/SS19 验证地图。

## 分层验证

| 层次 | 实际结果 | 证据边界 |
| --- | --- | --- |
| 默认 transport 与业务回归 | 37 pass、0 fail、174 assertions；其中新增 21 个 HTTP 边界、7 个既有 adapter、9 个 refresh | 受控 HTTP/Effect 时钟，不冒充真实服务 |
| 全仓类型检查 | exit 0 | 不代替功能验证 |
| 真实 Linear，只读 | Node v24.20.0；1 个 HTTP 200；请求 139 B、响应 2,698 B；实际响应正文 hash 与来源版本一致 | 直接运行正式 source 函数的 Node 构建；public_cli=false，没有创建生产 Source |
| CLI 独立安装 | 既有 43 项消费检查全部通过；Node v24.20.0 | seeded offline consumer；包含独立历史 operator，不冒充本轮线上迁移 |
| 安装产物完整性 | CLI 30 个、Broker 62 个发布文件逐项匹配 tarball | 新的日用目录分别独立 npm 安装，未复用旧包内容 |
| 正常 Pi 新会话 | 实际自动加载新 Broker，默认随包 CLI、pstack@notion 身份和正常配置验证通过 | 新建 owned 会话，未重启已有用户会话 |
| 日用实际请求 | 18 metadata＋1 次显式 doctor 正文读取；启动/查找正文 0；模型调用、工具执行、Notion mutation 均为 0 | 另有 7 条其他插件 HTTP，单独保留，不计入 Notion 消费 |
| 退出与配置保护 | Pi 观察到关闭，启动器、验证子进程和 Pi PID 独立检查均已不存在；验证前后配置、安装文件、shim 和审核 catalog hash 不变 | 仅本轮 owned 进程；未按进程名称终止用户会话 |

四并发测试在被测操作完成后、finally 清理前断言 watchdogFired=false。实际 1.74 ms 自行结束，保留了峰值 4、三个 sibling 取消、排队资源不启动、failure 1/cancelled 3/in-flight 0 的断言。两秒测试兜底不能帮助形成通过。

当前生产 Sources 的公开只读 list 返回 59 项，全部为 Git，没有现存 Linear Source。因此本轮没有用真实 sources check/fetch 命令验证 Linear，也没有为此向生产库新增测试行。真实服务读取、受控调用者测试和独立安装分别报告。

### 保留的失败与校验修正

默认 HTTP 接缝的 RED 在源码修改前实际失败，并设置了全局 fetch 防护，没有访问外部服务。早期测试还保留了 Bun 异步断言顺序和 fetch 替身类型错误，修正只发生在测试中。

第一次真实读取收到 HTTP 200，但校验器错误地将 Linear 连接器的展示文本当作原始 GraphQL 字节，严格 hash 比较失败。独立检查确认只有三个 Issue 链接的表示不同：连接器返回 issue 标签，原始 API 返回 Markdown 链接；其他所有字符相同。原失败保持 failed。

随后新场次使用只观察、不改写请求或响应的真实 HTTP 响应副本，独立核对原始正文、身份、updatedAt 与来源 hash，实际通过。没有修改产品正文来满足 oracle，也没有将原失败改记为通过。

## 实际安装产物

CLI 和 Broker 的版本号分别仍为 0.1.0 与 0.0.2；本轮是内容 hash 固定的本机安装产物，没有声称向公共 npm 发布。

| 产物 | SHA-256 |
| --- | --- |
| CLI tarball | 92f2c4b59c665cd2f55f76309b1af100f536aa9f591b064b51fb3120712c68c0 |
| CLI standalone entry | 753e6fad418a56d57e4e3d72099f79de9f5050c19cfe65cc4eafaf7c5ff3a918 |
| Broker tarball | 302159449a60fd57ba8e1853e75493039b14910fd4c3b7dab2832bb22ea705e9 |
| Broker embedded CLI | 47c42b15b0364c05877eb5ad5c68bf6ff765b5688c057420ed1ea4578c19bac5 |

CLI 来源为 03bf68895716034529c30f7600c213daf011aa38。Broker 逻辑来源仍为 83260c1c75e2b513834396efbfdad3d41c0ddfd5，本轮仅以 broker target 重新嵌入新 CLI 和打包，不构建或改写 Tern。

日用位置：

- /Users/yoyo/.local/share/ntn-skills/installed/ah503-92f2c4b59c66/node_modules/ntn-skills
- /Users/yoyo/.local/share/context-broker/installed/ah503-302159449a60/node_modules/pi-context-broker

实际切换只修改 /Users/yoyo/.local/bin/ntn-skills 和 Pi settings 的第 2 个包位置，20 个非目标插件和其他 settings 字节保留。切换前的两个完整文件有独立备份。实际 shim --version 退出 0；正常新会话验证也退出 0。

原 AH-561 的 A/H11 与 B/H12 真实模型证据继续绑定 CLI9/Broker10。本轮未重新运行两条模型矩阵，不能将旧样本写成新包上的 A/B 重跑。

## 原票范围核对

| AH-503 原条件 | 本轮可以确认 | 保留条件 |
| --- | --- | --- |
| 并发、相同读取合并、权限和取消 | Notion service 内在途合并及权限隔离由原引擎证据承接；机器级 SQLite 共享准入/冷却；Linear 单次来源发现最多四个完整资源并发 | 不把同机节流写成跨 CLI 共用正文 producer，也不新增全局正文共享工程 |
| 限流、连续失败和流式超时 | Notion 的 429/529/Retry-After 与总预算由 AH-565 承接；Linear 非 2xx 明确单次失败，headers/body 共用 45 秒及 8 MiB | 不把 Linear 单次拒绝写成 Notion 调度器的跨进程退避 |
| 取消、晚到结果、资源释放与未知写入 | 原 AH-561 证据及本次 21 个边界覆盖当前改动；真实读取只读 | 历史 unknown 保持原记录，不重放 |
| N+1、Provider 成本与正式 Effect 路径 | Notion 图批量准备由 AH-575 承接；Linear 当前正式路径已迁移并接入账本 | Generic Git/Registry 的主动来源成本观测仍未贯通，AH-503 不整体 Done |

Generic Git/Registry 已有 Effect Process/HTTP、Scope、执行时限和字节上限，不能称为尚未实现资源管理。当前缺口是从 Sources 入口贯通可审计的来源获取成本：Git 逻辑操作、实际可观察的字节/耗时，以及不能直接观测的底层网络次数需要分别表达，不能把未知网络请求写成零。无需为此另建 Git 网络代理或集中调度服务器。

历史四 ACK re-sign 恢复、SQLite 动态 import、私有路径 lstat 与 multipart 编码不属于本轮新增修复，不以其存在推断另有业务引擎，也不宣称全仓 Promise 清零。

全局 Namespace 仍有 25 条旧库 catalog 成员不可用，来自 open-source-bundle 和 matt-engineering-suite。其审核 catalog hash 仍为 2e6f2be190d667af8c5fd47873be3920e9d8253a0fd14834e9b3e24dc667bc4a。正常 Pstack 结果不将这些旧成员改判为可用；AK 权威配置与生成链属于 AH-516 的独立范围。

## 证据索引

本轮持久根目录：

/Users/yoyo/Library/Logs/ntn-skills/AH-503-20261104/delivery-G3piT6

| 记录 | 位置与 SHA-256 |
| --- | --- |
| 源码及受控测试冻结 | ../linear-http-bJWAbC/freeze.json；bc9a8ca6df68e916325dbc7a31b4b827cacb83f2d2670cca0eb56c71d1347b39 |
| 真实 Linear 新场次 | live-linear-00wxN6/result.json；1044d195b5ce6014375801b02b3f5ac5decc8e524ec318510e3b4683ff5afc32 |
| 独立 wire 观察 | live-linear-00wxN6/wire-observation.json；1d465eab3313c7500a0973ca1040506ae3e9c703b8b02ed334276bc7267b3e66 |
| 连接器表示差异 | live-linear-00wxN6/connector-normalization-review.json；保留与原 failed 场次的精确关系 |
| CLI 独立安装矩阵 | cli-package-BbFuNb/run/evidence/package.json；1c03011d7da8589c1f8b3b68f140488ea26a2a395f9d1f0f17afc8ec5b3767ad |
| CLI 原始消费证据 | cli-package-BbFuNb/run/evidence/installed-consumer.json；b890490d254040e0cb8bf33f36002f36b3bfcb5d5777a32052739c2e2cb21bb5 |
| 两包准备和逐文件 closure | candidate-preparation.json；actual child exit、全部发布文件和安装身份 |
| 日用切换 | activation.json；原状态 activated_awaiting_normal_session_validation 为切换时点，后续实际结果另列 |
| 日用实际验证 | daily-validation/daily-pi-ggKb48/result.json；0418375a4bb19cbb1ff34fd6fe7a17a13d06554d0374d0a0674cb8fa60005a56 |
| 日用实际终局 | daily-terminal.json；Node 验证进程 exit 0，daily-process-review.json 独立检查 PID |
| 原始工作区保护 | baseline.json、source-commit.json；CLI 1615 个既有保护路径保持，Tern 原 index 和工作树保持 |

最终文档提交、推送、回填状态和本轮 owned 临时目录清理由外部 delivery-closure.json 记录。该记录不要求反向改写已经冻结的包、测试回执或历史 AH-561 账本。
