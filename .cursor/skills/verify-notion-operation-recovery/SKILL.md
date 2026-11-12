---
name: verify-notion-operation-recovery
description: 验证 Notion skills 原操作恢复的状态协议。修改 ACK Record 连续前缀、exact ACK GET 与 query 可见性、仅未派发 suffix、file accept-add 独立接受、restore-follow 业务反馈 reconcile、原操作身份或 pending/unknown barrier 时使用。读取覆盖模型、正负例、源码对应和公共回归；复用锁定的 statechart/TLC 与仓库运行器。
---

# 原操作恢复验证

先读 [模型边界与源码对应](../../../verification/models/operation-recovery/README.md) 和 [coverage.json](../../../verification/models/operation-recovery/coverage.json)。以文件内容和当前源码为准，不从历史结论推断通过。

## 选择范围

| 变化 | 模型 | 公共回归 |
| --- | --- | --- |
| 原 ACK、frozen request、exact Record GET、原生恢复前缀或 suffix | AcknowledgedRecordPrefix | shared-create-native-recovery、shared-create-known-recovery |
| 独立 accept-add、原失败、adopted event、完整冷读证明 | IndependentAcceptance | shared-file-management |
| 原 restore ID、submitted body/frontier/Source、processing 绑定、反馈丢失与 reconcile | RestoreFeedback | shared-file-request |
| 共享 dispatcher、Record 或 source mutation | 三个模型 | 四个回归文件 |

恢复前的 create/import 和既有 continuation 仍读 [verify-notion-resource-lifecycle](../verify-notion-resource-lifecycle/SKILL.md)。HTTP RequestEngine 的 retry/预算/取消归独立 request-engine 验证；Broker consumer/session 归 Broker guardian。不要把原业务 Request 当成 HTTP 请求重试模型。

## 核对源码对应

1. 读取 coverage.json 的 files、models、cases，根据变化读 README 对应实际函数。
2. 检查 source hash。漂移意味着原证明需要维护审查，不能自动刷新 hash。
3. 对照改变的派发前提、未知结果、原身份、证据持久化、exact readback 和最终结果。模型步骤要对应实际边界；网络发送、provider apply、ACK Store 写入不能合并为一个原子动作。
4. 维护差异时使用 /maintain-formal-verification-skill；新增性质或模型时读 /statechart。保留故意坏配置的违例；不复制上游 skill 内部命令实现。
5. 完成源码对应审查、必要回归和正负例后，才更新本 suite 相关 files hashes 与 synchronized_commit，不刷新别的 guardian。

三个关键边界：

- exact ACK GET 不依赖 query 索引可见性；native suffix 仍要求完整 census 与已核实前缀相符。
- unknown 不可变 Record 的精确观察可以支持下一个不同 Record；同一 POST 不重派发，不补造原 ACK。
- metadata ACK 历史结果与当前正文/Source 授权分开。正文变了停止新动作，但不能抹除已知历史结果。

## 在 Pro 冷启动并运行

从目标仓库根执行。先实读工具路径和 `verification/models/resource-lifecycle/tool-lock.json`，由运行器核验完整锁。下列是已安装的 Pro 路径；别的机器使用该机器已验证的同版本安装，不放松 lock。

~~~sh
export PSTACK_STATECHART_ROOT=/Users/yoyo/Documents/code/personal/verification-evidence/ah681-20261108/ah922-ah740-recovery-20261111/pinned-pstack-repository/pstack/skills/statechart
export TLA2TOOLS=/Users/yoyo/Documents/code/personal/verification-evidence/notion-skills/formal-planning-20261108-4fx3wnpv/tla2tools-1.7.4.jar
OPERATION_RECOVERY_OUT="$(mktemp -d /Users/yoyo/Documents/code/personal/verification-evidence/notion-operation-recovery-XXXXXX)"
/Users/yoyo/.volta/tools/image/node/24.20.0/bin/node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --out "$OPERATION_RECOVERY_OUT"
~~~

单模型变化可加 --model AcknowledgedRecordPrefix、IndependentAcceptance 或 RestoreFeedback。共享边界和批次验收运行完整 suite；当前 cases 共 28 项，不能拿子集代替完整运行。

读取输出 summary.json 和每组 report.md，核对 complete、源码/工具/input hashes、完整性质清单和预期反例集合。正例没有 broken；反例只允许 expected_broken 的准确集合。tool error、少跑性质、额外违例、未完成搜索、cut、unexamined 都停止通过结论。失败输出也保留。

再执行四个实际公共函数回归；使用 fixture，不连接生产 Notion。

~~~sh
bun test packages/core/test/shared-create-native-recovery.test.ts packages/core/test/shared-create-known-recovery.test.ts packages/core/test/shared-file-management.test.ts packages/core/test/shared-file-request.test.ts --timeout 60000
~~~

