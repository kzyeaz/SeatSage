"""Start both local demo servers. Usage: python scripts/dev.py --setup"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
NPM = shutil.which("npm")


def main():
    parser = argparse.ArgumentParser(description="Run the SeatSage local demo")
    parser.add_argument("--setup", action="store_true", help="Install dependencies before starting")
    args = parser.parse_args()
    if not NPM:
        raise SystemExit("Install Node.js 22+ first (https://nodejs.org).")
    if args.setup:
        if not PYTHON.exists():
            subprocess.run([sys.executable, "-m", "venv", str(ROOT / ".venv")], check=True)
        subprocess.run([str(PYTHON), "-m", "pip", "install", "-r", str(ROOT / "api/requirements.txt")], check=True)
        subprocess.run([NPM, "ci"], cwd=ROOT / "web", check=True)
    if not PYTHON.exists() or not (ROOT / "web/node_modules").exists():
        raise SystemExit("Run: python scripts/dev.py --setup")
    env = {**os.environ, "PYTHONPATH": str(ROOT / "api"), "APP_MODE": "local", "DATABASE_URL": ""}
    processes = []
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    try:
        processes.append(subprocess.Popen(
            [str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000",
             "--reload", "--reload-dir", str(ROOT / "api" / "app")],
            cwd=ROOT, env=env, creationflags=flags,
        ))
        processes.append(subprocess.Popen([NPM, "run", "dev"], cwd=ROOT / "web", creationflags=flags))
        print("\nSeatSage: http://localhost:5173\nAPI docs: http://localhost:8000/docs\nPress Ctrl+C to stop.\n", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nStopping SeatSage…")
    finally:
        for process in processes:
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    process.send_signal(signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    main()
