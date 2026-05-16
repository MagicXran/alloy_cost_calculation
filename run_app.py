"""本地发布入口：读取 config.json 后启动单服务 Web 应用。"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

import uvicorn

from app.main import app


def app_root() -> Path:
    """返回运行目录；打包后使用 exe 所在目录，开发态使用源码目录。"""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def load_config() -> dict[str, Any]:
    """读取外置 config.json，让发布包迁移后仍可改 IP、端口和合金配置。"""

    config_path = app_root() / "config.json"
    if not config_path.exists() and getattr(sys, "_MEIPASS", None):
        config_path = Path(sys._MEIPASS) / "config.json"
    return json.loads(config_path.read_text(encoding="utf-8-sig"))


def open_browser_later(url: str) -> None:
    """延迟打开浏览器，避免服务尚未监听时浏览器先报错。"""

    time.sleep(1.0)
    webbrowser.open(url)


def main() -> None:
    """启动 FastAPI 应用，监听地址和端口来自 config.json 的 server 段。"""

    config = load_config()
    server = config.get("server") or {}
    host = os.getenv("ALLOY_HOST") or str(server.get("host") or "127.0.0.1")
    port = int(os.getenv("ALLOY_PORT") or server.get("port") or 8017)
    url = f"http://{host}:{port}/"

    if server.get("open_browser", True):
        threading.Thread(target=open_browser_later, args=(url,), daemon=True).start()

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
