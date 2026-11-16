"""Read indexed episode evidence for the native inspector, without modifying it."""

import ast
import io
import math
import re
import struct
import zipfile
from pathlib import PurePosixPath

from .files import read_small, strict_json
from .prompts import planning_discussion_context

LIMIT = 32 * 1024 * 1024
CAPTURE_HASH = "6a421781f7ff14cb09bfeb704c9638bfb63fa0ecfada727047e70f1c5d30e42e"


def catalog(index, run_id):
    run = index.public(index.get(run_id))
    return {"episodes": run["reproducibility"]["config"].get("episode_index", [])}


def read(index, run_id, path):
    return read_small(index.file(run_id, path), path, limit=LIMIT)


def npy(data):
    """Decode only bounded, non-object NumPy arrays used by saved floorplans."""
    stream = io.BytesIO(data)
    if stream.read(6) != b"\x93NUMPY":
        raise ValueError("Invalid floorplan array")
    version = stream.read(2)
    size = 2 if version[0] == 1 else 4
    length = int.from_bytes(stream.read(size), "little")
    if length > 10000:
        raise ValueError("Floorplan header is too large")
    header = ast.literal_eval(stream.read(length).decode("latin1"))
    shape = header["shape"]
    count = math.prod(shape)
    dtype = header["descr"]
    formats = {"|b1": "?", "|u1": "B", "<f4": "f", "<f8": "d"}
    if dtype not in formats or count > 4_000_000 or count < 0:
        raise ValueError("Unsupported floorplan array")
    fmt = "<" + str(count) + formats[dtype]
    raw = stream.read(struct.calcsize(fmt))
    values = struct.unpack(fmt, raw)
    if header["fortran_order"]:
        if len(shape) != 2:
            raise ValueError("Unsupported column-major floorplan shape")
        rows, columns = shape
        values = tuple(
            values[column * rows + row] for row in range(rows) for column in range(columns)
        )
    return shape, values


