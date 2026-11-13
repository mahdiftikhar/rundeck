"""Machine-readable observatory entry point."""

import fcntl
import json
import re
import subprocess
import sys
from argparse import ArgumentParser, ArgumentTypeError
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import load_settings
from .files import MAX_JSON, atomic_json, open_file, strict_json
from .index import Index, observation, tmux_panes
from .metrics import compare
from .models import Report, Run, relative_path
from .reports import finalize, generate_draft, validate_report

STATUSES = ("running", "completed", "failed", "interrupted")


def bounded(minimum, maximum):
    def convert(value):
        number = int(value)
        if not minimum <= number <= maximum:
            raise ArgumentTypeError(f"expected {minimum}–{maximum}")
        return number

    return convert


def parser():
    cli = ArgumentParser(
        prog="obs",
        description="Catalog experiment evidence and publish structured scientific reports.",
    )
    cli.add_argument(
        "--config",
        type=Path,
        help="Settings TOML (default OBS_CONFIG or observatory.toml)",
    )
    commands = cli.add_subparsers(dest="command", required=True)

    def command(name, help_text, *, run=False, input_file=False):
        sub = commands.add_parser(name, help=help_text, description=help_text)
        if run:
            sub.add_argument("run")
        if input_file:
            sub.add_argument("--input", required=True, help="JSON file or - for stdin")
        return sub

    command("index", "Refresh the filesystem catalog")
    listing = command("list", "Query indexed runs")
    for key in ("query", "source", "group", "tag"):
        listing.add_argument(f"--{key}")
    listing.add_argument("--status", choices=STATUSES)
    listing.add_argument("--limit", type=bounded(1, 200), default=50)
    listing.add_argument("--offset", type=bounded(0, 2**31 - 1), default=0)
    command("inspect", "Read run metadata and tmux observation", run=True)
    registration = command(
        "register",
        "Write a run manifest in a configured discovery directory",
        input_file=True,
    )
    registration.add_argument("source")
    registration.add_argument(
        "directory", help="Path relative to the configured source root"
    )
    status = command(
        "status", "Record execution status and optional exit code", run=True
    )
    status.add_argument("status", choices=STATUSES)
    status.add_argument("--exit-code", type=int)
    command(
        "attach",
        "Merge run metadata, config, metric/log paths and labeled artifacts",
        run=True,
        input_file=True,
    )
    comparison = command("compare", "Compare aggregate or episode metrics")
    comparison.add_argument("runs", nargs="+")
    comparison.add_argument("--baseline")
    comparison.add_argument("--episode")
    command("report-schema", "Emit the v1 report JSON Schema")
    draft = command(
        "draft",
        "Collect evidence and optionally apply a scientific report patch",
        run=True,
    )
    draft.add_argument("--input", help="JSON patch file or - for stdin")
    command("validate", "Check the report against finalization rules", run=True)
    command("finalize", "Publish the validated report snapshot", run=True)
    plan = command("sync-plan", "Emit a plan for selected indexed artifacts", run=True)
    plan.add_argument("paths", nargs="+")
    sync = command(
        "sync",
        "Pull artifacts from an explicit SSH destination using rsync",
        input_file=True,
    )
    sync.add_argument("--host", required=True, help="SSH host alias or user@host")
    sync.add_argument("--rsync", default="rsync", help="Path to rsync 3.x")
    sync.add_argument("destination", type=Path)
    serve = command("serve", "Serve the dashboard on local loopback")
    serve.add_argument("--port", type=bounded(1, 65535), default=8765)
    return cli


def input_json(filename):
    if filename == "-":
        data = sys.stdin.buffer.read(MAX_JSON + 1)
    else:
        with open(filename, "rb") as stream:
            data = stream.read(MAX_JSON + 1)
    if len(data) > MAX_JSON:
        raise ValueError("input JSON exceeds the size limit")
    value = strict_json(data)
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


@contextmanager
def mutation(settings):
    with (settings.database.parent / ".observatory.lock").open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def normalize_run(data):
    return Run.model_validate_json(json.dumps(data, allow_nan=False))


def register(index, args):
    try:
        source = index.settings.source(args.source)
    except StopIteration as exc:
        raise ValueError(f"unknown source {args.source}") from exc
    root = source.root / relative_path(args.directory)
    if (
        not root.is_dir()
        or root.resolve() != root
        or root not in source.root.glob(source.glob)
    ):
        raise ValueError("directory must exist and match the source discovery glob")
    data = input_json(args.input)
    run = normalize_run({**source.manifest_defaults(), **data})
    path = root / "run.json"
    if path.exists():
        previous = index.read_run(source, root)
        if previous != run:
            raise ValueError(
                "manifest already exists; use status or attach to update it"
            )
    else:
        with index.connect() as db:
            conflict = db.execute(
                "SELECT root FROM runs WHERE id=?", (run.id,)
            ).fetchone()
        if conflict and conflict["root"] != str(root):
            raise ValueError(f"run ID already registered: {run.id}")
        atomic_json(path, run.model_dump(mode="json"))
    index.scan()
    return index.public(index.get(run.id))


