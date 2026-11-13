"""Bounded reads and atomic metadata writes on Unix."""

import json
import math
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from secrets import token_hex

from .models import relative_path

MAX_JSON = 4 * 1024 * 1024
MAX_LINE = 128 * 1024


@contextmanager
def open_directory(path: Path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open("/", flags)
    try:
        for part in path.absolute().parts[1:]:
            if part == "..":
                raise ValueError("directory path must be normalized")
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        yield directory
    finally:
        os.close(directory)


@contextmanager
def open_file(root: Path, relative: str):
    parts = relative_path(relative).split("/")
    with open_directory(root.joinpath(*parts[:-1])) as directory:
        fd = os.open(
            parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory
        )
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError("expected a regular file")
            yield stream


def read_small(root: Path, relative: str, limit: int = MAX_JSON) -> bytes:
    with open_file(root, relative) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{relative} exceeds {limit} bytes")
    return data


def strict_json(data):
    def invalid_constant(value):
        raise ValueError(f"invalid JSON constant {value}")

    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key}")
            result[key] = value
        return result

    def finite_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("JSON number is outside the finite float range")
        return parsed

    return json.loads(
        data,
        parse_constant=invalid_constant,
        parse_float=finite_float,
        object_pairs_hook=unique_pairs,
    )


def atomic_json(path: Path, value):
    data = (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    ).encode()
    if len(data) > MAX_JSON:
        raise ValueError("metadata exceeds size limit")
    with open_directory(path.parent) as directory:
        tmp = ".observatory-" + token_hex(16)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp, path.name, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
        finally:
            try:
                os.unlink(tmp, dir_fd=directory)
            except FileNotFoundError:
                pass


def iter_lines(stream):
    """Yield complete or partial lines with bounded allocation."""
    while line := stream.readline(MAX_LINE + 1):
        if len(line) > MAX_LINE:
            while line and not line.endswith(b"\n"):
                line = stream.readline(MAX_LINE + 1)
            yield None, True
        else:
            yield line, line.endswith(b"\n")
