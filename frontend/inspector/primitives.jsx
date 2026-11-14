import { createContext, useContext } from "react";

export const EvidenceContext = createContext("");
export const fileURL = (base, path) => `${base}/file?path=${encodeURIComponent(path)}`;

export function SourceLink({ evidence }) {
  const base = useContext(EvidenceContext);
  if (!evidence) return null;
  const fragment = evidence.line ? `#L${evidence.line}` : "";
  const label = evidence.line ? `Source · line ${evidence.line}` : evidence.pointer ? `Source · ${evidence.pointer}` : "Source evidence";
  return <a href={`${fileURL(base, evidence.path)}${fragment}`} target="_blank" rel="noopener" className="inspector-source">{label}</a>;
}

export function Button({ children, ...props }) {
  return <button type="button" {...props}>{children}</button>;
}

export function Empty({ children }) {
  return <p className="inspector-empty">{children}</p>;
}

export function Field({ name, value }) {
  return <section className="inspector-field"><h3>{name}</h3>
    {value ? <p className="inspector-text">{value}</p> : <Empty>Not recorded.</Empty>}
  </section>;
}

export function Details({ name, children, ...props }) {
  return <details className="inspector-details" {...props}><summary>{name}</summary>{children}</details>;
}

export function Panel({ title, subtitle, heading, className = "", children, ...props }) {
  return <section className={`inspector-panel ${className}`} {...props}>
    <header>{subtitle != null ? <div><h2>{title}</h2><span className="inspector-caption">{subtitle}</span></div> : <h2>{title}</h2>}{heading}</header>{children}
  </section>;
}
