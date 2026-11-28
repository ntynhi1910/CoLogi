import fcntl
import os
import signal
import subprocess
import time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
frontend = root / "frontend"
port = 15174

lock = open("/tmp/cologi-vite-15174.lock", "a")

try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("Watchdog already running.", flush=True)
    raise SystemExit(0)

def port_in_use():
    result = subprocess.check_output(
        ["ss", "-H", "-ltn", f"sport = :{port}"],
        text=True
    )
    return bool(result.strip())

def healthy():
    return subprocess.run(
        [
            "curl", "--noproxy", "*", "-fsS",
            "--max-time", "5",
            f"http://127.0.0.1:{port}/"
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    ).returncode == 0

def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    except ProcessLookupError:
        pass

def shutdown(*args):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, shutdown)

if port_in_use():
    print("Port 15174 already occupied. No duplicate started.")
    raise SystemExit(0)

if not (frontend / "node_modules").exists():
    raise SystemExit("Missing node_modules. Run npm ci first.")

if not (frontend / "vite.codespaces.config.ts").exists():
    raise SystemExit("Missing Vite Codespaces configuration.")

while True:
    print("Starting CoLogi Vite on port 15174...", flush=True)

    process = subprocess.Popen(
        [
            "npm", "run", "dev", "--",
            "--config", "vite.codespaces.config.ts",
            "--host", "127.0.0.1",
            "--port", str(port),
            "--strictPort"
        ],
        cwd=frontend,
        start_new_session=True
    )

    try:
        time.sleep(45)
        failures = 0

        while process.poll() is None:
            failures = 0 if healthy() else failures + 1

            if failures >= 3:
                print("Vite unresponsive. Restarting...", flush=True)
                break

            time.sleep(10)
    finally:
        stop(process)

    time.sleep(3)

    if port_in_use():
        raise SystemExit("Port occupied. Refusing duplicate startup.")
