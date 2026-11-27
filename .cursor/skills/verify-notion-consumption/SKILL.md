---
name: verify-notion-consumption
description: "验证 ntn-skills 当前完整目录、有界元数据、正文与子文件、任务内选择、缓存、导出及普通消费远端零写。修改 list/read/use/files/export、Hosted MCP 内容搜索与独立 Token/OAuth、权限、精确获取或 freshness 时使用，不保留历史内容恢复合同。"
---

# 当前消费验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 1、3、5 组。本入口负责 CLI/SDK 当前字节和成本，不负责作者写入恢复，也不负责用成功读取代替 Pi 投递。

## Launch

从仓库根执行，复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch)。独立消费者不复制作者 Store。安装检查使用实际 bin/SDK，移除开发 override；scope、凭据、endpoint 和 freshness 保持相同。

## Doctor

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-relative.test.ts packages/core/test/bounded-graph-metadata.test.ts --timeout 60000
~~~

这些测试直接驱动当前 reader 的受控 Notion 边界，记录查询、正文与语义写；不是仅调用一个拒写 wrapper。缺 Content、非 ready、错 owner/path、分页未完或截断正文不得产出完整快照。

## Drive

1. 核对完整目录和 binding。Skills 主文唯一，Files 只含 supporting；所有来源共享相同当前 descriptor。精确 owner/Requires/Members 按 physical target 与 stable claim 有界读取，局部结果不能标 complete。Disabled 重复声明仍拒绝；显式 catalog/name 与 native 外部引用保留完整 inventory。目录完整与 Notion 全文投影分别验。
2. native 冷读、无变化 metadata 复核、单文件直接编辑、缺本地正文及独立全文期限各走一次。三份 native 文件的固定 fixture 冷读为 9 请求、3 body；无变化 metadata 复核为 6 请求、0 body。前后 owner 与完整目录 fence 均计入；以 shared-current-snapshot.test.ts 的当前 oracle 为准，不推广为所有 live 请求数。外层有效 TTL 直接命中才是 0 HTTP。
   同一原生选择连续两次 `refresh` 后，使用同一真实 SQLite 的第三个独立 Node SDK 进程按 `maxAge: 300000` 读取；核完整正文、固定 snapshot/ref、第二次真实 `validated_at` 均保留，整个暖读 0 HTTP，未选 supporting 资源仍未物化。`sdk-immutable-read.node.test.ts` 持有这条公开 SDK 回归。不可变 manifest 的 `created_at` 保持首次存储值，不能把它当作最近校验时间；tree proof 必须绑定磁盘中实际 manifest 的全部字段，不能删除时间戳参与摘要来消除失配。
   `shared-current-evidence.node.test.ts` 另用真实 Store/SQLite 和可控交错检查两个首次写者都观察到同 ID 缺失后，后写者重新读取实际不可变赢家。该回归保持当前 metadata、acquisition 和独立 freshness；不能用 Map Store 或全量预载资源替代。
3. stable claim query 只选择身份；正文前的精确 owner GET 决定当前权限与 metadata，不能复用 query 行替代。Name/Description 变化返回当前 metadata，但不改 bytes 或内容身份。原任务选择仍保留其 metadata。改路径或删当前行不被旧 cache 复活。正文/provider 后的 owner/Files/Source fence 须重新观察，不复用本轮局部 claim。
4. 同任务内保持一份完整选定目录。缺 Source/resource bytes 只可使用仍相符的当前 owner/descriptor；缺 native 旧选择字节或当前声明变化要求重选，不恢复远端历史。
5. 每文件 acquisition v5 支持多 Source、native 和 resource。Source/resource 核 exact hash/bytes/mode；native 核实际当前正文加显式 frontmatter/mode，不承诺写入前 Markdown 字节。检查按需获取、offline 不发请求及权限拒绝；generated body 编辑不自动接管。 已观察到的 target `ACCESS_DENIED` 或 scope `AUTH_REQUIRED` 对 offline 正文同样生效；历史目录不授予正文权限。保留未知网络失败下的离线正例，以及业务 Enabled 关闭后的完整旧字节正例。T05 必须从公开 SDK 实际观察 401/403 后检查 scalar、batch、use/inspect 与 clear 后行为，不以直接构造失败对象代替这条边界。
   精确 child403 只归因已观察的 physical path；库级 claim 拒绝、未知或不匹配 path 不得误伤 root/其他 scope。physical 拒绝先于 alias 读取及 stable 写入持久化；分别注入后两步故障。用实际 SQLite 验 alias 退休、clear、迟到 grant，以及同 stable 两个正文版本的 fresh 恢复；逐个 pin 核原 hash。physical 授权槽不成为第二份正文 cache status。
