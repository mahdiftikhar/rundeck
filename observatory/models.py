"""Versioned contracts shared by the CLI, index and presentation layer."""

import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    FiniteFloat,
    JsonValue,
    model_validator,
)

Status = Literal["running", "completed", "failed", "interrupted"]
Direction = Literal["higher", "lower", "neutral"]
Nonempty = Annotated[str, Field(pattern=r"\S", max_length=20000)]


def run_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise ValueError(
            "expected a run ID of up to 128 letters, digits, dots, underscores or hyphens"
        )
    return value


def relative_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not path.parts
        or path.is_absolute()
        or ".." in path.parts
        or str(path) != value
        or "\x00" in value
    ):
        raise ValueError("expected a normalized, run-relative path")
    return value


def version(value):
    if type(value) is not int:
        raise ValueError("schema_version must be an integer")
    return value


Version = Annotated[Literal[1], BeforeValidator(version)]
RunID = Annotated[str, AfterValidator(run_id)]
RelativePath = Annotated[str, AfterValidator(relative_path)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Reproducibility(Contract):
    command: str | None = None
    git_commit: str | None = None
    config: dict[str, JsonValue] = Field(default_factory=dict)
    seed: int | None = None
    environment: dict[str, str] = Field(default_factory=dict)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    exit_code: int | None = None

    @model_validator(mode="after")
    def check_times(self):
        for stamp in (self.started_at, self.ended_at):
            if stamp is not None and stamp.utcoffset() is None:
                raise ValueError("timestamps must include a timezone")
        if self.started_at and self.ended_at and self.ended_at < self.started_at:
            raise ValueError("ended_at precedes started_at")
        return self


class Artifact(Contract):
    path: RelativePath
    label: str | None = None


class Run(Contract):
    schema_version: Version = 1
    id: RunID
    title: Nonempty
    status: Status
    group: str | None = None
    tags: list[str] = Field(default_factory=list)
    tmux_pane: str | None = None
    log: RelativePath | None = None
    metrics: RelativePath | None = None
    artifacts: list[Artifact] = Field(default_factory=list)
    reproducibility: Reproducibility = Field(default_factory=Reproducibility)

    @model_validator(mode="after")
    def check_execution(self):
        code = self.reproducibility.exit_code
        if code is not None and self.status != ("completed" if code == 0 else "failed"):
            raise ValueError("exit code conflicts with execution status")
        if self.status == "running" and self.reproducibility.ended_at:
            raise ValueError("running execution cannot have an end timestamp")
        return self


class Metric(Contract):
    name: Nonempty
    value: FiniteFloat
    unit: str = ""
    direction: Direction = "neutral"
    episode: Nonempty | None = None


class Evidence(Contract):
    path: RelativePath
    detail: Nonempty | None = None


class Finding(Contract):
    text: Nonempty
    evidence: list[Evidence] = Field(min_length=1)


class Report(Contract):
    schema_version: Version
    run_id: RunID
    baseline: RunID | None = None
    objective: Nonempty | None = None
    hypothesis: Nonempty | None = None
    methodology: Nonempty | None = None
    reproducibility: Reproducibility = Field(default_factory=Reproducibility)
    results: list[Metric] = Field(default_factory=list)
    baseline_results: list[Metric] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    limitations: list[Nonempty] = Field(default_factory=list)
    next_steps: list[Nonempty] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    sections: dict[str, Nonempty] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_results(self):
        for dataset in (self.results, self.baseline_results):
            keys = {(row.name, row.episode) for row in dataset}
            if len(keys) != len(dataset):
                raise ValueError("duplicate metric and episode")
        if self.baseline == self.run_id:
            raise ValueError("baseline must be another run")
        if self.baseline_results and self.baseline is None:
            raise ValueError("baseline results require a baseline run ID")
        return self
