// Metadata-only audit. Nested Helper/operation durations are never added to
// sequential pipeline phases, and savings are bounds rather than measured gains.
import fs from "node:fs";
import path from "node:path";
const [input = "data/logs/pipeline-timing.jsonl", output = "artifacts/timing-breakdown.json", since = ""] = process.argv.slice(2);
const rows = fs.existsSync(input) ? fs.readFileSync(input, "utf8").split("\n").flatMap(line => {
  try { const row = JSON.parse(line); return (!since || (row.started_at || row.received_at) >= since) ? [row] : []; }
  catch { return []; }
}) : [];
const stats = values => {
  const v = values.filter(Number.isFinite).sort((a,b) => a-b);
  return v.length ? { n:v.length, mean_s:+(v.reduce((a,b)=>a+b,0)/v.length/1000).toFixed(3),
    median_s:+((v[(v.length-1)>>1]+v[v.length>>1])/2000).toFixed(3),
    p90_s:+(v[Math.max(0,Math.ceil(v.length*.9)-1)]/1000).toFixed(3) } : null;
};
const traces = new Map();
for (const row of rows) {
  if (!row.trace_id) continue;
  const key = `${row.instance_id || ""}:${row.trace_id}`;
  if (!traces.has(key)) traces.set(key, []);
  traces.get(key).push(row);
}
const report = { input:path.resolve(input), since, generated_at:new Date().toISOString(),
  note:"Sequential pipeline phases sum to total. Helper requests and tab_close are nested diagnostics. Estimates are upper bounds, not verified improvements; do not add alternatives targeting the same phase.", sites:{} };
for (const site of ["liepin","boss"]) {
  const all = rows.filter(r => r.site === site);
  const complete = [...traces.values()].filter(group => group.some(r => r.event === "timing:total" && r.site === site && r.job_id));
  const good = complete.filter(group => !group.some(r => r.event === "timing:total" && ["paused","failed","interrupted","title_skipped","skipped"].includes(r.status)));
  const phaseTotals = good.map(group => {
    const phases = group.filter(r => r.event === "timing:phase");
    const sums = {};
    for (const p of phases) sums[p.phase] = (sums[p.phase] || 0) + p.elapsed_ms;
    const total = group.findLast(r => r.event === "timing:total");
    sums.total = total.elapsed_ms;
    sums.unaccounted = Math.max(0, total.elapsed_ms - phases.reduce((n,p)=>n+p.elapsed_ms,0));
    sums.tab_close = group.filter(r => r.event === "timing:operation" && r.phase === "tab_close").reduce((n,p)=>n+p.elapsed_ms,0);
    return sums;
  });
  const phases = {};
  for (const phase of new Set(phaseTotals.flatMap(p => Object.keys(p))))
    phases[phase] = stats(phaseTotals.map(p => p[phase] || 0));
  const helper = {};
  for (const phase of ["screen","evaluate","model","ocr"])
    helper[phase] = stats(all.filter(r => r.event === "timing:helper" && r.phase === phase && r.status === 200).map(r=>r.elapsed_ms));
  const mean = phase => phases[phase]?.mean_s || 0;
  const estimates = phaseTotals.length ? [
    {action:"取消逐条标题预筛", maximum_saved_s:mean("title_screen"), assumption:"只表示可移除阶段的上限；新增无关JD的评分成本尚未计入"},
    {action:"标题批量预筛20条", maximum_saved_s:+(mean("title_screen")*.95).toFixed(3), assumption:"假设20条批量请求耗时与单条相同，须用A/B实测校正"},
    {action:"预筛改low", maximum_saved_s:mean("title_screen"), assumption:"目前没有low对照数据，实际收益未知，范围0到此上限"},
    {action:"复用详情标签页", maximum_saved_s:+(mean("tab_open")+mean("tab_close")).toFixed(3), assumption:"仅计创建/关闭标签API耗时；重新导航和详情加载仍存在"},
    {action:"预加载下一条详情", maximum_saved_s:+Math.min(mean("detail_load"),mean("scoring")).toFixed(3), assumption:"理论重叠上限，尚未验证页面限制和调度成本"},
  ] : [];
  report.sites[site] = {completed_traces:complete.length, usable_traces:good.length, phases, helper,
    waits:stats(all.filter(r=>r.event==="timing:wait").map(r=>r.elapsed_ms)), estimated_actions:estimates};
}
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report.sites,null,2));
console.log(`Saved ${output}`);
