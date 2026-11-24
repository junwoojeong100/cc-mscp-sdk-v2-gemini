#!/usr/bin/env python3
"""Runs one command in a PTY and relays it as JSON lines.

stdin  : {"input": "<base64 bytes to type>"} or {"signal": "SIGTERM"}
stdout : {"output": "<base64 bytes>"} ... then one {"exit": <code>}

The command runs in its own session, and its whole process group is stopped
when it ends or when stdin closes, so nothing is left running.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    spec = json.loads(sys.argv[1])
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))
        os.chdir(spec["cwd"])
        os.execvpe(spec["argv"][0], spec["argv"], spec["env"])

    os.set_blocking(master, False)
    stdin_fd = sys.stdin.fileno()
    os.set_blocking(stdin_fd, False)
    pending = b""
    stdin_open = True
    code = None

    def stop_group(sig):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass

    while True:
        watched = [master] + ([stdin_fd] if stdin_open else [])
        ready, _, _ = select.select(watched, [], [], 0.25)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            emit({"output": base64.b64encode(data).decode()})
        if stdin_fd in ready:
            try:
                chunk = os.read(stdin_fd, 65536)
            except BlockingIOError:
                chunk = None
            if chunk == b"":
                stdin_open = False
                stop_group(signal.SIGTERM)
            elif chunk:
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    if "input" in message:
                        os.write(master, base64.b64decode(message["input"]))
                    elif "signal" in message:
                        stop_group(getattr(signal, message["signal"]))

    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        pass
    stop_group(signal.SIGKILL)
    emit({"exit": code})


if __name__ == "__main__":
    main()
