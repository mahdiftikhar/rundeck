export const episodeColumns = [
  ["id", "Episode"], ["progress", "Goals found"], ["success", "Success"],
  ["steps", "Steps"], ["elapsed_s", "Duration"],
];

const collator = new Intl.Collator(undefined, { numeric: true });
const known = value => typeof value === "string" || Number.isFinite(value);

function compare(a, b, direction) {
  if (!known(a)) return known(b) ? 1 : 0;
  if (!known(b)) return -1;
  const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return direction === "desc" ? -order : order;
}

export function groupEpisodes(episodes, { sortKey = "id", direction = "asc", groupKey = "" } = {}) {
  const ordered = [...episodes].sort((a, b) =>
    compare(a[sortKey], b[sortKey], direction) || collator.compare(String(a.id), String(b.id)));
  if (!groupKey) return [{ value: null, episodes: ordered }];

  const groups = new Map();
  for (const episode of ordered) {
    const value = known(episode[groupKey]) ? episode[groupKey] : null;
    if (!groups.has(value)) groups.set(value, { value, episodes: [] });
    groups.get(value).episodes.push(episode);
  }
  return [...groups.values()].sort((a, b) => compare(a.value, b.value, groupKey === sortKey ? direction : "asc"));
}
