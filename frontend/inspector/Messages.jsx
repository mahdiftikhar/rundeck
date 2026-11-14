import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { splitMessageText, splitViewList } from "./message-format.js";
import { agentName } from "./model.js";
import { Button, Details, Field, Panel, SourceLink } from "./primitives.jsx";

function ReadableBody({ text }) {
  return splitViewList(text).map((block, index) => block.type === "list"
    ? <ul key={index} className="inspector-view-list">{block.items.map((item, i) => <li key={i}><strong>{item.label}:</strong> {item.text}</li>)}</ul>
    : <p key={index} className="inspector-text">{block.text}</p>);
}

export function ReadableMessage({ text }) {
  return <div className="inspector-message-text">{splitMessageText(text).map((block, index) =>
    <section key={index} className="inspector-message-section">
      {block.label && <h4>{block.label}</h4>}<ReadableBody text={block.text} />
    </section>)}
  </div>;
}

function CompactMessage({ blocks }) {
  const lead = blocks.find(block => ["Proposed action", "Proposed plan", "Proposed next steps", "Revised plan", "Search plan"].includes(block.label) && block.text)
    || blocks.find(block => block.label === "Reasoning" && block.text)
    || blocks.find(block => block.label && block.text)
    || blocks.find(block => block.text) || { label: null, text: "No broadcast text recorded." };
  const reasoning = blocks.find(block => block.label === "Reasoning" && block.text);
  return <div><section className="inspector-compact-lead">
    {lead.label && <h4>{lead.label}</h4>}<p className="inspector-text">{lead.text}</p>
  </section>
    {reasoning && reasoning !== lead && <section className="inspector-compact-lead inspector-compact-reasoning">
      <h4>Reasoning</h4><p className="inspector-text">{reasoning.text}</p>
    </section>}
  </div>;
}

export function MessageBubble({ message, stage, mode, expanded, onExpand, onCamera }) {
  const text = message.text || "No broadcast text recorded.";
  const blocks = splitMessageText(text);
  const full = mode === "full" || expanded;
  const cameraLabel = Number.isFinite(message.observation_step)
    ? `Camera · step ${message.observation_step} · ${message.observation_age_steps ?? "?"} ${message.observation_age_steps === 1 ? "step" : "steps"} old`
    : `Camera · request ${message.request_step}`;
  return <article className={`inspector-message inspector-compact-bubble agent-${message.agent_id % 3}`}>
    <div className="inspector-message-heading">
      <span className="inspector-avatar" aria-hidden="true">A{message.agent_id}</span><strong>{agentName(message.agent_id)}</strong>
      {message.truncated && <span className="inspector-message-badge">Shortened for sharing</span>}
      {message.status && message.status !== "ok" && <span className="inspector-message-badge">{message.status}</span>}
      {message.request_step !== stage.step && <span className="inspector-caption">Request {message.request_step}</span>}
    </div>
    <div className="inspector-broadcast-content">{full ? <ReadableMessage text={text} /> : <CompactMessage blocks={blocks} />}</div>
    <div className="inspector-bubble-actions">
      <Button className="inspector-chat-action" aria-expanded={full} onClick={onExpand}
        hidden={mode === "full" || (blocks.length === 1 && blocks[0].text.length < 90)}>{full ? "Show less" : "Read whole message"}</Button>
      {message.views.some(Boolean) && <Button className="inspector-chat-action" onClick={onCamera}>{cameraLabel}</Button>}
    </div>
    <Details name="Original reply and evidence">
      <p className="inspector-caption">{message.truncated ? "The complete raw reply below includes text teammates did not receive." : "Original model reply and recorded delivery metadata."}</p>
      <Details name="Full raw reply"><ReadableMessage text={message.raw_text || "No raw reply logged."} /></Details>
      <Field name="Image provenance" value={message.view_note} />
      <Field name="Visible prior messages" value={JSON.stringify(message.visible_message_ids)} />
      <Field name="Returned" value={message.returned_at} /><Field name="Published after round barrier" value={message.published_at} />
      <SourceLink evidence={message.source} /><SourceLink evidence={message.request_source} />
    </Details>
  </article>;
}

export function DebatePanel({ stage, onCamera, hidden }) {
  const [mode, setMode] = useState("full");
  const [expanded, setExpanded] = useState(new Set());
  const host = useRef(null);
  useLayoutEffect(() => { if (host.current) host.current.scrollTop = 0; }, [stage]);
  const toggle = key => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return <Panel ref={host} hidden={hidden} className="inspector-chat" title={stage ? `${stage.label} discussion` : "Discussion"}
    subtitle={`${stage?.messages.length || 0} messages`} heading={<>
      <select aria-label="Conversation detail" value={mode} onChange={e => setMode(e.target.value)}>
        <option value="compact">Compact</option><option value="full">Full shared messages</option>
      </select>
    </>}>
      {stage?.messages.map((message, index) => {
        const key = message.source.pointer;
        return <Fragment key={key}>
          {(index === 0 || stage.messages[index - 1].round !== message.round) && <h3 className="inspector-round">Round {message.round}</h3>}
          <MessageBubble message={message} stage={stage} mode={mode} expanded={expanded.has(key)} onExpand={() => toggle(key)} onCamera={() => onCamera(message)} />
        </Fragment>;
      })}
  </Panel>;
}
