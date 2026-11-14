const h = (tag, attrs = {}, ...children) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null && value !== false) element.setAttribute(key, value === true ? "" : value);
  for (const child of children.flat(Infinity)) if (child != null) element.append(child instanceof Node ? child : String(child));
  return element;
};
const set = (element, ...children) => element.replaceChildren(...children.flat(Infinity).filter(child => child != null));
const btn = (text, action, attrs = {}) => { const element = h("button", { type: "button", ...attrs }, text); element.onclick = action; return element; };
const empty = text => h("p", { class: "inspector-empty" }, text);
const field = (name, value) => h("section", { class: "inspector-field" }, h("h3", {}, name), value ? h("p", { class: "inspector-text" }, value) : empty("Not recorded."));
const details = (name, ...content) => h("details", { class: "inspector-details" }, h("summary", {}, name), ...content);
const request = async url => { const r = await fetch(url, { headers: { Accept: "application/json" } }); const data = await r.json(); if (!r.ok) throw new Error(data.detail || "Evidence unavailable"); return data; };
const last = (items, step, key = "step") => items.filter(item => Number.isFinite(item[key]) && item[key] <= step).sort((a, b) => a[key] - b[key]).at(-1);
const directions = ["Forward", "Left", "Behind", "Right"];

export function splitMessageText(value) {
  const text = String(value || "");
  const labels = {
    progress_analysis: "Progress", reasoning: "Reasoning", action: "Proposed action",
    "to teammates": "To teammates", teammates: "To teammates", observations: "Observations",
    uncertainty: "Uncertainty", plan: "Proposed plan", "next steps": "Proposed next steps",
    "disagreement/overlap": "Disagreement / overlap", "disagreements/overlap": "Disagreements / overlap",
    "disagreement / overlap": "Disagreement / overlap", "disagreements / overlap": "Disagreements / overlap",
    "disagreement or overlap": "Disagreement or overlap", "disagreements or overlap": "Disagreements or overlap",
    disagreement: "Disagreement", disagreements: "Disagreements", overlap: "Overlap",
    coordination: "Coordination", "reasoning/coordination": "Reasoning / coordination",
    "reasoning / coordination": "Reasoning / coordination", "revised plan": "Revised plan",
    "proposed plan": "Proposed plan", "search plan": "Search plan",
  };
  // Recognize recorded field labels, including plain-text and Markdown variants.
  // Render with text nodes so model-provided HTML remains literal evidence.
  const names = Object.keys(labels).sort((a, b) => b.length - a.length).map(name =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ \\t]+"));
  const marker = new RegExp(`(?:^|\\s)(?:#{1,6}[ \\t]+)?(?:\\*\\*)?(${names.join("|")})(?:\\*\\*)?[ \\t]*:(?:\\*\\*)?`, "gi");
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return [{ label: null, text }];
  const blocks = [];
  const preamble = text.slice(0, matches[0].index).trim();
  if (preamble) blocks.push({ label: null, text: preamble });
  matches.forEach((match, i) => blocks.push({ label: labels[match[1].toLowerCase().replace(/[ \t]+/g, " ")], text: text.slice(match.index + match[0].length, matches[i + 1]?.index ?? text.length).trim() }));
  return blocks;
}
export function splitViewList(value) {
  const text = String(value || "");
  // Require an explicit bullet or a line boundary, never a direction in prose.
  const marker = /(?:(?:^|[\r\n])[ \t]*(?:[-*•][ \t]+)?|[ \t]+[-*•][ \t]+)(?:\*\*)?(forward|left|behind|right|backward|back|front)(?:\*\*)?[ \t]*:(?:\*\*)?/gi;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return [{ type: "paragraph", text }];
  const blocks = [];
  const preamble = text.slice(0, matches[0].index).trim();
  if (preamble) blocks.push({ type: "paragraph", text: preamble });
  blocks.push({ type: "list", items: matches.map((match, i) => ({
    label: match[1],
    text: text.slice(match.index + match[0].length, matches[i + 1]?.index ?? text.length).trim(),
  })) });
  return blocks;
}
const readableBody = text => splitViewList(text).map(block => block.type === "list"
  ? h("ul", { class: "inspector-view-list" }, block.items.map(item =>
    h("li", {}, h("strong", {}, `${item.label}:`), " ", item.text)))
  : h("p", { class: "inspector-text" }, block.text));
