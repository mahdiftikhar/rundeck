"""Incremental SQLite catalog of run metadata and file identities."""

import json
import os
import sqlite3
import stat
import subprocess
from contextlib import contextmanager
from datetime import datetime, timezone
from fnmatch import fnmatchcase
from hashlib import sha256
from pathlib import Path

from .config import Settings
from .files import open_file, read_small, strict_json
from .models import Run, relative_path

INTERNAL_FILES = {"run.json", "report.json", "report.final.json"}


class Index:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, source TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
                    data TEXT NOT NULL, updated_ns INTEGER NOT NULL, issue TEXT
                );
                CREATE TABLE IF NOT EXISTS files (
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    path TEXT NOT NULL, size INTEGER NOT NULL, modified_ns INTEGER NOT NULL,
                    PRIMARY KEY(run_id, path)
                );
                CREATE INDEX IF NOT EXISTS runs_updated ON runs(updated_ns DESC, id);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.settings.database, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def scan(self):
        issues = []
        with self.connect() as db:
            # Serialize writers so two snapshots cannot publish in reverse order.
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TEMP TABLE seen_runs (root TEXT PRIMARY KEY)")
            db.execute("CREATE TEMP TABLE seen_files (path TEXT PRIMARY KEY)")
            for source in self.settings.sources:
                try:
                    with os.scandir(source.root):
                        pass
                    roots = sorted(source.root.glob(source.glob))
                except OSError as exc:
                    issues.append({"source": source.name, "error": str(exc)})
                    continue
                for root in roots:
                    try:
                        if not root.is_dir() or root.resolve() != root:
                            continue
                        db.execute(
                            "INSERT OR IGNORE INTO seen_runs VALUES (?)", (str(root),)
                        )
                        db.execute("SAVEPOINT scan_run")
                        try:
                            self._scan_run(db, source, root)
                        except BaseException:
                            db.execute("ROLLBACK TO scan_run")
                            raise
                        finally:
                            db.execute("RELEASE scan_run")
                    except (OSError, ValueError, RecursionError) as exc:
                        issues.append({"path": str(root), "error": str(exc)})
                        db.execute(
                            "UPDATE runs SET issue=? WHERE root=?",
                            (str(exc), str(root)),
                        )
                db.execute(
                    "DELETE FROM runs WHERE source=? AND root NOT IN (SELECT root FROM seen_runs)",
                    (source.name,),
                )
                db.execute("DELETE FROM seen_runs")
            names = [source.name for source in self.settings.sources]
            db.execute(
                "DELETE FROM runs WHERE source NOT IN (SELECT value FROM json_each(?))",
                (json.dumps(names),),
            )
            count = db.execute("SELECT count(*) FROM runs").fetchone()[0]
        return {"runs": count, "issues": issues}

    def _scan_run(self, db, source, root):
        run = self.read_run(source, root)
        if run is None:
            db.execute(
                "DELETE FROM runs WHERE source=? AND root=?", (source.name, str(root))
            )
            return
        existing = db.execute("SELECT root FROM runs WHERE id=?", (run.id,)).fetchone()
        if existing and existing["root"] != str(root):
            if Path(existing["root"]).exists():
                raise ValueError(f"duplicate run ID {run.id}")
            db.execute("DELETE FROM runs WHERE id=?", (run.id,))
        db.execute("DELETE FROM runs WHERE root=? AND id<>?", (str(root), run.id))
        payload = run.model_dump_json()
        db.execute(
            """
            INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET source=excluded.source, data=excluded.data, issue=NULL
            WHERE runs.data<>excluded.data OR runs.source<>excluded.source OR runs.issue IS NOT NULL
        """,
            (run.id, source.name, str(root), payload, root.stat().st_mtime_ns),
        )
        db.execute("DELETE FROM seen_files")
        newest = root.stat().st_mtime_ns
        errors = []

        def fail(exc):
            errors.append(exc)

        for folder, dirs, names, directory in os.fwalk(
            root, follow_symlinks=False, onerror=fail
        ):
            dirs[:] = [name for name in dirs if not name.startswith(".")]
            for name in names:
                if name.startswith("."):
                    continue
                path = Path(folder) / name
                try:
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    relative = relative_path(path.relative_to(root).as_posix())
                except (FileNotFoundError, ValueError):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                newest = max(newest, info.st_mtime_ns)
                db.execute("INSERT INTO seen_files VALUES (?)", (relative,))
                db.execute(
                    """
                    INSERT INTO files VALUES (?, ?, ?, ?)
                    ON CONFLICT(run_id,path) DO UPDATE SET size=excluded.size, modified_ns=excluded.modified_ns
                    WHERE files.size<>excluded.size OR files.modified_ns<>excluded.modified_ns
                """,
                    (run.id, relative, info.st_size, info.st_mtime_ns),
                )
        if errors:
            raise ValueError(str(errors[0]))
        db.execute(
            "DELETE FROM files WHERE run_id=? AND path NOT IN (SELECT path FROM seen_files)",
            (run.id,),
        )
        db.execute(
            "UPDATE runs SET updated_ns=? WHERE id=? AND updated_ns<>?",
            (newest, run.id, newest),
        )

    def read_run(self, source, root):
        try:
            manifest = strict_json(read_small(root, "run.json"))
            if not isinstance(manifest, dict):
                raise ValueError("run manifest must be a JSON object")
            return Run.model_validate_json(
                json.dumps({**source.manifest_defaults(), **manifest}, allow_nan=False)
            )
        except FileNotFoundError:
            pass
        if source.marker:
            try:
                with open_file(root, source.marker):
                    pass
            except FileNotFoundError:
                return None
        key = sha256(root.relative_to(source.root).as_posix().encode()).hexdigest()[:24]
        data = {
            **source.manifest_defaults(),
            "id": f"{source.name[:96]}-{key}",
            "title": root.name,
            "status": source.default_status,
        }
        if source.metadata:
            raw = strict_json(read_small(root, source.metadata))
            if not isinstance(raw, dict):
                raise ValueError("legacy metadata must be a JSON object")
            reproducibility = {}
            for field, path in source.metadata_fields.items():
                value = raw
                for key in path.split("."):
                    value = value.get(key) if isinstance(value, dict) else None
                if value is None:
                    continue
                if field in {"title", "status", "group", "tags", "tmux_pane"}:
                    data[field] = value
                else:
                    reproducibility[field] = value
            if "exit_code" in reproducibility:
                data["status"] = (
                    "completed" if reproducibility["exit_code"] == 0 else "failed"
                )
            data["reproducibility"] = reproducibility
        return Run.model_validate_json(json.dumps(data, allow_nan=False))

    def list_runs(
        self,
        *,
        query="",
        status=None,
        source=None,
        group=None,
        tag=None,
        limit=100,
        offset=0,
    ):
        clauses = []
        values = []
        for expression, value in (
            ("json_extract(data,'$.status')=?", status),
            ("source=?", source),
            ("json_extract(data,'$.group')=?", group),
            ("EXISTS (SELECT 1 FROM json_each(data,'$.tags') WHERE value=?)", tag),
        ):
            if value is not None:
                clauses.append(expression)
                values.append(value)
        if query:
            clauses.append("""instr(lower(id || ' ' || source || ' ' || json_extract(data,'$.title')
                || ' ' || coalesce(json_extract(data,'$.group'),'') || ' ' || json_extract(data,'$.tags')),lower(?))>0""")
            values.append(query)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connect() as db:
            total = db.execute("SELECT count(*) FROM runs" + where, values).fetchone()[
                0
            ]
            rows = db.execute(
                "SELECT * FROM runs"
                + where
                + " ORDER BY updated_ns DESC,id LIMIT ? OFFSET ?",
                (*values, limit, offset),
            )
            runs = [self.public(row) for row in rows]
            counts = {
                row[0]: row[1]
                for row in db.execute(
                    "SELECT json_extract(data,'$.status'), count(*) FROM runs"
                    + where
                    + " GROUP BY 1",
                    values,
                )
            }
        return {
            "runs": runs,
            "total": total,
            "counts": counts,
            "limit": limit,
            "offset": offset,
        }

    def public(self, row):
        run = json.loads(row["data"])
        return {
            **run,
            "source": row["source"],
            "indexed_at": datetime.fromtimestamp(
                row["updated_ns"] / 1e9, timezone.utc
            ).isoformat(),
            "index_issue": row["issue"],
        }

    def get(self, run_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(f"unknown run {run_id}")
        return row

    def artifacts(self, run_id, *, offset=0, limit=100, query=""):
        self.get(run_id)
        where = "run_id=? AND path NOT IN ('run.json','report.json','report.final.json') AND instr(lower(path),lower(?))>0"
        with self.connect() as db:
            total = db.execute(
                "SELECT count(*) FROM files WHERE " + where, (run_id, query)
            ).fetchone()[0]
            files = db.execute(
                "SELECT path,size,modified_ns FROM files WHERE "
                + where
                + " ORDER BY path LIMIT ? OFFSET ?",
                (run_id, query, limit, offset),
            )
            return {
                "files": [dict(row) for row in files],
                "total": total,
                "offset": offset,
                "limit": limit,
            }

    def file(self, run_id, relative, *, internal=False):
        root = Path(self.get(run_id)["root"])
        relative_path(relative)
        if not internal and relative in INTERNAL_FILES:
            raise KeyError("file is reserved for the observatory")
        with self.connect() as db:
            if not db.execute(
                "SELECT 1 FROM files WHERE run_id=? AND path=?", (run_id, relative)
            ).fetchone():
                raise KeyError(f"file is not indexed: {relative}")
        return root


def matching_trajectory(source, relative):
    return next(
        (spec for spec in source.trajectories if fnmatchcase(relative, spec.pattern)),
        None,
    )


def tmux_panes():
    """Read pane state from the current user's default tmux socket."""
    try:
        result = subprocess.run(
            [
                "tmux",
                "list-panes",
                "-a",
                "-F",
                "#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{session_name}\t#{pane_pid}",
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode:
        return (
            {}
            if any(
                message in result.stderr
                for message in ("no server running", "No such file")
            )
            else None
        )
    panes = {}
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) == 5:
            pane, dead, exit_code, session, pid = fields
            panes[pane] = {
                "state": "exited" if dead == "1" else "present",
                "session": session,
                "pane_exit_code": int(exit_code)
                if exit_code.lstrip("-").isdigit()
                else None,
                "pane_pid": int(pid) if pid.isdigit() else None,
            }
    return panes


def observation(run, panes):
    pane = run["tmux_pane"]
    if not pane:
        return None
    if panes is None:
        return {"state": "unavailable"}
    return panes.get(pane, {"state": "absent"})
