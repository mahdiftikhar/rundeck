const main = document.querySelector("main");
const selected = new Map();
const states = ["running", "completed", "failed", "interrupted"];
const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 7 });
let generation = 0;
let timers = [];
let runsOffset = 0;
let filters = { q: "", status: "", source: "", group: "", tag: "" };
let reference = "";
let episode = "";
let destroyBaselinePicker;
let destroyInspector;

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null && value !== false) element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const link = (label, href, className) => node("a", { href, class: className }, label);
const panel = (...children) => node("section", { class: "panel panel-pad" }, children);
const notice = (message, error = false) => node("p", { class: error ? "notice error" : "notice", role: error ? "alert" : null }, message);
const badge = (state) => node("span", { class: `badge ${state}` }, state);
const query = (pairs) => new URLSearchParams(pairs.filter(([, value]) => value !== "" && value != null)).toString();
const runHash = (id, tab = "results") => `#run/${encodeURIComponent(id)}/${tab}`;
const runApi = (id, suffix = "") => `/api/runs/${encodeURIComponent(id)}${suffix}`;
const lookup = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;

const displayOf = run => run.reproducibility?.config?.display || {};
const experimentKey = run => run.reproducibility?.config?.experiment_id || run.id;
const kindLabels = { evaluation: "Full evaluation", "spot-check": "Spot check", pilot: "Pilot", unknown: "Unknown" };
const scopeLabel = run => {
  const d = displayOf(run);
  return d.benchmark ? d.benchmark.toLowerCase() : kindLabels[d.kind] || "Unknown";
};
const coverage = run => {
  const d = displayOf(run);
  return String(d.completed_episodes ?? "—");
};
const scoreNames = { progress: "Goals found", success: "Success", mspl: "MSPL" };
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
let overviewMetric = "progress";
let showUnsuccessful = false;
const visibleStatus = run => showUnsuccessful || !["failed", "interrupted"].includes(run.status);

function experimentGroups(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = experimentKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()].map(group => group.sort((a, b) => a.id.localeCompare(b.id)));
}

async function allRuns(pairs = []) {
  const runs = [];
  let first;
  let offset = 0;
  while (true) {
    const page = await api(`/api/runs?${query([...pairs, ["limit", 200], ["offset", offset]])}`);
    first ||= page;
    runs.push(...page.runs);
    offset += page.runs.length;
    if (offset >= page.total || !page.runs.length) return { ...first, runs };
  }
}

function candidateChart(candidates, metric) {
  const svgNode = (tag, attrs = {}, ...children) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    element.append(...children);
    return element;
  };
  const width = 600;
  const left = 160;
  const plotWidth = 365;
  const top = 22;
  const rowHeight = 110;
  const bottom = top + candidates.length * rowHeight;
  const height = bottom + 66;
  const chart = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "candidate-chart-title",
    class: "candidate-chart",
  }, svgNode("title", { id: "candidate-chart-title" },
    `${scoreNames[metric]}: ${candidates.map(run => `${displayOf(run).experiment}, ${percent(displayOf(run).scores?.[metric])}`).join("; ")}`));

  for (const tick of [0, 20, 40, 60, 80, 100]) {
    const x = left + plotWidth * tick / 100;
    chart.append(svgNode("line", { x1: x, x2: x, y1: top, y2: bottom,
      class: tick === 0 ? "candidate-axis" : "candidate-gridline", "aria-hidden": "true" }),
    svgNode("text", { x, y: bottom + 25, "text-anchor": "middle", class: "candidate-tick" }, `${tick}%`));
  }
  chart.append(svgNode("line", { x1: left, x2: left + plotWidth, y1: bottom, y2: bottom,
    class: "candidate-axis", "aria-hidden": "true" }),
  svgNode("text", { x: left + plotWidth / 2, y: height - 8, "text-anchor": "middle", class: "candidate-axis-label" },
    `${scoreNames[metric]} (%)`));

  candidates.forEach((run, index) => {
    const d = displayOf(run);
    const value = d.scores?.[metric];
    const valid = Number.isFinite(value) && value >= 0 && value <= 1;
    const y = top + index * rowHeight + rowHeight / 2;
    const end = left + (valid ? value * plotWidth : 0);
    const label = d.experiment?.split(" · ").slice(1).join(" · ") || run.title;
    const entry = svgNode("a", { href: runHash(run.id), class: `candidate-series candidate-series-${index % 2}` },
      svgNode("title", {}, `${d.experiment || run.title}: ${percent(value)}`),
      svgNode("text", { x: left - 14, y: y + 6, "text-anchor": "end", class: "candidate-label" }, label));
    if (valid) entry.append(svgNode("rect", {
      x: left, y: y - 22, width: value * plotWidth, height: 44, rx: 4, class: "candidate-bar",
    }));
    entry.append(svgNode("text", { x: end + 10, y: y + 6, class: "candidate-value" }, percent(value)));
    chart.append(entry);
  });
  return node("figure", { class: "candidate-figure" },
    node("figcaption", {}, scoreNames[metric]), chart);
}

