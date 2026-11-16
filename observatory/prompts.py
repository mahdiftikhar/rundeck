"""Expose existing indexed prompts and frozen templates without running source code."""

import ast
import re
from pathlib import PurePosixPath

from .files import read_small, strict_json

LIMIT = 4 * 1024 * 1024
MAX_CAPTURED = 256
BUILDERS = {
    "navigate_or_backtrack": ("LA", "Navigation prompt builder"),
    "_build_nav_prompt": ("LA", "Navigation template selection"),
    "query_llm": ("VA", "Visual grounding prompt builder"),
    "double_check_stop": ("LA", "STOP verification prompt builder"),
    "generate_todo_list": ("LA", "TODO reasoning prompt builder"),
    "replan_at_backtrack": ("LA", "Replanning prompt builder"),
}


def planning_discussion_context(result, result_path, agent_id, request_step):
    """Resolve recorded visibility IDs, without reconstructing a model request."""
    opening = result.get("initial_debate") or {}
    periodic = result.get("periodic_debate") or {}
    stages = [("/initial_debate", opening)] + [
        (f"/periodic_debate/stages/{i}", stage)
        for i, stage in enumerate(periodic.get("stages", []))
    ]
    messages = {}
    for pointer, stage in stages:
        for i, message in enumerate(stage.get("messages", [])):
            identity = message.get("message_id")
            if isinstance(identity, str):
                messages.setdefault(identity, []).append(
                    {
                        **message,
                        "source": {"path": result_path, "pointer": f"{pointer}/messages/{i}"},
                    }
                )

    context = {"messages": [], "sources": [], "notes": [], "execution": None}
    visible = []
    for pointer, stage in (("/initial_debate", opening), ("/periodic_debate", periodic)):
        snapshots = [
            (i, event)
            for i, event in enumerate(stage.get("events", []))
            if event.get("event_type") == "planning_snapshot"
            and event.get("agent_id") == agent_id
            and event.get("request_step") == request_step
        ]
        if len(snapshots) > 1:
            context["notes"].append(f"Ambiguous {pointer} visibility snapshots; not combined.")
            continue
        if not snapshots:
            if stage:
                context["notes"].append(f"No {pointer} visibility snapshot for this request.")
            continue
        i, snapshot = snapshots[0]
        context["sources"].append({"path": result_path, "pointer": f"{pointer}/events/{i}"})
        visible.extend(snapshot.get("visible_message_ids", []))

    for identity in dict.fromkeys(visible):
        matches = messages.get(identity, [])
        if len(matches) != 1:
            context["notes"].append(
                f"Message {identity} is missing or ambiguous; text unavailable."
            )
            continue
        message = matches[0]
        # Use broadcast text only: raw replies may contain text teammates did not receive.
        context["messages"].append(
            {
                key: message.get(key)
                for key in ("message_id", "agent_id", "round", "text", "status", "source")
            }
        )

    executions = [
        (i, event)
        for i, event in enumerate(periodic.get("events", []))
        if event.get("event_type") == "post_debate_decision_request"
        and event.get("agent_id") == agent_id
        and event.get("request_step") == request_step
    ]
    if len(executions) == 1:
        i, event = executions[0]
        context["execution"] = {
            "checkpoint": event.get("checkpoint"),
            "final_message_id": event.get("final_message_id"),
            "source": {"path": result_path, "pointer": f"/periodic_debate/events/{i}"},
        }
    elif executions:
        context["notes"].append("Ambiguous post-debate execution records; not linked.")

    return context


