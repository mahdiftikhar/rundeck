"""Streaming artifact inspection, transfer and trajectory adapters."""

import csv
import io
import json
import os
import re
import tarfile
from codecs import getincrementaldecoder
from importlib import import_module
from itertools import islice
from math import isfinite
from pathlib import Path

from .files import iter_lines, open_file, read_small, strict_json

CHUNK = 64 * 1024
PREVIEW_LIMIT = 256 * 1024
MEDIA = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
}


def identity(stream):
    info = os.fstat(stream.fileno())
    return info, f"{info.st_dev}:{info.st_ino}"


def log_chunk(root, path, *, cursor=None, file_id=None, size=CHUNK):
    with open_file(root, path) as stream:
        info, current = identity(stream)
        reset = cursor is not None and (cursor > info.st_size or file_id != current)
        start = max(0, info.st_size - size) if cursor is None or reset else cursor
        stream.seek(start)
        data = stream.read(size)
        # Leave a partial UTF-8 character for the next live poll.
        decoder = getincrementaldecoder("utf-8")(errors="replace")
        output = decoder.decode(data, final=False)
        end = len(data) - len(decoder.getstate()[0])
        return {
            "text": output,
            "cursor": start + end,
            "file_id": current,
            "reset": reset,
            "has_earlier": start > 0,
            "more": start + end < info.st_size and end == size,
        }


def preview(root, path):
    extension = Path(path).suffix.lower()
    if extension in MEDIA:
        return {"kind": "media", "mime": MEDIA[extension]}
    if extension == ".json":
        try:
            data = strict_json(read_small(root, path, PREVIEW_LIMIT))
            return {"kind": "text", "text": json_display(data), "truncated": False}
        except (ValueError, RecursionError) as exc:
            return {"kind": "notice", "message": f"JSON preview unavailable: {exc}"}
    if extension in {".log", ".out", ".err"}:
        return {"kind": "text", **log_chunk(root, path)}
    if extension in {
        ".csv",
        ".tsv",
        ".jsonl",
        ".txt",
        ".md",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".conf",
    }:
        with open_file(root, path) as stream:
            data = stream.read(PREVIEW_LIMIT + 1)
        if extension in {".csv", ".tsv"}:
            try:
                reader = csv.reader(
                    io.StringIO(data[:PREVIEW_LIMIT].decode("utf-8", "replace")),
                    delimiter="," if extension == ".csv" else "\t",
                    strict=True,
                )
                rows = list(islice(reader, 101))
                return {
                    "kind": "table",
                    "rows": [row[:32] for row in rows[:100]],
                    "truncated": len(data) > PREVIEW_LIMIT
                    or len(rows) > 100
                    or any(len(row) > 32 for row in rows),
                }
            except csv.Error:
                pass
        return {
            "kind": "text",
            "text": data[:PREVIEW_LIMIT].decode("utf-8", "replace"),
            "truncated": len(data) > PREVIEW_LIMIT,
        }
    return {"kind": "notice", "message": "Preview unavailable for this file type."}


def json_display(data):
    return json.dumps(data, ensure_ascii=False, indent=2)


def stream_bytes(stream, count):
    while count:
        data = stream.read(min(CHUNK, count))
        if not data:
            raise OSError("file shortened during transfer")
        yield data
        count -= len(data)


def byte_range(header, size):
    if not header:
        return 0, size, False
    match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", header)
    if not match or not any(match.groups()) or size == 0:
        raise ValueError("unsatisfiable byte range")
    left, right = match.groups()
    if not left:
        start, stop = max(0, size - int(right)), size
    else:
        start = int(left)
        stop = min(size, int(right) + 1) if right else size
    if start >= stop:
        raise ValueError("unsatisfiable byte range")
    return start, stop, True


def tar_stream(files):
    for root, path in files:
        with open_file(root, path) as stream:
            info = os.fstat(stream.fileno())
            header = tarfile.TarInfo(path)
            header.size = info.st_size
            header.mtime = int(info.st_mtime)
            header.mode = 0o644
            yield header.tobuf(format=tarfile.PAX_FORMAT)
            yield from stream_bytes(stream, header.size)
            if padding := -header.size % 512:
                yield b"\x00" * padding
    yield b"\x00" * 1024


def trajectory_records(stream, spec):
    if spec.format == "csv":
        lines = iter_lines(stream)
        first, _ = next(lines, (None, False))
        if first is None:
            raise ValueError("missing or oversized CSV header")
        names = csv_row(first)
        if len(set(names)) != len(names) or any(
            name not in names for name in spec.columns
        ):
            raise ValueError("trajectory columns do not match the CSV header")
        positions = [names.index(name) for name in spec.columns]
        for line, _ in lines:
            try:
                if line is None:
                    yield None
                    continue
                row = csv_row(line)
                yield (
                    [row[position] for position in positions]
                    if len(row) == len(names)
                    else None
                )
            except (ValueError, csv.Error):
                yield None
    elif spec.format == "jsonl":
        for line, _ in iter_lines(stream):
            try:
                row = strict_json(line) if line is not None else None
                yield (
                    [row[key] for key in spec.columns]
                    if isinstance(row, dict)
                    else None
                )
            except (KeyError, ValueError, RecursionError):
                yield None
    else:
        module, function = spec.format.split(":", 1)
        yield from getattr(import_module(module), function)(stream, spec.columns)


def csv_row(line):
    return next(csv.reader([line.decode("utf-8-sig")], strict=True), [])


def trajectory_window(root, path, spec, offset, limit):
    def valid_cell(value):
        if isinstance(value, str):
            return len(value) <= 2048
        if isinstance(value, float):
            return isfinite(value)
        return value is None or isinstance(value, (int, bool))

    rows = []
    has_more = False
    with open_file(root, path) as stream:
        for record in islice(
            trajectory_records(stream, spec), offset, offset + limit + 1
        ):
            if len(rows) == limit:
                has_more = True
                break
            valid = (
                isinstance(record, (list, tuple))
                and len(record) == len(spec.columns)
                and all(map(valid_cell, record))
            )
            rows.append(record if valid else None)
    return {
        "columns": spec.columns,
        "rows": rows,
        "offset": offset,
        "invalid": rows.count(None),
        "has_more": has_more,
    }