6. 相对文件留在选定 owner；跨 Skill 路径需要可靠 containing-file Source 证据或完整身份引用，不能按缓存布局补全。沿 [引用验证](../verify-ntn-skills/features/skill-reference.md) 检查两库重叠、正文 Library 上下文、固定 manifest 的 owner/path/entrypoint 与缺失拒绝。Source 文件不必有 Notion File 投影行。整包 export 与单文件 read --output 分别核 bytes/path/mode；任意多路径 export 尚未公开，不发明选项。
7. 真实公开 list/read/use/files/export 的语义写计数均为 0。Notion query POST 是读；Record 创建、投影、adoption 和清理都是写。
8. SDK 的完整 `options.env` 同时约束配置和实际 Git 子进程；并发 operation 不共享可变环境。公共 consume 的接线必须有受控 Source/实际 shim 证据，单独测试 runtime 不能代替。
9. 取消不只检查 SDK 返回。POSIX Git 主进程及其自有进程组须收束，包括主进程先退、孙进程忽略 SIGTERM 的情况；保留原取消原因、2 秒强杀边界和 stderr 保密。不改认证或延长预算制造通过。
10. 持久 current evidence 绑定精确 scope、实际读到的 page/Files/Sources/relations 指纹与单调事实 epoch。已观察变化立即阻断旧 current；unknown、失败或重复 unchanged 不恢复旧资格、不反复制造失效。旧 observation 缺完整 proof 时补验，不能由 schema 迁移抬升；原 pin 与合法不可变对象保留。最终 root 与所有 Requires 的读集在一次实际 SQLite 检查中共同核事实、权限和退休记录。候选展示、单页 unchanged、根成功均不能替代该准入。

跨进程事实、最终读集和旧版本反复出现的回归沿现有 Node/SQLite 入口；Files、Contributions 和关系全集由当前 snapshot fence 负责，partial 不得标 complete。`shared-current-evidence.node.test.ts` 使用真实 Store 和既有 transport hook，补核冷 9 HTTP/3 body、metadata 6 HTTP/0 body、完整成员增删、根时间不变的关系分页、物理 Source 换页，以及较早网络观察不能借后到 caller 的新 generation 覆盖较新事实。同协议旧库缺 `current_facts` 时仅加表：保留原 pin/bytes，缺完整 proof 的 current 经元数据补验才重新取得资格，不能由升级或旧候选嫁接 proof：

~~~sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/current-evidence.node.test.ts packages/core/test/shared-current-evidence.node.test.ts
~~~

相关当前获取和请求检查：

~~~sh
bun test packages/core/test/shared-acquisition-contract.test.ts packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-read-coalescing.test.ts --timeout 60000
~~~

元数据、授权、SDK 环境或 Git 生命周期变化执行对应的现有边界回归：

~~~sh
bun test packages/cli/test/sdk.test.ts packages/core/test/source-git-runtime.test.ts --timeout 30000
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-bounded-metadata.node.test.ts packages/core/test/sdk-immutable-read.node.test.ts packages/core/test/sqlite-state.node.test.ts
~~~

快速补全的 SDK 本地边界沿 `packages/core/test/candidate-snapshot.node.test.ts`
验收。公开 `readCandidateSnapshot` 必须在无 HTTP transport/scheduler、View 或正文
获取的情况下返回 miss/blocked/snapshot，并保留原观察时间。用真实 SQLite 核完整目录
经历 partial、failure、exact deny 后仍正确保留；后到旧 generation 不得覆盖新事实，
complete empty 必须撤掉旧项。两库、换凭据、disabled 与精确 physical 拒绝分别隔离。
这里不证明 Pi 下拉首帧、同屏更新、高亮或排队输入；这些仍由 Broker integration 验。

缓存、变化证据、TTL、库选择、启动/SDK 次序或跨会话复用变化，按 [T01 合同入口](../../../verification/skill-domains.json) 交接 Broker integration：执行 `notion-sdk-pi.mjs` 的 `http-warm-restart`、`http-warm-directory-expired`、`http-smart-revalidate` 和 `http-smart-current`，再沿 `verify-pi-daily-installation.mjs cache-plan/cache-run` 复验普通安装。核新 PID/session、准确的 snapshot/校验时间、完整根与 Requires 的实际 provider 全文，并将目录 HTTP、metadata 续证和正文下载分开；已观察 Required 变化后取消/429 不得回退旧 current，原已接纳 pin 不升级。这里的 SDK 通过只记局部覆盖，不能记作 T01 host 通过。 原生根引用待物化 Source Requires 的交错还必须沿 `source-materialize-native-root` 检查：管理前已选过原生正文、管理后强制 consume，再在五分钟内启动新 Pi，原生根与 Source Requires 都须复用，且该暖读阶段的全部前后台远端请求为 0。

