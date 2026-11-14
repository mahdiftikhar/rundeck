import { useContext, useLayoutEffect, useRef, useState } from "react";
import { DIRECTIONS, agentName } from "./model.js";
import { EvidenceContext, Empty, Panel, SourceLink, fileURL } from "./primitives.jsx";
import { agentColor, useThemeRevision } from "./theme.js";

function CameraImage({ evidence, data, agent, boxes, children }) {
  const { path, note, bbox, crop } = evidence;
  const base = useContext(EvidenceContext);
  const canvas = useRef(null);
  const theme = useThemeRevision();
  const [status, setStatus] = useState({ error: false, combined: false });

  useLayoutEffect(() => {
    let cancelled = false;
    setStatus({ error: false, combined: false });
    if (!path) return;
    // Clear the previous image before presenting a different request/view.
    const target = canvas.current;
    target.width = 300;
    target.height = 150;
    const image = new Image();
    image.onload = () => {
      if (cancelled || !canvas.current) return;
      const target = canvas.current;
      const ctx = target.getContext("2d");
      const layout = crop ? data.mosaic_layout : null;
      if (layout && data.agents.includes(agent) && image.naturalWidth === layout.columns * layout.width && image.naturalHeight === Math.ceil(data.agents.length / layout.columns) * (layout.height + layout.header)) {
        target.width = layout.width;
        target.height = layout.height;
        ctx.drawImage(image, agent % layout.columns * layout.width, Math.floor(agent / layout.columns) * (layout.height + layout.header) + layout.header, layout.width, layout.height, 0, 0, layout.width, layout.height);
      } else {
        target.width = image.naturalWidth;
        target.height = image.naturalHeight;
        ctx.drawImage(image, 0, 0);
        setStatus({ error: false, combined: Boolean(crop) });
      }
      if (boxes && bbox && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) {
        ctx.strokeStyle = agentColor(agent);
        ctx.lineWidth = 3;
        ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
      }
    };
    image.onerror = () => { if (!cancelled) setStatus({ error: true, combined: false }); };
    image.src = fileURL(base, path);
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [base, path, bbox, crop, data, agent, boxes, theme]);

  return <>
    <div className="inspector-frame">
      {!path ? <Empty>No captured frame at this step.</Empty> : <>
        <canvas ref={canvas} hidden={status.error} className="inspector-camera" role="img" aria-label={`${agentName(agent)} · ${note}`} />
        {status.error && <Empty>Captured image is unavailable.</Empty>}
      </>}
    </div>
    {children}
    <div className="inspector-caption">
      {status.combined && "Combined frame · per-agent crop unavailable. "}{note}
      {path && <SourceLink evidence={{ path }} />}
    </div>
  </>;
}

export function CameraPanel({ data, state, decision, evidence, dispatch }) {
  const debate = state.phase === "debate";
  const patch = value => dispatch({ type: "patch", value });
  const direction = state.view ?? (!debate && Number.isInteger(decision?.raw.frame_idx) ? decision.raw.frame_idx : 0);
  return <Panel title="Egocentric view" heading={
    <select aria-label="Selected agent" value={state.agent} onChange={e => dispatch({ type: "agent", agent: Number(e.target.value) })}>
      {data.agents.map(id => <option key={id} value={id}>{agentName(id)}</option>)}
    </select>
  }>
    <CameraImage evidence={evidence} data={data} agent={state.agent} boxes={state.boxes}>
    <div className="inspector-image-controls">
      <select aria-label="Image source" hidden={debate} value={state.imageMode} onChange={e => patch({ imageMode: e.target.value, view: null })}>
        <option value="live">Simulator frame</option><option value="decision">Decision image</option>
      </select>
      <select aria-label="Captured camera direction" value={direction} onChange={e => patch({ view: Number(e.target.value), ...(!debate ? { imageMode: "decision" } : {}) })}>
        {DIRECTIONS.map((name, i) => <option key={name} value={i}>{name}</option>)}
      </select>
      <label className="inspector-box-toggle" hidden={debate}>
        <input type="checkbox" checked={state.boxes} onChange={e => patch({ boxes: e.target.checked })} /> Predicted boxes
      </label>
    </div>
    </CameraImage>
  </Panel>;
}