async function candidateOverview(target, version) {
  const { runs } = await allRuns();
  if (version !== generation || !target.isConnected) return;
  const candidates = runs.filter(run => displayOf(run).candidate === true
    && displayOf(run).kind === "evaluation" && visibleStatus(run))
    .sort((a, b) => displayOf(a).candidate_order - displayOf(b).candidate_order);
  const metric = dropdown("Chart metric", Object.entries(scoreNames), overviewMetric, value => {
    overviewMetric = value;
    candidateOverview(target, version).catch(error => target.replaceChildren(notice(error.message, true)));
  });
  target.replaceChildren(node("div", { class: "catalog-heading" }, node("h2", {}, "Candidate results"), metric));
  if (!candidates.length) {
    target.append(notice("No candidate evaluations are available under the current status visibility."));
    return;
  }
  const bars = candidateChart(candidates, overviewMetric);
  const rows = candidates.map(run => [link(displayOf(run).experiment || run.title, runHash(run.id)), scopeLabel(run), coverage(run),
    badge(run.status), ...Object.keys(scoreNames).map(name => percent(displayOf(run).scores?.[name]))]);
  target.append(notice("Scores may use different episodes or settings."),
    node("div", { class: "overview-grid" }, bars,
      table(["Candidate", "Scope", "Episodes", "Status", ...Object.values(scoreNames)], rows, "Candidate results")));
}

async function resultsView(run, target, version) {
  const d = displayOf(run);
  target.append(panel(node("p", {}, d.description || run.title),
    node("div", { class: "run-score-strip" }, Object.entries(scoreNames).map(([name, label]) =>
      node("div", {}, node("span", {}, label), node("strong", {}, percent(d.scores?.[name])))))));
  const data = await api(runApi(run.id, "/episodes"));
  if (version !== generation) return;
  if (data.episodes.length === 1 && data.episodes[0].captured) {
    const { mountInspector } = await import("./inspector.js");
    const cleanup = await mountInspector({ run, target, alive: () => version === generation, episodes: data.episodes });
    if (version === generation) destroyInspector = cleanup; else cleanup();
  } else if (data.episodes.length) {
    target.append(panel(node("h2", {}, "Episodes"), table(["Episode", "Goals found", "Success", "Steps", "Duration", ""],
      data.episodes.map(e => [e.id, percent(e.progress), percent(e.success), e.steps ?? "—",
        Number.isFinite(e.elapsed_s) ? `${Math.round(e.elapsed_s)} s` : "—",
        link(e.captured ? "Inspect" : "View evidence", `${runHash(run.id, "inspect")}/${encodeURIComponent(e.id)}`, "button")]), "Episode results")));
  }
  target.append(node("details", { class: "panel panel-pad" }, node("summary", {}, "Run details and analysis"),
    link("Written analysis", runHash(run.id, "report"), "button"), link("Original log", runHash(run.id, "log"), "button"),
    descriptionList([["Original run ID", run.id], ["Selection evidence", d.scope_basis], ["Date basis", d.date_basis]]), recordMeta(run)));
}

function button(label, action, attrs = {}) {
  const element = node("button", { type: "button", ...attrs }, label);
  element.addEventListener("click", action);
  return element;
}

function table(headings, rows, label) {
  return node("div", { class: "table-scroll", tabindex: "0", "aria-label": label },
    node("table", { "aria-label": label },
      node("thead", {}, node("tr", {}, headings.map(value => node("th", { scope: "col" }, value)))),
      node("tbody", {}, rows.map(values => node("tr", {}, values.map(value => node("td", {}, value)))))));
}

function dropdown(label, items, current, changed) {
  const select = node("select", {}, items.map(([value, text]) => node("option", { value }, text)));
  select.value = current;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
  select.addEventListener("change", () => changed(select.value));
  return node("label", { class: "field" }, label, select);
}

function field(label, value, changed, type = "text") {
  const input = node("input", { type, value, autocomplete: "off" });
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (input.isConnected) changed(input.value.trim());
    }, 250);
  });
  return node("label", {}, label, input);
}

function pagination(data, changed) {
  const { offset, limit, total } = data;
  return node("div", { class: "pager" },
    node("span", { class: "muted" }, total ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total}` : "0 results"),
    node("div", {},
      button("Previous", () => changed(Math.max(0, offset - limit)), { disabled: !offset }),
      button("Next", () => changed(offset + limit), { disabled: offset + limit >= total })));
}

async function api(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status})`);
  return data;
}

function later(action, milliseconds) {
  timers.push(setInterval(action, milliseconds));
}