const readableMessage = text => h("div", { class: "inspector-message-text" }, splitMessageText(text).map(block =>
  h("section", { class: "inspector-message-section" }, block.label ? h("h4", {}, block.label) : null, readableBody(block.text))));

export async function mountInspector({ run, target, alive, episodeId, episodes: supplied }) {
  let disposed = false, timer = null, generation = 0, frameGeneration = 0, observer;
  const active = () => !disposed && alive();
  const base = `/api/runs/${encodeURIComponent(run.id)}`;
  const fileURL = path => `${base}/file?path=${encodeURIComponent(path)}`;
  const source = ref => ref ? h("a", { href: `${fileURL(ref.path)}${ref.line ? "#L" + ref.line : ""}`, target: "_blank", rel: "noopener", class: "inspector-source" }, ref.line ? `Source · line ${ref.line}` : ref.pointer ? `Source · ${ref.pointer}` : "Source evidence") : null;
  const root = h("section", { class: "episode-inspector", "aria-label": "Episode inspector" });
  target.append(root);
  let stages = [], stageIndex = 0, messageMode = "full";
  const expandedMessages = new Set();
  let data, phase = "replay", step = 0, agent = 0, boxes = true, imageMode = "live", view = null, panel = "decision", focus = null, search = "", page = 0;
  let map, frame, frameNote, decisionArea, messagesArea, timeline, stepLabel, slider, phaseButtons, body, chat, selectedAgent, play, speed, attachment, stageControls;
  const stop = () => { clearInterval(timer); timer = null; if (play) play.textContent = "Play"; };
  const colors = () => { const style = getComputedStyle(document.documentElement); return ["--inspector-a", "--inspector-b", "--inspector-c"].map(name => style.getPropertyValue(name).trim()); };
  const color = id => colors()[Math.abs(id) % 3];
  const current = () => focus != null ? data.decisions[focus] : last(data.decisions.filter(d => d.agent_id === agent && d.applied_step != null), step, "applied_step");
  const jump = (value, decision = null) => { stop(); step = Math.max(0, Math.min(data.result.steps || 0, value)); focus = decision; view = null; render(); };
  const agentName = id => `Agent ${id}`;
  const currentStage = () => stages[stageIndex];
  const chooseStage = index => {
    stop(); stageIndex = Math.max(0, Math.min(stages.length - 1, index)); phase = "debate";
    attachment = null; focus = null; view = null;
    if (Number.isFinite(currentStage()?.step)) step = currentStage().step;
    renderChat(); render(); chat.scrollTop = 0;
  };

  function drawMap() {
    if (!map || !active()) return;
    const rect = map.getBoundingClientRect();
    const width = Math.max(300, rect.width), height = width / 1.45;
    const ratio = devicePixelRatio || 1;
    map.width = width * ratio; map.height = height * ratio;
    const ctx = map.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(document.documentElement), floor = data.floor;
    ctx.fillStyle = style.getPropertyValue("--background"); ctx.fillRect(0, 0, width, height);
    const selectedStep = phase === "debate" ? currentStage()?.step : step;
    const sample = last(data.poses, selectedStep);
    const points = data.poses.flatMap(p => (p.pos || []).filter(p => p?.length >= 3).map(p => [p[0], p[2]]));
    const goals = data.goals.filter(g => Array.isArray(g.object_xz || g.xz));
    points.push(...goals.map(g => g.object_xz || g.xz));
    if (!points.length && !floor) { ctx.fillStyle = style.getPropertyValue("--muted-foreground"); ctx.font = "14px system-ui"; ctx.fillText("No measured positions recorded.", 20, 40); return; }
    let minX, minZ, maxX, maxZ;
    if (floor) {
      const xs = floor.spans.map(span => floor.lower[0] + span[0] * floor.mpp);
      const zs = floor.spans.map(span => floor.lower[1] + span[1] * floor.mpp);
      minX = Math.min(...xs, ...points.map(p => p[0])) - .6;
      minZ = Math.min(...zs, ...points.map(p => p[1])) - .6;
      maxX = Math.max(...floor.spans.map(span => floor.lower[0] + (span[0] + span[2]) * floor.mpp), ...points.map(p => p[0])) + .6;
      maxZ = Math.max(...zs, ...points.map(p => p[1])) + .6;
    }
    else { minX = Math.min(...points.map(p => p[0])) - 1; maxX = Math.max(...points.map(p => p[0])) + 1; minZ = Math.min(...points.map(p => p[1])) - 1; maxZ = Math.max(...points.map(p => p[1])) + 1; }
    const scale = Math.min((width - 54) / (maxX - minX || 1), (height - 54) / (maxZ - minZ || 1));
    const ox = (width - (maxX - minX) * scale) / 2, oy = (height - (maxZ - minZ) * scale) / 2;
    const x = n => ox + (n - minX) * scale, y = n => oy + (n - minZ) * scale;
    if (floor) {
      const fx = floor.lower[0] - floor.mpp / 2, fz = floor.lower[1] - floor.mpp / 2;
      ctx.fillStyle = style.getPropertyValue("--inspector-map-solid");
      ctx.fillRect(x(fx), y(fz), floor.width * floor.mpp * scale, floor.height * floor.mpp * scale);
      ctx.fillStyle = style.getPropertyValue("--inspector-map-floor");
      for (const [col, row, count] of floor.spans) ctx.fillRect(x(fx + col * floor.mpp), y(fz + row * floor.mpp), count * floor.mpp * scale + .3, floor.mpp * scale + .3);
      ctx.strokeStyle = style.getPropertyValue("--inspector-map-edge"); ctx.lineWidth = 1.1; ctx.beginPath();
      for (const [x1, z1, x2, z2] of floor.outline || []) {
        ctx.moveTo(x(fx + x1 * floor.mpp), y(fz + z1 * floor.mpp));
        ctx.lineTo(x(fx + x2 * floor.mpp), y(fz + z2 * floor.mpp));
      }
      ctx.stroke();
    }
    const poses = data.poses.filter(p => p.step <= selectedStep);
    const count = sample?.pos?.length || 0;
    for (let i = 0; i < count; i++) {
      const id = data.pose_agent_ids?.[i];
      ctx.strokeStyle = color(id ?? i); ctx.lineWidth = id === agent ? 3 : 2; ctx.globalAlpha = .65; ctx.beginPath(); let started = false;
      for (const pose of poses) { const p = pose.pos?.[i]; if (!p) continue; if (!started) { ctx.moveTo(x(p[0]), y(p[2])); started = true; } else ctx.lineTo(x(p[0]), y(p[2])); }
      ctx.stroke(); ctx.globalAlpha = 1;
      const p = sample.pos[i]; ctx.fillStyle = color(id ?? i); ctx.beginPath(); ctx.arc(x(p[0]), y(p[2]), id === agent ? 10 : 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = style.getPropertyValue("--card"); ctx.font = "bold 11px system-ui"; ctx.textAlign = "center"; ctx.fillText(id == null ? `s${i}` : String(id), x(p[0]), y(p[2]) + 4);
    }
    for (const goal of goals) { const p = goal.object_xz || goal.xz; ctx.strokeStyle = style.getPropertyValue("--foreground"); ctx.lineWidth = 1.5; ctx.strokeRect(x(p[0]) - 4, y(p[1]) - 4, 8, 8); ctx.fillStyle = style.getPropertyValue("--foreground"); ctx.font = "11px system-ui"; ctx.textAlign = "left"; ctx.fillText(`G${goal.idx}`, x(p[0]) + 7, y(p[1]) + 4); }
    ctx.fillStyle = style.getPropertyValue("--muted-foreground"); ctx.textAlign = "left"; ctx.font = "11px system-ui";
    ctx.fillText(sample ? `Pose step ${sample.step} · X/Z metres${data.pose_agent_ids ? "" : " · pose slots, identity unverified"}` : "No pose at this step", 12, height - 12);
  }

  function showImage(path, note, bbox = null, crop = false) {
    const token = ++frameGeneration;
    frame.replaceChildren(); frameNote.replaceChildren(note, path ? source({ path }) : null);
    if (!path) { frame.append(empty("No captured frame at this step.")); return; }
    const canvas = h("canvas", { class: "inspector-camera", role: "img", "aria-label": `${agentName(agent)} · ${note}` });
    frame.append(canvas);
    const image = new Image();
    image.onload = () => {
      if (!active() || token !== frameGeneration) return;
      const ctx = canvas.getContext("2d"), layout = crop ? data.mosaic_layout : null;
      if (layout && data.agents.includes(agent) && image.naturalWidth === layout.columns * layout.width && image.naturalHeight === Math.ceil(data.agents.length / layout.columns) * (layout.height + layout.header)) {
        canvas.width = layout.width; canvas.height = layout.height;
        ctx.drawImage(image, agent % layout.columns * layout.width, Math.floor(agent / layout.columns) * (layout.height + layout.header) + layout.header, layout.width, layout.height, 0, 0, layout.width, layout.height);
      } else { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; ctx.drawImage(image, 0, 0); if (crop) frameNote.prepend("Combined frame · per-agent crop unavailable. "); }
      if (boxes && bbox && [bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) {
        ctx.strokeStyle = color(agent); ctx.lineWidth = 3; ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
      }
    };
    image.onerror = () => { if (active() && token === frameGeneration) frame.replaceChildren(empty("Captured image is unavailable.")); };
    image.src = fileURL(path);
  }

  function drawFrame() {
    if (phase === "debate") {
      const message = attachment || currentStage()?.messages.find(m => m.agent_id === agent);
      const paths = message?.views || []; const pick = view ?? 0;
      const note = Number.isFinite(message?.observation_step)
        ? `Cached ${directions[pick] || "camera"} view · acquired ${message.observation_step} · ${message.observation_age_steps ?? "unknown"} steps old at request ${message.request_step}`
        : `Same-step captured ${directions[pick] || "camera"} view · request ${message?.request_step ?? "unknown"}`;
      showImage(paths[pick], note);
      return;
    }
    const d = current();
    if (imageMode === "decision") {
      const idx = view ?? (Number.isInteger(d?.raw.frame_idx) ? d.raw.frame_idx : 0);
      const bbox = idx === d?.raw.frame_idx ? d?.raw.bbox : null;
      showImage(d?.views?.[idx], `Decision ${directions[idx] || "camera"} view · request ${d?.request_step ?? "unlogged"}${bbox && boxes ? " · predicted box" : ""}`, bbox);
    } else { const image = data.frames.find(f => f.step === step); showImage(image?.path, `Captured simulator frame · step ${step}`, null, true); }
  }

  function decisionContent() {
    const d = current();
    if (!d) { set(decisionArea, empty("No applied decision is recorded for this agent at or before this step.")); return; }
    const raw = d.raw, la = raw.la_decision || {};
    const claims = (data.result.policy_claims || []).filter(c => c.agent_id === agent && c.step <= step);
    const claim = claims.at(-1);
    set(decisionArea, h("div", { class: "inspector-chips" }, h("span", {}, `Requested ${d.request_step}`), h("span", {}, d.applied_step == null ? "Not applied" : `Applied ${d.applied_step}`)),
      d.attribution_warning ? empty(d.attribution_warning) : null,
      field("Recorded reasoning", la.reasoning || raw.reasoning_action || raw.reasoning),
      field("Chosen action", [raw.action, raw.direction].filter(Boolean).join(" ")),
      raw.bbox?.target ? field("Predicted target", raw.bbox.target) : null,
      field("Policy claim", raw.stop_proposed || la.stop_signal ? raw.reported_claim_goal_id || la.claim_goal_id || "STOP proposed; target not recorded" : "No STOP claim in this decision."),
      claim ? field("Latest evaluator outcome (offline)", `${claim.goal_id || "Goal"} · ${claim.evaluator_valid === true ? "Confirmed" : claim.evaluator_valid === false ? "Rejected" : "Not recorded"} · step ${claim.step}`) : null,
      details("More decision evidence", field("Progress report", raw.progress_analysis || la.progress_analysis),
        field("Visual target reasoning", raw.bbox?.reasoning), source(d.source), source(d.request_source), source(d.application_source),
        h("pre", { class: "inspector-raw" }, JSON.stringify(raw, null, 2))));
  }

  function boardContent() {
    const snapshot = last(data.board.filter(e => e.agent_id === agent), step);
    messagesArea.replaceChildren(snapshot ? h("div", {}, h("p", { class: "inspector-caption" }, `Shared-board snapshot read by Agent ${agent} at request ${snapshot.step}. Report steps are producer labels, not send times.`),
      ...snapshot.records.map(record => h("article", { class: `inspector-message agent-${record.agent_id % 3}` }, h("strong", {}, agentName(record.agent_id)), h("span", { class: "inspector-caption" }, `Report step ${record.step}`), h("p", { class: "inspector-text" }, record.text || "No report recorded."))), source(snapshot.source)) : empty("No shared-board snapshot is recorded at this step."));
  }

  function render() {
    if (!active() || !data) return;
    phaseButtons.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.phase === phase));
    body.dataset.phase = phase;
    stageControls.hidden = phase !== "debate";
    stageControls.querySelector("select").value = stageIndex;
    stageControls.querySelector("[data-stage-info]").textContent = `${currentStage()?.label || "Discussion"} · ${currentStage()?.step == null ? "step unlogged" : "simulator step " + currentStage().step} · ${currentStage()?.completed === true ? "complete" : "completion unrecorded or incomplete"}`;
    stageControls.querySelector("[data-previous-stage]").disabled = stageIndex === 0;
    stageControls.querySelector("[data-next-stage]").disabled = stageIndex >= stages.length - 1;
    chat.hidden = phase !== "debate"; decisionArea.parentElement.hidden = phase === "debate";
    if (phase === "replay") { decisionArea.hidden = panel !== "decision"; messagesArea.hidden = panel !== "messages"; }
    slider.disabled = phase === "debate"; play.disabled = phase === "debate";
    root.querySelector(".inspector-controls").hidden = phase === "debate";
    root.querySelector(".inspector-box-toggle").hidden = phase === "debate";
    root.querySelector(".inspector-thought>header h2").textContent = `Agent ${agent} · recorded state`;
    root.querySelectorAll(".inspector-local-tabs button").forEach(button => button.setAttribute("aria-pressed", button.textContent.toLowerCase() === (panel === "messages" ? "messages" : "decision")));
    stepLabel.textContent = phase === "debate" ? `${currentStage()?.label || "Discussion"} · step ${currentStage()?.step ?? "unlogged"}` : `Simulator step ${step} / ${data.result.steps ?? "?"}`;
    slider.value = step; selectedAgent.value = agent;
    const imageChoice = root.querySelector('[aria-label="Image source"]');
    imageChoice.value = imageMode; imageChoice.hidden = phase === "debate";
    const direction = root.querySelector('[aria-label="Captured camera direction"]');
    direction.value = view ?? (phase === "replay" && Number.isInteger(current()?.raw.frame_idx) ? current().raw.frame_idx : 0);
    drawMap(); drawFrame(); decisionContent(); boardContent();
  }

  function renderTimeline() {
    const items = [
      ...stages.flatMap((stage, index) => stage.messages.map(message => ({ step: message.request_step, agent: message.agent_id, type: `Discussion · ${stage.label} · Round ${message.round}`, text: message.text || "", stageIndex: index, message }))),
      ...data.decisions.map((d, i) => ({ step: d.applied_step ?? d.request_step, agent: d.agent_id, type: d.applied_step == null ? "Unapplied response" : "Decision", text: JSON.stringify(d.raw), decision: i })),
      ...(data.result.policy_claims || []).map(c => ({ step: c.step, agent: c.agent_id, type: c.evaluator_valid === true ? "Confirmed claim" : c.evaluator_valid === false ? "Rejected claim" : "Claim", text: c.goal_id || "" })),
      ...data.board.map(b => ({ step: b.step, agent: b.agent_id, type: "Board snapshot", text: b.records.map(r => r.text).join(" ") })),
    ].filter(e => e.agent === agent && `${e.type} ${e.text}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.step - b.step);
    const list = h("div", { class: "inspector-event-list" });
    for (const e of items.slice(page * 40, page * 40 + 40)) list.append(btn(`${e.step} · ${e.type}${e.type.includes("claim") ? " · " + e.text : ""}`, () => { if (Number.isInteger(e.stageIndex)) { chooseStage(e.stageIndex); attachment = e.message; render(); return; } phase = "replay"; panel = e.type === "Board snapshot" ? "messages" : "decision"; jump(e.step, e.decision ?? null); }, { class: "inspector-event" }));
    timeline.replaceChildren(h("p", { class: "inspector-caption" }, `${items.length} matching events · Agent ${agent}`), list,
      h("div", { class: "inspector-paging" }, btn("Previous", () => { page--; renderTimeline(); }, { disabled: page === 0 }), btn("Next", () => { page++; renderTimeline(); }, { disabled: (page + 1) * 40 >= items.length })));
  }

  function renderChat() {
    const stage = currentStage();
    const mode = h("select", { "aria-label": "Conversation detail" }, h("option", { value: "compact", selected: messageMode === "compact" }, "Compact"), h("option", { value: "full", selected: messageMode === "full" }, "Full shared messages"));
    mode.onchange = event => { messageMode = event.target.value; renderChat(); };
    set(chat, h("header", {}, h("div", {}, h("h2", {}, stage ? `${stage.label} discussion` : "Discussion"),
      h("span", { class: "inspector-caption" }, `${stage?.messages.length || 0} messages`)), mode));
    let round;
    for (const message of stage?.messages || []) {
      if (message.round !== round) { round = message.round; chat.append(h("h3", { class: "inspector-round" }, `Round ${round}`)); }
      const key = `${data.id}${message.source.pointer}`;
      const blocks = splitMessageText(message.text || "No broadcast text recorded.");
      const lead = blocks.find(block => ["Proposed action", "Proposed plan", "Proposed next steps", "Revised plan", "Search plan"].includes(block.label) && block.text)
        || blocks.find(block => block.label === "Reasoning" && block.text)
        || blocks.find(block => block.label && block.text)
        || blocks.find(block => block.text) || { label: null, text: "No broadcast text recorded." };
      const reasoning = blocks.find(block => block.label === "Reasoning" && block.text);
      const content = h("div", { class: "inspector-broadcast-content" });
      const expand = btn("Read whole message", () => {
        if (expandedMessages.has(key)) expandedMessages.delete(key); else expandedMessages.add(key);
        paintContent();
      }, { class: "inspector-chat-action" });
      const paintContent = () => {
        const full = messageMode === "full" || expandedMessages.has(key);
        content.replaceChildren(full ? readableMessage(message.text || "No broadcast text recorded.") :
          h("div", {}, h("section", { class: "inspector-compact-lead" }, lead.label ? h("h4", {}, lead.label) : null,
            h("p", { class: "inspector-text" }, lead.text)),
            reasoning && reasoning !== lead ? h("section", { class: "inspector-compact-lead inspector-compact-reasoning" },
              h("h4", {}, "Reasoning"), h("p", { class: "inspector-text" }, reasoning.text)) : null));
        expand.textContent = full ? "Show less" : "Read whole message";
        expand.setAttribute("aria-expanded", String(full));
        expand.hidden = messageMode === "full" || (blocks.length === 1 && lead.text.length < 90);
      };
      paintContent();
      const cameraLabel = Number.isFinite(message.observation_step)
        ? `Camera · step ${message.observation_step} · ${message.observation_age_steps ?? "?"} ${message.observation_age_steps === 1 ? "step" : "steps"} old`
        : `Camera · request ${message.request_step}`;
      const camera = message.views.some(Boolean) ? btn(cameraLabel, () => { agent = message.agent_id; attachment = message; view = 0; render(); renderTimeline(); }, { class: "inspector-chat-action" }) : null;
      chat.append(h("article", { class: `inspector-message inspector-compact-bubble agent-${message.agent_id % 3}` },
        h("div", { class: "inspector-message-heading" }, h("span", { class: "inspector-avatar", "aria-hidden": "true" }, `A${message.agent_id}`), h("strong", {}, agentName(message.agent_id)),
          message.truncated ? h("span", { class: "inspector-message-badge" }, "Shortened for sharing") : null,
          message.status && message.status !== "ok" ? h("span", { class: "inspector-message-badge" }, message.status) : null,
          message.request_step !== stage.step ? h("span", { class: "inspector-caption" }, `Request ${message.request_step}`) : null),
        content, h("div", { class: "inspector-bubble-actions" }, expand, camera),
        details("Original reply and evidence",
          h("p", { class: "inspector-caption" }, message.truncated ? "The complete raw reply below includes text teammates did not receive." : "Original model reply and recorded delivery metadata."),
          details("Full raw reply", readableMessage(message.raw_text || "No raw reply logged.")),
          field("Image provenance", message.view_note), field("Visible prior messages", JSON.stringify(message.visible_message_ids)),
          field("Returned", message.returned_at), field("Published after round barrier", message.published_at), source(message.source), source(message.request_source))));
    }
  }

  function build() {
    const chooseAgent = id => { agent = Number(id); focus = null; view = null; page = 0; attachment = null; render(); renderTimeline(); };
    selectedAgent = h("select", { "aria-label": "Selected agent" }, data.agents.map(id => h("option", { value: id }, agentName(id)))); selectedAgent.onchange = e => chooseAgent(e.target.value);
    phaseButtons = h("div", { class: "inspector-phase" }, ...(stages.length ? [btn(stages.length > 1 ? "Debate stages" : "Opening debate", () => { const nearest = stages.map((stage, index) => ({ stage, index })).filter(item => item.stage.step <= step).at(-1); chooseStage(phase === "replay" ? nearest?.index ?? 0 : stageIndex); }, { "data-phase": "debate" })] : []), btn("Simulator replay", () => { phase = "replay"; render(); }, { "data-phase": "replay" }));
    const stagePicker = h("select", { "aria-label": "Debate stage" }, stages.map((stage, index) => h("option", { value: index }, `${stage.label}${stage.step == null ? "" : " · step " + stage.step}`)));
    stagePicker.onchange = e => chooseStage(Number(e.target.value));
    stageControls = h("section", { class: "inspector-stage-controls", "aria-label": "Discussion navigation" },
      h("div", { class: "inspector-stage-navigation" }, btn("← Previous", () => chooseStage(stageIndex - 1), { "data-previous-stage": true }), stagePicker,
        btn("Next →", () => chooseStage(stageIndex + 1), { "data-next-stage": true })), h("span", { class: "inspector-caption", "data-stage-info": true }));
    stepLabel = h("strong", { class: "inspector-step" });
    slider = h("input", { type: "range", min: 0, max: data.result.steps || 0, value: step, "aria-label": "Simulator step" }); slider.oninput = e => { stop(); step = Number(e.target.value); focus = null; view = null; render(); };
    speed = h("select", { "aria-label": "Playback speed" }, ...[.25, .5, 1, 1.5, 2].map(value => h("option", { value, selected: value === .5 }, `${value}×`)));
    play = btn("Play", () => { if (timer) { stop(); return; } if (step >= data.result.steps) step = 0; play.textContent = "Pause"; timer = setInterval(() => { if (!active()) { stop(); return; } step = Math.min(data.result.steps, step + 1); focus = null; view = null; render(); if (step >= data.result.steps) stop(); }, 250 / Number(speed.value)); });
    speed.onchange = () => { if (timer) { stop(); play.click(); } };
    const next = direction => { const steps = data.decisions.filter(d => d.agent_id === agent && d.applied_step != null).map(d => d.applied_step).sort((a, b) => a - b); const n = direction > 0 ? steps.find(s => s > step) : steps.filter(s => s < step).at(-1); phase = "replay"; jump(n ?? (direction > 0 ? data.result.steps : 0)); };
    const controls = h("section", { class: "inspector-controls" }, h("div", { class: "inspector-control-row" }, stepLabel, h("div", { class: "inspector-actions" }, btn("← Decision", () => next(-1)), play, btn("Decision →", () => next(1)), speed)), slider);
    map = h("canvas", { class: "inspector-map", role: "img", "aria-label": "Measured trajectories and current agent positions" });
    frame = h("div", { class: "inspector-frame" }); frameNote = h("div", { class: "inspector-caption" });
    const viewChoice = h("select", { "aria-label": "Captured camera direction" }, ...directions.map((name, i) => h("option", { value: i }, name))); viewChoice.onchange = e => { view = Number(e.target.value); if (phase === "replay") imageMode = "decision"; render(); };
    const imageChoice = h("select", { "aria-label": "Image source" }, h("option", { value: "live" }, "Simulator frame"), h("option", { value: "decision" }, "Decision image")); imageChoice.onchange = e => { imageMode = e.target.value; view = null; render(); };
    const boxToggle = h("input", { type: "checkbox", checked: true }); boxToggle.onchange = e => { boxes = e.target.checked; drawFrame(); };
    const mapPanel = h("section", { class: "inspector-panel" }, h("header", {}, h("h2", {}, data.floor ? "Top-down map" : "Positions only"), h("span", { class: "inspector-caption" }, data.floor ? "Navigable floorplan · offline reference" : "Floorplan unavailable")), map,
      h("div", { class: "inspector-legend" }, data.agents.map(id => h("span", { class: `agent-${id % 3}` }, `● ${agentName(id)}`))),
      details("Map evidence", source(data.poses_source), source(data.floor?.source), h("p", {}, "Goal markers and reference floorplan are offline evaluator evidence, not agent observations.")));
    const imagePanel = h("section", { class: "inspector-panel" }, h("header", {}, h("h2", {}, "Egocentric view"), selectedAgent), frame,
      h("div", { class: "inspector-image-controls" }, imageChoice, viewChoice, h("label", { class: "inspector-box-toggle" }, boxToggle, " Predicted boxes")), frameNote);
    chat = h("section", { class: "inspector-panel inspector-chat" });
    renderChat();
    decisionArea = h("div", { class: "inspector-decision" }); messagesArea = h("div", { class: "inspector-decision" });
    const tabs = h("div", { class: "inspector-local-tabs" }, btn("Decision", () => { panel = "decision"; render(); }), btn("Messages", () => { panel = "messages"; render(); }));
    const thought = h("section", { class: "inspector-panel inspector-thought" }, h("header", {}, h("h2", {}, "Recorded agent state")), tabs, decisionArea, messagesArea);
    const side = h("div", {}, chat, thought);
    body = h("div", { class: "inspector-layout" }, h("div", { class: "inspector-visuals" }, mapPanel, imagePanel), side);
    timeline = h("div", {});
    const searchInput = h("input", { type: "search", placeholder: "Search reasoning, messages, actions…", "aria-label": "Search recorded events" }); searchInput.oninput = e => { search = e.target.value; page = 0; renderTimeline(); };
    const eventDetails = details("Search decision timeline", searchInput, timeline);
    set(workspace, phaseButtons, stageControls, controls, body, eventDetails, data.warnings.length ? details("Capture gaps", ...data.warnings.map(w => h("p", {}, w))) : null);
    observer?.disconnect(); observer = new ResizeObserver(() => drawMap()); observer.observe(map);
    render(); renderTimeline();
  }

  const pickerHost = h("div", { class: "inspector-picker" });
  const workspace = h("div", {}, empty("Loading episode evidence…")); root.append(pickerHost, workspace);
  async function load(id) {
    const token = ++generation; stop(); workspace.replaceChildren(empty("Loading episode evidence…"));
    try {
      const next = await request(`${base}/episodes/${encodeURIComponent(id)}`);
      if (!active() || token !== generation) return;
      data = next; stages = data.debate_stages || (data.debate.length ? [{ label: "Opening", kind: "opening", step: data.debate[0]?.request_step, messages: data.debate, completed: true }] : []);
      stageIndex = 0; step = 0; agent = data.agents[0] ?? 0; phase = stages.length ? "debate" : "replay"; attachment = null; focus = null; page = 0; view = null;
      build();
    } catch (error) { if (active() && token === generation) workspace.replaceChildren(empty(error.message)); }
  }
  const theme = () => { if (active() && data) { drawMap(); drawFrame(); } };
  document.addEventListener("rundeck-theme-change", theme);
  try {
    const episodes = supplied || (await request(`${base}/episodes`)).episodes;
    if (!active()) return () => {};
    if (!episodes.length) workspace.replaceChildren(empty("No indexed episode results are available for this run."));
    else {
      if (episodes.length > 1) { const picker = h("select", { "aria-label": "Episode" }, episodes.map(e => h("option", { value: e.id, selected: e.id === episodeId }, e.id))); pickerHost.append(h("label", {}, "Episode ", picker)); picker.onchange = e => load(e.target.value); }
      await load(episodes.some(e => e.id === episodeId) ? episodeId : episodes[0].id);
    }
  } catch (error) { if (active()) workspace.replaceChildren(empty(error.message)); }
  return () => { disposed = true; generation++; frameGeneration++; stop(); observer?.disconnect(); document.removeEventListener("rundeck-theme-change", theme); };
}
