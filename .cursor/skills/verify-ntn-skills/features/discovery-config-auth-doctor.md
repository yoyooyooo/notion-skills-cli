# 当前发现、配置与访问检查

主要入口：[verify-ntn-skills](../SKILL.md)。本页只检查当前四表库的发现、精确选择、本地配置、Views 与访问诊断；正文和缓存资格沿 [当前消费](skill-consumption.md)。

## 公开入口

沿 [harness Launch](../references/harness.md#launch) 隔离配置、状态与 cache，从当前命令 schema 核对参数：

~~~sh
ntn-skills --help
ntn-skills schema list
ntn-skills schema ctl views
ntn-skills ctl config show
ntn-skills ctl doctor --database "$ENTRY"
ntn-skills list --database "$ENTRY" --json --metrics
ntn-skills ctl cache status
~~~

使用明确的当前 library entry；缺 Sources、Members/Requires、Origin 或 Content 时不能以旧布局继续。身份、凭据与 endpoint 属于本次 scope，已知访问拒绝不得由缓存覆盖。需要配置 token 时只沿现有 stdin 入口，不把凭据放进命令参数或报告。

`ctl doctor` 是实际在线访问检查：不带 database 时核身份，带 database 时检查所选目录并尝试读取一个当前 Skill。空库或 `skill_read.checked=false` 不等于正文已读过。验证 controller 的 doctor 只检查本机运行条件；未指定 live 不冒充在线结果。

## 必要守卫

按实际改动选择现有测试，不组合完整矩阵：

~~~sh
bun test packages/core/test/catalog.test.ts packages/core/test/views.test.ts packages/core/test/cache.test.ts --timeout 60000
~~~

- 发现只返回当前 `shared_skill` 定位。名称不唯一时要求精确当前引用；不同库或 Source 的同名记录不能合并。
- 查询完整分页后才能声明唯一性或完整目录。limit、筛选结果与局部成功均保留实际 coverage；某个来源拒绝不隐藏其它有效记录，也不把 partial 缓存成 complete。
- Enabled 与 Default Context 由当前 schema 明确解码。禁用记录不进入公开目录；错误属性类型不能当默认值。
- Views 使用真实 View ID/URL 和远端次序。默认首 View、明确 View、全部 View 列表保持独立；空 View 不回退全库，错库、截断成员或权限错误明确失败。
- 缓存按当前 scope 与有效期使用，命中不延长原验证时间。清理只处理可回收本地状态，不修改 Notion 内容、配置或用户文件。

`STATE_CUTOVER_REQUIRED` 要求显式选择新的 `NTN_SKILLS_HOME`；旧配置仍有退役绑定时也选择新的 `NTN_SKILLS_CONFIG_HOME`。保留旧数据库与 objects 给有限只读提取器，不通过打开或重写它来完成普通发现。

## 结果边界

记录实际 entry、查询范围、coverage、freshness 和请求数量。目录通过不代表全部正文、实库清理或 Pi 已通过。独立安装沿 [package check](portable-export-package-consumption.md)，自有临时目录沿 [harness Cleanup](../references/harness.md#cleanup) 进入系统 Trash。
