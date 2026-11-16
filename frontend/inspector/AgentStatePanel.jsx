import { PromptViewer } from "./PromptViewer.jsx";
import { agentName, last } from "./model.js";
import { Button, Details, Empty, Field, Panel, SourceLink } from "./primitives.jsx";

function DecisionContent({ data, decision, agent, step }) {
  if (!decision) return <><Empty>No applied decision is recorded for this agent at or before this step.</Empty><PromptViewer agent={agent} /></>;
  const raw = decision.raw;
  const la = raw.la_decision || {};
  const claim = (data.result.policy_claims || []).filter(c => c.agent_id === agent && c.step <= step).at(-1);
  return <>
    <div className="inspector-chips"><span>Requested {decision.request_step}</span>
      <span>{decision.applied_step == null ? "Not applied" : `Applied ${decision.applied_step}`}</span>
    </div>
    {decision.attribution_warning && <Empty>{decision.attribution_warning}</Empty>}
    <PromptViewer agent={agent} requestStep={decision.request_step} inputs={decision.request_inputs} planningContext={decision.planning_context} source={decision.request_source} />
    <Field name="Recorded reasoning" value={la.reasoning || raw.reasoning_action || raw.reasoning} />
    <Field name="Chosen action" value={[raw.action, raw.direction].filter(Boolean).join(" ")} />
    {raw.bbox?.target && <Field name="Predicted target" value={raw.bbox.target} />}
    <Field name="Policy claim" value={raw.stop_proposed || la.stop_signal ? raw.reported_claim_goal_id || la.claim_goal_id || "STOP proposed; target not recorded" : "No STOP claim in this decision."} />
    {claim && <Field name="Latest evaluator outcome (offline)" value={`${claim.goal_id || "Goal"} · ${claim.evaluator_valid === true ? "Confirmed" : claim.evaluator_valid === false ? "Rejected" : "Not recorded"} · step ${claim.step}`} />}
    <Details name="More decision evidence">
      <Field name="Progress report" value={raw.progress_analysis || la.progress_analysis} />
      <Field name="Visual target reasoning" value={raw.bbox?.reasoning} />
      <SourceLink evidence={decision.source} /><SourceLink evidence={decision.request_source} /><SourceLink evidence={decision.application_source} />
      <pre className="inspector-raw">{JSON.stringify(raw, null, 2)}</pre>
    </Details>
  </>;
}

function BoardSnapshot({ data, agent, step }) {
  const snapshot = last(data.board.filter(item => item.agent_id === agent), step);
  if (!snapshot) return <Empty>No shared-board snapshot is recorded at this step.</Empty>;
  return <div>
    <p className="inspector-caption">Shared-board snapshot read by Agent {agent} at request {snapshot.step}. Report steps are producer labels, not send times.</p>
    {snapshot.records.map((record, index) => <article key={index} className={`inspector-message agent-${record.agent_id % 3}`}>
      <strong>{agentName(record.agent_id)}</strong><span className="inspector-caption">Report step {record.step}</span>
      <p className="inspector-text">{record.text || "No report recorded."}</p>
    </article>)}
    <SourceLink evidence={snapshot.source} />
  </div>;
}

export function AgentStatePanel({ data, state, decision, dispatch }) {
  return <Panel className="inspector-thought" title={`Agent ${state.agent} · recorded state`}>
    <div className="inspector-local-tabs">{["decision", "messages"].map(panel =>
      <Button key={panel} aria-pressed={state.panel === panel} onClick={() => dispatch({ type: "patch", value: { panel } })}>{panel === "decision" ? "Decision" : "Messages"}</Button>)}
    </div>
    <div className="inspector-decision" hidden={state.panel !== "decision"}>
      <DecisionContent data={data} decision={decision} agent={state.agent} step={state.step} />
    </div>
    <div className="inspector-decision" hidden={state.panel !== "messages"}>
      <BoardSnapshot data={data} agent={state.agent} step={state.step} />
    </div>
  </Panel>;
}
