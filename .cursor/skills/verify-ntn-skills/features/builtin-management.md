# Bundled Skill discovery and reading

主要验证入口：[verify-ntn-skills](../../verify-ntn-skills/SKILL.md)。本页验证一级 `skills` 命令与实际随包主文、支持文件和目录。产品指引随 CLI 版本交付，没有独立安装状态、分发登记或 Notion 投影。

## 当前行为

- `skills` 默认列出目录，`skills list --json` 返回名称、描述和包内身份。目录不包含安装状态。
- `skills get NAME` 默认输出原始 Markdown。`--path` 读取一个精确相对文件，`--full` 包含所有支持文件；两者互斥。多个名称或 `--all` 可读取多份指引。
- `skills path NAME` 返回该 Skill 的实际目录；省略名称返回随包目录。独立 CLI 与 Broker 内嵌 CLI 都必须指向自己的文件。
- 每个动作支持 `--json`。错误保留实际错误码和非零退出；未知名称和越界路径不回退到 Notion。
- 命令无需 Notion 凭据、Library、本地配置或缓存，不创建应用目录、Skill 副本或链接。CLI 升级时指引一起更新。

## 用户入口

从选定的实际安装包执行：

```bash
ntn-skills skills
ntn-skills skills list --json
ntn-skills skills get ntn-skills
ntn-skills skills get ntn-skills-maintain --full
ntn-skills skills get ntn-skills-sync --path references/synchronization.md
ntn-skills skills path ntn-skills-maintain
```

三个公开名称是 `ntn-skills`、`ntn-skills-maintain`、`ntn-skills-sync`。
产品指导默认来自同一执行包。普通业务 Skill 仍在 Notion 发现；明确选择的 Notion／团队工作流保持精确 source/ref 和 Requires，不因失败或同名内容切换来源。

## 安装包验证

复用父 [Skill](../SKILL.md) 的隔离环境和现有 package checker：

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- skills list --json
NTN_SMOKE_EVIDENCE_ROOT="$RUN/scratch/installed-package" bun run package:check > "$RUN/evidence/package.json"
```

检查实际 npm 安装后的 Node.js CLI，逐个比较主文与支持文件的全部字节、目录路径、名称和描述。核对默认 Markdown、`--json`、`--full` 与单个 reference；`path` 指向的文件须与同包 `get` 返回的内容一致。离开源码 checkout 执行，清除开发 override，使用无凭据和不可用应用目录的环境验证离线读取。

检查空名称、未知名称、越界路径和冲突参数。旧命令必须失败，不保留别名；读取不能产生安装登记、状态、缓存或分发链接。源码回归由 `packages/cli/test/cli.test.ts` 和 `builtin-guidance.test.ts` 覆盖，实际安装由 `scripts/package-smoke.ts` 覆盖。

这些结果证明随包读取，不证明公开 registry 发布、真实 Notion 管理或 Agent 已按指引完成业务任务。保留真实命令、包身份和完整输出，按本次范围报告。

## Broker 交接

Broker 的 `.agents/skills/verify-notion-skills-integration/features/builtin-management.md` 拥有普通 Pi 选择与其实际包检查。通过它的现有 `scripts/verify-artifacts.mjs` 验证内嵌 CLI 的同一组命令、全部正文和支持文件，以及实际 `path` 位置。

启用 Notion source 时，Pi 可以选择 `$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 和 `$ntn-skills-sync@builtin`。没有启用 source 时，不注入 Notion 目录、工具或系统指引；显式 setup 仍可读取 shell CLI 的随包指南。OMP/Tern 宿主验收仍延期。

实际模型投递和自然任务沿现有工作流验证入口单独判断。不要用安装包成功替代 Pi 成功，也不为验证建立中央 Skill 安装或 Notion 副本。

## 清理

只保留本次必要结果。临时验证目录按 [系统 Trash 清理](../references/harness.md#cleanup) 处理，不修改用户会话、配置或其他任务目录。历史本地 Skill 副本和用户业务内容不是本命令的管理对象。