def template_definitions(text, path, task_type=None):
    """Read literal prompt definitions and builder source; never import a snapshot."""
    tree = ast.parse(text)
    module = PurePosixPath(path).stem
    task = module.removeprefix("prompts_").upper() if module.startswith("prompts_") else None
    if task_type and task and task != task_type:
        return []
    entries = []
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant):
            continue
        if not isinstance(node.value.value, str):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name) or "PROMPT" not in target.id:
                continue
            role = "VA" if target.id.startswith("VA_") else "LA"
            entries.append(
                {
                    "kind": "template",
                    "role": role,
                    "title": f"{task or 'Source'} · {target.id}",
                    "text": node.value.value,
                    "source": {"path": path, "line": node.lineno},
                }
            )
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        for node in cls.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            debate = module in ("initial_debate", "periodic_debate") and node.name == "_content"
            if not debate and node.name not in BUILDERS:
                continue
            role, title = (
                ("Debate", f"{module} · Prompt builder") if debate else BUILDERS[node.name]
            )
            entries.append(
                {
                    "kind": "builder",
                    "role": role,
                    "title": title,
                    "text": ast.get_source_segment(text, node),
                    "source": {"path": path, "line": node.lineno},
                }
            )
    return entries


def captured_identity(path, episode_id):
    """Accept only explicit agent/episode/step paths, excluding copied VA mirrors."""
    match = re.search(
        r"(?:^|/)agent_(\d+)/" + re.escape(episode_id) + r"/step_(\d+)/([^/]+)/prompt\.json$",
        path,
    )
    if not match or match[3].startswith("va_query_cached_"):
        return None
    folder = match[3]
    role = "LA" if folder.startswith("la_") else "VA" if folder.startswith("va_") else None
    if role is None:
        return None
    return {"agent_id": int(match[1]), "request_step": int(match[2]), "role": role, "title": folder}


def prompt_inventory(index, run_id, episode_id, result_path, config):
    """Read only this run's indexed captures and source snapshots on demand."""
    # Use the canonical run prefix, not a different experiment's source snapshot.
    marker = "/episodes/"
    prefix = result_path.split(marker, 1)[0] if marker in result_path else None
    task = re.search(r"(?m)^TASK_TYPE:\s*([A-Za-z]+)\s*$", config.get("effective_config_yaml", ""))
    task_type = task[1].upper() if task else None
    with index.connect() as db:
        paths = [
            row[0]
            for row in db.execute(
                "SELECT path FROM files WHERE run_id=? AND "
                "((substr(path,-12)='/prompt.json' AND instr(path,?)>0) "
                "OR (instr('/' || path,'/source_snapshot/')>0 AND "
                "(path LIKE '%/utils/prompts_%.py' OR path LIKE '%/ZS_Evaluator_mp.py' "
                "OR path LIKE '%/benchmark/initial_debate.py' "
                "OR path LIKE '%/benchmark/periodic_debate.py'))) ORDER BY path",
                (run_id, "/" + episode_id + "/"),
            )
        ]
    result = {"captured": [], "templates": [], "notes": []}
    capped = False
    for path in paths:
        if prefix is not None and not path.startswith(prefix + "/"):
            continue
        try:
            if path.endswith("/prompt.json"):
                identity = captured_identity(path, episode_id)
                if identity is None:
                    continue
                if len(result["captured"]) >= MAX_CAPTURED:
                    if not capped:
                        result["notes"].append(
                            f"Showing the first {MAX_CAPTURED} indexed prompt artifacts."
                        )
                        capped = True
                    continue
                messages = strict_json(read_small(index.file(run_id, path), path, limit=LIMIT))
                if not isinstance(messages, list):
                    raise ValueError("expected a message list")
                for message in messages:
                    if not isinstance(message, dict) or not isinstance(message.get("role"), str):
                        raise TypeError("invalid recorded message")
                result["captured"].append(
                    {"kind": "captured", **identity, "messages": messages, "source": {"path": path}}
                )
            else:
                text = read_small(index.file(run_id, path), path, limit=LIMIT).decode("utf-8")
                result["templates"].extend(template_definitions(text, path, task_type))
        except (KeyError, OSError, ValueError, TypeError, SyntaxError, UnicodeError) as exc:
            result["notes"].append(f"Unavailable prompt evidence {PurePosixPath(path).name}: {exc}")
    result["templates"].sort(key=lambda entry: (entry["kind"] == "builder", entry["title"]))
    result["captured"].sort(
        key=lambda entry: (entry["agent_id"], entry["request_step"], entry["role"], entry["title"])
    )
    return result
