import io
import json
import shutil
import subprocess
import sys
import tarfile

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from observatory.config import load_settings
from observatory.index import Index, observation, tmux_panes
from observatory.metrics import compare
from observatory.models import Report
from observatory.web import make_app


@pytest.fixture
def workspace(tmp_path):
    config = tmp_path / "observatory.toml"
    config.write_text("""
scan_seconds = 1
[[sources]]
name = "robotics"
root = "runs"
group = "Bench"
marker = "metadata.json"
metadata = "metadata.json"
metrics = "stats.json"
metrics_format = "json-map"
metadata_fields = { title = "name", exit_code = "execution.code", config = "configuration" }
sections = { protocol = "Protocol notes" }
metrics_style.score = { direction = "higher", unit = "points", label = "Task score" }
metrics_style.loss = { direction = "lower", chart = false }
[[sources.trajectories]]
pattern = "trace.csv"
format = "csv"
columns = ["step", "x"]
""")
    roots = tmp_path / "runs"
    roots.mkdir()
    legacy = roots / "previous"
    legacy.mkdir()
    (legacy / "metadata.json").write_text(
        '{"name":"Prior policy","execution":{"code":0},"configuration":{"seed":1}}'
    )
    (legacy / "stats.json").write_text('{"score":7,"loss":2}')
    candidate = roots / "candidate"
    candidate.mkdir()
    (candidate / "metrics.jsonl").write_text(
        '{"name":"score","value":10}\n{"name":"loss","value":"bad"}\n'
        '{"name":"score","episode":"e1","value":12}\n{"name":"score","episode":"e2","value":13}\n{"name"'
    )
    (candidate / "trace.csv").write_text(
        "step,x,unused\n0,1,a\n1,2,b\ninvalid\n3,4,d\n"
    )
    (candidate / "run.log").write_text("starting\n")
    (candidate / "capture.mp4").write_bytes(bytes(range(256)))
    (candidate / "unsafe.html").write_text(
        "<script>window.artifactExecuted = true</script>"
    )
    (tmp_path / "secret.txt").write_text("outside run")
    (candidate / "external.txt").symlink_to(tmp_path / "secret.txt")
    (roots / "unrelated").mkdir()
    return config, candidate, legacy


