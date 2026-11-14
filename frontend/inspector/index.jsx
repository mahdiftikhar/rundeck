import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EpisodeInspector } from "./EpisodeInspector.jsx";
import { Empty, EvidenceContext } from "./primitives.jsx";

async function request(url, signal) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Evidence unavailable");
  return data;
}

function Inspector({ run, alive, episodeId, episodes: supplied }) {
  const base = `/api/runs/${encodeURIComponent(run.id)}`;
  const [episodes, setEpisodes] = useState(supplied ?? null);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const items = supplied || (await request(`${base}/episodes`, controller.signal)).episodes;
        if (!alive() || controller.signal.aborted) return;
        setEpisodes(items);
        setSelected(items.some(item => item.id === episodeId) ? episodeId : items[0]?.id ?? null);
      } catch (failure) {
        if (!controller.signal.aborted && alive()) setError(failure.message);
      }
    }
    load();
    return () => controller.abort();
  }, [base, supplied, episodeId, alive]);

  useEffect(() => {
    if (selected == null) return;
    const controller = new AbortController();
    setData(null);
    setError(null);
    request(`${base}/episodes/${encodeURIComponent(selected)}`, controller.signal).then(next => {
      if (!controller.signal.aborted && alive()) setData(next);
    }).catch(failure => {
      if (!controller.signal.aborted && alive()) setError(failure.message);
    });
    return () => controller.abort();
  }, [base, selected, alive]);

  return <EvidenceContext.Provider value={base}>
    <section className="episode-inspector" aria-label="Episode inspector">
      <div className="inspector-picker">{episodes?.length > 1 && <label>Episode <select aria-label="Episode" value={selected ?? ""}
        onChange={event => { setData(null); setSelected(event.target.value); }}>
        {episodes.map(episode => <option key={episode.id} value={episode.id}>{episode.id}</option>)}
      </select></label>}</div>
      <div>{error ? <Empty>{error}</Empty>
        : data ? <EpisodeInspector key={selected} data={data} />
          : episodes?.length === 0 ? <Empty>No indexed episode results are available for this run.</Empty>
            : <Empty>Loading episode evidence…</Empty>}
      </div>
    </section>
  </EvidenceContext.Provider>;
}

// Keep the existing dashboard's mount/cleanup contract at the React boundary.
export async function mountInspector(props) {
  const host = document.createElement("div");
  props.target.append(host);
  const root = createRoot(host);
  root.render(<Inspector {...props} />);
  return () => { root.unmount(); host.remove(); };
}