安装层复用 [portable-export-package-consumption](../verify-ntn-skills/features/portable-export-package-consumption.md) 的实际包入口。旧远端恢复或已退出命令的步骤不可继承；包未切换记缺口。Pi 由 Broker integration 沿 AH-1197/AH-637/AH-1198 验；AH-1063 仅为历史基线，不扩 OMP/Tern。

## Evidence

### Hosted MCP 内容搜索与认证

复用 [notion-mcp-auth](../../../verification/models/notion-mcp-auth/README.md) 和现有形式验证 runner，不建立第二份 REST 认证或通用验证入口。MCP 凭据只使用本次隔离 config home；测试用假令牌和真实 loopback HTTP，不读取个人凭据。

~~~sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-mcp-auth.node.test.ts packages/core/test/notion-mcp-credential-store.node.test.ts
node scripts/verify-formal.mjs --suite notion-mcp-auth --out /absolute/new-mcp-model-run
python3 scripts/check-formal-mutations.py --suite notion-mcp-auth --out /absolute/new-mcp-mutation-run
~~~

认证或存储守卫变化时保留两个模型的 31 个正例、负例和可达性见证；准确的独立规则清单、TLC/statechart 字节、模型范围和实际 source hash 均由现有 runner 核对。先审阅实现差异与模型抽象，再更新对应 hash。实际 guard mutation 必须原件通过、删除守卫后行为断言失败、恢复原字节后通过；导入或语法错误不算捕获。

分别核显式环境 token → 存储 token → OAuth 的优先级，错误显式 token 不切身份，headless 不开浏览器，独立 waiter 取消，callback state/iss/PKCE/resource/redirect/expiry，跨进程 logout 对 exchange/commit 的 fence。绝对时间已过但定时器尚未执行时，也须在兑换、提交和原子发布前重新确认至少一个未取消且未过期的 owner；过期 waiter 不可恢复，另一有效 waiter 仍可完成。刷新必须在同 config home 的锁内重读、先 fsync 在途标记、原子提交新 AT/RT 并清标记；不同调用的 deadline、SIGKILL 后接管、未知结果和 403/429 不重放分别留原始记录。只承诺同机协作进程，不把有限模型的原子存储步骤写成断电证明。

内容命中资格、独立 Source 选择和 cursor 绑定沿公开 SDK/CLI 与 [notion-mcp-search](../../../verification/models/notion-mcp-search/README.md) 的 SearchAdmission 模型验：复用 `verify-formal.mjs --suite notion-mcp-search` 和 `check-formal-mutations.py --suite notion-mcp-search`，各用新的外部绝对输出目录。Broker 的 Enabled/前台/会话 ticket 与 Pi 授权 UI 由其既有 integration owner 验。模型中的 Enabled/sessionEpoch 是宿主输入，核心认证 suite 通过不代替这些接线或真实用户授权证据。

### 回执范围

按 [当前合同与回执](../../../docs/verification-contracts.md) 标 C01/C06/C07a/C09、具体时间线及实际层级；相同原件跨票引用不重复计数。

记录当前范围、来源、完整字节比对、freshness、HTTP attempts/bytes 和语义写。相同输入/scope/freshness 才可比较成本；不省文件或延 TTL 制造下降。

区分公开 SQLite 与构造的 Store seam：SQLite alias 退休后仍拒绝改绑另一个 stable identity；Store seam 的 A→B 回放只证明该守卫，不声称公开改绑可达。物理身份、授权拒绝及 generation 时序属于 concrete replay，旧有限模型 PASS 不能代填。

冷读未取得完整固定结果时，下一次同输入是再次 current 观察，不能记作 warm。
Notion metadata 成功、Git acquisition 等待、实际 cat-file 正文、进程树退出分别记录；
未知 wire/auth wait 不填零。显式测试期限不代表普通 Pi 的默认期限。

源码当前测试、实际安装、真实 Notion 阅读投影和 Pi 分开记录。Source/resource 的本地 exact bytes 不证明 Notion 每份子文档已有人类正文。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有派生状态。当前任务仍需的字节暂留；不承诺旧选择跨机或永久恢复。当前唯一内容和其他 owner 不误删。
