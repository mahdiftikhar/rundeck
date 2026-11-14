# Episode inspector

The dashboard mounts this React island through `mountInspector` in `index.jsx`.
The returned cleanup unmounts React, cancels requests, stops playback, disconnects
resize observers and removes theme listeners. The rest of the dashboard still
uses its existing JavaScript entry point.

- `EpisodeInspector.jsx` composes the debate/replay workspace and dispatches user actions.
- `state.js` owns state transitions; `model.js` selects recorded decisions, frames,
  stages and timeline events without creating missing evidence.
- `MapPanel.jsx` and `CameraPanel.jsx` share the visual column in both phases.
  Canvas drawing remains isolated in `draw-map.js`; image loading cancels stale callbacks.
- `PlaybackControls.jsx`, `Messages.jsx`, `AgentStatePanel.jsx` and
  `DecisionTimeline.jsx` render their respective panels.
- `primitives.jsx` provides shared panels, buttons, fields, expandable evidence
  and source links. `message-format.js` parses recorded labels and view lists;
  React renders their content as text, never HTML.
- `theme.js` handles redraws when dashboard theme colors change.

From the Rundeck checkout, using Node.js 22+ and npm:

```bash
npm ci
npm run build:inspector
npm run test:inspector
```

`npm run build` also builds this inspector. Edit source files here, then rebuild;
`observatory/static/inspector.js` is a generated bundle served by the existing
Python server. No Vite development server is required.

For this project's pinned installation, also refresh
`sim-code/scripts/rundeck/rundeck.patch` from the pinned upstream revision,
including newly added frontend source files. Keep source and bundle together so
setup can restore both without requiring Node to browse experiments.
