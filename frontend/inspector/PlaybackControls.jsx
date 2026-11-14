import { PLAYBACK_SPEEDS } from "./model.js";
import { Button } from "./primitives.jsx";

export function StageNavigation({ stages, stageIndex, onStage }) {
  const stage = stages[stageIndex];
  return <section className="inspector-stage-controls" aria-label="Discussion navigation">
    <div className="inspector-stage-navigation">
      <Button disabled={stageIndex === 0} onClick={() => onStage(stageIndex - 1)} data-previous-stage>← Previous</Button>
      <select aria-label="Debate stage" value={stageIndex} onChange={e => onStage(Number(e.target.value))}>
        {stages.map((item, index) => <option key={item.id ?? index} value={index}>{item.label}{item.step == null ? "" : ` · step ${item.step}`}</option>)}
      </select>
      <Button disabled={stageIndex >= stages.length - 1} onClick={() => onStage(stageIndex + 1)} data-next-stage>Next →</Button>
    </div>
    <span className="inspector-caption" data-stage-info>{stage?.label || "Discussion"} · {stage?.step == null ? "step unlogged" : `simulator step ${stage.step}`} · {stage?.completed === true ? "complete" : "completion unrecorded or incomplete"}</span>
  </section>;
}

export function PlaybackControls({ state, maxStep, dispatch, onDecision }) {
  return <section className="inspector-controls">
    <div className="inspector-control-row">
      <strong className="inspector-step">Simulator step {state.step} / {maxStep}</strong>
      <div className="inspector-actions">
        <Button onClick={() => onDecision(-1)}>← Decision</Button>
        <Button onClick={() => dispatch({ type: "play", maxStep })}>{state.playing ? "Pause" : "Play"}</Button>
        <Button onClick={() => onDecision(1)}>Decision →</Button>
        <select aria-label="Playback speed" value={state.speed} onChange={e => dispatch({ type: "patch", value: { speed: Number(e.target.value) } })}>
          {PLAYBACK_SPEEDS.map(value => <option key={value} value={value}>{value}×</option>)}
        </select>
      </div>
    </div>
    <input type="range" min={0} max={maxStep} value={state.step} aria-label="Simulator step"
      onChange={e => dispatch({ type: "seek", step: Number(e.target.value), maxStep })} />
  </section>;
}
