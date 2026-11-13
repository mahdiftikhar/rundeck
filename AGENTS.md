# Experiment workflow

Use the observatory CLI from this checkout for experiments whose directories are under a configured source. Run `uv run obs --help` for commands. The CLI emits JSON so scripts can consume its output directly.

## Register and track execution

Create the run directory before registration. Send a manifest with `uv run obs register SOURCE RELATIVE_DIRECTORY --input -`:

```json
{
  "schema_version": 1,
  "id": "policy-ablation-03",
  "title": "Policy ablation, seed 3",
  "status": "running",
  "group": "Policy ablations",
  "tags": ["evaluation", "seed-3"],
  "tmux_pane": "%17",
  "log": "run.log",
  "metrics": "metrics.jsonl",
  "reproducibility": {
    "command": "python train.py --seed 3",
    "git_commit": "a1b2c3d",
    "seed": 3,
    "started_at": "2026-01-01T12:00:00Z",
    "config": {"episodes": 100}
  }
}
```

Record actual values. Use `uv run obs status RUN running` to record a start timestamp when registration omitted it. Capture the launcher process's exit status. Record it with `uv run obs status RUN completed --exit-code 0` or `uv run obs status RUN failed --exit-code N`. Mark a known interruption with `uv run obs status RUN interrupted`. Treat the tmux observation as pane information only. Leave existing tmux sessions under their owners' control.

Use `uv run obs attach RUN --input -` for additional metadata, reproducibility fields, changed log or metric paths, tags, and labeled artifact paths. Paths are relative to the run directory. Keep raw artifacts in place.

## Record evidence and submit findings

Append one complete object per line to the attached metric stream. Use a stable name and unit for each metric. Omit `episode` for aggregates.

```jsonl
{"name":"score","value":8.25,"unit":"points","direction":"higher"}
{"name":"score","value":7.5,"unit":"points","direction":"higher","episode":"ep-001"}
```

Use `uv run obs index` to refresh discovery on demand. Inspect earlier runs with `obs list`, `obs inspect RUN` and `obs compare RUN BASELINE --baseline BASELINE`. Use `--episode ep-001` for an individual episode.

Generate a report with `uv run obs draft RUN`. Submit scientific interpretation with `uv run obs draft RUN --input -`. A patch may be as small as the one field you are updating:

```json
{
  "objective": "Measure the effect of the policy ablation.",
  "hypothesis": "Removing the component reduces task score.",
  "methodology": "Evaluate both policies on the same episode IDs with a fixed seed.",
  "baseline": "reference-run",
  "findings": [
    {
      "text": "The aggregate score was 8.25 points. Report the baseline difference only after verifying the comparison.",
      "evidence": [{"path": "metrics.jsonl", "detail": "Aggregate score record"}]
    }
  ],
  "limitations": ["One seed was evaluated."],
  "next_steps": ["Repeat the paired comparison across more seeds."]
}
```

Use evidence paths that actually exist. Explain uncertainties and failed evaluations in the report. Include the project section keys declared in settings when relevant. Submit structured scientific data and analysis only. The observatory generates the presentation, plots, and Markdown.

Run `uv run obs validate RUN` and fix any reported errors before `uv run obs finalize RUN`. Submit later observations with another draft patch. Finalize again when the updated report is ready. Use `uv run obs report-schema` to inspect the report contract.
