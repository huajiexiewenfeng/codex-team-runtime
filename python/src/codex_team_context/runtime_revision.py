"""Bounded diagnostic labels from explicit config or one matching installation.

Installation metadata is an operator declaration, never integrity or admission proof.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .core import ContextError


def _valid_label(value: object) -> bool:
    return (
        isinstance(value, str) and bool(value.strip()) and len(value) <= 512
        and all(ord(c) >= 32 and not 0xD800 <= ord(c) <= 0xDFFF for c in value)
    )


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate metadata key")
        result[key] = value
    return result


def resolve_runtime_revision(
    runtime_root: str | Path | None, explicit: str | None = None,
) -> str | None:
    """Explicit config wins; otherwise read only runtimeRoot/../installation.json.

    Missing/invalid metadata or unknown dirty status stays unknown. A local patch
    is a declared label, independent of sourceDirty, and never a verified digest.
    """
    if explicit is not None:
        if not _valid_label(explicit):
            raise ContextError("INVALID_RUNTIME_CONFIG", "runtime_revision must be a bounded JSON-safe operator declaration")
        return explicit
    if runtime_root is None:
        return None
    try:
        configured = Path(runtime_root)
        if not configured.is_absolute():
            return None
        root = configured.resolve(strict=True)
        if not root.is_dir():
            return None
        metadata = root.parent / "installation.json"
        if not metadata.is_file():
            return None
        with metadata.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            return None
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(data, dict):
            return None
        declared_root = data.get("runtimeRoot")
        if not isinstance(declared_root, str) or not Path(declared_root).is_absolute():
            return None
        if os.path.normcase(str(Path(declared_root).resolve(strict=True))) != os.path.normcase(str(root)):
            return None
        revision, dirty = data.get("revision"), data.get("sourceDirty")
        if not isinstance(revision, str) or re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", revision) is None:
            return None
        if type(dirty) is not bool:
            return None
        patch = data.get("localPatch")
        if patch not in (None, ""):
            if not isinstance(patch, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", patch) is None:
                return None
            revision += "+" + patch
        return revision + ("+dirty" if dirty else "")
    except (OSError, ValueError, RuntimeError):
        # Version diagnostics must not turn unavailable metadata into startup failure.
        return None
