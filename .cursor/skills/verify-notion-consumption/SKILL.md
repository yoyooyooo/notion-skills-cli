---
name: verify-notion-consumption
description: "验证 ntn-skills 当前完整目录、有界元数据、正文与子文件、任务内选择、缓存、导出及普通消费远端零写。修改 list/read/use/files/export、权限、精确获取或 freshness 时使用，不保留历史内容恢复合同。"
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
3. stable claim query 只选择身份；正文前的精确 owner GET 决定当前权限与 metadata，不能复用 query 行替代。Name/Description 变化返回当前 metadata，但不改 bytes 或内容身份。原任务选择仍保留其 metadata。改路径或删当前行不被旧 cache 复活。正文/provider 后的 owner/Files/Source fence 须重新观察，不复用本轮局部 claim。
4. 同任务内保持一份完整选定目录。缺 Source/resource bytes 只可使用仍相符的当前 owner/descriptor；缺 native 旧选择字节或当前声明变化要求重选，不恢复远端历史。
5. 每文件 acquisition v5 支持多 Source、native 和 resource。Source/resource 核 exact hash/bytes/mode；native 核实际当前正文加显式 frontmatter/mode，不承诺写入前 Markdown 字节。检查按需获取、offline 不发请求及权限拒绝；generated body 编辑不自动接管。 已观察到的 target `ACCESS_DENIED` 或 scope `AUTH_REQUIRED` 对 offline 正文同样生效；历史目录不授予正文权限。保留未知网络失败下的离线正例，以及业务 Enabled 关闭后的完整旧字节正例。T05 必须从公开 SDK 实际观察 401/403 后检查 scalar、batch、use/inspect 与 clear 后行为，不以直接构造失败对象代替这条边界。
   精确 child403 只归因已观察的 physical path；库级 claim 拒绝、未知或不匹配 path 不得误伤 root/其他 scope。physical 拒绝先于 alias 读取及 stable 写入持久化；分别注入后两步故障。用实际 SQLite 验 alias 退休、clear、迟到 grant，以及同 stable 两个正文版本的 fresh 恢复；逐个 pin 核原 hash。physical 授权槽不成为第二份正文 cache status。
6. 相对文件留在选定 owner；跨 Skill 路径要求显式当前引用。整包 export 与单文件 read --output 分别核 bytes/path/mode；任意多路径 export 尚未公开，不发明选项。
7. 真实公开 list/read/use/files/export 的语义写计数均为 0。Notion query POST 是读；Record 创建、投影、adoption 和清理都是写。
8. SDK 的完整 `options.env` 同时约束配置和实际 Git 子进程；并发 operation 不共享可变环境。公共 consume 的接线必须有受控 Source/实际 shim 证据，单独测试 runtime 不能代替。
9. 取消不只检查 SDK 返回。POSIX Git 主进程及其自有进程组须收束，包括主进程先退、孙进程忽略 SIGTERM 的情况；保留原取消原因、2 秒强杀边界和 stderr 保密。不改认证或延长预算制造通过。

相关当前获取和请求检查：

~~~sh
bun test packages/core/test/shared-acquisition-contract.test.ts packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-read-coalescing.test.ts --timeout 60000
~~~

元数据、授权、SDK 环境或 Git 生命周期变化执行对应的现有边界回归：

~~~sh
bun test packages/cli/test/sdk.test.ts packages/core/test/source-git-runtime.test.ts --timeout 30000
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-bounded-metadata.node.test.ts packages/core/test/sdk-immutable-read.node.test.ts packages/core/test/sqlite-state.node.test.ts
~~~

安装层复用 [portable-export-package-consumption](../verify-ntn-skills/features/portable-export-package-consumption.md) 的实际包入口。旧远端恢复或已退出命令的步骤不可继承；包未切换记缺口。Pi 由 Broker integration 沿 AH-1197/AH-637/AH-1198 验；AH-1063 仅为历史基线，不扩 OMP/Tern。

## Evidence

按 [当前合同与回执](../../../docs/verification-contracts.md) 标 C01/C06/C07a/C09、具体时间线及实际层级；相同原件跨票引用不重复计数。

记录当前范围、来源、完整字节比对、freshness、HTTP attempts/bytes 和语义写。相同输入/scope/freshness 才可比较成本；不省文件或延 TTL 制造下降。

区分公开 SQLite 与构造的 Store seam：SQLite alias 退休后仍拒绝改绑另一个 stable identity；Store seam 的 A→B 回放只证明该守卫，不声称公开改绑可达。物理身份、授权拒绝及 generation 时序属于 concrete replay，旧有限模型 PASS 不能代填。

冷读未取得完整固定结果时，下一次同输入是再次 current 观察，不能记作 warm。
Notion metadata 成功、Git acquisition 等待、实际 cat-file 正文、进程树退出分别记录；
未知 wire/auth wait 不填零。显式测试期限不代表普通 Pi 的默认期限。

源码当前测试、实际安装、真实 Notion 阅读投影和 Pi 分开记录。Source/resource 的本地 exact bytes 不证明 Notion 每份子文档已有人类正文。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有派生状态。当前任务仍需的字节暂留；不承诺旧选择跨机或永久恢复。当前唯一内容和其他 owner 不误删。
