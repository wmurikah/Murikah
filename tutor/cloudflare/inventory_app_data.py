#!/usr/bin/env python3
"""Summarise Tutor /app/data without printing file contents or secrets."""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import os
import sys

SQLITE_MAGIC = b"SQLite format 3\x00"
LARGE_FILE_BYTES = 50 * 1024 * 1024


def human_bytes(value: int) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{value} B"


def is_sqlite(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(len(SQLITE_MAGIC)) == SQLITE_MAGIC
    except OSError:
        return False


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "tutor/.codespaces-data").resolve()
    if not root.is_dir():
        print(f"ERROR: data directory not found: {root}", file=sys.stderr)
        return 2

    total_files = 0
    total_bytes = 0
    top_counts: dict[str, int] = defaultdict(int)
    top_bytes: dict[str, int] = defaultdict(int)
    sqlite_files: list[tuple[str, int]] = []
    large_files: list[tuple[str, int]] = []
    symlinks: list[str] = []
    extension_counts: dict[str, int] = defaultdict(int)

    for base, dirs, files in os.walk(root, followlinks=False):
        base_path = Path(base)
        for name in list(dirs):
            candidate = base_path / name
            if candidate.is_symlink():
                symlinks.append(candidate.relative_to(root).as_posix())
        for name in files:
            path = base_path / name
            rel = path.relative_to(root)
            if path.is_symlink():
                symlinks.append(rel.as_posix())
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue

            total_files += 1
            total_bytes += size
            top = rel.parts[0] if rel.parts else "."
            top_counts[top] += 1
            top_bytes[top] += size
            suffix = path.suffix.lower() or "<none>"
            extension_counts[suffix] += 1

            if size >= LARGE_FILE_BYTES:
                large_files.append((rel.as_posix(), size))
            if size >= len(SQLITE_MAGIC) and is_sqlite(path):
                sqlite_files.append((rel.as_posix(), size))

    print("Murikah Tutor data inventory")
    print(f"Root: {root}")
    print(f"Files: {total_files}")
    print(f"Total size: {human_bytes(total_bytes)}")

    print("\nTop-level storage")
    for name in sorted(top_counts):
        print(f" - {name}: {top_counts[name]} files, {human_bytes(top_bytes[name])}")

    print("\nSQLite databases detected")
    if sqlite_files:
        for rel, size in sorted(sqlite_files):
            print(f" - {rel}: {human_bytes(size)}")
    else:
        print(" - none detected by SQLite file signature")

    print("\nLarge files (>= 50 MiB)")
    if large_files:
        for rel, size in sorted(large_files, key=lambda item: item[1], reverse=True):
            print(f" - {rel}: {human_bytes(size)}")
    else:
        print(" - none")

    print("\nMost common file extensions")
    for suffix, count in sorted(extension_counts.items(), key=lambda item: (-item[1], item[0]))[:20]:
        print(f" - {suffix}: {count}")

    print("\nSymlinks")
    if symlinks:
        for rel in sorted(set(symlinks)):
            print(f" - {rel}")
    else:
        print(" - none")

    print("\nNo file contents were read beyond the 16-byte SQLite signature check.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
