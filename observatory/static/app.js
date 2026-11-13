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
const runHash = (id, tab = "report") => `#run/${encodeURIComponent(id)}/${tab}`;
const runApi = (id, suffix = "") => `/api/runs/${encodeURIComponent(id)}${suffix}`;
const lookup = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;

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
    runsOffset = 0;
    load();
  }

  controls.append(
    field("Search runs", filters.q, value => updateFilter("q", value), "search"),
    field("Group", filters.group, value => updateFilter("group", value)),
    field("Tag", filters.tag, value => updateFilter("tag", value)));
  controls.firstChild.classList.add("search");
  let sourceField;
  list.append(node("div", { class: "catalog-heading" }, node("h2", {}, "Run catalog"), count), controls, content);
  main.append(title("Experiment runs"), strip, problems, list, selectionBar);
  updateSelection();

  async function load(quiet = false) {
    const id = ++request;
    try {
      const all = Object.entries(filters).filter(([key]) => key !== "status");
      const url = `/api/runs?${query([...Object.entries(filters), ["offset", runsOffset]])}`;
      const [data, totals] = await Promise.all([api(url), filters.status
        ? api(`/api/runs?${query([...all, ["limit", 1]])}`) : null]);
      if (version !== generation || id !== request) return;
      if (data.offset >= data.total && data.offset > 0) {
        runsOffset = Math.max(0, Math.floor((data.total - 1) / data.limit) * data.limit);
        load();
        return;
      }
      if (!sourceField) {
        sourceField = dropdown("Source", [["", "All sources"], ...data.sources.map(value => [value, value])],
          filters.source, value => updateFilter("source", value));
        controls.append(sourceField);
      }
      const totalsByState = (totals || data).counts;
      for (const state of states) {
        let item = strip.querySelector(`.${state}`);
        if (!item) {
          const label = state[0].toUpperCase() + state.slice(1);
          item = button(node("span", { class: "status-label" }, label),
            () => updateFilter("status", filters.status === state ? "" : state), { class: state });
          item.append(node("strong"));
          strip.append(item);
        }
        item.setAttribute("aria-pressed", String(filters.status === state));
        item.lastChild.textContent = totalsByState[state] || "0";
      }
      count.textContent = `${data.total} ${filters.status ? filters.status + " " : ""}${data.total === 1 ? "run" : "runs"}`;
      problems.replaceChildren(...(data.scan.issues.length
        ? [notice(`${data.scan.issues.length} indexing issue(s). Run obs index to inspect details.`, true)] : []));
      if (quiet && content.contains(document.activeElement)) return;
      if (!data.runs.length) {
        content.replaceChildren(node("div", { class: "panel-pad" }, notice(data.sources.length
          ? "No runs match these filters. Clear them or check the configured directories."
          : "Add an experiment source in observatory.toml, then restart the dashboard.")));
        return;
      }
      const rows = data.runs.map(run => {
        const box = node("input", { type: "checkbox", "aria-label": `Select ${run.title} for comparison` });
        box.checked = selected.has(run.id);
        box.disabled = !box.checked && selected.size >= 20;
        box.addEventListener("change", () => {
          toggleRun(run, box.checked);
          updateSelection();
        });
        return [box, node("div", {}, link(run.title, runHash(run.id)), node("div", { class: "run-id" }, run.id),
          run.index_issue ? node("span", { class: "error" }, "Index issue") : null),
          node("div", {}, badge(run.status), run.observation ? node("small", { class: "delta" },
            `Pane ${run.observation.state}`) : null), node("div", {}, run.group || run.source,
            node("div", { class: "tag-list" }, run.tags.map(tag => node("span", { class: "tag" }, tag)))),
          badge(run.report_state), node("time", { datetime: run.indexed_at, class: "numeric" }, date(run.indexed_at))];
      });
      content.replaceChildren(table(["Select", "Run", "Execution", "Group", "Report", "Last file change"], rows, "Runs"),
        pagination(data, offset => { runsOffset = offset; load(); }));
    } catch (error) {
      if (version === generation && id === request) problems.replaceChildren(notice(error.message, true));
    }
  }

  await load();
  if (version === generation) later(() => load(true), 8000);
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
      ["Source", run.source], ["Group", run.group], ["Tags", run.tags.join(", ")], ["Started", r.started_at ? date(r.started_at) : null],
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

const seriesColors = ["#17644f", "#47668a", "#ab5d41", "#8d6740", "#795599", "#487678"];
function canvasPlot(label, draw) {
  const canvas = node("canvas", { width: 640, height: 270, role: "img", "aria-label": label });
  const context = canvas.getContext("2d");
  if (context) {
    context.scale(2, 2);
    context.font = "10px system-ui";
    context.fillStyle = "#58655f";
    draw(context, 320, 135);
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
    canvasPlot(label, (ctx, width, height) => {
      const left = 14;
      const space = width - 28;
      const step = (height - 18) / items.length;
      const x = value => left + scalePosition(value, low, high) * space;
      const zero = x(0);
      ctx.fillStyle = "#b3c3b9";
      ctx.fillRect(zero, 0, 1, height - 16);
      items.forEach((item, index) => {
        ctx.fillStyle = seriesColors[index % seriesColors.length];
        ctx.fillRect(Math.min(x(item.value), zero), index * step + 3,
          Math.max(1, Math.abs(x(item.value) - zero)), Math.max(2, step * .65));
      });
      ctx.fillStyle = "#58655f";
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
  target.append(actions, node("div", { class: "split" }, article, recordMeta(run, report?.reproducibility)));
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
      (ctx, width, height) => {
        const x = index => 14 + (width - 28) * index / Math.max(1, series.length - 1);
        const y = value => 7 + (height - 24) * (1 - scalePosition(value, low, high));
        ctx.strokeStyle = seriesColors[0];
        ctx.fillStyle = seriesColors[0];
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
        ctx.fillStyle = "#58655f";
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
    node("p", { class: "meta" }, badge(run.status), " ", node("span", { class: "run-id" }, run.id)));
  if (run.index_issue) main.append(notice(run.index_issue, true));
  const nav = node("nav", { class: "tabs", "aria-label": "Run views" });
  for (const [key, label] of [["report", "Report"], ["artifacts", "Artifacts"], ["log", "Live log"]]) {
    const item = link(label, runHash(id, key));
    if (key === tab || key === "report" && tab === "final") item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  const area = node("div");
  main.append(nav, area);
  if (tab === "artifacts") await artifactsView(run, area, version, initialPath);
  else if (tab === "log") logView(run, area, version);
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
      const charts = compareCharts(data);
      output.replaceChildren(...issues, node("section", { class: "panel" },
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
    else if (page === "run" && id) await runView(decodeURIComponent(id), tab || "report",
      path ? decodeURIComponent(path) : null, version);
    else await explorer(version);
  } catch (error) {
    if (version === generation) main.append(notice(error.message, true), link("Return to runs", "#runs"));
  }
}

window.addEventListener("hashchange", route);
route();
