"""Local, read-only HTTP interface. Changes are made through the CLI."""

import asyncio
import csv
import io
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    StreamingResponse,
)
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles

from .artifacts import (
    MEDIA,
    byte_range,
    identity,
    log_chunk,
    preview,
    stream_bytes,
    tar_stream,
    trajectory_window,
)
from .config import load_settings
from .episodes import catalog as episode_catalog
from .episodes import inspect_episode
from .files import open_file
from .index import Index, matching_trajectory, observation, tmux_panes
from .metrics import compare, compare_report, draft_metrics
from .reports import markdown, read_report

STATIC = Path(__file__).parent / "static"
LOGGER = logging.getLogger(__name__)


def make_app(settings=None, refresh_settings=None):
    settings = settings or load_settings()
    index = Index(settings)
    scan_state = {"runs": 0, "issues": []}

    async def scan():
        try:
            if refresh_settings:
                fresh = await run_in_threadpool(refresh_settings)
                settings.sources = fresh.sources
            scan_state.update(await run_in_threadpool(index.scan))
        except Exception:
            LOGGER.exception("Index refresh failed")
            scan_state["issues"] = [
                {"error": "Index refresh failed. See the service logs."}
            ]

    async def refresh():
        while True:
            await asyncio.sleep(settings.scan_seconds)
            await scan()

    @asynccontextmanager
    async def lifespan(_app):
        await scan()
        task = asyncio.create_task(refresh())
        try:
            yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="Experiment Observatory", docs_url=None, redoc_url=None, lifespan=lifespan
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self'; media-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(KeyError)
    @app.exception_handler(FileNotFoundError)
    @app.exception_handler(NotADirectoryError)
    @app.exception_handler(PermissionError)
    async def not_found(_request, exc):
        return JSONResponse(
            {
                "detail": exc.args[0]
                if isinstance(exc, KeyError)
                else "File is unavailable"
            },
            status_code=404,
        )

    @app.exception_handler(ValueError)
    @app.exception_handler(OSError)
    async def invalid(_request, exc):
        return JSONResponse(
            {
                "detail": str(exc)
                if isinstance(exc, ValueError)
                else "File is unavailable"
            },
            status_code=400,
        )

    @app.get("/")
    def home():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/runs")
    def runs(
        q: str = "",
        status: str | None = None,
        source: str | None = None,
        group: str | None = None,
        tag: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
    ):
        page = index.list_runs(
            query=q,
            status=status,
            source=source,
            group=group,
            tag=tag,
            limit=limit,
            offset=offset,
        )
        panes = (
            tmux_panes()
            if any(
                run["tmux_pane"] and run["status"] == "running" for run in page["runs"]
            )
            else None
        )
        for run in page["runs"]:
            _, state = read_report(index.get(run["id"]))
            run["report_state"] = state["state"]
            run["observation"] = (
                observation(run, panes) if run["status"] == "running" else None
            )
        return {
            **page,
            "sources": [item.name for item in settings.sources],
            "scan": scan_state,
        }

    @app.get("/api/compare")
    def comparison(
        run: list[str] = Query(..., min_length=1, max_length=20),
        baseline: str | None = None,
        episode: str | None = None,
    ):
        return compare(index, run, baseline, episode)

    @app.get("/api/compare.csv")
    def comparison_csv(
        run: list[str] = Query(..., min_length=1, max_length=20),
        baseline: str | None = None,
        episode: str | None = None,
    ):
        data = compare(index, run, baseline, episode)

        def spreadsheet_text(value):
            return (
                "'" + value
                if value.lstrip().startswith(("=", "+", "-", "@"))
                or value.startswith(("\t", "\r", "\n"))
                else value
            )

        def records():
            yield [
                "metric",
                "label",
                "episode",
                "run_id",
                "baseline",
                "state",
                "value",
                "unit",
                "direction",
                "delta",
                "issue",
            ]
            for row in data["rows"]:
                for run_id, cell in row["values"].items():
                    yield [
                        spreadsheet_text(row["metric"]),
                        spreadsheet_text(row["label"]),
                        spreadsheet_text(episode or ""),
                        run_id,
                        data["baseline"],
                        cell["state"],
                        cell.get("value"),
                        spreadsheet_text(cell.get("unit", "")),
                        cell.get("direction"),
                        cell.get("delta"),
                        cell.get("comparison_issue"),
                    ]

        def stream():
            buffer = io.StringIO()
            writer = csv.writer(buffer)
            for row in records():
                writer.writerow(row)
                yield buffer.getvalue()
                buffer.seek(0)
                buffer.truncate()

        return StreamingResponse(
            stream(),
            media_type="text/csv",
            headers={
                "Content-Disposition": 'attachment; filename="experiment-comparison.csv"'
            },
        )

    @app.get("/api/runs/{run_id}")
    def run_details(run_id: str):
        run = index.public(index.get(run_id))
        run["observation"] = observation(
            run, tmux_panes() if run["tmux_pane"] else None
        )
        return run

    @app.get("/api/runs/{run_id}/episodes")
    def episodes(run_id: str):
        return episode_catalog(index, run_id)

    @app.get("/api/runs/{run_id}/episodes/{episode_id}")
    def episode(run_id: str, episode_id: str):
        return inspect_episode(index, run_id, episode_id)

    @app.get("/api/runs/{run_id}/report")
    def report_details(run_id: str, revision: Literal["current", "final"] = "current"):
        row = index.get(run_id)
        report, state = read_report(row, revision)
        source = settings.source(row["source"])
        results, issues = draft_metrics(index, row) if report is None else ([], {})
        comparison = (
            compare_report(index, row, report) if report and report.baseline else None
        )
        return {
            **state,
            "report": report,
            "sections": source.sections,
            "comparison": comparison,
            "available_results": results,
            "metric_issues": issues,
            "metric_labels": {
                name: style.label for name, style in source.metrics_style.items()
            },
            "charts": {
                name: style.chart for name, style in source.metrics_style.items()
            },
        }

    @app.get("/api/runs/{run_id}/report.md")
    def export(run_id: str, revision: Literal["current", "final"] = "current"):
        row = index.get(run_id)
        details = report_details(run_id, revision)
        report = details["report"]
        if report is None:
            raise HTTPException(404, "Report unavailable")
        return PlainTextResponse(
            markdown(
                index.public(row),
                report,
                "finalized" if revision == "final" else details["state"],
                details["sections"],
                details["comparison"],
            ),
            media_type="text/markdown",
            headers={
                "Content-Disposition": f'attachment; filename="{run_id}-report.md"'
            },
        )

    @app.get("/api/runs/{run_id}/artifacts")
    def artifacts(
        run_id: str,
        q: str = "",
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
    ):
        row = index.get(run_id)
        page = index.artifacts(run_id, offset=offset, limit=limit, query=q)
        source = settings.source(row["source"])
        for file in page["files"]:
            file["trajectory"] = matching_trajectory(source, file["path"]) is not None
        return page

    @app.get("/api/runs/{run_id}/preview")
    def preview_artifact(run_id: str, path: str):
        root = index.file(run_id, path)
        with open_file(root, path):
            pass
        return preview(root, path)

    @app.get("/api/runs/{run_id}/trajectory")
    def trajectory(
        run_id: str,
        path: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=1000),
    ):
        row = index.get(run_id)
        spec = matching_trajectory(settings.source(row["source"]), path)
        if not spec:
            raise KeyError("no trajectory parser matches this artifact")
        return trajectory_window(index.file(run_id, path), path, spec, offset, limit)

    @app.get("/api/runs/{run_id}/log")
    def log(
        run_id: str, cursor: int | None = Query(None, ge=0), file_id: str | None = None
    ):
        path = index.public(index.get(run_id))["log"]
        if not path:
            raise KeyError("no live log attached")
        return log_chunk(index.file(run_id, path), path, cursor=cursor, file_id=file_id)

    @app.get("/api/runs/{run_id}/file")
    def file(run_id: str, path: str, request: Request, download: bool = False):
        root = index.file(run_id, path)
        media = MEDIA.get(Path(path).suffix.lower())
        context = open_file(root, path)
        stream = context.__enter__()
        try:
            size = identity(stream)[0].st_size
            try:
                start, stop, partial = byte_range(request.headers.get("range"), size)
            except ValueError as exc:
                raise HTTPException(
                    416, str(exc), headers={"Content-Range": f"bytes */{size}"}
                ) from exc
            stream.seek(start)
            headers = {"Accept-Ranges": "bytes", "Content-Length": str(stop - start)}
            if download or not media:
                headers["Content-Disposition"] = (
                    "attachment; filename*=UTF-8''" + quote(Path(path).name, safe="")
                )
            if partial:
                headers["Content-Range"] = f"bytes {start}-{stop - 1}/{size}"
            return StreamingResponse(
                stream_bytes(stream, stop - start),
                status_code=206 if partial else 200,
                media_type=media
                if media and not download
                else "application/octet-stream",
                headers=headers,
                background=BackgroundTask(context.__exit__, None, None, None),
            )
        except BaseException:
            context.__exit__(None, None, None)
            raise

    @app.get("/api/runs/{run_id}/bundle")
    def bundle(run_id: str, path: list[str] = Query(..., min_length=1, max_length=100)):
        files = []
        for name in dict.fromkeys(path):
            root = index.file(run_id, name)
            with open_file(root, name):
                pass
            files.append((root, name))
        return StreamingResponse(
            tar_stream(files),
            media_type="application/x-tar",
            headers={
                "Content-Disposition": f'attachment; filename="{run_id}-artifacts.tar"'
            },
        )

    return app
