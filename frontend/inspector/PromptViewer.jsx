import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Details, Empty, EvidenceContext, SourceLink, fileURL } from "./primitives.jsx";

const PromptContext = createContext(null);

export function PromptEvidenceProvider({ episodeId, children }) {
  const base = useContext(EvidenceContext);
  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState(null);
  const request = useRef(null);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const load = useCallback(() => {
    if (request.current) return;
    controller.current = new AbortController();
    request.current = fetch(`${base}/episodes/${encodeURIComponent(episodeId)}/prompts`, { signal: controller.current.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Prompt evidence unavailable.");
        if (!controller.current.signal.aborted) setEvidence(data);
      }).catch(failure => {
        if (!controller.current.signal.aborted) setError(failure.message);
      });
  }, [base, episodeId]);
  return <PromptContext.Provider value={{ evidence, error, load }}>{children}</PromptContext.Provider>;
}

const explanations = {
  logged_text: "Recorded text parts for this debate request, in order. Exact image attachment references were not recorded here.",
  captured: "Saved request messages. Image URLs refer to saved artifacts; generation settings and earlier overwritten retries may be absent.",
  inputs: "The job snapshot can be captured before debate text is attached. An empty announcement_text here does not mean the final LA request had no discussion. Recorded visibility evidence is shown separately below; this is not the complete model request.",
  template: "Frozen source template. Placeholders are unfilled; runtime additions, history and images are not included. Its selection for this request was not recorded.",
  builder: "Frozen prompt-building source. Values and runtime history are not expanded.",
};

function SavedMessages({ messages, source }) {
  const base = useContext(EvidenceContext);
  return messages.map((message, index) => <section key={index} className="inspector-message-section">
    <h4>{message.role}</h4>
    {typeof message.content === "string" ? <pre className="inspector-prompt-text">{message.content}</pre>
      : Array.isArray(message.content) ? message.content.map((part, i) => {
        if (!part || typeof part !== "object") return <pre key={i} className="inspector-prompt-text">{JSON.stringify(part)}</pre>;
        if (part.type === "text") return <pre key={i} className="inspector-prompt-text">{part.text}</pre>;
        const url = part.image_url?.url;
        // Debug captures store image filenames beside prompt.json. Keep remote,
        // embedded and traversal URLs out of this artifact preview.
        if (part.type === "image_url" && typeof url === "string" && /^[\w.-]+$/.test(url) && url !== "." && url !== "..") {
          const path = `${source.path.slice(0, source.path.lastIndexOf("/"))}/${url}`;
          return <a key={i} href={fileURL(base, path)} target="_blank" rel="noopener">
            <img className="inspector-prompt-image" src={fileURL(base, path)} loading="lazy" alt={`Recorded input image ${i + 1}`} />
          </a>;
        }
        return <p key={i} className="inspector-caption">{part.type === "image_url" ? "Image reference: see original prompt artifact." : `Recorded ${part.type || "content"} part: see original prompt artifact.`}</p>;
      }) : <pre className="inspector-prompt-text">{JSON.stringify(message.content, null, 2)}</pre>}
  </section>);
}

function PlanningInputs({ entry }) {
  const context = entry.planningContext;
  return <>
    <h4>Job input snapshot · partial</h4>
    <pre className="inspector-prompt-text">{entry.text || "No job input snapshot is linked to this response."}</pre>
    <SourceLink evidence={entry.source} />
    <h4>Discussion context · recorded visibility</h4>
    <p className="inspector-caption">Messages below are linked by this agent's recorded planning snapshot, not inferred from checkpoint timing. Only broadcast text is shown.</p>
    {context?.sources?.map((evidence, index) => <SourceLink key={index} evidence={evidence} />)}
    {context?.messages?.length ? context.messages.map(message => <section key={message.message_id} className="inspector-message-section">
      <h4>Agent {message.agent_id} · round {message.round} · {message.message_id}</h4>
      <pre className="inspector-prompt-text">{message.status === "error" ? "[message unavailable]" : message.text || "[broadcast text unavailable]"}</pre>
      <SourceLink evidence={message.source} />
    </section>) : <Empty>{context?.sources?.length ? "No discussion messages are listed in the recorded visibility snapshots." : "Discussion visibility was not recorded or cannot be linked uniquely. This does not establish that no discussion was sent."}</Empty>}
    {context?.execution && <>
      <h4>Post-debate replanning</h4>
      <p>A replanning request was recorded for checkpoint {context.execution.checkpoint ?? "unknown"}, referencing final reply {context.execution.final_message_id || "not recorded"}. The exact added execution instruction is not present in this job snapshot.</p>
      <SourceLink evidence={context.execution.source} />
    </>}
    {context?.notes?.map((note, index) => <p key={index} className="inspector-caption">{note}</p>)}
  </>;
}

