"""Drafts and approved snapshots share one versioned scientific contract."""

import json
import re
from hashlib import sha256
from pathlib import Path

from .files import atomic_json, open_file, read_small, strict_json
from .models import Report, Run

DRAFT = "report.json"
FINAL = "report.final.json"
REQUIRED_FOR_FINAL = (
    "objective",
    "hypothesis",
    "methodology",
    "findings",
    "limitations",
    "next_steps",
)


def canonical(report):
    return json.dumps(
        report.model_dump(mode="json"),
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    )


def report_digest(report):
    return sha256(canonical(report).encode()).hexdigest()


def missing_sections(report):
    return [
        f"{name} is required for finalization"
        for name in REQUIRED_FOR_FINAL
        if not getattr(report, name)
    ]


def read_report(row, revision="current"):
    root = Path(row["root"])
    reports = {}
    errors = {}
    for name in (DRAFT, FINAL):
        try:
            data = strict_json(read_small(root, name))
            report = Report.model_validate_json(json.dumps(data, allow_nan=False))
            if report.run_id != row["id"]:
                raise ValueError("report belongs to another run")
            if name == FINAL and (missing := missing_sections(report)):
                raise ValueError("; ".join(missing))
            reports[name] = report
        except FileNotFoundError:
            pass
        except (OSError, ValueError, RecursionError) as exc:
            errors[name] = str(exc)
    draft, final = reports.get(DRAFT), reports.get(FINAL)
    state = "missing"
    if errors:
        state = "invalid"
    elif draft:
        state = (
            "finalized"
            if final and report_digest(draft) == report_digest(final)
            else "draft"
        )
    elif final:
        state = "finalized"
    return (final if revision == "final" else draft or final), {
        "state": state,
        "has_final": final is not None,
        "errors": errors,
        "final_digest": report_digest(final) if final else None,
    }


def generate_draft(index, run_id, updates=None):
    from .metrics import draft_metrics

    row = index.get(run_id)
    root = Path(row["root"])
    run = Run.model_validate_json(row["data"])
    source = index.settings.source(row["source"])
    existing, state = read_report(row)
    if DRAFT in state["errors"]:
        raise ValueError(state["errors"][DRAFT])
    artifacts = index.artifacts(run_id, limit=100)
    results, issues = draft_metrics(index, row)
    draft = {
        "schema_version": 1,
        "run_id": run_id,
        "baseline": source.baseline if source.baseline != run_id else None,
        "reproducibility": run.reproducibility.model_dump(mode="json"),
        "results": [metric.model_dump(mode="json") for metric in results],
        "artifacts": [
            {"path": path, "label": label}
            for path, label in {
                **{item["path"]: None for item in artifacts["files"]},
                **{item.path: item.label for item in run.artifacts},
            }.items()
        ],
    }
    if existing:
        old = existing.model_dump(mode="json")
        merged = {(m["name"], m["episode"]): m for m in old["results"]}
        merged.update({(m["name"], m["episode"]): m for m in draft["results"]})
        draft.update(
            {
                key: old[key]
                for key in (
                    "baseline",
                    "objective",
                    "hypothesis",
                    "methodology",
                    "findings",
                    "limitations",
                    "next_steps",
                    "sections",
                )
            }
        )
        draft["results"] = list(merged.values())
        draft["artifacts"] = list(
            {
                item["path"]: item for item in [*draft["artifacts"], *old["artifacts"]]
            }.values()
        )
    if updates:
        if {"run_id", "schema_version", "baseline_results"} & updates.keys():
            raise ValueError(
                "run_id, schema_version and baseline_results are assigned by the observatory"
            )
        draft.update(updates)
    report = Report.model_validate_json(json.dumps(draft, allow_nan=False))
    if report.baseline:
        try:
            baseline_row = index.get(report.baseline)
        except KeyError:
            pass  # Validation reports an unavailable baseline while the report is still a draft.
        else:
            baseline_report, _ = read_report(baseline_row)
            baseline_results, _ = draft_metrics(
                index,
                baseline_row,
                submitted=baseline_report.results if baseline_report else (),
            )
            report = report.model_copy(update={"baseline_results": baseline_results})
    if (
        not existing
        or report_digest(existing) != report_digest(report)
        or not (root / DRAFT).exists()
    ):
        atomic_json(root / DRAFT, report.model_dump(mode="json"))
    return {
        "report": report.model_dump(mode="json"),
        "metric_issues": issues,
        **read_report(row)[1],
    }