输出中文图时使用本次 runner 的 chart.mmd 和 report.md，遵循 /statechart 的视图与渲染规则。Pele 的可定位安装和公开渲染命令见 [图形产物复现](../../../docs/formal-verification-maintenance.md#图形产物定位与复现)。正反例都保留，不为展示缩小性质/cfg 或隐藏最短反例动作。

## 验证真实 guard 和恢复

`python3 scripts/check-operation-recovery-mutations.py` 会暂时改真实源码，只在单独 linked candidate worktree 运行。当前产品树作为 --protected-worktree；两者不能相同。以当前审查过的源码与测试建立候选，不使用脏的旧主仓。

1. 在隔离树安装自己的 frozen-lockfile 依赖，不链接外部 node_modules，不启动生产应用。
2. 让候选包含产品树 coverage.json.files 的准确版本与当前 mutation 脚本；脚本逐项核查 source/test hashes 相同。
3. 在候选执行脚本，传真实产品绝对路径和新的树外输出目录。可绑定为环境变量：`python3 scripts/check-operation-recovery-mutations.py --protected-worktree "$OPERATION_PRODUCT_ROOT" --out "$OPERATION_MUTATION_OUT"`。
4. 四组 baseline → mutant → restored 中，baseline/restored 执行准确测试数且通过，mutant 为真实断言失败；语法或依赖错误不计。
5. 核对 complete_source_and_modes_restored、protected_source_unchanged 与前后完整快照。并发变化时保留文件并报告，不覆盖他人更改。原件保留，不永久清理。

真实 guard 变化后若旧 mutation 不再精确定位，先审查新边界再更新对照。hash 检查失败不能冒充真实安全回归被抓住。


当前 mutation 入口固定执行四组，不接受单 guard 选择；模型切片可以用 `--model`，不要将真实回放四组误报为只执行一组。下面的准备配方保留当前尚未提交的 Git 可见文件，依赖仍在候选内独立安装。先暂停候选的其他写入者，所有目录必须是本次新建的：

~~~sh
export OPERATION_PRODUCT_ROOT="$PWD"
export OPERATION_CANDIDATE_PARENT="$(mktemp -d /tmp/notion-operation-candidate.XXXXXX)"
export OPERATION_CANDIDATE_ROOT="$OPERATION_CANDIDATE_PARENT/candidate"
git worktree add --detach "$OPERATION_CANDIDATE_ROOT" HEAD
python3 - <<'COPY_REVIEWED'
from pathlib import Path
import os, shutil, subprocess
source = Path(os.environ["OPERATION_PRODUCT_ROOT"])
candidate = Path(os.environ["OPERATION_CANDIDATE_ROOT"])
names = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=source).decode().split("\0")
for name in sorted(set(filter(None, names))):
    src, dst = source / name, candidate / name
    if src.is_file() and not src.is_symlink():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    elif src.is_symlink():
        if not dst.is_symlink() or os.readlink(src) != os.readlink(dst):
            raise RuntimeError("Review symlink separately: " + name)
COPY_REVIEWED
(cd "$OPERATION_CANDIDATE_ROOT" && bun install --frozen-lockfile)
export OPERATION_MUTATION_OUT="$OPERATION_CANDIDATE_PARENT/mutations"
python3 "$OPERATION_CANDIDATE_ROOT/scripts/check-operation-recovery-mutations.py" --protected-worktree "$OPERATION_PRODUCT_ROOT" --out "$OPERATION_MUTATION_OUT"
~~~

此配方不会删除候选或产品文件。遇到工作树删除项、符号链接变化或不匹配的 coverage 时，先审阅具体差异；不能通过删除原件或更新 hash 绕过。最终 `protected_source_unchanged` 核对 coverage 全部源码/测试的内容和模式，候选另核完整 Git 可见文件前后快照。

## 交付和冷跑

提交模型/配置/源码对应、必要回归、中文图和证据 manifest。区分有限模型、公共函数回归、真实 guard 对照、冷 Agent、安装 CLI、真实 Notion 证据；这里没有自动获得后两类证明。

独立冷 Agent 只给此 skill 路径、目标 checkout、任务范围和新输出根，由它读原件并运行。回执包括实际命令、配置数量、完整性质判据、源码/工具/input hashes、失败原件和恢复结果。未实际跑过时保持“未验证”，不能以读过文档替代。

回链：[恢复地图](../verify-ntn-skills/features/import-create-recovery-dry-run.md) · [共享 SSOT](../verify-ntn-skills/features/shared-ssot.md)。更新覆盖边界时保留原六模型历史范围。通过不表示任意长度前缀、跨机器 exactly-once、provider CAS 或无条件进度。