function title(text, ...actions) {
  return node("div", { class: "heading" }, node("h1", {}, text), node("div", { class: "actions" }, actions));
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const level = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${number.format(bytes / 1024 ** level)} ${["B", "KiB", "MiB", "GiB", "TiB"][level]}`;
}

function date(value) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function toggleRun(run, checked) {
  if (checked) selected.set(run.id, run.title);
  else selected.delete(run.id);
  const count = document.querySelector("#compare-count");
  count.textContent = selected.size;
  count.hidden = selected.size === 0;
}

async function explorer(version) {
  const strip = node("section", { class: "ledger-strip", "aria-label": "Execution status totals" });
  const count = node("p", { class: "meta", role: "status" });
  const problems = node("div");
  const list = node("div", { class: "panel" });
  const controls = node("div", { class: "filters" });
  const content = node("div", {}, notice("Reading the run catalog…"));
  const selectionCount = node("span", { role: "status" });
  const selectionBar = node("div", { class: "selection-bar" }, selectionCount,
    node("div", { class: "actions" }, button("Clear", () => {
      for (const id of selected.keys()) toggleRun({ id }, false);
      for (const check of content.querySelectorAll("input[type=checkbox]")) check.checked = false;
      updateSelection();
      (content.querySelector("input[type=checkbox]") || controls.querySelector("input")).focus();
    }), link("Compare selected", "#compare", "button primary")));
  let request = 0;

  function updateSelection() {
    selectionBar.hidden = selected.size === 0;
    selectionCount.textContent = `${selected.size} selected`;
    for (const check of content.querySelectorAll("input[type=checkbox]")) {
      check.disabled = !check.checked && selected.size >= 20;
    }
  }

  function updateFilter(key, value) {
    filters[key] = value;
    if (key === "status" && ["failed", "interrupted"].includes(value)) {
      showUnsuccessful = true;
      unsuccessful.checked = true;
      refreshOverview();
    }
    runsOffset = 0;
    load();
  }

  controls.append(
    field("Search experiments", filters.q, value => updateFilter("q", value), "search"),
    dropdown("Scope", [["", "All scopes"], ["scope-evaluation", "Full evaluations"],
      ["scope-spot-check", "Spot checks"], ["scope-pilot", "Pilots"], ["scope-unknown", "Unknown"]],
      filters.tag, value => updateFilter("tag", value)));
  controls.firstChild.classList.add("search");
  const unsuccessful = node("input", { type: "checkbox", "aria-label": "Show failed and interrupted" });
  unsuccessful.checked = showUnsuccessful;
  unsuccessful.addEventListener("change", () => {
    showUnsuccessful = unsuccessful.checked;
    if (!showUnsuccessful && ["failed", "interrupted"].includes(filters.status)) filters.status = "";
    runsOffset = 0;
    load();
    refreshOverview();
  });
  controls.append(node("label", { class: "status-visibility" }, unsuccessful, "Show failed and interrupted"));
  let sourceField;
  list.append(node("div", { class: "catalog-heading" }, node("h2", {}, "Experiments"), count), controls, content);
  const overview = node("section", { class: "panel panel-pad" });
  main.append(title("Experiments"), overview, strip, problems, list, selectionBar);
  const refreshOverview = () => candidateOverview(overview, version).catch(error => overview.replaceChildren(notice(error.message, true)));
  refreshOverview();
  updateSelection();

  async function load(quiet = false) {
    const id = ++request;
    try {
      const pairs = Object.entries(filters);
      const all = pairs.filter(([key]) => key !== "status");
      const [data, totals] = await Promise.all([allRuns(pairs), filters.status ? allRuns(all) : null]);
      if (version !== generation || id !== request) return;
      const groups = experimentGroups(data.runs.filter(visibleStatus));
      const limit = 50;
      if (runsOffset >= groups.length) runsOffset = Math.max(0, Math.floor((groups.length - 1) / limit) * limit);
      if (!sourceField && data.sources.length > 1 && !data.runs.some(run => displayOf(run).experiment)) {
        sourceField = dropdown("Source", [["", "All sources"], ...data.sources.map(value => [value, value])],
          filters.source, value => updateFilter("source", value));
        controls.append(sourceField);
      }
      const totalsByState = (totals || data).counts;
      for (const state of states.filter(state => showUnsuccessful || !["failed", "interrupted"].includes(state))) {
        let item = strip.querySelector(`.${state}`);
        if (!item) {
          const label = `${state[0].toUpperCase() + state.slice(1)} runs`;
          item = button(node("span", { class: "status-label" }, label),
            () => updateFilter("status", filters.status === state ? "" : state), { class: state });
          item.append(node("strong"));
          strip.append(item);
        }
        item.setAttribute("aria-pressed", String(filters.status === state));
        item.lastChild.textContent = totalsByState[state] || "0";
      }
      for (const state of ["failed", "interrupted"]) {
        if (!showUnsuccessful) strip.querySelector(`.${state}`)?.remove();
      }
      count.textContent = `${groups.length} experiments`;
      problems.replaceChildren(...(data.scan.issues.length
        ? [notice(`${data.scan.issues.length} indexing issue(s). Run obs index to inspect details.`, true)] : []));
      if (quiet && content.contains(document.activeElement)) return;
      if (!groups.length) {
        content.replaceChildren(node("div", { class: "panel-pad" }, notice(data.sources.length
          ? "No runs match these filters. Clear them or check the configured directories."
          : "Add an experiment source in observatory.toml, then restart the dashboard.")));
        return;
      }
      function compareBox(run) {
        const box = node("input", { type: "checkbox", "aria-label": `Select ${run.title} for comparison` });
        box.checked = selected.has(run.id);
        box.disabled = !box.checked && selected.size >= 20;
        box.addEventListener("change", () => { toggleRun(run, box.checked); updateSelection(); });
        return box;
      }
      const openExperiments = new Set([...content.querySelectorAll("details[data-experiment][open]")].map(item => item.dataset.experiment));
      const rows = groups.slice(runsOffset, runsOffset + limit).map(group => {
        const run = group[0];
        const d = displayOf(run);
        const name = d.experiment || run.title;
        const runRows = group.map(trial => [compareBox(trial),
          link(`Run ${displayOf(trial).run_number || trial.id}`, runHash(trial.id)), badge(trial.status),
          coverage(trial), ...Object.keys(scoreNames).map(key => percent(displayOf(trial).scores?.[key])),
          displayOf(trial).date || "—"]);
        const details = node("details", { "data-experiment": experimentKey(run), open: openExperiments.has(experimentKey(run)) },
          node("summary", {}, name),
          table(["Compare", "Run", "Status", "Episodes", ...Object.values(scoreNames), "Date"], runRows, `${name} runs`));
        const statuses = states.filter(state => group.some(trial => trial.status === state))
          .map(state => node("span", { class: `badge ${state}` }, `${group.filter(trial => trial.status === state).length} ${state}`));
        const dates = [...new Set(group.map(trial => displayOf(trial).date).filter(Boolean))].sort();
        const dateLabel = dates.length > 1 ? `${dates[0]} – ${dates.at(-1)}` : dates[0] || "—";
        return [group.length === 1 ? compareBox(run) : null,
          group.length > 1 ? details : link(name, runHash(run.id)),
          [...new Set(group.map(scopeLabel))].join(" / "),
          String(group.length), node("div", { class: "tag-list" }, statuses), dateLabel];
      });
      content.replaceChildren(table(["Compare", "Experiment", "Scope", "Runs", "Status", "Date"], rows, "Experiments"),
        pagination({ offset: runsOffset, limit, total: groups.length }, offset => { runsOffset = offset; load(); }));
    } catch (error) {
      if (version === generation && id === request) problems.replaceChildren(notice(error.message, true));
    }
  }

  await load();
  if (version === generation) later(() => { load(true); refreshOverview(); }, 8000);
}

function descriptionList(items) {
  return node("dl", {}, items.filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => [node("dt", {}, key), node("dd", {}, value)]));
}

function jsonBlock(value) {
  return node("pre", {}, JSON.stringify(value, null, 2));
}

function section(heading, ...children) {
  return node("section", { class: "report-section" }, node("h2", {}, heading), children);
}

function evidenceLink(run, path) {
  return link(path, `${runHash(run.id, "artifacts")}/${encodeURIComponent(path)}`);
}

function reportResults(results, data) {
  const rows = results.map(item => [lookup(data.metric_labels, item.name) || item.name, item.episode || "Aggregate",
    node("span", { class: "numeric" }, number.format(item.value)), item.unit || "—", item.direction]);
  return table(["Metric", "Episode", "Value", "Unit", "Direction"], rows, "Report metrics");
}

function recordMeta(run, reproducibility) {
  const r = reproducibility || run.reproducibility;
  const observed = run.observation;
  return panel(node("div", { class: "details" }, node("h2", {}, "Run record"),
    descriptionList([
      ["Source", run.source], ["Experiment", run.group], ["Tags", run.tags.join(", ")], ["Started", r.started_at ? date(r.started_at) : null],
      ["Ended", r.ended_at ? date(r.ended_at) : null], ["Exit code", r.exit_code], ["Git commit", r.git_commit],
      ["Seed", r.seed], ["Command", r.command], ["tmux pane", run.tmux_pane],
      ["Pane observation", observed ? [observed.state, observed.session, observed.pane_pid ? `PID ${observed.pane_pid}` : "",
        observed.pane_exit_code != null ? `pane exit ${observed.pane_exit_code}` : ""].filter(Boolean).join(" · ") : null],
    ]),
    Object.keys(r.config).length ? node("details", {}, node("summary", {}, "Configuration"), jsonBlock(r.config)) : null,
    Object.keys(r.environment).length ? node("details", {}, node("summary", {}, "Environment"), jsonBlock(r.environment)) : null));
}

function comparisonCell(cell) {
  if (!cell || cell.state !== "valid") return badge(cell?.state || "missing");
  const difference = cell.delta;
  const good = difference && cell.direction !== "neutral" ? (difference > 0) === (cell.direction === "higher") : null;
  return node("div", { class: "numeric" }, `${number.format(cell.value)} ${cell.unit}`.trim(),
    difference !== undefined ? node("small", { class: `delta ${good === null ? "" : good ? "good" : "bad"}` },
      `Δ ${difference > 0 ? "+" : ""}${number.format(difference)}`) : null,
    cell.comparison_issue ? node("small", { class: "delta" }, cell.comparison_issue) : null);
}

function comparisonTable(data) {
  const comparison = table(["Metric", ...data.runs.map(run => node("span", {}, link(run.title, runHash(run.id)),
    run.id === data.baseline ? node("small", { class: "delta" }, "Baseline") : null))],
  data.rows.map(row => [row.label, ...data.runs.map(run => comparisonCell(row.values[run.id]))]), "Metric comparison");
  const column = data.runs.findIndex(run => run.id === data.baseline) + 2;
  for (const cell of comparison.querySelectorAll(`tr > :nth-child(${column})`)) {
    cell.classList.add("baseline");
  }
  return comparison;
}

const chartPainters = new WeakMap();
document.addEventListener("rundeck-theme-change", () => {
  for (const canvas of main.querySelectorAll("canvas")) chartPainters.get(canvas)?.();
});
function canvasPlot(label, draw) {
  const canvas = node("canvas", { width: 640, height: 270, role: "img", "aria-label": label });
  const context = canvas.getContext("2d");
  if (context) {
    function paint() {
      const style = getComputedStyle(document.documentElement);
      const colors = {
        text: style.getPropertyValue("--muted-foreground").trim(),
        axis: style.getPropertyValue("--chart-axis").trim(),
        series: style.getPropertyValue("--chart-series").split(",").map(color => color.trim()),
      };
      context.setTransform(2, 0, 0, 2, 0, 0);
      context.clearRect(0, 0, 320, 135);
      context.font = "10px system-ui";
      context.textAlign = "left";
      draw(context, 320, 135, colors);
    }
    chartPainters.set(canvas, paint);
    paint();
  }
  return canvas;
}

function scalePosition(value, low, high) {
  const divisor = Math.max(Math.abs(low), Math.abs(high), 1);
  return low === high ? .5 : (value / divisor - low / divisor) / (high / divisor - low / divisor);
}

function barChart(heading, items) {
  const low = Math.min(0, ...items.map(item => item.value));
  const high = Math.max(0, ...items.map(item => item.value));
  const label = items.map(item => `${item.label} ${number.format(item.value)} ${item.unit}`).join(", ");
  return node("div", { class: "chart-card" }, node("h3", {}, heading),
    canvasPlot(label, (ctx, width, height, colors) => {
      const left = 14;
      const space = width - 28;
      const step = (height - 18) / items.length;
      const x = value => left + scalePosition(value, low, high) * space;
      const zero = x(0);
      ctx.fillStyle = colors.axis;
      ctx.fillRect(zero, 0, 1, height - 16);
      items.forEach((item, index) => {
        ctx.fillStyle = colors.series[index % colors.series.length];
        ctx.fillRect(Math.min(x(item.value), zero), index * step + 3,
          Math.max(1, Math.abs(x(item.value) - zero)), Math.max(2, step * .65));
      });
      ctx.fillStyle = colors.text;
      ctx.fillText(number.format(low), left, height - 2);
      ctx.textAlign = "right";
      ctx.fillText(number.format(high), width - 14, height - 2);
    }),
    node("div", { class: "legend" }, items.map((item, index) => node("span", {},
      `${index + 1}. ${item.label} · ${number.format(item.value)} ${item.unit}`.trim()))));
}

function compareCharts(data) {
  const chartable = data.rows.flatMap(row => {
    if (!row.chart) return [];
    const items = data.runs.flatMap(run => {
      const value = row.values[run.id];
      return value.state === "valid" ? [{ ...value, label: run.title }] : [];
    });
    return items.length && new Set(items.map(item => item.unit)).size === 1 ? [{ row, items }] : [];
  });
  if (!chartable.length) return null;
  const chartArea = node("div", { class: "chart-grid" });
  const render = (start) => {
    chartArea.replaceChildren(...chartable.slice(start, start + 12).map(({ row, items }) => barChart(row.label, items)));
    if (chartable.length > 12) chartArea.append(pagination({ offset: start, limit: 12, total: chartable.length }, render));
  };
  render(0);
  return chartArea;
}

async function reportView(run, target, version, final = false) {
  const suffix = final ? "?revision=final" : "";
  const data = await api(runApi(run.id, `/report${suffix}`));
  if (version !== generation) return;
  const report = data.report;
  const actions = node("div", { class: "actions" }, badge(final && report ? "finalized" : data.state),
    report ? link("Export Markdown", runApi(run.id, `/report.md${suffix}`), "button") : null,
    data.has_final && !final && data.state !== "finalized" ? link("Open finalized snapshot", runHash(run.id, "final"), "button") : null,
    final ? link("Open current report", runHash(run.id), "button") : null);
  const article = node("article", { class: "panel" });
  target.append(actions, article, node("details", { class: "panel panel-pad" }, node("summary", {}, "Run details"), recordMeta(run, report?.reproducibility)));
  if (data.state === "invalid") {
    article.append(section("Report validation", Object.entries(data.errors).map(([name, error]) => notice(`${name}: ${error}`, true))));
  }
  if (!report) {
    article.append(section("Report", notice(final ? "This run has no finalized snapshot." : `Generate a draft with obs draft ${run.id}.`)));
    if (data.available_results.length) article.append(section("Indexed metrics", reportResults(data.available_results, data)));
    if (data.metric_issues.invalid || data.metric_issues.incomplete || data.metric_issues.truncated) {
      article.append(section("Metric source issues", jsonBlock(data.metric_issues)));
    }
    return;
  }
  for (const key of ["objective", "hypothesis", "methodology"]) {
    article.append(section(key[0].toUpperCase() + key.slice(1), node("p", { class: "prose" }, report[key] || "Pending")));
  }
  const resultCharts = compareCharts({ runs: [{ id: run.id, title: run.title }], rows: report.results
    .filter(metric => metric.episode == null).map(metric => ({
      label: lookup(data.metric_labels, metric.name) || metric.name,
      chart: lookup(data.charts, metric.name) !== false,
      values: { [run.id]: { ...metric, state: "valid" } },
    })) });
  article.append(section("Results", report.results.length ? reportResults(report.results, data) : notice("No metrics in this report."),
    resultCharts));
  if (report.baseline) {
    article.append(section("Baseline comparison", link(report.baseline, runHash(report.baseline)),
      data.comparison?.rows.length ? comparisonTable(data.comparison) : null));
  }
  article.append(section("Findings", report.findings.length ? node("ul", {}, report.findings.map(finding =>
    node("li", {}, node("p", { class: "prose" }, finding.text),
      node("ul", {}, finding.evidence.map(item => node("li", {}, evidenceLink(run, item.path),
        item.detail ? ` · ${item.detail}` : null)))))) : notice("Pending")));
  for (const [heading, items] of [["Limitations", report.limitations], ["Next steps", report.next_steps]]) {
    article.append(section(heading, items.length ? node("ul", {}, items.map(item => node("li", { class: "prose" }, item))) : notice("Pending")));
  }
  for (const [key, value] of Object.entries(report.sections)) {
    article.append(section(lookup(data.sections, key) || key, node("p", { class: "prose" }, value)));
  }
  if (report.artifacts.length) article.append(section("Referenced artifacts",
    node("ul", {}, report.artifacts.map(item => node("li", {}, evidenceLink(run, item.path), item.label ? ` · ${item.label}` : null)))));
}

function artifactURL(run, endpoint, path, extra = []) {
  return runApi(run.id, `/${endpoint}?${query([["path", path], ...extra])}`);
}

function trajectoryPlot(data, column) {
  const index = data.columns.indexOf(column);
  const series = data.rows.map(row => {
    const value = row?.[index];
    return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
      && Number.isFinite(Number(value)) ? Number(value) : null;
  });
  const valid = series.filter(value => value !== null);
  if (!valid.length) return notice("This column contains no numeric values in the window.");
  const low = Math.min(...valid), high = Math.max(...valid);
  return node("div", { class: "chart-card" }, node("h3", {}, column),
    node("p", { class: "numeric" }, `${valid.length} values · min ${number.format(low)} · max ${number.format(high)}`),
    canvasPlot(`${column} from row ${data.offset + 1} through ${data.offset + data.rows.length}`,
      (ctx, width, height, colors) => {
        const x = index => 14 + (width - 28) * index / Math.max(1, series.length - 1);
        const y = value => 7 + (height - 24) * (1 - scalePosition(value, low, high));
        ctx.strokeStyle = colors.series[0];
        ctx.fillStyle = colors.series[0];
        ctx.lineWidth = 1.6;
        let previous = null;
        series.forEach((value, index) => {
          if (value !== null) {
            ctx.fillRect(x(index) - 1, y(value) - 1, 2, 2);
            if (previous !== null) {
              ctx.beginPath();
              ctx.moveTo(x(index - 1), y(previous));
              ctx.lineTo(x(index), y(value));
              ctx.stroke();
            }
          }
          previous = value;
        });
        ctx.fillStyle = colors.text;
        ctx.fillText(String(data.offset + 1), 14, height - 2);
        ctx.textAlign = "right";
        ctx.fillText(String(data.offset + data.rows.length), width - 14, height - 2);
      }));
}

async function trajectoryView(run, path, target, alive) {
  const windowArea = node("div", {}, notice("Reading trajectory…"));
  let column = "";
  const limit = 100;

  async function load(offset) {
    const data = await api(artifactURL(run, "trajectory", path, [["offset", offset], ["limit", limit]]));
    if (!alive()) return;
    const chart = node("div");
    const draw = value => {
      column = value;
      chart.replaceChildren(trajectoryPlot(data, value));
    };
    const columns = data.columns.map(value => [value, value]);
    column = column || data.columns[0];
    const paging = node("div", { class: "actions" },
      button("Previous window", () => safeLoad(Math.max(0, offset - limit)), { disabled: !offset }),
      button("Next window", () => safeLoad(offset + limit), { disabled: !data.has_more }));
    const rows = data.rows.map((row, index) => [offset + index + 1, ...data.columns.map((_, i) => {
      const value = row?.[i];
      return value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : value;
    })]);
    windowArea.replaceChildren(
      node("p", { class: "meta" }, `${rows.length} rows in window · ${data.invalid} invalid`),
      node("div", { class: "actions" }, dropdown("Plot column", columns, column, draw), paging),
      chart, table(["Row", ...data.columns], rows, "Trajectory window"));
    draw(column);
  }

  async function safeLoad(offset) {
    try { await load(offset); }
    catch (error) { if (alive()) windowArea.replaceChildren(notice(error.message, true)); }
  }

  target.append(windowArea);
  await safeLoad(0);
}

async function artifactsView(run, target, version, initialPath) {
  const selectedFiles = new Set();
  const body = node("div", {}, notice("Reading artifacts…"));
  const previewBox = node("section", { class: "panel panel-pad preview", "aria-live": "polite" },
    node("h2", {}, "Preview"), notice("Select an artifact to inspect it."));
  const bundleLink = link("Download selected", "#", "button");
  bundleLink.hidden = true;
  const filtersArea = node("div", { class: "filters" });
  let search = "";
  let listRequest = 0;
  let previewRequest = 0;

  function updateBundle() {
    bundleLink.hidden = !selectedFiles.size;
    bundleLink.textContent = `Download selected (${selectedFiles.size})`;
    bundleLink.href = runApi(run.id, `/bundle?${query([...selectedFiles].map(path => ["path", path]))}`);
    for (const check of body.querySelectorAll("input[type=checkbox]")) {
      check.disabled = !check.checked && selectedFiles.size >= 100;
    }
  }

  async function open(path, knownTrajectory = false) {
    const request = ++previewRequest;
    const alive = () => version === generation && request === previewRequest;
    const header = node("h2", { class: "artifact-name" }, path);
    const download = link("Download file", artifactURL(run, "file", path, [["download", true]]), "button");
    previewBox.replaceChildren(header, download);
    const detail = node("div");
    previewBox.append(detail);
    try {
      if (knownTrajectory) {
        await trajectoryView(run, path, detail, alive);
        return;
      }
      const result = await api(artifactURL(run, "preview", path));
      if (!alive()) return;
      if (result.kind === "media") {
        const source = artifactURL(run, "file", path);
        detail.append(result.mime.startsWith("image/")
          ? node("img", { src: source, alt: path })
          : node("video", { src: source, controls: true, preload: "metadata", "aria-label": path }));
      } else if (result.kind === "text") {
        detail.append(node("pre", {}, result.text));
      } else if (result.kind === "table") {
        const [headers, ...rows] = result.rows;
        detail.append(headers ? table(headers, rows, "Delimited preview") : notice("This file is empty."));
      } else {
        detail.append(notice(result.message));
      }
      if (result.truncated || result.has_earlier) detail.append(notice("Preview shows part of this file."));
    } catch (error) {
      if (alive()) detail.replaceChildren(notice(error.message, true));
    }
  }

  async function load(offset = 0) {
    const request = ++listRequest;
    try {
      const data = await api(runApi(run.id, `/artifacts?${query([["q", search], ["offset", offset]])}`));
      if (version !== generation || request !== listRequest) return;
      if (!data.files.length) {
        body.replaceChildren(node("div", { class: "panel-pad" }, notice("No indexed artifacts match.")));
        return;
      }
      const rows = data.files.map(file => {
        const check = node("input", { type: "checkbox", "aria-label": `Include ${file.path} in download` });
        check.checked = selectedFiles.has(file.path);
        check.addEventListener("change", () => {
          if (check.checked) selectedFiles.add(file.path);
          else selectedFiles.delete(file.path);
          updateBundle();
        });
        return [check, button(file.path, () => open(file.path, file.trajectory), { class: "artifact-button" }),
          node("span", { class: "numeric" }, size(file.size)), file.trajectory ? "Trajectory" : "File"];
      });
      body.replaceChildren(table(["Select", "Path", "Size", "Type"], rows, "Artifacts"), pagination(data, load));
      updateBundle();
      return data;
    } catch (error) {
      if (version === generation && request === listRequest) body.replaceChildren(notice(error.message, true));
    }
  }

  const searchField = field("Search artifact paths", "", value => { search = value; load(); }, "search");
  searchField.classList.add("search");
  filtersArea.append(searchField, bundleLink);
  target.append(node("div", { class: "split" }, node("section", { class: "panel" }, filtersArea, body), previewBox));
  if (initialPath) {
    load();
    try {
      const match = await api(runApi(run.id, `/artifacts?${query([["q", initialPath], ["limit", 200]])}`));
      if (version === generation && !previewRequest) open(initialPath, match.files.some(file => file.path === initialPath && file.trajectory));
    } catch (error) {
      if (version === generation && !previewRequest) previewBox.replaceChildren(notice(error.message, true));
    }
  } else {
    await load();
  }
}

function logView(run, target, version) {
  const status = node("p", { class: "meta", role: "status" });
  if (!run.log) {
    target.append(panel(notice(`Attach a log path with obs attach ${run.id}.`)));
    return;
  }
  const log = node("pre", { class: "log", tabindex: "0", "aria-label": "Live log output" });
  let cursor = null;
  let fileId = null;
  let output = "";
  let following = true;
  let busy = false;
  const toggle = button("Pause following", () => {
    following = !following;
    toggle.textContent = following ? "Pause following" : "Resume following";
    if (following) update();
    else status.textContent = "Paused";
  });
  target.append(panel(node("h2", {}, run.log), node("div", { class: "actions" }, toggle,
    link("Download log", artifactURL(run, "file", run.log, [["download", true]]), "button")),
  status, log));

  async function update() {
    if (!following || busy) return;
    busy = true;
    try {
      const result = await api(runApi(run.id, `/log?${query([["cursor", cursor], ["file_id", fileId]])}`));
      if (version !== generation || !following) return;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
      if (cursor === null || result.reset) output = result.has_earlier ? "[Earlier log output available in download]\n" : "";
      if (result.reset) output += "[Log replaced or truncated]\n";
      const next = (output + result.text).slice(-256 * 1024);
      if (next !== output || !log.textContent) {
        log.textContent = next || "Waiting for output…";
        if (atBottom) log.scrollTop = log.scrollHeight;
      }
      output = next;
      cursor = result.cursor;
      fileId = result.file_id;
      status.textContent = result.more ? "Catching up with the log" : "Following live log";
    } catch (error) {
      if (version === generation) status.textContent = `${error.message}. Retrying while following is enabled.`;
    } finally {
      busy = false;
    }
  }

  update();
  later(update, 1800);
}

async function runView(id, tab, initialPath, version) {
  const run = await api(runApi(id));
  if (version !== generation) return;
  const add = button(selected.has(id) ? "Remove from comparison" : "Add to comparison", () => {
    toggleRun(run, !selected.has(id));
    add.textContent = selected.has(id) ? "Remove from comparison" : "Add to comparison";
  }, { disabled: !selected.has(id) && selected.size >= 20 });
  main.append(link("← Experiment runs", "#runs", "breadcrumb"), title(run.title, add),
    node("p", { class: "meta" }, badge(run.status), " · ", scopeLabel(run), " · Episodes ", coverage(run), " · ", displayOf(run).date || "Date unknown"));
  if (run.index_issue) main.append(notice(run.index_issue, true));
  const nav = node("nav", { class: "tabs", "aria-label": "Run views" });
  for (const [key, label] of [["results", "Results"], ["inspect", "Inspect"], ["artifacts", "Files"]]) {
    const item = link(label, runHash(id, key));
    if (key === tab || key === "report" && tab === "final") item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  const area = node("div");
  main.append(nav, area);
  if (tab === "artifacts") await artifactsView(run, area, version, initialPath);
  else if (tab === "log") logView(run, area, version);
  else if (tab === "results") await resultsView(run, area, version);
  else if (tab === "inspect") {
    const { mountInspector } = await import("./inspector.js");
    if (version !== generation) return;
    const cleanup = await mountInspector({ run, target: area, alive: () => version === generation, episodeId: initialPath });
    if (version === generation) destroyInspector = cleanup; else cleanup();
  }
  else await reportView(run, area, version, tab === "final");
}

function compareView(version) {
  const choices = node("div", { class: "actions comparison-controls" });
  const baselineHost = node("div", { class: "field" });
  const scopeControls = node("div", { class: "actions" });
  choices.append(baselineHost, scopeControls);
  const output = node("div");
  const picks = node("div", { class: "comparison-picks" });
  const controls = panel(picks, choices);
  let request = 0;
  let picker;
  const changeBaseline = value => { reference = value; render(); };
  main.append(title("Compare experiments", link("Select runs", "#runs", "button")), controls, output);

  async function render() {
    const id = ++request;
    const ids = [...selected.keys()];
    controls.hidden = ids.length === 0;
    picks.replaceChildren(...[...selected].map(([key, name]) =>
      button(`${name} ×`, () => { toggleRun({ id: key }, false); render(); }, { "aria-label": `Remove ${name}` })));
    if (!ids.length) {
      scopeControls.replaceChildren();
      output.replaceChildren(notice("Select one or more runs in the run ledger to begin a comparison."));
      return;
    }
    const options = [["", "Default baseline"], ...selected];
    const current = selected.has(reference) ? reference : "";
    if (picker) picker.update(options, current, changeBaseline);
    else baselineHost.replaceChildren(dropdown("Baseline", options, current, changeBaseline));
    scopeControls.replaceChildren();
    output.replaceChildren(notice("Comparing metrics…"));
    try {
      const parameters = query([
        ...ids.map(key => ["run", key]), ["baseline", selected.has(reference) ? reference : ""], ["episode", episode]]);
      const data = await api(`/api/compare?${parameters}`);
      if (version !== generation || id !== request) return;
      if (episode && !data.episodes.includes(episode)) {
        episode = "";
        render();
        return;
      }
      scopeControls.append(dropdown("Episode", [["", "Aggregate"], ...data.episodes.map(value => [value, value])],
        episode, value => { episode = value; render(); }),
      link("Export CSV", `/api/compare.csv?${parameters}`, "button"));
      const issues = data.runs.flatMap(run => {
        const details = [run.issues.invalid ? `${run.issues.invalid} invalid records` : "",
          run.issues.incomplete ? `${run.issues.incomplete} incomplete records` : "",
          run.truncated ? "metric catalog truncated" : ""].filter(Boolean);
        return details.length ? [notice(`${run.title} · ${details.join(" · ")}`)] : [];
      });
      const contexts = data.runs.filter(run => run.context != null);
      const caveats = contexts.length ? [panel(
        notice("Descriptive comparison: aggregate cohorts may differ. Review recorded conditions and caveats before attributing a delta to an experimental factor."),
        ...contexts.map(run => node("details", {},
          node("summary", {}, `${run.title} · recorded comparison context`), jsonBlock(run.context))))] : [];
      const charts = compareCharts(data);
      output.replaceChildren(...caveats, ...issues, node("section", { class: "panel" },
        data.rows.length ? comparisonTable(data) : node("div", { class: "panel-pad" }, notice("No metrics are indexed for this scope."))),
      ...(charts ? [panel(node("h2", {}, "Metric charts"), charts)] : []));
    } catch (error) {
      if (version === generation && id === request) output.replaceChildren(notice(error.message, true));
    }
  }

  render();
  if (selected.size) {
    import("./baseline-picker.js").then(({ createBaselinePicker }) => {
      if (version !== generation || !selected.size) return;
      baselineHost.replaceChildren();
      picker = createBaselinePicker(baselineHost);
      destroyBaselinePicker = () => picker.destroy();
      picker.update([["", "Default baseline"], ...selected], selected.has(reference) ? reference : "", changeBaseline);
    }).catch(error => console.warn("Searchable baseline picker could not load", error));
  }
}

async function route() {
  const hash = location.hash.slice(1) || "runs";
  if (hash === "main") return;
  const version = ++generation;
  destroyInspector?.();
  destroyInspector = undefined;
  destroyBaselinePicker?.();
  destroyBaselinePicker = undefined;
  timers.forEach(clearInterval);
  timers = [];
  main.replaceChildren();
  window.scrollTo(0, 0);
  document.querySelector("#runs-link").toggleAttribute("aria-current", hash !== "compare");
  document.querySelector("#compare-link").toggleAttribute("aria-current", hash === "compare");
  try {
    const [page, id, tab, path] = hash.split("/");
    if (page === "compare") compareView(version);
    else if (page === "run" && id) await runView(decodeURIComponent(id), tab || "results",
      path ? decodeURIComponent(path) : null, version);
    else await explorer(version);
  } catch (error) {
    if (version === generation) main.append(notice(error.message, true), link("Return to runs", "#runs"));
  }
}

window.addEventListener("hashchange", route);
route();
