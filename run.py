from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
BACKEND_VENV_PYTHON = BACKEND_DIR / ".venv" / "bin" / "python"


def backend_python() -> str:
    if BACKEND_VENV_PYTHON.exists():
        return str(BACKEND_VENV_PYTHON)
    return sys.executable


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def find_free_port(host: str, preferred_port: int) -> int:
    port = preferred_port
    while port < preferred_port + 100:
        if port_is_free(host, port):
            return port
        port += 1
    raise RuntimeError(f"空いているポートが見つかりませんでした: {preferred_port}-{preferred_port + 99}")


def start_process(name: str, command: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.Popen:
    print(f"[{name}] starting: {' '.join(command)}", flush=True)
    return subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        start_new_session=True,
    )


def stop_processes(processes: list[tuple[str, subprocess.Popen]]) -> None:
    for name, process in processes:
        if process.poll() is None:
            print(f"[{name}] stopping", flush=True)
            os.killpg(process.pid, signal.SIGTERM)

    deadline = time.time() + 5
    for name, process in processes:
        while process.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        if process.poll() is None:
            print(f"[{name}] force stopping", flush=True)
            os.killpg(process.pid, signal.SIGKILL)


def url_is_ready(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=0.5):
            return True
    except (OSError, urllib.error.URLError):
        return False


def wait_for_url(url: str, processes: list[tuple[str, subprocess.Popen]], timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for name, process in processes:
            exit_code = process.poll()
            if exit_code is not None:
                print(f"[{name}] exited with code {exit_code}", flush=True)
                return False
        if url_is_ready(url):
            return True
        time.sleep(0.25)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Start the dataset builder backend and frontend.")
    parser.add_argument("--backend-port", type=int, default=8000)
    parser.add_argument("--frontend-port", type=int, default=5173)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    args = parser.parse_args()

    if not (FRONTEND_DIR / "node_modules").exists():
        print("frontend/node_modules がありません。先に `cd frontend` して `npm install` を実行してください。", flush=True)
        return 1

    if not BACKEND_VENV_PYTHON.exists():
        print("backend/.venv がありません。先に README の初回セットアップを実行してください。", flush=True)
        return 1

    backend_port = find_free_port(args.host, args.backend_port)
    frontend_port = find_free_port(args.host, args.frontend_port)

    if backend_port != args.backend_port:
        print(f"backend port {args.backend_port} は使用中です。{backend_port} を使います。", flush=True)
    if frontend_port != args.frontend_port:
        print(f"frontend port {args.frontend_port} は使用中です。{frontend_port} を使います。", flush=True)

    frontend_url = f"http://{args.host}:{frontend_port}"
    backend_health_url = f"http://{args.host}:{backend_port}/api/health"
    env = os.environ.copy()
    env["VITE_API_BASE_URL"] = f"http://{args.host}:{backend_port}"

    processes: list[tuple[str, subprocess.Popen]] = []
    try:
        processes.append(
            (
                "backend",
                start_process(
                    "backend",
                    [
                        backend_python(),
                        "-m",
                        "uvicorn",
                        "app.main:app",
                        "--host",
                        args.host,
                        "--port",
                        str(backend_port),
                    ],
                    BACKEND_DIR,
                ),
            )
        )
        processes.append(
            (
                "frontend",
                start_process(
                    "frontend",
                    [
                        "npm",
                        "run",
                        "dev",
                        "--",
                        "--host",
                        args.host,
                        "--port",
                        str(frontend_port),
                    ],
                    FRONTEND_DIR,
                    env=env,
                ),
            )
        )

        print("", flush=True)
        print("Waiting for backend...", flush=True)
        if not wait_for_url(backend_health_url, processes, timeout=20):
            print(f"backend が起動しませんでした: {backend_health_url}", flush=True)
            return 1

        print("Waiting for frontend...", flush=True)
        if not wait_for_url(frontend_url, processes, timeout=20):
            print(f"frontend が起動しませんでした: {frontend_url}", flush=True)
            return 1

        print(f"Open: {frontend_url}", flush=True)
        print("Stop: Ctrl+C", flush=True)

        if not args.no_open:
            webbrowser.open(frontend_url)

        while True:
            for name, process in processes:
                exit_code = process.poll()
                if exit_code is not None:
                    print(f"[{name}] exited with code {exit_code}")
                    return exit_code or 1
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("", flush=True)
        print("Stopping servers...", flush=True)
        return 0
    finally:
        stop_processes(processes)


if __name__ == "__main__":
    raise SystemExit(main())
