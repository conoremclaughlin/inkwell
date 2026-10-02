"""Owned synthetic TUI fixture: no real HOME, no credentials, no model tools."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 150, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
print(json.dumps({'pid': child.pid}), flush=True)
try:
    deadline = time.monotonic() + 100
    while child.poll() is None and time.monotonic() < deadline:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')
            print(json.dumps({'output': data.decode(errors='replace')}), flush=True)
        if sys.stdin in ready:
            line = sys.stdin.readline()
            if not line:
                break
            value = json.loads(line)
            if value.get('stop'):
                break
            os.write(master, value.get('write', '').encode())
finally:
    # Only the Popen child created by this helper is ever signalled.
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
