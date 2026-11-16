import assert from "node:assert/strict";
import { test } from "node:test";
import { goalSummary } from "../goals.js";

const data = {
  goals: [{ idx: 0, category: "printer", found_by: -1 }, { idx: 1, category: "plant", found_by: 7 }],
  result: {
    metrics: { M: 2 },
    per_agent: [{ agent_id: 0, goals_found: [0] }, { agent_id: 7, goals_found: [] }],
    policy_claims: [
      { goal_index: 1, agent_id: 7, step: 10, evaluator_valid: false },
      { goal_index: 0, agent_id: 0, step: 30, evaluator_valid: true },
      { goal_index: 0, agent_id: 0, step: 25, evaluator_valid: true },
    ],
  },
};

test("final evaluator results determine goal status and preserve agent zero", () => {
  const goals = goalSummary(data, 0);
  assert.deepEqual(goals.map(g => g.status), ["found", "missing"]);
  assert.deepEqual(goals[0].foundBy, [0]);
  assert.equal(goals[0].category, "printer");
  assert.equal(goals[1].rejectedClaims, 0);
});

test("replay confirmation uses earliest valid recorded step and rejected claims stay separate", () => {
  assert.equal(goalSummary(data, 24)[0].confirmedAtStep, false);
  assert.equal(goalSummary(data, 25)[0].confirmedAtStep, true);
  assert.equal(goalSummary(data, 40)[0].confirmation.step, 25);
  assert.equal(goalSummary(data, 10)[1].rejectedClaims, 1);
  assert.equal(goalSummary(data, 40)[1].status, "missing");
});

test("missing results and timing remain unknown rather than adopting reference map outcomes", () => {
  const goals = goalSummary({ goals: data.goals }, 100);
  assert.deepEqual(goals.map(g => g.status), ["unknown", "unknown"]);
  const finalOnly = goalSummary({ ...data, result: { ...data.result, policy_claims: [] } }, 100);
  assert.equal(finalOnly[0].status, "found");
  assert.equal(finalOnly[0].confirmation, null);
  assert.equal(finalOnly[0].confirmedAtStep, false);
});

test("uncaptured episodes retain evaluator goal inventory without inventing names or timing", () => {
  const goals = goalSummary({ result: { metrics: { M: 2 }, per_agent: [{ agent_id: 4, goals_found: [1] }] } }, 100);
  assert.deepEqual(goals.map(g => [g.idx, g.status]), [[0, "missing"], [1, "found"]]);
  assert.equal(goals[1].category, undefined);
  assert.deepEqual(goalSummary({}, 0), []);
});
