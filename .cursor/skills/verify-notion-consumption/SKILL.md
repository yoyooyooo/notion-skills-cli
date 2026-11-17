---
name: verify-notion-consumption
description: "验证 ntn-skills CLI/SDK 的目录资格、当前读取、固定文件、整树依赖、缓存新鲜度、请求成本与消费effects。修改list/read/use、权限、缓存或固定引用时使用；不负责作者写入恢复、实际Pi注入或真实模型任务验收。"
---

# 消费验证

本入口拥有 CLI/SDK 取得哪些字节、凭什么复用、产生哪些effects。作者管理交给 [管理专项](../verify-notion-management/SKILL.md)。不负责将成功read等同于宿主已投递或模型已完成。

## Launch

从仓库根运行，沿 [共用设施](../verify-ntn-skills/references/harness.md#launch) 隔离config/state/cache/data。安装证明明确删除NTN_SKILLS_DEV_ROOT，使用精确包内bin/SDK；冷消费不得拷贝作者缓存。真实库和实际宿主凭据必须已授权。

## Doctor

四柱验收将实际HTTP、源响应字节、持久cache、Agent工具调用及最终provider输入分账。`apply --compact` 的最终输出必须在CommandMetrics追加后再投影；`command-output.ts` 给订阅者的完整账本须由真实已结束进程的stdout SHA256/长度回证。没有独立账本的compact不是零请求，也不是完整审计；只声明已安装CLI/SDK的proof v1能力不足以替代实际运行记录。Warm read重复零HTTP且不刷新有效期/扩大immutable对象目录；过期、权限变化、force refresh、独立Store与凭据隔离回归沿原测试保留。

```sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
```

先判断目标是current、fixed pin还是明确offline。完整目录与Default View/搜索投影分开；disabled的新纳管条目不应悄悄进入普通list，但精确authoring read另有授权。

## Drive

| 子模块 | 必测正反例 | 原规程 |
| --- | --- | --- |
| 资格/目录 | 名称唯一性、完整分页、Enabled/View/401/403；不能用View证明全局唯一 | [consumption](../verify-ntn-skills/features/skill-consumption.md) |
| 当前与固定资源 | 完整文件、旧pin、相对引用、binary/mode；缺块/错owner/变hash拒绝 | [snapshots](../verify-ntn-skills/features/snapshot-read-open-files-resolve.md) |
| 新鲜度/请求 | 冷暖/过期不变/单页变化、原观察时间、取消/晚到、并发去重、只读effects | [requests](../verify-ntn-skills/features/request-engine.md) |
| Requires/Members | 固定依赖闭包、共享依赖只取一次、目录不拉全文、失败不发布半新图 | [graph](../verify-ntn-skills/features/skill-dependency-graph.md) |
| CLI→SDK→Pi | 实际安装、会话、serializer完整正文/去重、投递与完成分别确认 | [broker consumption](../verify-ntn-skills/features/broker-consumption.md) |

最小源切片：

```sh
bun test packages/core/test/shared-freshness-consumer.test.ts packages/core/test/fixed-snapshot-files.test.ts packages/core/test/resource-read.test.ts packages/core/test/consumer-effects.test.ts packages/cli/test/sdk.test.ts --timeout 60000
```

安装层复用 [portable-export-package-consumption](../verify-ntn-skills/features/portable-export-package-consumption.md) 和已有 `scripts/sdk-package-smoke.mjs` 的 `scalar-inventory` / `fixed-names` / `ownership-current` 切片。先读该recipe获得真实archive、fixture、输出根；不能用源码导入冒充安装SDK。实际Pi使用Broker的 `verify-notion-skills-integration`，不在本仓复制服务或模型mock。

## Evidence

### 固定Git传输与缓存

```sh
bun test packages/core/test/shared-fixed-git-transport.test.ts packages/core/test/shared-source-materialization.test.ts --timeout 60000
```

内容身份仍是原repository/commit/tree/path/blob/sha256/mode，机器auto/http/git只选择
获取通道。真实Git隔离测试须证明旧commit不被新HEAD替代、请求文件范围、错tree/hash/
mode拒绝和无checkout/脚本执行。HTTP网络失效可以读取相同Git对象；完整性失败不借
另一个通道掩盖，强制git不可用时明确失败，auto批取的Git传输不可用可回精确HTTP。
暖缓存不访问Provider，损坏缓存拒绝；缺本机字节只按原固定身份补取，不回Notion整包。

storage alignment的独立安装入口归来源Skill。实库冷消费新state/cache/data不得复制
作者Store，分别验证主文有效投影和支持资源原字节；Notion元数据权限检查不能省略。
Git fetch/cat-file数据按真实计量留证，未知wire bytes不记0。纯元数据storage review
不得加载源ZIP/二进制块；切换当前pin不等于清理历史文件，也不改变旧pin语义。

### GitHub API路由与认证

```sh
bun test packages/core/test/github-api-access.test.ts packages/core/test/shared-github-routing.test.ts packages/core/test/shared-github-source.test.ts packages/core/test/shared-source-materialization.test.ts --timeout 60000
```

custom API的commit/tree/blob必须共用完整prefix；受控JSON Broker须验证base64原字节、
大小/OID/哈希以及不跟随返回url。默认官方链验证专用token→GH_TOKEN→GITHUB_TOKEN→
gh活动账号→无登录公共读取，custom不得继承官方凭据。gh通过真实隔离子进程验证精确
host、一次懒调用、完整SDK env、缺程序/未登录和错误输出脱敏；不读取用户实际secret
来制造fixture。重定向/401/配额403/429/错内容的负例必须没有降级换路或新缓存。

同Store/client跨配置和gh身份的在途请求不可合并；暖内容读取不启动gh或Provider。
安装层复用来源域library-source-storage-http.test.ts，其新增API前缀检查、SDK冷读5份
资源、同快照、热读零Provider和官方凭据哨兵无泄漏与原Git路径分别留证。真实公共Broker
健康、实际CLI树读取及SDK字节读取另立证据，不以memory历史ready或受控服务通过代证。

保留exact owner/page/file、scope、snapshot/version、原观察时间与资格、输入文件及完整实际字节。分别记录metadata/current-body/retained-body/provider/write的次数和实际bytes；缺失/截断账本不得声称零请求。cold/warm、正常/失败/取消、共享Requires、重复read和增长上界分别记录，不能把延迟平均值当正确性。

管理到消费交接必须逐层检查：原操作完成 → 当前目录资格 → 固定图准备 → 全文交付 → provider接受 → turn完成 → 持久化。已有pin不代表当前仍授权，provider收包不代表任务完成，摘要/标题不证明全文送入上下文。

## Cleanup

沿 [harness cleanup](../verify-ntn-skills/references/harness.md#cleanup)；保留原结果和会话/请求账本后才回收自有scratch。缓存整理不得移除原操作journal、共享唯一副本或未知用户pins。真实会话另按Broker的cleanup核对结束回执。

## 维护与分层

状态改变由Broker `verify-notion-consumer-state`和现有request-engine formal按实际owner处理；纯说明或链接不扩大模型域。源测试/安装/实际Notion/Pi/自然模型/物理第二机分别标passed、failed、blocked或not_run。新入口本身的冷Agent评估也单列。


### 原模板字节与阅读页表示

Notion阅读页可折叠仅class的div/span排版，但固定来源的模板文件仍须保留原HTML、
frontmatter和完整原字节。复用来源域shared-source-projection-retained.test.ts的独立
冷读反例及原安装HTTP旅程的SDK readResources全文比对；不能仅凭阅读页语义相同、
文件名或目录条目证明原模板仍可用，也不能把阅读投影重新存成固定源版本。