def cli(config, *args, data=None, expected=0):
    result = subprocess.run(
        [sys.executable, "-m", "observatory.cli", "--config", str(config), *args],
        input=json.dumps(data) if data is not None else None,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == expected, (result.stdout, result.stderr)
    return json.loads(result.stdout)


def register(config):
    return cli(
        config,
        "register",
        "robotics",
        "candidate",
        "--input",
        "-",
        data={
            "id": "candidate",
            "title": "Candidate policy",
            "status": "running",
            "group": "Bench",
            "tags": ["trial"],
            "tmux_pane": "%42",
            "metrics": "metrics.jsonl",
            "log": "run.log",
            "reproducibility": {
                "git_commit": "abcd123",
                "command": "python train.py",
                "seed": 42,
            },
        },
    )


def science(baseline):
    return {
        "objective": "Improve task score.",
        "hypothesis": "The candidate improves the score.",
        "methodology": "Run a fixed evaluation.",
        "baseline": baseline,
        "findings": [
            {"text": "Candidate scored 10.", "evidence": [{"path": "metrics.jsonl"}]}
        ],
        "limitations": ["One seed."],
        "next_steps": ["Repeat with additional seeds."],
        "sections": {"protocol": "Same environment for both runs."},
    }


def test_cli_full_lifecycle_and_snapshot(workspace):
    config, root, legacy = workspace
    run = register(config)
    assert register(config)["id"] == run["id"]
    assert cli(config, "index") == {"runs": 2, "issues": []}
    previous = cli(config, "list", "--query", "prior")["runs"][0]
    assert cli(config, "list", "--group", "Bench", "--tag", "trial")["total"] == 1
    assert previous["status"] == "completed"
    assert previous["reproducibility"]["exit_code"] == 0
    assert previous["reproducibility"]["config"] == {"seed": 1}
    attached = cli(
        config,
        "attach",
        "candidate",
        "--input",
        "-",
        data={
            "reproducibility": {"config": {"steps": 100}},
            "artifacts": [{"path": "trace.csv", "label": "Agent path"}],
        },
    )
    assert attached["reproducibility"]["git_commit"] == "abcd123"
    assert attached["reproducibility"]["config"]["steps"] == 100
    assert cli(config, "draft", "candidate")["metric_issues"] == {
        "invalid": 1,
        "incomplete": 1,
        "truncated": False,
    }
    assert cli(config, "validate", "candidate", expected=1)["valid"] is False
    cli(config, "draft", "candidate", "--input", "-", data=science(previous["id"]))
    assert "terminal" in " ".join(
        cli(config, "finalize", "candidate", expected=1)["errors"]
    )
    assert cli(config, "status", "candidate", "failed", "--exit-code", "0", expected=1)[
        "error"
    ]
    completed = cli(config, "status", "candidate", "completed", "--exit-code", "0")
    assert completed["reproducibility"]["ended_at"]
    cli(config, "draft", "candidate")
    finalized = cli(config, "finalize", "candidate")
    assert finalized["state"] == "finalized"
    snapshot = (root / "report.final.json").read_bytes()
    assert (
        cli(config, "finalize", "candidate")["final_digest"]
        == finalized["final_digest"]
    )
    assert (root / "report.final.json").read_bytes() == snapshot

    (legacy / "stats.json").write_text('{"score":99}')
    draft = cli(
        config,
        "draft",
        "candidate",
        "--input",
        "-",
        data={"next_steps": ["Run a larger study."]},
    )
    assert draft["state"] == "draft" and draft["has_final"]
    assert draft["report"]["baseline_results"][0]["value"] == 99
    assert (root / "report.final.json").read_bytes() == snapshot
    with TestClient(
        make_app(load_settings(config)), base_url="http://localhost"
    ) as browser:
        old = browser.get("/api/runs/candidate/report?revision=final").json()
        rows = {item["metric"]: item for item in old["comparison"]["rows"]}
        assert rows["score"]["values"]["candidate"]["delta"] == 3
        exported = browser.get("/api/runs/candidate/report.md?revision=final")
        assert (
            "## Baseline comparison" in exported.text
            and "Repeat with additional seeds." in exported.text
        )
    shutil.rmtree(legacy)
    with TestClient(
        make_app(load_settings(config)), base_url="http://localhost"
    ) as browser:
        old = browser.get("/api/runs/candidate/report?revision=final").json()
        rows = {item["metric"]: item for item in old["comparison"]["rows"]}
        assert rows["score"]["values"]["candidate"]["delta"] == 3


def test_compare_scopes_and_invalid_states(workspace):
    config, _, _ = workspace
    register(config)
    index = Index(load_settings(config))
    previous = index.list_runs(query="prior")["runs"][0]["id"]
    result = compare(index, ["candidate", previous], previous)
    metrics = {row["metric"]: row for row in result["rows"]}
    assert metrics["score"]["values"]["candidate"] == {
        "state": "valid",
        "value": 10.0,
        "unit": "points",
        "direction": "higher",
        "delta": 3.0,
    }
    assert metrics["loss"]["values"]["candidate"] == {"state": "invalid"}
    assert result["episodes"] == ["e1", "e2"]
    episode = compare(index, ["candidate"], previous, "e1")
    metrics = {row["metric"]: row for row in episode["rows"]}
    assert metrics["score"]["values"]["candidate"]["value"] == 12
    assert metrics["score"]["values"][previous]["state"] == "missing"
    assert metrics["loss"]["values"]["candidate"]["state"] == "incomplete"
    with TestClient(
        make_app(load_settings(config)), base_url="http://localhost"
    ) as client:
        exported = client.get(
            "/api/compare.csv", params=[("run", "candidate"), ("baseline", previous)]
        )
        assert (
            f"score,Task score,,candidate,{previous},valid,10.0,points,higher,3.0,"
            in exported.text
        )


def test_index_handles_partial_writes_and_removals(workspace):
    config, root, _ = workspace
    register(config)
    index = Index(load_settings(config))
    manifest = root / "run.json"
    old = manifest.read_bytes()
    manifest.write_text('{"id":')
    assert index.scan()["issues"]
    assert index.public(index.get("candidate"))["status"] == "running"
    manifest.write_bytes(old)
    (root / "trace.csv").unlink()
    assert index.scan()["issues"] == []
    assert index.get("candidate")["issue"] is None
    assert "trace.csv" not in {
        file["path"] for file in index.artifacts("candidate")["files"]
    }
    assert index.scan() == {"runs": 2, "issues": []}


def test_report_schema_and_evidence_validation(workspace):
    config, _, _ = workspace
    register(config)
    with pytest.raises(ValidationError):
        Report.model_validate(
            {
                "schema_version": 1,
                "run_id": "x",
                "results": [{"name": "score", "value": "5"}],
            }
        )
    with pytest.raises(ValidationError):
        Report.model_validate({"schema_version": 1, "run_id": "x", "unexpected": True})
    with pytest.raises(ValidationError):
        Report.model_validate(
            {"schema_version": 1, "run_id": "x", "artifacts": [{"path": "../secret"}]}
        )
    with pytest.raises(ValidationError):
        Report.model_validate({"schema_version": True, "run_id": "x"})
    cli(config, "status", "candidate", "interrupted")
    patch = science(None)
    patch["findings"][0]["evidence"][0]["path"] = "external.txt"
    cli(config, "draft", "candidate", "--input", "-", data=patch)
    assert cli(config, "validate", "candidate", expected=1)["errors"] == [
        "unavailable artifact or evidence: external.txt",
    ]


def test_http_artifacts_logs_ranges_and_loopback(workspace):
    config, root, _ = workspace
    register(config)
    with TestClient(
        make_app(load_settings(config)), base_url="http://localhost"
    ) as client:
        assert client.get("/").status_code == 200
        assert "Experiment Observatory" in client.get("/").text
        assert client.get("/", headers={"host": "example.invalid"}).status_code == 400
        assert client.get("/static/app.js").status_code == 200
        assert client.get("/api/runs", params={"tag": "trial"}).json()["total"] == 1
        base = "/api/runs/candidate"
        assert (
            client.get(f"{base}/preview", params={"path": "trace.csv"}).json()["kind"]
            == "table"
        )
        window = client.get(
            f"{base}/trajectory", params={"path": "trace.csv", "offset": 1, "limit": 2}
        ).json()
        assert window == {
            "columns": ["step", "x"],
            "rows": [["1", "2"], None],
            "offset": 1,
            "invalid": 1,
            "has_more": True,
        }

        media = client.get(
            f"{base}/file",
            params={"path": "capture.mp4"},
            headers={"Range": "bytes=4-7"},
        )
        assert media.status_code == 206 and media.content == bytes(range(4, 8))
        assert media.headers["content-range"] == "bytes 4-7/256"
        assert client.get(
            f"{base}/file",
            params={"path": "capture.mp4"},
            headers={"Range": "bytes=-5"},
        ).content == bytes(range(251, 256))
        assert (
            client.get(
                f"{base}/file",
                params={"path": "capture.mp4"},
                headers={"Range": "bytes=300-"},
            ).status_code
            == 416
        )

        first = client.get(f"{base}/log").json()
        with (root / "run.log").open("a") as stream:
            stream.write("another line\n")
        args = {key: first[key] for key in ("cursor", "file_id")}
        assert client.get(f"{base}/log", params=args).json()["text"] == "another line\n"
        (root / "run.log").rename(root / "rotated.log")
        (root / "run.log").write_text("replacement\n")
        replaced = client.get(f"{base}/log", params=args).json()
        assert replaced["reset"] and replaced["text"] == "replacement\n"

        for path in ("../secret.txt", "external.txt", "run.json"):
            assert client.get(f"{base}/file", params={"path": path}).status_code in {
                400,
                404,
            }
        html = client.get(f"{base}/file", params={"path": "unsafe.html"})
        assert html.headers["content-type"] == "application/octet-stream"
        assert html.headers["content-disposition"].startswith("attachment")
        assert html.headers["x-content-type-options"] == "nosniff"
        response = client.get(
            f"{base}/bundle", params=[("path", "trace.csv"), ("path", "run.log")]
        )
        with tarfile.open(fileobj=io.BytesIO(response.content)) as bundle:
            assert bundle.getnames() == ["trace.csv", "run.log"]
            assert bundle.extractfile("run.log").read() == b"replacement\n"
        (root / "trace.csv").unlink()
        (root / "trace.csv").symlink_to(root.parent.parent / "secret.txt")
        assert (
            client.get(f"{base}/file", params={"path": "trace.csv"}).status_code == 400
        )


def test_tmux_is_observation_only(monkeypatch):
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(
            argv, 0, "%1\t0\t\tsession\t900\n%2\t1\t7\tsession\t901\n", ""
        )

    monkeypatch.setattr("observatory.index.subprocess.run", fake_run)
    panes = tmux_panes()
    assert calls[0][:3] == ["tmux", "list-panes", "-a"]
    assert (
        observation({"status": "running", "tmux_pane": "%1"}, panes)["state"]
        == "present"
    )
    assert (
        observation({"status": "running", "tmux_pane": "%2"}, panes)["pane_exit_code"]
        == 7
    )
    assert (
        observation({"status": "running", "tmux_pane": "%3"}, panes)["state"]
        == "absent"
    )
    assert (
        observation({"status": "running", "tmux_pane": "%3"}, None)["state"]
        == "unavailable"
    )


def test_sync_plan_and_rsync_arguments(workspace, monkeypatch, tmp_path):
    from argparse import Namespace

    from observatory.cli import sync

    config, root, _ = workspace
    register(config)
    plan = cli(config, "sync-plan", "candidate", "trace.csv", "run.log", "trace.csv")
    assert plan["root"] == str(root.resolve()) and plan["paths"] == [
        "trace.csv",
        "run.log",
    ]
    filename = tmp_path / "plan.json"
    filename.write_text(json.dumps(plan))

    def fake_rsync(argv, *, input, **kwargs):
        assert "--protect-args" in argv and "--from0" in argv
        assert input == b"trace.csv\0run.log\0"
        assert argv[-2] == f"research-alias:{root.resolve()}/"
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr("observatory.cli.subprocess.run", fake_rsync)
    assert (
        sync(
            Namespace(
                input=str(filename),
                host="research-alias",
                rsync="rsync",
                destination=tmp_path / "out",
            )
        )["files"]
        == 2
    )


def test_trajectory_jsonl_and_partial_utf8_log(workspace):
    from observatory.artifacts import log_chunk, trajectory_window
    from observatory.config import Trajectory

    _, root, _ = workspace
    root = root.resolve()
    spec = Trajectory(pattern="trace.jsonl", format="jsonl", columns=["step", "x"])
    (root / "trace.jsonl").write_text(
        '{"step":0,"x":2}\n{"step":1,"x":1e999}\n{"step":2,"x":4}'
    )
    data = trajectory_window(root, "trace.jsonl", spec, 0, 5)
    assert data["rows"] == [[0, 2], None, [2, 4]]
    (root / "run.log").write_bytes(b"one\xff\xe2")
    first = log_chunk(root, "run.log")
    assert first["text"] == "one\ufffd" and first["cursor"] == 4
    with (root / "run.log").open("ab") as stream:
        stream.write(b"\x82\xac\n")
    second = log_chunk(
        root, "run.log", cursor=first["cursor"], file_id=first["file_id"]
    )
    assert second["text"] == "€\n"


def test_project_defaults_and_baseline_draft(workspace):
    config, _, _ = workspace
    config.write_text(
        config.read_text().replace(
            'group = "Bench"', 'group = "Bench"\nbaseline = "candidate"'
        )
    )
    registered = cli(
        config,
        "register",
        "robotics",
        "candidate",
        "--input",
        "-",
        data={
            "id": "candidate",
            "title": "Reference",
            "status": "completed",
        },
    )
    assert (registered["group"], registered["log"], registered["metrics"]) == (
        "Bench",
        "run.log",
        "stats.json",
    )
    assert cli(config, "draft", "candidate")["report"]["baseline"] is None
