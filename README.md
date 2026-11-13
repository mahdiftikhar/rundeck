# Experiment Observatory

A self-hosted catalog for research runs, scientific reports, comparisons, logs, and artifacts. The service runs on the machine that holds the experiments. It keeps metadata in SQLite and reads evidence from the original run directories.

## Start on the experiment server

Install Python 3.11–3.14 and uv. From this checkout on Linux:

```sh
uv sync
cp observatory.example.toml observatory.toml
# Edit the source root and discovery rules for your actual run directories.
uv run obs index
./scripts/serve
```

In a terminal on the Mac, forward the loopback port through your SSH connection:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8765:127.0.0.1:8765 "$EXPERIMENT_SSH"
```

Set `EXPERIMENT_SSH` to your SSH alias or `user@host` first. Open [the dashboard](http://127.0.0.1:8765/) on the Mac. Use `./scripts/serve --port 8876` and adjust the forwarded ports if 8765 is in use. The web app has no accounts and relies on loopback access and the SSH connection. On a shared Linux server, local users who can reach the port can read the served experiments. Run the service under an account that can access the intended directories.

### Persistent Linux launch

Create your own user service at `~/.config/systemd/user/experiment-observatory.service` and substitute the two absolute paths:

```ini
[Unit]
Description=Experiment Observatory
After=network.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/experiment-dashboard
ExecStart=/absolute/path/to/uv run --no-sync obs serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload`, then `systemctl --user enable --now experiment-observatory`. Use `journalctl --user -u experiment-observatory -f` for service logs. If your host stops user services after logout, enable user lingering where permitted or use a dedicated, newly created tmux session for the dashboard.

## Discover existing outputs

Set one `[[sources]]` entry per project or discovery layout. `root` is a directory containing runs and `glob` selects run directories relative to that root, such as `batch-*/seed-*`. Use disjoint sources. Any matched directory with `run.json` uses that manifest. Legacy directories may be filtered by a run-relative `marker` and read using a small JSON `metadata` file. `metadata_fields` maps supported run fields or reproducibility fields to dotted keys in that file. Legacy IDs are derived from the source name and relative directory. Renaming a legacy directory changes that ID. An exit code takes precedence over a legacy status. Supply `default_status` if you know the convention for that source.

Set `metrics_format = "json-map"` and `metrics = "stats.json"` to read a legacy JSON object such as `{"score": 4.2, "loss": 0.1}`. Use `jsonl` for the standard metric record stream. The JSON-map adapter applies to the configured filename, and `metrics.jsonl` always uses the standard format. Set `log` to the existing log path. Run manifests inherit the source's group, metric path, and log path when those fields are omitted. Use a null manifest value to disable one of those defaults for a run. Run `obs index` after changing files, or let the service refresh on its configured interval. Restart the service after changing settings.

Declare metric labels, default units, direction, and chart inclusion with `metrics_style`. Set a default `baseline` and add named report `sections` as needed. Add trajectory adapters by glob with `[[sources.trajectories]]`. CSV adapters expect a header and one record per line. JSONL adapters map top-level keys. For other formats, install a trusted Python module in the app environment and set `format = "module:function"`. The function receives a binary stream and the configured column names, and yields lists or tuples of JSON-serializable scalar values in that order. Yield `None` for invalid records. Keep reads bounded inside the adapter. Format code is selected by service configuration.

## CLI contract

Run `uv run obs --help` or `uv run obs COMMAND --help`. Put `--config path/to/file.toml` before the command, or set `OBS_CONFIG`. Standard output contains compact JSON for machine commands. Validation and operational failures exit 1. Argument parsing errors exit 2 and print usage to stderr. The server and rsync diagnostics use stderr.

| Command | Operation |
| --- | --- |
| `index` | Discover runs and refresh artifact identities. Returns run count and indexing issues. |
| `list --query TEXT --status STATUS --source NAME --group GROUP --tag TAG` | Filter the catalog. Use `--limit` and `--offset` for paging. |
| `inspect RUN` | Get run metadata, reproducibility fields, and tmux observation. |
| `register SOURCE DIRECTORY --input FILE` | Create a manifest in a matched existing run directory. Identical registration is idempotent. |
| `status RUN STATUS --exit-code N` | Update the execution record. The exit code is optional. |
| `attach RUN --input FILE` | Patch manifest fields. Configuration and environment maps merge by key. Artifact references merge by path. |
| `compare RUN ... --baseline RUN --episode EPISODE` | Compare selected runs. Omit episode for aggregates. |
| `report-schema` | Emit the v1 report JSON Schema. |
| `draft RUN --input FILE` | Collect evidence and apply an optional scientific patch. |
| `validate RUN` | Check the current report against publication requirements. |
| `finalize RUN` | Validate and publish the current report snapshot. |
| `sync-plan RUN PATH ...` | Emit a plan for the requested indexed artifact paths. |
| `sync --input FILE --host SSH_ALIAS DESTINATION` | Pull files in a plan through SSH with rsync. |
| `serve --port PORT` | Start the loopback-only dashboard and automatic index refresh. |

Use `--input -` for stdin. See [AGENTS.md](AGENTS.md) for registration, metric, and report inputs. The dashboard's comparison view also exports the selected scope as CSV.

### Execution status and tmux

Statuses are `running`, `completed`, `failed`, and `interrupted`. Use actual exit evidence when available. Zero means completed and a nonzero code means failed. Use interrupted when you know the experiment stopped before completing and have no compatible process exit record. A Linux wrapper or agent that owns the experiment launch should record its exit code. The observatory only runs `tmux list-panes` on the service user's default socket. A live pane may contain a shell after the experiment ends, and a missing pane may reflect a restarted tmux server. Pane observations never change execution status.

### Reports and comparisons

`report.json` stores the current v1 report. `report.final.json` stores the last published version. The run page labels a changed draft and provides a link to the last finalized snapshot. A later successful finalization replaces that snapshot. Archive externally if you need all historical revisions.

Draft generation collects aggregate metrics, run metadata, up to 100 indexed artifact references, explicitly attached artifacts, and baseline aggregate values where configured. Each draft refreshes this collected evidence. It preserves existing interpretation unless replaced by a patch. Patch arrays replace their corresponding report arrays. Finalization requires a terminal status, objective, hypothesis, methodology, at least one finding with an indexed evidence path, limitations, next steps, valid references, and known custom section keys. Results can be empty for qualitative or failed runs. Use the same report page for Markdown export.

The comparison explorer reads current evidence. It uses the latest JSONL record for each metric and episode, with raw values taking precedence over a report fallback. Episode IDs are strings. Aggregate metrics use an absent or null episode. Missing means no value for a terminal run, incomplete means a run or record is unfinished, and invalid means the reader identified malformed evidence. Unattributable malformed rows show up in run-level issue counts. Deltas are candidate minus baseline and require matching units. Default baseline selection uses the first selected run's report or project configuration, then the first selected run itself. Reports render captured metric values from the saved draft or snapshot.

### Selective transfer

The browser downloads one file or a selected TAR bundle. Bundles stream from disk. For resumable, large transfers, install rsync 3.x on the Mac and Linux host and produce a plan on the server:

```sh
ssh "$EXPERIMENT_SSH" 'cd /absolute/path/to/experiment-dashboard && uv run obs sync-plan run-123 trace.csv videos/episode.mp4' > plan.json
uv run obs sync --input plan.json --host "$EXPERIMENT_SSH" ./selected-artifacts
```

If the Mac's default rsync is older, pass `--rsync /absolute/path/to/rsync`. Run the second command in a local checkout. Review the plan if it came from an external source.

## Architecture and operational limits

- FastAPI serves a same-origin HTML/CSS/JavaScript interface. The web API is read-only. The CLI is the mutation interface and uses an advisory lock plus atomic JSON replacement.
- SQLite in WAL mode is a rebuildable catalog. A refresh walks configured directories and updates changed rows by identity, size, and modification time. Per-run savepoints retain the last good index when a manifest is temporarily invalid. Removing the database rebuilds the catalog from the run directories.
- The service opens indexed regular files without following symlinks. Hidden paths and internal manifests are excluded from artifact browsing. Supported media uses single-range streaming. Other browser previews are structured text with bounded reads. Active content such as HTML and SVG is download-only.
- Log reads are bounded to 64 KiB per request. The viewer tracks file identity and offset and keeps a bounded scrollback. Rotation and shrinkage are detected. A truncate-and-refill between polls can evade size-based detection.
- Metric and trajectory streams use bounded lines and windows. Selecting a metric scope scans its source without retaining the full stream. Deep trajectory windows scan preceding records, so latency increases with offset. The metric catalog caps distinct names per scope and discovered episode IDs at 5,000 per run. Keep very wide or high-rate telemetry in separate artifacts.
- Run directories are expected to contain evidence intended for this dashboard. Regular files in those directories are visible over the local port. Mounts and hard links are managed by the host. The SQLite database and configuration belong outside discovered run directories.

## Development

```sh
uv sync
uv run pytest
node --check observatory/static/app.js
```

The tests create representative experiment directories and exercise CLI lifecycle, schema and references, legacy discovery, status and tmux observation, comparisons, report exports, log growth and rotation, artifact ranges and bundles, and rsync argument construction.
