#!/usr/bin/env python3
"""
Runs a command on a real pty and relays it over plain pipes.

Node has no pty API, and macOS `script` refuses to run unless its own stdin is
a tty, which rules it out for a scripted driver. This bridge is the missing
piece: the child gets a pty with a fixed window size, while the driver keeps
ordinary pipes and full control of the keyboard.

    pty-bridge.py <cols> <rows> <command> [args...]

stdin  → keystrokes, forwarded verbatim to the pty
stdout → everything the child painted
Exits with the child's status.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def main() -> int:
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty-bridge.py <cols> <rows> <command> [args...]\n")
        return 2

    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]

    pid, master = pty.fork()
    if pid == 0:
        # Child: the pty is already stdin/stdout/stderr. Make the size it will
        # report match what the driver asked for, since a TUI lays out from it.
        os.environ["COLUMNS"] = str(cols)
        os.environ["LINES"] = str(rows)
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            sys.stderr.write(f"pty-bridge: cannot exec {argv[0]}: {error}\n")
            os._exit(127)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    open_fds = [master, stdin_fd]

    while master in open_fds:
        try:
            readable, _, _ = select.select(open_fds, [], [], 0.2)
        except InterruptedError:
            continue

        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(stdout_fd, data)

        if stdin_fd in readable:
            try:
                keys = os.read(stdin_fd, 65536)
            except OSError:
                keys = b""
            if not keys:
                # The driver is done sending. Keep draining the child rather
                # than closing its input, which a TUI reads as "quit".
                open_fds.remove(stdin_fd)
            else:
                os.write(master, keys)

    os.close(master)
    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(128 + signal.SIGINT)
