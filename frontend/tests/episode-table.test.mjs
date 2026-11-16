import assert from "node:assert/strict";
import { test } from "node:test";
import { groupEpisodes } from "../../observatory/static/episode-table.js";

const episodes = [
  { id: "ep10", progress: 0.5, success: 0, steps: 100, elapsed_s: 20 },
  { id: "ep2", progress: 0.5, success: 0, steps: 9, elapsed_s: 100 },
  { id: "ep3", progress: 1, success: 1, steps: 20, elapsed_s: 9 },
  { id: "ep4", progress: null },
  { id: "ep5", progress: NaN },
];
const ids = groups => groups.flatMap(group => group.episodes.map(e => e.id));

test("sorts raw numeric goals in both directions with deterministic ties and missing last", () => {
  assert.deepEqual(ids(groupEpisodes(episodes, { sortKey: "progress", direction: "desc" })), ["ep3", "ep2", "ep10", "ep4", "ep5"]);
  assert.deepEqual(ids(groupEpisodes(episodes, { sortKey: "progress" })), ["ep2", "ep10", "ep3", "ep4", "ep5"]);
  assert.deepEqual(episodes.map(e => e.id), ["ep10", "ep2", "ep3", "ep4", "ep5"]);
});

test("sorts episode IDs naturally and steps and duration numerically", () => {
  assert.deepEqual(ids(groupEpisodes(episodes)), ["ep2", "ep3", "ep4", "ep5", "ep10"]);
  assert.deepEqual(ids(groupEpisodes(episodes, { sortKey: "steps" })), ["ep2", "ep3", "ep10", "ep4", "ep5"]);
  assert.deepEqual(ids(groupEpisodes(episodes, { sortKey: "elapsed_s" })), ["ep3", "ep10", "ep2", "ep4", "ep5"]);
});

test("groups equal values, merges missing values, and sorts within groups", () => {
  const groups = groupEpisodes(episodes, { groupKey: "success", sortKey: "steps" });
  assert.deepEqual(groups.map(g => g.value), [0, 1, null]);
  assert.deepEqual(groups.map(g => g.episodes.map(e => e.id)), [["ep2", "ep10"], ["ep3"], ["ep4", "ep5"]]);
  const goals = groupEpisodes(episodes, { groupKey: "progress", sortKey: "progress", direction: "desc" });
  assert.deepEqual(goals.map(g => g.value), [1, 0.5, null]);
  assert.deepEqual(groupEpisodes([]), [{ value: null, episodes: [] }]);
});
