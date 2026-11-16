import { goalSummary } from "./goals.js";
import { Button, Details, Empty, Panel, SourceLink } from "./primitives.jsx";

export function GoalOverview({ data, step, onSeek }) {
  const goals = goalSummary(data, step);
  const found = goals.filter(g => g.status === "found").length;
  const unknown = goals.filter(g => g.status === "unknown").length;
  return <Panel title="Episode goals" className="inspector-goals"
    subtitle="Final evaluator outcomes · offline evidence"
    heading={<strong>{found} / {goals.length || "?"} found{unknown > 0 ? ` · ${unknown} unknown` : ""}</strong>}>
    {!goals.length ? <Empty>Goal identities and individual outcomes are not recorded.</Empty> :
      <ul className="inspector-goal-list">{goals.map(goal => <li key={goal.idx} className={`inspector-goal inspector-goal-${goal.status}`}>
        <div className="inspector-goal-heading"><strong>G{goal.idx} · {goal.category || "Name not recorded"}</strong>
          <span className="inspector-goal-status">{goal.status === "found" ? "✓ Found" : goal.status === "missing" ? "○ Not found" : "? Unknown"}</span></div>
        {goal.modality && <span className="inspector-caption">{goal.modality}</span>}
        <p>{goal.foundBy.length > 0 ? `Found by ${goal.foundBy.map(id => `Agent ${id}`).join(", ")}` : goal.status === "missing" ? "No evaluator-confirmed discovery" : "Individual outcome unavailable"}</p>
        {goal.confirmation ? <>
          <p className="inspector-caption">{goal.confirmedAtStep ? "Confirmed by selected step" : "Confirmation later in replay"} · step {goal.confirmation.step}</p>
          <Button onClick={() => onSeek(goal.confirmation.step)}>Go to confirmation · {goal.confirmation.step}</Button>
        </> : goal.status === "found" && <p className="inspector-caption">Discovery step not recorded</p>}
        {goal.rejectedClaims > 0 && <p className="inspector-caption">{goal.rejectedClaims} evaluator-rejected {goal.rejectedClaims === 1 ? "claim" : "claims"} by selected step</p>}
      </li>)}</ul>}
    <Details name="Goal evidence"><SourceLink evidence={data.result_source} /><SourceLink evidence={data.goals_source} />
      <p>Names and G labels match the map. Found / Not found describes the final recorded evaluator result, regardless of replay position. Confirmation timing uses evaluator-valid claims only; policy claims alone do not count as discoveries.</p>
    </Details>
  </Panel>;
}
