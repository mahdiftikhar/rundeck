"""Adapters for streaming metric records and baseline comparisons."""

from .files import iter_lines, open_file, read_small, strict_json
from .models import Metric, Run

MAX_METRICS = 5000


def adapted_metric(metric, source):
    style = source.metrics_style.get(metric.name)
    if style is None:
        return metric
    updates = {}
    if style.unit is not None and not metric.unit:
        updates["unit"] = style.unit
    if style.direction is not None and metric.direction == "neutral":
        updates["direction"] = style.direction
    return metric.model_copy(update=updates)


def metric_records(index, row):
    run = Run.model_validate_json(row["data"])
    source = index.settings.source(row["source"])
    if not run.metrics:
        return
    try:
        root = index.file(run.id, run.metrics)
        if (
            source.metrics_format == "json-map"
            and run.metrics == source.metrics
            and run.metrics != "metrics.jsonl"
        ):
            data = strict_json(read_small(root, run.metrics))
            if not isinstance(data, dict):
                raise ValueError("expected a metric-name to value object")
            for name, value in data.items():
                yield parse_metric({"name": name, "value": value}, source)
        else:
            with open_file(root, run.metrics) as stream:
                for line, complete in iter_lines(stream):
                    if line is None:
                        yield None, "invalid", None, None
                    elif line.strip():
                        try:
                            data = strict_json(line)
                            yield parse_metric(data, source)
                        except (ValueError, RecursionError):
                            state = (
                                "incomplete"
                                if not complete
                                and run.status in {"running", "interrupted"}
                                else "invalid"
                            )
                            yield None, state, None, None
    except (FileNotFoundError, KeyError):
        return
    except (OSError, ValueError, RecursionError):
        yield None, "invalid", None, None


def parse_metric(data, source):
    try:
        metric = adapted_metric(Metric.model_validate(data), source)
        return metric, "valid", metric.name, metric.episode
    except ValueError:
        if isinstance(data, dict) and isinstance(data.get("name"), str):
            episode = data.get("episode")
            if episode is None or isinstance(episode, str):
                return None, "invalid", data["name"], episode
        return None, "invalid", None, None


def collect(index, row, *, episode=None, submitted=()):
    source = index.settings.source(row["source"])
    cells = {}
    issues = {"invalid": 0, "incomplete": 0}
    episodes = set()
    truncated = False

    def record(metric, state, name, scope):
        nonlocal truncated
        if scope is not None and len(episodes) < MAX_METRICS:
            episodes.add(scope)
        if name is None or scope != episode:
            return
        key = (name, scope)
        if len(cells) < MAX_METRICS or key in cells:
            cells[key] = (metric, state)
        else:
            truncated = True

    for metric in submitted:
        metric = adapted_metric(metric, source)
        record(metric, "valid", metric.name, metric.episode)
    for metric, state, name, scope in metric_records(index, row):
        if state != "valid":
            issues[state] += 1
        record(metric, state, name, scope)
    return cells, issues, sorted(episodes), truncated


def draft_metrics(index, row, *, submitted=()):
    cells, issues, _, truncated = collect(index, row, submitted=submitted)
    results = [metric for metric, state in cells.values() if state == "valid"]
    # The raw episode stream remains available for comparison and is never copied into the report automatically.
    return results, {**issues, "truncated": truncated}


def compare(index, run_ids, baseline_id=None, episode=None):
    from .reports import read_report

    ids = list(dict.fromkeys(run_ids))
    if not ids:
        raise ValueError("select at least one run")
    if baseline_id is None:
        first = index.get(ids[0])
        report, _ = read_report(first)
        source = index.settings.source(first["source"])
        baseline_id = (report.baseline if report else None) or source.baseline or ids[0]
    if baseline_id not in ids:
        ids.insert(0, baseline_id)
    if len(ids) > 20:
        raise ValueError("select up to 20 runs including the baseline")
    datasets = {}
    episodes = set()
    summaries = []
    for run_id in ids:
        row = index.get(run_id)
        run = index.public(row)
        source = index.settings.source(row["source"])
        report, _ = read_report(row)
        cells, issues, scopes, truncated = collect(
            index, row, episode=episode, submitted=report.results if report else ()
        )
        datasets[run_id] = (run, source, cells, issues)
        episodes.update(scopes)
        summaries.append(
            {
                "id": run_id,
                "title": run["title"],
                "status": run["status"],
                "issues": issues,
                "truncated": truncated,
            }
        )
    return {
        "runs": summaries,
        "baseline": baseline_id,
        "episode": episode,
        "episodes": sorted(episodes),
        "rows": comparison_rows(datasets, baseline_id, episode),
    }


def compare_report(index, row, report):
    source = index.settings.source(row["source"])
    run = index.public(row)
    try:
        baseline = index.public(index.get(report.baseline))
    except KeyError:
        baseline = {"id": report.baseline, "title": report.baseline, "status": None}
    datasets = {}
    for item, metrics in ((run, report.results), (baseline, report.baseline_results)):
        cells = {
            (metric.name, metric.episode): (metric, "valid")
            for metric in metrics
            if metric.episode is None
        }
        datasets[item["id"]] = (
            {**item, "status": None},
            source,
            cells,
            {"incomplete": 0},
        )
    summaries = [
        {key: item[key] for key in ("id", "title", "status")}
        for item in (run, baseline)
    ]
    return {
        "runs": summaries,
        "baseline": report.baseline,
        "episode": None,
        "episodes": [],
        "rows": comparison_rows(datasets, report.baseline, None, configured=False),
    }


def comparison_rows(datasets, baseline_id, episode, *, configured=True):
    names = {name for _, _, cells, _ in datasets.values() for name, _ in cells}
    if configured:
        names.update(
            name
            for _, source, _, _ in datasets.values()
            for name in source.metrics_style
        )
    rows = []
    for name in sorted(names):
        baseline = datasets[baseline_id][2].get((name, episode), (None, None))[0]
        style = datasets[baseline_id][1].metrics_style.get(name)
        values = {}
        for run_id, (run, source, cells, issues) in datasets.items():
            metric, state = cells.get((name, episode), (None, None))
            if state is None:
                state = (
                    "incomplete"
                    if run["status"] in {"running", "interrupted"}
                    or issues["incomplete"]
                    else "missing"
                )
            value = {"state": state}
            if metric is not None:
                value.update(
                    value=metric.value, unit=metric.unit, direction=metric.direction
                )
                if baseline is not None and metric.unit == baseline.unit:
                    delta = metric.value - baseline.value
                    if abs(delta) != float("inf"):
                        value["delta"] = delta
                elif baseline is not None:
                    value["comparison_issue"] = "unit mismatch"
            values[run_id] = value
            style = style or source.metrics_style.get(name)
        rows.append(
            {
                "metric": name,
                "label": style.label if style and style.label else name,
                "chart": style.chart if style else True,
                "values": values,
            }
        )
    return rows
