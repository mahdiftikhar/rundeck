import { debateStages } from "./model.js";

export function initialState(data) {
  return {
    phase: debateStages(data).length ? "debate" : "replay", stageIndex: 0,
    step: 0, agent: data.agents[0] ?? 0, boxes: true, imageMode: "live", view: null,
    panel: "decision", focus: null, attachment: null, playing: false, speed: 0.5,
  };
}

export function inspectorReducer(state, action) {
  switch (action.type) {
    case "patch": return { ...state, ...action.value };
    case "stage": return {
      ...state, stageIndex: action.index, phase: "debate", playing: false,
      attachment: null, focus: null, view: null,
      step: Number.isFinite(action.stage?.step) ? action.stage.step : state.step,
    };
    case "agent": return { ...state, agent: action.agent, focus: null, view: null, attachment: null };
    case "seek": return {
      ...state, step: Math.max(0, Math.min(action.maxStep, action.step)),
      playing: false, focus: action.focus ?? null, view: null,
    };
    case "play": return { ...state, playing: !state.playing, step: !state.playing && state.step >= action.maxStep ? 0 : state.step };
    case "tick": {
      const step = Math.min(action.maxStep, state.step + 1);
      return { ...state, step, focus: null, view: null, playing: step < action.maxStep };
    }
    default: return state;
  }
}
