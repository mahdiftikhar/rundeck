import { useLayoutEffect, useRef } from "react";
import { drawMap } from "./draw-map.js";
import { useThemeRevision } from "./theme.js";
import { Details, Panel, SourceLink } from "./primitives.jsx";
import { agentName } from "./model.js";

export function MapPanel({ data, step, agent }) {
  const canvas = useRef(null);
  const theme = useThemeRevision();
  useLayoutEffect(() => {
    const map = canvas.current;
    const draw = () => drawMap(map, data, step, agent);
    const observer = new ResizeObserver(draw);
    observer.observe(map);
    draw();
    return () => observer.disconnect();
  }, [data, step, agent, theme]);

  return <Panel title={data.floor ? "Top-down map" : "Positions only"}
    heading={<span className="inspector-caption">{data.floor ? "Navigable floorplan · offline reference" : "Floorplan unavailable"}</span>}>
    <canvas ref={canvas} className="inspector-map" role="img" aria-label="Measured trajectories and current agent positions" />
    <div className="inspector-legend">{data.agents.map(id => <span key={id} className={`agent-${id % 3}`}>● {agentName(id)}</span>)}</div>
    <p className="inspector-map-goal-key inspector-caption">Goal markers: ■ found · □ not found · ? unknown. Final evaluator outcomes; see Episode goals.</p>
    <Details name="Map evidence"><SourceLink evidence={data.poses_source} /><SourceLink evidence={data.floor?.source} />
      <p>Goal markers and reference floorplan are offline evaluator evidence, not agent observations.</p>
    </Details>
  </Panel>;
}
