"""Build the Python service used by the packaged Electron application."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "backend"
WORK = ROOT / "build" / "pyinstaller"


def python_with_pyinstaller() -> list[str]:
    candidates: list[str] = []
    configured = os.environ.get("PYTHON")
    if configured:
        candidates.append(configured)
    venv = ROOT / (".venv\\Scripts\\python.exe" if os.name == "nt" else ".venv/bin/python")
    if venv.exists():
        candidates.append(str(venv))
    candidates.append(sys.executable)
    for candidate in candidates:
        probe = subprocess.run([candidate, "-c", "import PyInstaller"], cwd=ROOT, capture_output=True)
        if probe.returncode == 0:
            return [candidate]
    raise SystemExit("未找到 PyInstaller。请运行：python -m pip install pyinstaller")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    for old in OUT.iterdir():
        if old.is_file() or old.is_symlink():
            old.unlink()
        elif old.is_dir():
            shutil.rmtree(old)
    python = python_with_pyinstaller()
    cmd = python + ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
                    "--name", "easyread-backend", "--distpath", str(OUT),
                    "--workpath", str(WORK), "--specpath", str(WORK),
                    "--collect-all", "easyread", str(ROOT / "scripts" / "backend_entry.py")]
    subprocess.run(cmd, cwd=ROOT, check=True)
    print(f"后端已生成：{OUT / ('easyread-backend.exe' if os.name == 'nt' else 'easyread-backend')}")


if __name__ == "__main__":
    main()
