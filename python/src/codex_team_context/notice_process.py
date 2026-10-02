"""Bounded E03 child lifecycle and conservative cleanup of owned Windows locks."""
from __future__ import annotations
import ctypes
import json
import os
import signal
import subprocess
import time
from pathlib import Path

MAX_BYTES = 1024 * 1024

class WindowsJob:
    def __init__(self, process):
        from ctypes import wintypes as w
        class BASIC(ctypes.Structure):
            _fields_ = [("perProcess", ctypes.c_longlong), ("perJob", ctypes.c_longlong), ("flags", w.DWORD),
                        ("min", ctypes.c_size_t), ("max", ctypes.c_size_t), ("active", w.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("r", "w", "o", "rb", "wb", "ob")]
        class EXTENDED(ctypes.Structure):
            _fields_ = [("basic", BASIC), ("io", IO), ("pm", ctypes.c_size_t), ("jm", ctypes.c_size_t),
                        ("peakp", ctypes.c_size_t), ("peakj", ctypes.c_size_t)]
        self.k = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.k.CreateJobObjectW.restype = w.HANDLE
        self.k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.k.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "Cannot create E03 process job")
        info = EXTENDED(); info.basic.flags = 0x2000  # kill on close
        if not self.k.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not self.k.AssignProcessToJobObject(self.handle, w.HANDLE(int(process._handle))):
            self.close()
            raise OSError(ctypes.get_last_error(), "Cannot contain E03 process tree")

    def terminate(self):
        if not self.k.TerminateJobObject(self.handle, 1):
            raise OSError(ctypes.get_last_error(), "Cannot stop E03 job")

    def empty(self):
        from ctypes import wintypes as w
        class ACCOUNTING(ctypes.Structure):
            _fields_ = [(n, ctypes.c_longlong) for n in ("user", "kernel", "pu", "pk")] + [(n, w.DWORD) for n in ("faults", "total", "active", "terminated")]
        info=ACCOUNTING()
        return bool(self.k.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None)) and info.active == 0

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle); self.handle = None

def _delete_owned_windows(path: str, owner: dict) -> bool:
    """Read/check and mark deletion through ONE handle, never check-then-unlink."""
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    k.CreateFileW.restype = w.HANDLE
    k.ReadFile.argtypes = [w.HANDLE, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p]
    k.SetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    k.CloseHandle.argtypes = [w.HANDLE]
    handle = k.CreateFileW(path, 0x80000000 | 0x10000, 7, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        return not Path(path).exists()
    try:
        buffer = ctypes.create_string_buffer(8192); count = w.DWORD()
        if not k.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None) or count.value == len(buffer):
            return False
        try:
            actual = json.loads(buffer.raw[:count.value].decode("utf-8"))
        except (ValueError, UnicodeError):
            return False
        if actual != owner:
            return False
        delete = w.BOOL(True)
        return bool(k.SetFileInformationByHandle(handle, 4, ctypes.byref(delete), ctypes.sizeof(delete)))
    finally:
        k.CloseHandle(handle)

def cleanup_owned(stderr: bytes, token: str, allowed_paths: set[str], *, read_only: bool = False) -> str:
    allowed = {os.path.normcase(os.path.abspath(p)) for p in allowed_paths}
    if not read_only and os.name == "nt":
        for line in stderr.decode("utf-8", errors="replace").splitlines():
            try:
                owner = json.loads(line)["e03Lock"]
                path = owner["path"]
                if owner["token"] != token or os.path.normcase(os.path.abspath(path)) not in allowed:
                    continue
                _delete_owned_windows(path, owner)
            except (ValueError, KeyError, TypeError, OSError):
                continue
    # Missing ownership report, an unknown/legacy lock, POSIX path-replacement
    # races, or a live contender all fail closed. No age/PID-based deletion.
    return "required" if any(Path(p).exists() for p in allowed_paths) else "complete"

def invoke_notice_process(argv, payload: bytes, env, token: str, allowed_paths: set[str], *, read_only=False, timeout=10, cleanup_timeout=3):
    def error(code, **extra):
        return {"status":"error", "reasonCode":code, "readOnly":read_only, "hostActionExecuted":False, **extra}
    proc = None; job = None
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, shell=False, start_new_session=os.name != "nt",
                                creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        # Node reads no request until job assignment completes.
        if os.name == "nt":
            job = WindowsJob(proc)
        try:
            stdout, stderr = proc.communicate(payload, timeout=timeout)
        except subprocess.TimeoutExpired:
            if job:
                job.terminate()
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            try:
                stdout, stderr = proc.communicate(timeout=cleanup_timeout)
            except subprocess.TimeoutExpired:
                return error("EXECUTION_RECOVERY_REQUIRED",executionEnded=False,mutationUnknown=not read_only,cleanupStatus="required")
            ended = proc.poll() is not None and (job.empty() if job else True)
            if not ended:
                return error("EXECUTION_RECOVERY_REQUIRED",executionEnded=False,mutationUnknown=not read_only,cleanupStatus="required")
            cleanup = cleanup_owned(stderr,token,allowed_paths,read_only=read_only)
            return error("BRIDGE_TIMEOUT",executionEnded=True,mutationUnknown=not read_only,cleanupStatus=cleanup,nextAction="notice_status" if cleanup == "complete" else "recover-owned-locks")
        def failed_response(code):
            # An abnormal exit can leave the same owned locks as a timeout.
            # Close the whole tree before any cleanup, including descendants
            # that closed their stdio streams before their parent exited.
            if job and not job.empty():
                job.terminate()
                deadline = time.monotonic() + cleanup_timeout
                while not job.empty() and time.monotonic() < deadline:
                    time.sleep(.01)
                if not job.empty():
                    return error("EXECUTION_RECOVERY_REQUIRED",executionEnded=False,mutationUnknown=not read_only,cleanupStatus="required")
            elif not job:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            cleanup = cleanup_owned(stderr,token,allowed_paths,read_only=read_only)
            return error(code,executionEnded=True,mutationUnknown=not read_only,cleanupStatus=cleanup,
                         nextAction="notice_status" if cleanup == "complete" else "recover-owned-locks")
        if len(stdout) > MAX_BYTES or len(stderr) > MAX_BYTES:
            return failed_response("PAYLOAD_TOO_LARGE")
        try:
            from .notice import strict_json
            result = strict_json(stdout.decode("utf-8", errors="strict"))
            if not isinstance(result,dict) or result.get("hostActionExecuted") is not False:
                raise ValueError("Invalid adapter response")
            if proc.returncode != 0:
                return failed_response("RUNTIME_UNAVAILABLE")
            if result.get("status") == "error" and result.get("mutationUnknown"):
                result.update({key:value for key,value in failed_response(result.get("reasonCode","RUNTIME_UNAVAILABLE")).items()
                               if key in {"executionEnded","cleanupStatus","nextAction"}})
            return result
        except (ValueError, UnicodeError):
            return failed_response("RUNTIME_UNAVAILABLE")
    except (OSError, subprocess.SubprocessError):
        return error("RUNTIME_UNAVAILABLE",mutationUnknown=proc is not None and not read_only,nextAction="inspect-bridge")
    finally:
        if job:
            job.close()
        if proc is not None and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=cleanup_timeout)
            except subprocess.TimeoutExpired:
                pass
