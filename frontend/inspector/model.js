export const DIRECTIONS = ["Forward", "Left", "Behind", "Right"];
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];
export const agentName = id => `Agent ${id}`;

export function last(items, step, key = "step") {
  return items.filter(item => Number.isFinite(item[key]) && item[key] <= step)
    .sort((a, b) => a[key] - b[key]).at(-1);
}

export function debateStages(data) {
  return data.debate_stages || (data.debate.length ? [{
    label: "Opening", kind: "opening", step: data.debate[0]?.request_step,
    messages: data.debate, completed: true,
  }] : []);
}

export function currentDecision(data, state) {
  return state.focus != null ? data.decisions[state.focus]
    : last(data.decisions.filter(d => d.agent_id === state.agent && d.applied_step != null), state.step, "applied_step");
}

export function timelineEvents(data, stages, agent, search) {
  return [
    ...stages.flatMap((stage, index) => stage.messages.map(message => ({ step: message.request_step, agent: message.agent_id, type: `Discussion · ${stage.label} · Round ${message.round}`, text: message.text || "", stageIndex: index, message }))),
    ...data.decisions.map((d, i) => ({ step: d.applied_step ?? d.request_step, agent: d.agent_id, type: d.applied_step == null ? "Unapplied response" : "Decision", text: JSON.stringify(d.raw), decision: i })),
    ...(data.result.policy_claims || []).map(c => ({ step: c.step, agent: c.agent_id, type: c.evaluator_valid === true ? "Confirmed claim" : c.evaluator_valid === false ? "Rejected claim" : "Claim", text: c.goal_id || "" })),
    ...data.board.map(b => ({ step: b.step, agent: b.agent_id, type: "Board snapshot", text: b.records.map(r => r.text).join(" ") })),
  ].filter(e => e.agent === agent && `${e.type} ${e.text}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.step - b.step);
}

export function frameEvidence(data, state, stage, decision) {
  const { phase, attachment, agent, view, imageMode, boxes, step } = state;
  if (phase === "debate") {
    const message = attachment || stage?.messages.find(m => m.agent_id === agent);
    const pick = view ?? 0;
    const note = Number.isFinite(message?.observation_step)
      ? `Cached ${DIRECTIONS[pick] || "camera"} view · acquired ${message.observation_step} · ${message.observation_age_steps ?? "unknown"} steps old at request ${message.request_step}`
      : `Same-step captured ${DIRECTIONS[pick] || "camera"} view · request ${message?.request_step ?? "unknown"}`;
    return { path: message?.views?.[pick], note };
  }
  if (imageMode === "decision") {
    const index = view ?? (Number.isInteger(decision?.raw.frame_idx) ? decision.raw.frame_idx : 0);
    const bbox = index === decision?.raw.frame_idx ? decision?.raw.bbox : null;
    return {
      path: decision?.views?.[index], bbox,
      note: `Decision ${DIRECTIONS[index] || "camera"} view · request ${decision?.request_step ?? "unlogged"}${bbox && boxes ? " · predicted box" : ""}`,
    };
  }
  return { path: data.frames.find(f => f.step === step)?.path, note: `Captured simulator frame · step ${step}`, crop: true };
}