def update_run(index, args):
    row = index.get(args.run)
    root = Path(row["root"])
    source = index.settings.source(row["source"])
    run = index.read_run(source, root)
    if run is None:
        raise ValueError("the run directory no longer has its discovery marker")
    current = run.model_dump(mode="json")
    if current["id"] != args.run:
        raise ValueError(
            "the run manifest identity changed; refresh the index and retry"
        )
    if args.command == "status":
        now = datetime.now(timezone.utc).isoformat()
        reproduction = current["reproducibility"]
        if args.status == "running":
            if current["status"] != "running" or not reproduction["started_at"]:
                reproduction["started_at"] = now
            reproduction.update(ended_at=None, exit_code=args.exit_code)
        elif (
            current["status"] != args.status
            or args.exit_code is not None
            or not reproduction["ended_at"]
        ):
            reproduction["ended_at"] = reproduction["ended_at"] or now
            if args.exit_code is not None or current["status"] != args.status:
                reproduction["exit_code"] = args.exit_code
        current["status"] = args.status
    else:
        patch = input_json(args.input)
        if {"id", "schema_version", "status"} & patch.keys():
            raise ValueError(
                "use status for execution state; run identity is immutable"
            )
        if "reproducibility" in patch:
            incoming = patch["reproducibility"]
            if not isinstance(incoming, dict):
                raise ValueError("reproducibility must be an object")
            for key in ("config", "environment"):
                if isinstance(incoming.get(key), dict):
                    incoming[key] = {**current["reproducibility"][key], **incoming[key]}
            patch["reproducibility"] = {**current["reproducibility"], **incoming}
        if "artifacts" in patch:
            items = patch["artifacts"]
            if not isinstance(items, list) or any(
                not isinstance(item, dict) or not isinstance(item.get("path"), str)
                for item in items
            ):
                raise ValueError("artifacts must be a list of objects with a path")
            patch["artifacts"] = list(
                {
                    item["path"]: item for item in [*current["artifacts"], *items]
                }.values()
            )
        current.update(patch)
    run = normalize_run(current)
    atomic_json(root / "run.json", run.model_dump(mode="json"))
    index.scan()
    return index.public(index.get(args.run))


def sync_plan(index, args):
    paths = list(dict.fromkeys(args.paths))
    for path in paths:
        root = index.file(args.run, path)
        with open_file(root, path):
            pass
    return {"schema_version": 1, "run_id": args.run, "root": str(root), "paths": paths}


def sync(args):
    plan = input_json(args.input)
    if type(plan.get("schema_version")) is not int or plan["schema_version"] != 1:
        raise ValueError("expected a v1 sync plan")
    root = plan.get("root")
    if (
        not isinstance(root, str)
        or not root.startswith("/")
        or Path(root).as_posix() != root
        or "\x00" in root
        or ".." in Path(root).parts
    ):
        raise ValueError("invalid remote run root")
    paths = plan.get("paths")
    if (
        not isinstance(paths, list)
        or not paths
        or any(not isinstance(path, str) for path in paths)
    ):
        raise ValueError("invalid artifact paths")
    if not re.fullmatch(
        r"(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*", args.host
    ):
        raise ValueError("expected an SSH hostname, alias or user@host")
    data = b"".join(relative_path(path).encode() + b"\x00" for path in paths)
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            args.rsync,
            "-rt",
            "--partial",
            "--protect-args",
            "--from0",
            "--files-from=-",
            "-e",
            "ssh",
            "--",
            f"{args.host}:{root.rstrip('/')}/",
            str(destination),
        ],
        input=data,
        stdout=sys.stderr,
        check=False,
    )
    if result.returncode:
        raise ValueError(f"rsync exited with code {result.returncode}")
    return {"files": len(paths), "destination": str(destination)}


def execute(args):
    if args.command == "report-schema":
        return Report.model_json_schema()
    if args.command == "sync":
        return sync(args)
    settings = load_settings(args.config)
    if args.command == "serve":
        import uvicorn

        from .web import make_app

        uvicorn.run(
            make_app(settings), host="127.0.0.1", port=args.port, proxy_headers=False
        )
        return None
    index = Index(settings)
    if args.command == "index":
        return index.scan()
    if args.command == "list":
        return index.list_runs(
            query=args.query or "",
            status=args.status,
            source=args.source,
            group=args.group,
            tag=args.tag,
            limit=args.limit,
            offset=args.offset,
        )
    if args.command == "inspect":
        run = index.public(index.get(args.run))
        return {
            **run,
            "observation": observation(run, tmux_panes() if run["tmux_pane"] else None),
        }
    if args.command == "compare":
        return compare(index, args.runs, args.baseline, args.episode)
    if args.command == "sync-plan":
        return sync_plan(index, args)
    with mutation(settings):
        index.scan()
        if args.command == "register":
            return register(index, args)
        if args.command in {"status", "attach"}:
            return update_run(index, args)
        if args.command == "draft":
            return generate_draft(
                index, args.run, input_json(args.input) if args.input else None
            )
        if args.command == "validate":
            _, errors = validate_report(index, args.run)
            return {"valid": not errors, "errors": errors}
        if args.command == "finalize":
            return finalize(index, args.run)
    raise ValueError("unknown command")


def main():
    args = parser().parse_args()
    try:
        result = execute(args)
        if result is not None:
            print(json.dumps(result, allow_nan=False, separators=(",", ":")))
        return 1 if isinstance(result, dict) and result.get("valid") is False else 0
    except (OSError, ValueError, KeyError, RecursionError) as exc:
        print(json.dumps({"error": str(exc)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
