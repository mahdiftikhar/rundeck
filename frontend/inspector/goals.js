const validAgent = id => Number.isInteger(id) && id >= 0;
const claimIndex = claim => Number.isInteger(claim.goal_index) ? claim.goal_index
  : /^goal_\d+$/.test(claim.goal_id || "") ? Number(claim.goal_id.slice(5)) : null;

export function goalSummary(data, step) {
  const result = data.result || {};
  const agents = result.per_agent || [];
  const complete = agents.length > 0 && agents.every(a => Array.isArray(a.goals_found));
  const claims = result.policy_claims || [];
  const goals = new Map((data.goals || []).map(g => [g.idx, g]));
  const count = result.metrics?.M;
  if (Number.isInteger(count) && count >= 0) {
    for (let idx = 0; idx < count; idx++) if (!goals.has(idx)) goals.set(idx, { idx });
  }
  for (const agent of agents) {
    for (const idx of agent.goals_found || []) if (!goals.has(idx)) goals.set(idx, { idx });
  }
  return [...goals.values()].sort((a, b) => a.idx - b.idx).map(goal => {
    const matching = claims.filter(c => claimIndex(c) === goal.idx);
    const confirmations = matching.filter(c => c.evaluator_valid === true && Number.isFinite(c.step))
      .sort((a, b) => a.step - b.step);
    const foundBy = agents.filter(a => a.goals_found?.includes(goal.idx)).map(a => a.agent_id).filter(validAgent);
    const found = agents.some(a => a.goals_found?.includes(goal.idx));
    // Final evaluator results take precedence over policy claims and map metadata.
    const status = found ? "found" : complete ? "missing" : "unknown";
    const confirmation = status === "found" ? (confirmations[0] ?? null) : null;
    return { ...goal, status, foundBy, confirmation,
      confirmedAtStep: confirmation != null && Number.isFinite(step) && confirmation.step <= step,
      rejectedClaims: matching.filter(c => c.evaluator_valid === false && Number.isFinite(c.step) && c.step <= step).length,
    };
  });
}
