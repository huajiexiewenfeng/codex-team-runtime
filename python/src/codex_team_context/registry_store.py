"""Atomic single-file persistence for the schema-v2 team registry."""

from __future__ import annotations

import errno
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

from .core import ContextError


T = TypeVar("T")


def _fail(code: str, message: str) -> None:
    raise ContextError(code, message)


class RegistryStore:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def read(self) -> Any:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            _fail("REGISTRY_MISSING", f"Registry is missing: {self.path}")
        except (OSError, UnicodeError) as exc:
            _fail("REGISTRY_CORRUPT", f"Cannot read registry {self.path}: {exc}")
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            _fail("REGISTRY_CORRUPT", f"Invalid registry JSON: {exc}")

    def transact(self, callback: Callable[[Any], tuple[T, bool]]) -> T:
        lock_path = Path(f"{self.path}.lock")
        descriptor: int | None = None
        deadline = time.monotonic() + 5.0
        while descriptor is None:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if time.monotonic() >= deadline:
                    _fail("REGISTRY_BUSY", f"Registry lock is busy: {lock_path}")
                time.sleep(0.01)
            except PermissionError as exc:
                if exc.errno == errno.EACCES and time.monotonic() < deadline:
                    time.sleep(0.01)
                    continue
                _fail("REGISTRY_LOCK_FAILED", f"Cannot lock registry {self.path}: {exc}")
            except OSError as exc:
                _fail("REGISTRY_LOCK_FAILED", f"Cannot lock registry {self.path}: {exc}")
        try:
            os.write(descriptor, str(os.getpid()).encode("ascii"))
            value = self.read()
            result, changed = callback(value)
            if changed:
                self._replace(value)
            return result
        finally:
            os.close(descriptor)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                # Never broaden cleanup or guess that another lock is stale.
                pass

    def _replace(self, value: Any) -> None:
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                json.dump(
                    value, stream, ensure_ascii=False, allow_nan=False, sort_keys=True,
                    separators=(",", ":"),
                )
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(21):
                try:
                    os.replace(temporary, self.path)
                    temporary = None
                    return
                except PermissionError as exc:
                    if exc.errno == errno.EACCES and attempt < 20:
                        time.sleep(0.01)
                        continue
                    raise
        except (OSError, TypeError, ValueError) as exc:
            _fail("REGISTRY_WRITE_FAILED", f"Cannot atomically write registry {self.path}: {exc}")
        finally:
            if temporary is not None:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
