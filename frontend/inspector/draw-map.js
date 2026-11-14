import { last } from "./model.js";
import { agentColor } from "./theme.js";

const color = agentColor;

export function drawMap(map, data, selectedStep, agent) {
  const rect = map.getBoundingClientRect();
  const width = Math.max(300, rect.width), height = width / 1.45;
  const ratio = devicePixelRatio || 1;
  map.width = width * ratio; map.height = height * ratio;
  const ctx = map.getContext("2d"); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const style = getComputedStyle(document.documentElement), floor = data.floor;
  ctx.fillStyle = style.getPropertyValue("--background"); ctx.fillRect(0, 0, width, height);
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
