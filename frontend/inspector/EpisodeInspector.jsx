import { useEffect, useMemo, useReducer } from "react";
import { AgentStatePanel } from "./AgentStatePanel.jsx";
import { CameraPanel } from "./CameraPanel.jsx";
import { DebatePanel } from "./Messages.jsx";
import { DecisionTimeline } from "./DecisionTimeline.jsx";
import { MapPanel } from "./MapPanel.jsx";
import { PlaybackControls, StageNavigation } from "./PlaybackControls.jsx";
import { debateStages, currentDecision, frameEvidence } from "./model.js";
import { Button, Details } from "./primitives.jsx";
import { initialState, inspectorReducer } from "./state.js";

export function EpisodeInspector({ data }) {
  const [state, dispatch] = useReducer(inspectorReducer, data, initialState);
  const stages = useMemo(() => debateStages(data), [data]);
  const stage = stages[state.stageIndex];
  const decision = currentDecision(data, state);
  const evidence = frameEvidence(data, state, stage, decision);
  const maxStep = data.result.steps || 0;
  const debate = state.phase === "debate";
  const patch = value => dispatch({ type: "patch", value });

  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => dispatch({ type: "tick", maxStep }), 250 / state.speed);
    return () => clearInterval(timer);
  }, [state.playing, state.speed, maxStep]);

  function chooseStage(index) {
    const selected = Math.max(0, Math.min(stages.length - 1, index));
    dispatch({ type: "stage", index: selected, stage: stages[selected] });
  }

  function nextDecision(direction) {
    const steps = data.decisions.filter(d => d.agent_id === state.agent && d.applied_step != null)
      .map(d => d.applied_step).sort((a, b) => a - b);
    const next = direction > 0 ? steps.find(step => step > state.step) : steps.filter(step => step < state.step).at(-1);
    patch({ phase: "replay" });
    dispatch({ type: "seek", step: next ?? (direction > 0 ? maxStep : 0), maxStep });
  }

  function selectEvent(event) {
    if (Number.isInteger(event.stageIndex)) {
      chooseStage(event.stageIndex);
      patch({ attachment: event.message });
    } else {
      patch({ phase: "replay", panel: event.type === "Board snapshot" ? "messages" : "decision" });
      dispatch({ type: "seek", step: event.step, focus: event.decision ?? null, maxStep });
    }
  }

  return <>
    <div className="inspector-phase">
      {stages.length > 0 && <Button data-phase="debate" aria-pressed={debate} onClick={() => {
        const nearest = stages.map((item, index) => ({ item, index })).filter(entry => entry.item.step <= state.step).at(-1);
        chooseStage(!debate ? nearest?.index ?? 0 : state.stageIndex);
      }}>{stages.length > 1 ? "Debate stages" : "Opening debate"}</Button>}
      <Button data-phase="replay" aria-pressed={!debate} onClick={() => patch({ phase: "replay" })}>Simulator replay</Button>
    </div>
    {debate ? <StageNavigation stages={stages} stageIndex={state.stageIndex} onStage={chooseStage} />
      : <PlaybackControls state={state} maxStep={maxStep} dispatch={dispatch} onDecision={nextDecision} />}
    <div className="inspector-layout" data-phase={state.phase}>
      <div className="inspector-visuals">
        <MapPanel data={data} step={debate ? stage?.step : state.step} agent={state.agent} />
        <CameraPanel data={data} state={state} decision={decision} evidence={evidence} dispatch={dispatch} />
      </div>
      <div>
        <DebatePanel stage={stage} hidden={!debate} onCamera={message => patch({ agent: message.agent_id, attachment: message, view: 0 })} />
        <div hidden={debate}><AgentStatePanel data={data} state={state} decision={decision} dispatch={dispatch} /></div>
      </div>
    </div>
    <DecisionTimeline data={data} stages={stages} agent={state.agent} onSelect={selectEvent} />
    {data.warnings.length > 0 && <Details name="Capture gaps">{data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</Details>}
  </>;
}
