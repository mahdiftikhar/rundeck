import { useEffect, useState } from "react";

export function agentColor(id) {
  const style = getComputedStyle(document.documentElement);
  return style.getPropertyValue(["--inspector-a", "--inspector-b", "--inspector-c"][Math.abs(id) % 3]).trim();
}

export function useThemeRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision(value => value + 1);
    document.addEventListener("rundeck-theme-change", update);
    return () => document.removeEventListener("rundeck-theme-change", update);
  }, []);
  return revision;
}
