import json
import sqlite3
from contextlib import contextmanager

from observatory.prompts import (
    captured_identity,
    planning_discussion_context,
    prompt_inventory,
    template_definitions,
)

PREFIX = "sim-code/logs/036_example/runs/01_2026-11-13"
RESULT = PREFIX + "/episodes/e1/episode_e1.json"
SNAPSHOT = PREFIX + "/source_snapshot/sim-code/vlnce_baselines/utils/prompts_objnav.py"


def discussion_result():
    def message(identity, agent, text):
        return {
            "message_id": identity,
            "agent_id": agent,
            "round": 2,
            "status": "ok",
            "text": text,
            "raw_text": "Private raw response must not replace broadcast text",
        }

    def snapshot(ids, agent=7, step=317):
        return {
            "event_type": "planning_snapshot",
            "agent_id": agent,
            "request_step": step,
            "visible_message_ids": ids,
        }

    return {
        "initial_debate": {
            "messages": [message("opening", 2, "Opening broadcast")],
            "events": [snapshot(["opening"])],
        },
        "periodic_debate": {
            "stages": [
                {"messages": [message("c100", 7, "Earlier plan")]},
                {"messages": [message("c200", 2, "Revised plan")]},
                {"messages": [message("future", 7, "Not visible yet")]},
            ],
            "events": [
                snapshot(["future"], agent=2),
                snapshot(["c100", "c200"]),
                snapshot(["future"], step=400),
                {
                    "event_type": "post_debate_decision_request",
                    "agent_id": 7,
                    "request_step": 317,
                    "checkpoint": 200,
                    "final_message_id": "c200",
                },
            ],
        },
    }


def test_planning_context_keeps_all_explicitly_visible_broadcasts_and_sources():
    context = planning_discussion_context(discussion_result(), RESULT, 7, 317)

    assert [message["message_id"] for message in context["messages"]] == ["opening", "c100", "c200"]
    assert [message["agent_id"] for message in context["messages"]] == [2, 7, 2]
    assert context["messages"][2]["text"] == "Revised plan"
    assert all("raw_text" not in message for message in context["messages"])
    assert context["messages"][2]["source"] == {
        "path": RESULT,
        "pointer": "/periodic_debate/stages/1/messages/0",
    }
    assert context["sources"][1]["pointer"] == "/periodic_debate/events/1"
    assert context["execution"]["checkpoint"] == 200
    assert context["execution"]["source"]["pointer"] == "/periodic_debate/events/3"
    assert context["notes"] == []


def test_planning_context_never_guesses_visibility_from_message_times():
    result = discussion_result()
    result["initial_debate"]["events"] = []
    result["periodic_debate"]["events"] = []

    context = planning_discussion_context(result, RESULT, 7, 317)

    assert context["messages"] == []
    assert context["sources"] == []
    assert len(context["notes"]) == 2
    assert context["execution"] is None


def test_planning_context_discloses_duplicate_snapshots_and_missing_message_ids():
    result = discussion_result()
    result["initial_debate"]["events"] *= 2
    result["periodic_debate"]["events"][1]["visible_message_ids"] += ["missing", "c100"]
    result["periodic_debate"]["stages"][1]["messages"] *= 2

    context = planning_discussion_context(result, RESULT, 7, 317)

    assert [message["message_id"] for message in context["messages"]] == ["c100"]
    assert any("Ambiguous /initial_debate" in note for note in context["notes"])
    assert any("Message missing" in note for note in context["notes"])
    assert any("Message c200" in note for note in context["notes"])