def validate_report(index, run_id):
    row = index.get(run_id)
    run = index.public(row)
    source = index.settings.source(row["source"])
    report, state = read_report(row)
    errors = [state["errors"][DRAFT]] if DRAFT in state["errors"] else []
    if report is None:
        return report, list(state["errors"].values()) or ["create report.json first"]
    errors.extend(missing_sections(report))
    if run["status"] == "running":
        errors.append("record a terminal run status before finalization")
    if report.baseline:
        try:
            index.get(report.baseline)
        except KeyError:
            errors.append(f"unknown baseline {report.baseline}")
    unknown = report.sections.keys() - source.sections.keys()
    if unknown:
        errors.append("unknown project sections: " + ", ".join(sorted(unknown)))
    paths = {item.path for item in report.artifacts}
    paths.update(item.path for finding in report.findings for item in finding.evidence)
    for path in sorted(paths):
        try:
            root = index.file(run_id, path)
            with open_file(root, path):
                pass
        except (KeyError, OSError, ValueError):
            errors.append(f"unavailable artifact or evidence: {path}")
    return report, errors


def finalize(index, run_id):
    report, errors = validate_report(index, run_id)
    if errors:
        return {"valid": False, "errors": errors}
    row = index.get(run_id)
    root = Path(row["root"])
    if read_report(row)[1]["final_digest"] != report_digest(report):
        atomic_json(root / FINAL, report.model_dump(mode="json"))
    return {"valid": True, **read_report(row)[1]}


def markdown(run, report, state, sections, comparison=None):
    def escaped(value):
        value = (
            str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        value = "".join(
            "\\" + char if char in "\\`*_{}[]()#+-!|~" else char for char in value
        )
        return re.sub(r"(?m)^(\s*\d+)\.(?=\s)", r"\1\\.", value)

    def table_cell(value):
        return escaped(value).replace("\n", " ").replace("\r", " ")

    lines = [
        f"# {table_cell(run['title'])}",
        "",
        f"Run **{escaped(run['id'])}** · {state} · {run['status']}",
        "",
    ]
    for field in ("objective", "hypothesis", "methodology"):
        if value := getattr(report, field):
            lines.extend((f"## {field.title()}", "", escaped(value), ""))
    lines.extend(
        (
            "## Reproducibility",
            "",
            "````json",
            json.dumps(
                report.reproducibility.model_dump(mode="json", exclude_none=True),
                indent=2,
                sort_keys=True,
                ensure_ascii=False,
            ),
            "````",
            "",
        )
    )
    if report.results:
        lines.extend(
            (
                "## Results",
                "",
                "| Metric | Episode | Value | Unit | Direction |",
                "| --- | --- | ---: | --- | --- |",
            )
        )
        for metric in report.results:
            fields = (
                metric.name,
                metric.episode or "Aggregate",
                metric.value,
                metric.unit,
                metric.direction,
            )
            lines.append("| " + " | ".join(map(table_cell, fields)) + " |")
        lines.append("")
    if comparison and comparison.get("rows"):
        baseline = comparison["baseline"]
        lines.extend(
            (
                f"## Baseline comparison · {escaped(baseline)}",
                "",
                "| Metric | Run | Baseline | Difference |",
                "| --- | ---: | ---: | ---: |",
            )
        )
        for row in comparison["rows"]:
            current = row["values"][run["id"]]
            reference = row["values"][baseline]

            def display(cell):
                return (
                    f"{cell['value']} {cell['unit']}".strip()
                    if "value" in cell
                    else cell["state"]
                )

            values = (
                row["label"],
                display(current),
                display(reference),
                current.get("delta", current.get("comparison_issue", "—")),
            )
            lines.append("| " + " | ".join(map(table_cell, values)) + " |")
        lines.append("")
    if report.findings:
        lines.extend(("## Findings", ""))
        for finding in report.findings:
            lines.append(f"- {escaped(finding.text)}")
            for evidence in finding.evidence:
                detail = f" · {escaped(evidence.detail)}" if evidence.detail else ""
                lines.append(f"  - {escaped(evidence.path)}{detail}")
        lines.append("")
    for title, values in (
        ("Limitations", report.limitations),
        ("Next steps", report.next_steps),
        (
            "Artifacts",
            [
                item.path if not item.label else f"{item.label} · {item.path}"
                for item in report.artifacts
            ],
        ),
    ):
        if values:
            lines.extend(
                (f"## {title}", "", *(f"- {escaped(item)}" for item in values), "")
            )
    for key, value in sorted(report.sections.items()):
        lines.extend(
            (f"## {table_cell(sections.get(key, key))}", "", escaped(value), "")
        )
    return "\n".join(lines)
