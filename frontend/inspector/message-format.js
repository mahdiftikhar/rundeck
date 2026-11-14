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