class EvidenceIndex:
    def __init__(self, root):
        self.root = root
        self.db = sqlite3.connect(":memory:")
        self.db.execute("CREATE TABLE files (run_id TEXT, path TEXT)")

    def add(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.db.execute("INSERT INTO files VALUES ('run', ?)", (path,))
        return target

    @contextmanager
    def connect(self):
        yield self.db

    def file(self, run_id, path):
        assert self.db.execute(
            "SELECT 1 FROM files WHERE run_id=? AND path=?", (run_id, path)
        ).fetchone()
        return self.root


def test_frozen_templates_are_literal_and_task_specific():
    source = """raise RuntimeError("never execute this source")
LA_PROMPT = "Find {target}."
VA_PROMPT = "Ground {intent}."
OTHER = "not a prompt"
DYNAMIC_PROMPT = build_prompt()
"""
    entries = template_definitions(source, SNAPSHOT, "OBJNAV")
    assert [(e["role"], e["text"]) for e in entries] == [
        ("LA", "Find {target}."),
        ("VA", "Ground {intent}."),
    ]
    assert entries[0]["source"] == {"path": SNAPSHOT, "line": 2}
    assert template_definitions(source, SNAPSHOT, "VLN") == []


def test_debate_builder_is_labelled_source_not_an_assembled_prompt():
    path = PREFIX + "/source_snapshot/sim-code/benchmark/initial_debate.py"
    entries = template_definitions(
        'class InitialDebate:\n    def _content(self, job):\n        return f"Agent {job}"\n',
        path,
    )
    assert entries[0]["kind"] == "builder"
    assert entries[0]["role"] == "Debate"
    assert 'f"Agent {job}"' in entries[0]["text"]


def test_captured_prompts_require_explicit_agent_episode_and_step():
    path = PREFIX + "/api_calls/agent_7/e1/step_12/la_nav_decision_123/prompt.json"
    assert captured_identity(path, "e1") == {
        "agent_id": 7,
        "request_step": 12,
        "role": "LA",
        "title": "la_nav_decision_123",
    }
    assert captured_identity(path, "e2") is None
    assert captured_identity(path.replace("agent_7", "unknown"), "e1") is None
    assert captured_identity(path.replace("la_nav_decision", "va_query_cached"), "e1") is None


def test_inventory_is_readonly_scoped_to_the_canonical_run_and_preserves_messages(tmp_path):
    index = EvidenceIndex(tmp_path)
    messages = [{"role": "user", "content": [{"type": "text", "text": "<script>literal</script>"}]}]
    capture = PREFIX + "/api_calls/agent_7/e1/step_12/va_query_123/prompt.json"
    index.add(capture, json.dumps(messages))
    index.add(SNAPSHOT, 'LA_PROMPT = "Find {target}."\nVA_PROMPT = "Ground {intent}."\n')
    index.add(SNAPSHOT.replace("objnav", "vln"), 'LA_PROMPT = "Other task."\n')
    index.add(SNAPSHOT.replace("036_example", "035_other"), 'LA_PROMPT = "Other run."\n')
    index.add(capture.replace("/e1/", "/e2/"), json.dumps(messages))
    index.add(capture.replace("va_query", "va_query_cached"), json.dumps(messages))
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    result = prompt_inventory(
        index, "run", "e1", RESULT, {"effective_config_yaml": "TASK_TYPE: OBJNAV\n"}
    )
    assert len(result["captured"]) == 1
    assert result["captured"][0]["messages"] == messages
    assert result["captured"][0]["agent_id"] == 7
    assert [entry["text"] for entry in result["templates"]] == [
        "Find {target}.",
        "Ground {intent}.",
    ]
    assert not result["notes"]
    assert before == {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}


def test_malformed_and_symlinked_artifacts_are_not_read(tmp_path):
    index = EvidenceIndex(tmp_path)
    capture = PREFIX + "/api_calls/agent_7/e1/step_12/la_nav_1/prompt.json"
    index.add(capture, '{"not": "messages"}')
    frozen = index.add(SNAPSHOT, 'LA_PROMPT = "safe"')
    private = tmp_path / "private.py"
    private.write_text('LA_PROMPT = "private"')
    frozen.unlink()
    frozen.symlink_to(private)
    result = prompt_inventory(index, "run", "e1", RESULT, {})
    assert result["captured"] == []
    assert result["templates"] == []
    assert len(result["notes"]) == 2


def test_prompt_api_exposes_recorded_debate_inputs_and_existing_artifacts(tmp_path):
    from fastapi.testclient import TestClient
    from observatory.config import load_settings
    from observatory.web import make_app

    config = tmp_path / "observatory.toml"
    config.write_text('[[sources]]\nname="local"\nroot="runs"\n')
    run = tmp_path / "runs/example"
    folder = run / "episodes/e1"
    folder.mkdir(parents=True)
    (run / "run.json").write_text(
        json.dumps(
            {
                "id": "example",
                "title": "Example",
                "status": "completed",
                "reproducibility": {
                    "config": {
                        "effective_config_yaml": "TASK_TYPE: OBJNAV\n",
                        "episode_index": [{"id": "e1", "result_path": "episodes/e1/result.json"}],
                    }
                },
            }
        )
    )
    (folder / "result.json").write_text(
        json.dumps(
            {
                "per_agent": [{"agent_id": 7}],
                "initial_debate": {
                    "messages": [
                        {
                            "message_id": "opening",
                            "agent_id": 7,
                            "round": 1,
                            "request_step": 12,
                            "text": "reply",
                        }
                    ],
                    "events": [
                        {
                            "event_type": "request",
                            "agent_id": 7,
                            "round": 1,
                            "prompt_text": ["Full debate instruction", "View label"],
                        },
                        {
                            "event_type": "planning_snapshot",
                            "agent_id": 7,
                            "request_step": 12,
                            "visible_message_ids": ["opening"],
                        },
                    ],
                },
            }
        )
    )
    events = [
        {
            "kind": "request",
            "agent_id": 7,
            "request_step": 12,
            "instruction": "Find a plant",
            "announcement_text": "",
        },
        {"kind": "response", "agent_id": 7, "request_step": 12, "result": {"raw": {}}},
    ]
    (folder / "communication.jsonl").write_text("\n".join(json.dumps(event) for event in events))
    template = run / "source_snapshot/sim-code/vlnce_baselines/utils/prompts_objnav.py"
    template.parent.mkdir(parents=True)
    template.write_text('LA_PROMPT = "Find {target}"\nVA_PROMPT = "Ground {intent}"\n')
    prompt = run / "api_calls/agent_7/e1/step_12/la_nav_123/prompt.json"
    prompt.parent.mkdir(parents=True)
    prompt.write_text('[{"role":"user","content":"Full saved LA request"}]')
    before = {p: p.read_bytes() for p in run.rglob("*") if p.is_file()}

    with TestClient(make_app(load_settings(config)), base_url="http://localhost") as client:
        response = client.get("/api/runs/example/episodes/e1/prompts")
        assert response.status_code == 200
        evidence = response.json()
        assert evidence["captured"][0]["messages"][0]["content"] == "Full saved LA request"
        assert len(evidence["templates"]) == 2
        episode = client.get("/api/runs/example/episodes/e1").json()
        assert episode["debate"][0]["prompt_text"] == ["Full debate instruction", "View label"]
        assert episode["decisions"][0]["request_inputs"] == {
            "instruction": "Find a plant",
            "announcement_text": "",
        }
        context = episode["decisions"][0]["planning_context"]
        assert context["messages"][0]["text"] == "reply"
        assert context["sources"][0]["pointer"] == "/initial_debate/events/1"
        assert client.get("/api/runs/example/episodes/unknown/prompts").status_code == 404

    assert before == {p: p.read_bytes() for p in run.rglob("*") if p.is_file()}
