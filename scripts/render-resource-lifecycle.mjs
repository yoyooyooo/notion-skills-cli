#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const arg = (name) => {
  const at = args.indexOf(name)
  if (at < 0 || !args[at + 1]) throw new Error(`Missing ${name}`)
  return path.resolve(args[at + 1])
}
const run = arg("--run"),
  pele = arg("--pele"),
  out = arg("--out")
const mutations = JSON.parse(fs.readFileSync(arg("--mutations"), "utf8"))
const expectedMutations = new Set([
  "editable-overwrite",
  "custom-takeover",
  "audit-readonly",
  "readonly-capability",
])
assert.equal(mutations.length, expectedMutations.size)
assert.deepEqual(new Set(mutations.map((entry) => entry.case)), expectedMutations)
assert.ok(
  mutations.every(
    (row) => row.before_exit === 0 && row.broken_exit !== 0 && row.restored_exit === 0,
  ),
)
const result = JSON.parse(fs.readFileSync(path.join(run, "summary.json"), "utf8"))
assert.equal(result.complete, true, "Refuse to publish an incomplete check as a finished report")
assert.ok(result.runs.every((row) => row.matches && row.states.complete && !row.states.cut))
assert.equal(JSON.parse(fs.readFileSync(path.join(pele, "package.json"), "utf8")).version, "1.9.0")
if (fs.existsSync(out)) assert.equal(fs.readdirSync(out).length, 0, "Use a new report directory")
else fs.mkdirSync(out, { recursive: true })
const { render } = await import(pathToFileURL(path.join(pele, "dist/pele.js")))
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
const style = `.pele{--pele-bg:#fff;--pele-fg:#182638;--pele-muted:#5b6573;--pele-surface:#f4f7fb;--pele-border:#aebbc9;--pele-line:#6b7c8e;--pele-font:system-ui,sans-serif}.pele .breaks rect{fill:#ffecee!important;stroke:#d32b3b!important;stroke-width:2.5px!important}.pele .breaks text{fill:#a32230!important}.pele .mayBreak rect{fill:#fff3e6!important;stroke:#cc7519!important}.pele .bugPath rect{stroke:#276db7!important;stroke-width:2.5px!important}.pele .repeats rect{stroke:#8e4cb6!important;stroke-dasharray:6 3}`
const charts = []
for (const row of result.runs) {
  const source = path.join(run, path.dirname(row.report)),
    name = path.basename(source),
    target = path.join(out, name)
  fs.mkdirSync(target)
  for (const file of fs.readdirSync(source))
    if (/\.(md|mmd|out)$/.test(file))
      fs.copyFileSync(path.join(source, file), path.join(target, file))
  const mmd = fs.readFileSync(path.join(source, "chart.mmd"), "utf8")
  const image = render(mmd, { limit: 1000000, outputLimit: 8000000, maxEdges: 10000 })
  const svg = image.svg.replace(/^(<svg\b[^>]*>)/, `$1<style>${style}</style>`)
  fs.writeFileSync(path.join(target, "chart.svg"), svg)
  charts.push({
    name,
    row,
    mmd,
    svg,
    width: image.width,
    height: image.height,
    report: fs.readFileSync(path.join(source, "report.md"), "utf8"),
  })
}
fs.copyFileSync(path.join(run, "summary.json"), path.join(out, "summary.json"))
fs.writeFileSync(
  path.join(out, "real-code-mutations.json"),
  JSON.stringify(mutations, null, 2) + "\n",
)
fs.cpSync(path.join(run, "model-inputs"), path.join(out, "models"), { recursive: true })
const selections = [
  [
    "ProjectionRace-broken-cfg",
    "01 · 人工编辑与自动投影",
    "最短反例：检查原文 → 允许写入 → 人工编辑 → 后台覆盖。当前 helper 拒绝这一覆盖路径；这张图展示应被否决的实现方案，不是已复现的生产事故。",
  ],
  [
    "UpdateCommit-cfg",
    "02 · 固定候选与未知结果恢复",
    "资源身份完整后才允许选择。响应丢失后核对同一原始操作；当前值可见不能代替原操作回执。旧会话继续使用原 pin。图中省略同标签内部步骤，完整轨迹在对应报告。",
  ],
  [
    "AuditRun-cfg",
    "03 · 只读审计与预算续跑",
    "先盘点范围，再顺序检查根对象，预算耗尽时保存进度，最后反向扫描失去主记录的资源。完整覆盖不等于没有问题，报告必须同时包含覆盖情况和发现。",
  ],
]
function section([name, title, text]) {
  const c = charts.find((x) => x.name === name)
  assert.ok(c)
  return `<section id="${name}" class="diagram"><div class="section-head"><h2>${esc(title)}</h2><span>${c.row.states.distinct} 个模型状态</span></div><p>${esc(text)}</p><div class="svg-wrap">${c.svg}</div><details><summary>生成的 Mermaid 源码</summary><pre>${esc(c.mmd)}</pre></details><details><summary>TLC 结果与最短反例原文</summary><pre>${esc(c.report)}</pre></details><p class="links"><a href="${name}/chart.svg">独立 SVG</a><a href="${name}/chart.mmd">Mermaid</a><a href="${name}/report.md">原报告</a></p></section>`
}
const table = charts
  .map(
    ({ name, row }) =>
      `<tr><td>${esc(row.model)}</td><td><a href="${name}/report.md">${esc(row.config)}</a></td><td>${row.states.distinct}</td><td>${row.expected_broken.length ? "负例按预期失败" : "正例通过"}</td><td>${
        row.rules
          .filter((x) => x.outcome === "broken")
          .map((x) => `<code>${esc(x.name)}</code>`)
          .join("<br>") || "全部被检查性质成立"
      }</td><td><a href="${name}/chart.svg">SVG</a></td></tr>`,
  )
  .join("")
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notion Skills 资源生命周期前置验证</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#19283a;font:16px/1.75 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:1120px;margin:auto;padding:42px 28px 80px}header{padding:30px 34px;background:#172b43;color:white;border-radius:16px}header h1{font-size:31px;line-height:1.4;margin:10px 0 16px}header p{color:#d7e2ef;margin:0}small,.eyebrow{font-size:13px;letter-spacing:.08em}nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}a{color:#2164a5;text-underline-offset:4px}section{background:white;border:1px solid #dde4ec;border-radius:14px;padding:26px 30px;margin:24px 0}h2{font-size:22px;line-height:1.5;margin:0 0 12px}h3{font-size:18px;margin:25px 0 8px}p{margin:12px 0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0}.stat{padding:18px;background:#fff;border:1px solid #dde4ec;border-radius:12px}.stat strong{display:block;font-size:26px}.stat span{font-size:13px;color:#526274}.section-head{display:flex;justify-content:space-between;gap:16px;align-items:baseline}.section-head span{font-size:13px;color:#647588;white-space:nowrap}.svg-wrap{overflow:auto;padding:20px 8px;text-align:center;background:#fff;border:1px solid #e6ebf1;border-radius:10px}.svg-wrap svg{max-width:100%;height:auto;min-width:480px}details{border-top:1px solid #e5ebf1;margin-top:18px;padding-top:12px}summary{cursor:pointer;color:#315577;font-weight:600}pre{overflow:auto;background:#f4f7fb;padding:18px;font:13px/1.65 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;border-radius:8px}code{font:13px/1.6 ui-monospace,monospace}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #e3eaf2;vertical-align:top}th{background:#f3f6fa;color:#3a526b}.table-scroll{overflow:auto}.callout{border-left:4px solid #c28a2c;background:#fff8e9;padding:14px 18px;margin:18px 0}.links{display:flex;gap:24px;font-size:14px}.muted{color:#5b6c7f;font-size:14px}.foot{font-size:12px;color:#627186;word-break:break-all}@media(max-width:700px){main{padding:20px 14px}header,section{padding:22px 18px}.stats{grid-template-columns:1fr 1fr}header h1{font-size:25px}.section-head{display:block}table{min-width:760px}}
</style></head><body><main><header><div class="eyebrow">规划期验证 · TLA+ / TLC / PSTACK STATECHART</div><h1>Notion Skills<br>资源、更新、审计的前置验证</h1><p>先明确哪些状态允许写入、哪些结果可以报告完成，再实施自动更新和资源审计。</p></header>
<div class="stats"><div class="stat"><strong>3</strong><span>独立状态模型</span></div><div class="stat"><strong>${result.runs.length}</strong><span>实际运行配置</span></div><div class="stat"><strong>${result.runs.filter((x) => !x.expected_broken.length).length} / ${result.runs.filter((x) => x.expected_broken.length).length}</strong><span>正例通过 / 负例被检出</span></div><div class="stat"><strong>${mutations.length}</strong><span>真实代码保护移除后被测试捕获</span></div></div>
<nav>${selections.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join("")}<a href="#plan">规划入口</a><a href="#results">完整结果</a></nav>
<section><h2>这轮真正改变了什么</h2><p>四表分工和现有 CLI/SDK 消费模型继续使用。规划增加一层明确的状态契约：来源候选、已选版本、页面展示、文件归属、原操作结果、会话 pin 与审计覆盖分别表达，不再由一个“已同步”状态代替。</p><div class="callout"><strong>自动更新仍有一个必须先通过的门禁：</strong>同一页面既可自由人工编辑，又允许无人值守覆写时，读前检查、单写者任务和写后读回都不能证明没有丢失人工编辑。缺少可验证的条件写入或编辑隔离时，应自动检查和准备，停止自动覆写。</div><p>审计从一开始就是只读能力。它不能通过循环普通 read 来顺便接管正文，不能把没有权限当成已删除，也不能因为当前根列表没有引用就删除历史对象。</p></section>
${selections.map(section).join("")}
<section id="plan"><h2>规划与实施入口</h2><p>长期设计与开放决策维护在 Notion，实施和真实验收跟随 AH-681 的原生依赖。此报告只记录当前有限模型与代码守卫回归，不复制另一份实施路线图。</p><p><a href="https://app.notion.com/p/4125636c236e819bba12c71af9a0c0f5">Notion 验证策略</a> · <a href="https://linear.app/yoyooyooo/issue/AH-681">AH-681 实施批次</a> · <a href="models/README.md">模型运行与范围说明</a></p></section>
<section id="results"><h2>完整检查结果</h2><p>下表的“负例”是故意破坏保护的配置。成功标准是检出指定错误，不能把负例都变绿。每个正例都完成其有限状态空间检查，没有未检查规则。</p><div class="table-scroll"><table><thead><tr><th>模型</th><th>配置</th><th>状态数</th><th>结果</th><th>检出的性质</th><th>图</th></tr></thead><tbody>${table}</tbody></table></div></section>
<section><h2>验证范围和保留的不确定性</h2><p>ProjectionRace 检查一次人工编辑与一次覆盖企图。UpdateCommit 检查两个资源、两个版本、一次原始派发和一个旧会话。AuditRun 检查两个 Skill、一个孤立资源、一次正文变化、每片一个 Skill 的预算和最多两次续跑。公平性仅在相应审计配置下验证，不能推出 Dagu 停机或无限重试时一定完成。</p><p>真实代码已做 ${mutations.length} 组“原版通过 → 移除保护失败 → 恢复原字节通过”。它们使用项目已有受控 API fixture，不是实时修改 Notion。新审计和来源级协调器尚未实现；模型通过不构成功能交付。</p><p>未证明：真实 Notion 的原子条件写入、多页事务、多机器写者切换、无限历史垃圾回收、全部分页交错、网络时延及完整模型任务质量。它们仍需要对应的集成／实际消费验证。</p><p>建模时发现过两个验证自身的问题：组合负例中的“重置检查点”遮蔽了“漏做反向扫描”的路径，已拆开独立测试；状态图曾合并尚可续跑和续跑额度耗尽的状态，Pstack 拒绝了这个误导性图，随后保留了两个不同标签。原失败记录未被覆盖。</p><p class="muted">图由 Pstack 的检查结果生成。终态自环、等待自环和同标签内部步骤不全部绘出；每个原报告说明省略步骤数，并保留原始 TLC 轨迹。</p></section>
<p class="foot">Reviewed product base ${esc(result.source_commit)}; exact reviewed bytes in models/coverage.json<br>Pstack ${esc(result.pstack_commit)} · TLC ${esc(result.tlc)} · Pele 1.9.0<br>运行产物与私有日志不进入日常系统提示词或开源仓库。</p></main></body></html>`
fs.writeFileSync(path.join(out, "index.html"), html)
console.log(
  JSON.stringify({
    report: out,
    charts: charts.length,
    html_bytes: Buffer.byteLength(html),
    all_check_results_match: true,
  }),
)