def floorplan(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        arrays = {}
        for name in ("nav", "lower", "mpp"):
            info = archive.getinfo(name + ".npy")
            if info.file_size > LIMIT:
                raise ValueError("Floorplan is too large")
            arrays[name] = npy(archive.read(info))
    (height, width), cells = arrays["nav"]
    lower = arrays["lower"][1]
    mpp = arrays["mpp"][1][0]
    if not math.isfinite(mpp) or mpp <= 0:
        raise ValueError("Invalid map scale")
    spans = []
    for row in range(height):
        start = None
        for column in range(width + 1):
            active = column < width and cells[row * width + column]
            if active and start is None:
                start = column
            elif not active and start is not None:
                spans.append([start, row, column - start])
                start = None
    outline = []
    for row in range(height):
        for column in range(width):
            if not cells[row * width + column]:
                continue
            if row == 0 or not cells[(row - 1) * width + column]:
                outline.append([column, row, column + 1, row])
            if row == height - 1 or not cells[(row + 1) * width + column]:
                outline.append([column, row + 1, column + 1, row + 1])
            if column == 0 or not cells[row * width + column - 1]:
                outline.append([column, row, column, row + 1])
            if column == width - 1 or not cells[row * width + column + 1]:
                outline.append([column + 1, row, column + 1, row + 1])
    return {
        "outline": outline,
        "width": width,
        "height": height,
        "lower": [lower[0], lower[2]],
        "mpp": mpp,
        "spans": spans,
    }


def discussion_stages(result, result_path, requests, image_path, warnings):
    """Normalize explicit opening/checkpoint records without inferring stage timing."""
    opening = result.get("initial_debate") or {}
    periodic = result.get("periodic_debate") or {}
    entries = []
    if opening.get("messages"):
        entries.append(("opening", "/initial_debate", opening))
    entries += [
        ("checkpoint", f"/periodic_debate/stages/{i}", stage)
        for i, stage in enumerate(periodic.get("stages", []))
    ]
    normalized = []
    for kind, pointer, stage in entries:
        recorded = stage.get("events", [])
        stage_requests = {}
        for i, event in enumerate(recorded):
            if event.get("event_type") == "request":
                stage_requests.setdefault((event.get("round"), event.get("agent_id")), []).append(
                    (i, event)
                )
        checkpoints = {
            event["checkpoint"] for event in recorded if type(event.get("checkpoint")) is int
        }
        checkpoint = next(iter(checkpoints)) if len(checkpoints) == 1 else None
        pauses = [
            event
            for event in periodic.get("events", [])
            if event.get("event_type") == "pause_started" and event.get("checkpoint") == checkpoint
        ]
        request_steps = {
            message["request_step"]
            for message in stage.get("messages", [])
            if type(message.get("request_step")) is int
        }
        step = (
            pauses[0].get("step")
            if len(pauses) == 1
            else next(iter(request_steps))
            if len(request_steps) == 1
            else None
        )
        messages = []
        for i, message in enumerate(stage.get("messages", [])):
            agent = message.get("agent_id")
            if type(agent) is not int or agent < 0:
                warnings.append("Debate message lacks an explicit agent ID; omitted.")
                continue
            matches = stage_requests.get((message.get("round"), agent), [])
            request_index, request = matches[0] if len(matches) == 1 else (None, {})
            image_step = request.get("observation_step", message.get("request_step"))
            ordinary = requests.get((agent, image_step), [])
            views = (
                [image_path(path) for path in ordinary[0].get("view_files", [])]
                if len(ordinary) == 1
                else []
            )
            note = (
                "Cached observation views matched to the same agent and recorded acquisition step; exact debate attachment references were not logged."
                if kind == "checkpoint"
                else "Captured ordinary-request views at the same agent and request step; exact debate image attachment references were not logged."
            )
            messages.append(
                {
                    **message,
                    "visible_message_ids": request.get("visible_message_ids", []),
                    "prompt_text": request.get("prompt_text"),
                    "requested_at": request.get("requested_at"),
                    "views": views,
                    "view_note": note,
                    "observation_step": request.get("observation_step"),
                    "observation_age_steps": request.get("observation_age_steps"),
                    "image_step": image_step,
                    "source": {"path": result_path, "pointer": f"{pointer}/messages/{i}"},
                    "request_source": {
                        "path": result_path,
                        "pointer": f"{pointer}/events/{request_index}",
                    }
                    if request_index is not None
                    else None,
                }
            )
        normalized.append(
            {
                "id": pointer,
                "kind": kind,
                "checkpoint": checkpoint,
                "step": step,
                "label": "Opening"
                if kind == "opening"
                else f"Checkpoint {checkpoint}"
                if checkpoint is not None
                else f"Discussion {len(normalized) + 1}",
                "completed": stage.get("completed"),
                "messages": messages,
                "protocol": stage.get("protocol", {}),
                "source": {"path": result_path, "pointer": pointer},
            }
        )
    return normalized


def inspect_episode(index, run_id, episode_id):
    entry = next((e for e in catalog(index, run_id)["episodes"] if e["id"] == episode_id), None)
    if entry is None:
        raise KeyError("Episode is not indexed for this run")
    run = index.public(index.get(run_id))
    config = run["reproducibility"]["config"]
    result_path = entry["result_path"]
    folder = str(PurePosixPath(result_path).parent)
    result = strict_json(read(index, run_id, result_path))
    warnings = []
    if any(
        "debate" in key and key not in ("initial_debate", "periodic_debate") and value
        for key, value in result.items()
    ):
        warnings.append(
            "An additional debate format is not normalized by this inspector; consult the original episode evidence."
        )

    def optional(path, default):
        try:
            return strict_json(read(index, run_id, path))
        except (KeyError, OSError, ValueError) as exc:
            warnings.append(f"Unavailable {PurePosixPath(path).name}: {exc}")
            return default

    with index.connect() as db:
        paths = {
            row[0]
            for row in db.execute(
                "SELECT path FROM files WHERE run_id=? AND substr(path,1,?)=?",
                (run_id, len(folder + "/"), folder + "/"),
            )
        }
    source = index.settings.source(run["source"])
    evidence_root = source.evidence_root

    def image_path(value):
        if not isinstance(value, str):
            return None
        if value.startswith("/"):
            if evidence_root is None:
                return None
            try:
                value = str(PurePosixPath(value).relative_to(str(evidence_root)))
            except ValueError:
                return None
        return value if value in paths else None

    events = []
    communication = folder + "/communication.jsonl"
    if communication in paths:
        for line, raw in enumerate(read(index, run_id, communication).splitlines(), 1):
            try:
                event = strict_json(raw)
                if isinstance(event, dict):
                    events.append({**event, "source": {"path": communication, "line": line}})
            except ValueError:
                warnings.append(f"Invalid communication record at line {line}; skipped.")
    else:
        warnings.append("Structured communication capture is not recorded for this episode.")

    requests = {}
    applications = {}
    responses = {}
    for event in events:
        key = (event.get("agent_id"), event.get("request_step"))
        if event.get("kind") == "response":
            responses.setdefault(key, []).append(event)
        if event.get("kind") == "request":
            requests.setdefault(key, []).append(event)
        if event.get("kind") == "decision_application":
            applications.setdefault(key, []).append(event)
    decisions = []
    board = []
    for event in events:
        agent = event.get("agent_id")
        step = event.get("request_step")
        if type(agent) is not int or agent < 0 or type(step) is not int or step < 0:
            continue
        key = (agent, step)
        if event.get("kind") == "communication_input":
            board.append(
                {
                    "agent_id": agent,
                    "step": step,
                    "records": event.get("progress_records", []),
                    "found_by": event.get("found_by", []),
                    "source": event["source"],
                }
            )
        if event.get("kind") != "response":
            continue
        raw = event.get("result", {}).get("raw") or {}
        matches = applications.get(key, [])
        request_matches = requests.get(key, [])
        ambiguous = len(matches) > 1 or len(request_matches) > 1 or len(responses.get(key, [])) > 1
        application = matches[0] if len(matches) == 1 and not ambiguous else None
        request = request_matches[0] if len(request_matches) == 1 else None
        decisions.append(
            {
                "agent_id": agent,
                "request_step": step,
                "applied_step": application.get("applied_step") if application else None,
                "raw": raw,
                "request_inputs": {
                    key: request[key]
                    for key in ("instruction", "announcement_text")
                    if request is not None and key in request
                },
                "planning_context": planning_discussion_context(result, result_path, agent, step)
                if not ambiguous
                else None,
                "source": event["source"],
                "application_source": application["source"] if application else None,
                "request_source": request["source"] if request else None,
                "views": [image_path(p) for p in request.get("view_files", [])] if request else [],
                "attribution_warning": "Repeated agent/request-step records; linkage is ambiguous."
                if ambiguous
                else None,
            }
        )

    poses_path = f"{folder}/fullpose_{episode_id}.json"
    poses = optional(poses_path, []) if poses_path in paths else []
    if not poses:
        warnings.append("Full per-step poses are unavailable; no trajectory is reconstructed.")
    frames = []
    for path in sorted(paths):
        match = re.fullmatch(re.escape(folder) + r"/rgb_frames/combined_step(\d+)\.jpg", path)
        if match:
            frames.append({"step": int(match[1]), "path": path})
    frames.sort(key=lambda item: item["step"])
    trajectory = optional(f"{folder}/traj_{episode_id}.json", {})
    stages = discussion_stages(result, result_path, requests, image_path, warnings)
    messages = [
        message for stage in stages if stage["kind"] == "opening" for message in stage["messages"]
    ]
    floor = None
    floor_paths = [config.get("inspector_floorplans", {}).get(episode_id)]
    floor_paths += [
        prefix + "/trajectories/floorplan.npz"
        for prefix in source.evidence_paths
        if prefix.startswith("reports/") and not prefix.endswith(".npz")
    ]
    for path in dict.fromkeys(floor_paths):
        if not path:
            continue
        try:
            floor = {**floorplan(read(index, run_id, path)), "source": {"path": path}}
            break
        except (KeyError, OSError, ValueError, struct.error, zipfile.BadZipFile):
            continue
    if floor is None:
        warnings.append("Reference floorplan is unavailable; the map shows measured paths only.")
    elif config.get("inspector_floorplan_notes", {}).get(episode_id):
        warnings.append(config["inspector_floorplan_notes"][episode_id])
    hashes = config.get("source_hashes", {})
    crop = hashes.get("scripts/navigation_heatmaps/capture_episode.py") == CAPTURE_HASH
    agent_ids = sorted(
        {p["agent_id"] for p in result.get("per_agent", []) if type(p.get("agent_id")) is int}
        | {d["agent_id"] for d in decisions}
        | {m["agent_id"] for stage in stages for m in stage["messages"]}
    )
    return {
        "id": episode_id,
        "result": {
            k: result.get(k)
            for k in (
                "steps",
                "progress",
                "elapsed_s",
                "metrics",
                "per_agent",
                "policy_claims",
                "joint_success",
            )
        },
        "agents": agent_ids,
        "poses": poses,
        "pose_agent_ids": agent_ids if crop and agent_ids == list(range(len(agent_ids))) else None,
        "poses_source": {"path": poses_path} if poses else None,
        "frames": frames,
        "mosaic_layout": {
            "columns": 2 if len(agent_ids) > 1 else 1,
            "width": 640,
            "height": 480,
            "header": 38,
        }
        if crop
        else None,
        "decisions": decisions,
        "board": board,
        "debate": messages,
        "debate_stages": stages,
        "goals": trajectory.get("goals", []),
        "goals_source": {"path": f"{folder}/traj_{episode_id}.json"}
        if trajectory.get("goals")
        else None,
        "floor": floor,
        "warnings": warnings,
        "result_source": {"path": result_path},
    }
