# Current export and installed package consumption

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。只验证当前合同；旧 operator、迁移 cache、authoring/history 和 Pi maintenance 包门禁已移除。

## Launch

使用当前 checkout、受支持的 Node.js 与 npm。复用现有仓库构建和 package check；不复制作者 Store，也不预填消费者的 snapshot、object 或 receipt。

```sh
bun run package:check
```

该入口在新的外部目录构建 CLI、SDK 与实际声明闭包，再打 tarball 并通过 npm 独立安装。它检查包内文档链接、依赖、公开命令 schema、三个 builtin 的完整内容与本地 install/update。旧 writer 路由及 `readOnly` 参数应明确拒绝。

## Drive

同一次 package check 运行现有 `sdk-fixture.ts` 与 `sdk-package-smoke.mjs`。fixture version 2 只提供当前 Notion 服务事实，不保留历史 cache。最终报告应为 `contract=current-only`、`selection=all`，11 个固定用例全部通过：

- 安装 SDK v2 的导出、声明与退役输入拒绝。
- 完整 catalog 分页和 SDK limit/cursor。
- 主正文、完整 Files 分页、当前缓存命中。
- use 完整 manifest、选中资源 UTF-8/CRLF/二进制/空文件字节和子文档正文。
- 字节预算与 attention 明确拒绝。
- 已选 File 当前描述符变化后要求重新选择，不查历史。
- 安装 CLI 的 files/read 与完整目录导出，含可执行 mode。
- consume 与 readResources 各自的响应头前和正文中取消；等待实际 transport 关闭并成功重试。

读流程只允许 GET 和语义查询；所有会报告 effects 的消费结果必须为远端零语义写。完整文件目录不代表所有资源已下载。检查实际请求 ledger 和导出 bytes，不以 fixture 配置代替结果。

## Real Notion and Pi boundary

受控安装态通过，不证明真实 Notion 已完成字段迁移、全部正文投影、全库残留清理或 Pi 日用。必要的真实 export 使用授权的目标与当前安装包；读取实际产物并核对每条声明路径的完整 bytes/mode。Writer/reimport 尚未实现的部分明确 blocked/not_run，不调用退役的 create/replace 路由。

Broker 使用同一最终 CLI SDK v2 产物做交接，真实 Pi 日常旅程仍由 AH-1063 负责。OMP/Tern 宿主适配延期。达到本次变更的必要证明后停止扩大矩阵。

## Cleanup

报告实际 archive、installed bin、SDK path、命令和成功/失败边界。保留一份结果即可；清理范围限本次自有临时目录，并沿用系统 Trash。无需新建版本档案、证明链或 runner。
