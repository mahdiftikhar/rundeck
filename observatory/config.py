import os
import tomllib
from pathlib import Path

from pydantic import Field, model_validator

from .models import Contract, Direction, RelativePath, RunID


class MetricStyle(Contract):
    label: str | None = None
    unit: str | None = None
    direction: Direction | None = None
    chart: bool = True


class Trajectory(Contract):
    pattern: str
    format: str = Field(
        pattern="^(csv|jsonl|[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*)$"
    )
    columns: list[str] = Field(min_length=1, max_length=16)


class Source(Contract):
    name: RunID
    root: Path
    glob: str = "*"
    group: str | None = None
    default_status: str = Field(
        default="interrupted", pattern="^(running|completed|failed|interrupted)$"
    )
    marker: RelativePath | None = None
    metadata: RelativePath | None = None
    metadata_fields: dict[str, str] = Field(default_factory=dict)
    metrics: RelativePath | None = "metrics.jsonl"
    metrics_format: str = Field(default="jsonl", pattern="^(jsonl|json-map)$")
    log: RelativePath | None = "run.log"
    baseline: RunID | None = None
    evidence_root: Path | None = None
    evidence_paths: list[RelativePath] = Field(default_factory=list)
    metrics_style: dict[str, MetricStyle] = Field(default_factory=dict)
    sections: dict[str, str] = Field(default_factory=dict)
    trajectories: list[Trajectory] = Field(default_factory=list)

    def manifest_defaults(self):
        return {"group": self.group, "metrics": self.metrics, "log": self.log}


class Settings(Contract):
    database: Path
    scan_seconds: int = Field(default=15, ge=1)
    sources: list[Source] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_sources(self):
        if len({source.name for source in self.sources}) != len(self.sources):
            raise ValueError("source names must be unique")
        for source in self.sources:
            if Path(source.glob).is_absolute() or ".." in Path(source.glob).parts:
                raise ValueError("source glob must stay inside its root")
        return self

    def source(self, name: str) -> Source:
        return next(source for source in self.sources if source.name == name)


def load_settings(path: Path | None = None) -> Settings:
    configured = path or os.environ.get("OBS_CONFIG")
    path = Path(configured or "observatory.toml").resolve()
    try:
        raw = tomllib.loads(path.read_text())
    except FileNotFoundError:
        if configured:
            raise
        raw = {}
    raw["database"] = (
        path.parent / raw.get("database", ".observatory/index.sqlite3")
    ).resolve()
    for source in raw.get("sources", []):
        source["root"] = (path.parent / source["root"]).resolve()
        if source.get("evidence_root"):
            source["evidence_root"] = (path.parent / source["evidence_root"]).resolve()
    return Settings.model_validate(raw)
