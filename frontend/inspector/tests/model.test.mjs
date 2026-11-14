import assert from "node:assert/strict";
import { test } from "node:test";
import { currentDecision, debateStages, frameEvidence, timelineEvents } from "../model.js";
import { initialState, inspectorReducer } from "../state.js";
import { splitMessageText, splitViewList } from "../message-format.js";

const data = {
  agents: [7, 2], result: { steps: 100, policy_claims: [{ agent_id: 7, step: 50, goal_id: "g1", evaluator_valid: false }] },
  decisions: [
    { agent_id: 7, request_step: 10, applied_step: 15, raw: { reasoning: "kitchen", frame_idx: 2, bbox: { x: 1, y: 2, width: 3, height: 4 } }, views: ["front.png", "left.png", "behind.png"] },
    { agent_id: 7, request_step: 20, applied_step: null, raw: { reasoning: "unapplied" } },
    { agent_id: 2, request_step: 11, applied_step: 12, raw: {} },
  ],
  board: [{ agent_id: 7, step: 18, records: [{ text: "bedroom" }] }],
  frames: [{ step: 15, path: "frame-15.png" }],
  debate: [{ agent_id: 7, request_step: 8, round: 1, text: "opening" }],
};

test("decision selection keeps request/application steps and explicit agent identity", () => {
  assert.equal(currentDecision(data, { agent: 7, step: 14 }), undefined);
  assert.equal(currentDecision(data, { agent: 7, step: 15 }), data.decisions[0]);
  assert.equal(currentDecision(data, { agent: 7, step: 99 }), data.decisions[0]);
  assert.equal(currentDecision(data, { agent: 7, step: 20, focus: 1 }), data.decisions[1]);
});

test("camera boxes belong only to the selected decision view; frames match exact steps", () => {
  const state = { ...initialState(data), phase: "replay", step: 15, imageMode: "decision" };
  const decision = data.decisions[0];
  assert.equal(frameEvidence(data, state, null, decision).bbox, decision.raw.bbox);
  assert.equal(frameEvidence(data, { ...state, view: 1 }, null, decision).bbox, null);
  assert.equal(frameEvidence(data, { ...state, imageMode: "live" }, null, decision).path, "frame-15.png");
  assert.equal(frameEvidence(data, { ...state, imageMode: "live", step: 16 }, null, decision).path, undefined);
});

test("debate images preserve logged acquisition age and selected attachment identity", () => {
  const message = { agent_id: 7, request_step: 40, observation_step: 30, observation_age_steps: 10, views: ["cached.png"] };
  const evidence = frameEvidence(data, { ...initialState(data), attachment: message }, {}, null);
  assert.equal(evidence.path, "cached.png");
  assert.match(evidence.note, /acquired 30 · 10 steps old at request 40/);
  assert.equal(debateStages({ ...data, debate_stages: [] }).length, 0);
});

test("timeline searches all logged event types and retains unapplied responses", () => {
  const events = timelineEvents(data, debateStages(data), 7, "");
  assert.deepEqual(events.map(event => event.step), [8, 15, 18, 20, 50]);
  assert.equal(events.find(event => event.type === "Unapplied response").decision, 1);
  assert.equal(timelineEvents(data, debateStages(data), 7, "REJECTED")[0].text, "g1");
  assert.equal(timelineEvents(data, debateStages(data), 7, "bedroom")[0].type, "Board snapshot");
});

test("playback stops at the end, restarts, and seeking/stage selection clear stale focus", () => {
  let state = { ...initialState(data), step: 99, playing: true, focus: 1, view: 2 };
  state = inspectorReducer(state, { type: "tick", maxStep: 100 });
  assert.equal(state.step, 100);
  assert.equal(state.playing, false);
  assert.equal(state.focus, null);
  state = inspectorReducer(state, { type: "play", maxStep: 100 });
  assert.equal(state.step, 0);
  assert.equal(state.playing, true);
  state = inspectorReducer(state, { type: "seek", step: 500, maxStep: 100, focus: 1 });
  assert.equal(state.step, 100);
  assert.equal(state.playing, false);
  state = inspectorReducer(state, { type: "stage", index: 2, stage: { step: 40 } });
  assert.equal(state.step, 40);
  assert.equal(state.phase, "debate");
  assert.equal(state.focus, null);
  state = inspectorReducer({ ...state, attachment: {} }, { type: "agent", agent: 2 });
  assert.equal(state.agent, 2);
  assert.equal(state.attachment, null);
});

test("headings and directional bullets preserve body text and literal HTML", () => {
  const blocks = splitMessageText("**Disagreement / overlap:** Same route. Coordination: Split up. Revised plan: Go left.");
  assert.deepEqual(blocks.map(block => block.label), ["Disagreement / overlap", "Coordination", "Revised plan"]);
  const views = splitViewList("Observations from 4 views: - FORWARD: wall. - LEFT: door. - BEHIND: <img src=x>. - RIGHT: couch. Notably, leaves near curtains.");
  assert.equal(views[0].text, "Observations from 4 views:");
  assert.deepEqual(views[1].items.map(item => item.label), ["FORWARD", "LEFT", "BEHIND", "RIGHT"]);
  assert.equal(views[1].items[2].text, "<img src=x>.");
  assert.equal(views[1].items[3].text, "couch. Notably, leaves near curtains.");
  assert.equal(splitViewList("I will turn left: the door is there.")[0].type, "paragraph");
});
