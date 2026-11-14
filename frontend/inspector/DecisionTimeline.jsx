import { useEffect, useMemo, useState } from "react";
import { timelineEvents } from "./model.js";
import { Button, Details } from "./primitives.jsx";

export function DecisionTimeline({ data, stages, agent, onSelect }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const items = useMemo(() => timelineEvents(data, stages, agent, search), [data, stages, agent, search]);
  useEffect(() => setPage(0), [agent]);
  return <Details name="Search decision timeline">
    <input type="search" placeholder="Search reasoning, messages, actions…" aria-label="Search recorded events"
      value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
    <div><p className="inspector-caption">{items.length} matching events · Agent {agent}</p>
      <div className="inspector-event-list">{items.slice(page * 40, page * 40 + 40).map((event, index) =>
        <Button key={`${page}-${index}`} className="inspector-event" onClick={() => onSelect(event)}>
          {event.step} · {event.type}{event.type.includes("claim") ? ` · ${event.text}` : ""}
        </Button>)}
      </div>
      <div className="inspector-paging">
        <Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button>
        <Button disabled={(page + 1) * 40 >= items.length} onClick={() => setPage(value => value + 1)}>Next</Button>
      </div>
    </div>
  </Details>;
}