export function PromptViewer({ agent, requestStep, recordedText, source, inputs, planningContext, debate = false }) {
  const context = useContext(PromptContext);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(debate ? "Debate" : "LA");
  const [selected, setSelected] = useState("");
  const entries = useMemo(() => {
    const items = [];
    const parts = Array.isArray(recordedText) ? recordedText : typeof recordedText === "string" ? [recordedText] : [];
    if (parts.length && parts.every(part => typeof part === "string")) {
      items.push({ kind: "logged_text", role: "Debate", title: "Recorded debate prompt text", parts, source });
    }
    items.push(...(context?.evidence?.captured || []).filter(entry => entry.agent_id === agent && (requestStep == null || entry.request_step === requestStep)).map(entry => ({ ...entry, title: `Request ${entry.request_step} · ${entry.title}` })));
    if ((inputs && Object.keys(inputs).length) || planningContext) items.push({ kind: "inputs", role: "LA", title: "Planning inputs and discussion evidence", text: Object.entries(inputs || {}).map(([key, value]) => `${key}:\n${value === "" ? "[empty in this job snapshot]" : value}`).join("\n\n"), source, planningContext });
    items.push(...(context?.evidence?.templates || []));
    return items.filter(entry => entry.role === role).map((entry, index) => ({ ...entry, id: `${entry.source?.path}:${entry.source?.line ?? ""}:${index}` }));
  }, [context?.evidence, agent, requestStep, recordedText, source, inputs, planningContext, role]);
  const entry = entries.find(item => item.id === selected) || entries[0];
  useEffect(() => { if (open) context?.load(); }, [open, context?.load]);

  return <Details name="Prompt" className="inspector-details inspector-prompt" onToggle={event => setOpen(event.currentTarget.open)}>
    {open && <>
      <div className="inspector-picker">
        {!debate && <label>Model role <select aria-label="Prompt model role" value={role} onChange={event => { setRole(event.target.value); setSelected(""); }}>
          <option value="LA">LA · planning / reasoning</option><option value="VA">VA · visual grounding</option>
        </select></label>}
        {entries.length > 0 && <label>Evidence <select aria-label="Prompt evidence" value={entry.id} onChange={event => setSelected(event.target.value)}>
          {entries.map(item => <option key={item.id} value={item.id}>{item.kind === "template" ? "Template · " : item.kind === "builder" ? "Source · " : ""}{item.title}</option>)}
        </select></label>}
      </div>
      {entry ? <>
        <p className="inspector-prompt-label">{entry.kind === "logged_text" ? "Recorded prompt text" : entry.kind === "captured" ? "Saved request messages" : entry.kind === "template" ? "Source template" : entry.kind === "builder" ? "Prompt builder source" : "Planning inputs and discussion evidence"}</p>
        <p className="inspector-caption">{explanations[entry.kind]}</p>
        <div className="inspector-prompt-body">
          {entry.kind === "inputs" ? <PlanningInputs entry={entry} /> : entry.messages ? <SavedMessages messages={entry.messages} source={entry.source} />
            : entry.parts ? entry.parts.map((text, index) => <pre key={index} className="inspector-prompt-text">{text}</pre>)
              : <pre className="inspector-prompt-text">{entry.text}</pre>}
        </div>
        <SourceLink evidence={entry.source} />
      </> : <Empty>{context?.error || (context?.evidence ? "No saved prompt or frozen source template is indexed for this selection." : "Loading existing prompt evidence…")}</Empty>}
      {context?.error && entry && <p className="inspector-caption">{context.error}</p>}
      {context?.evidence?.notes?.map((note, index) => <p key={index} className="inspector-caption">{note}</p>)}
    </>}
  </Details>;
}
