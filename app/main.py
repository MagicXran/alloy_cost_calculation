"""FastAPI 服务入口。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.core import OptimizerError, solve_alloy_cost
from app.models import HealthResponse, OptimizeRequest
from app.solvers import get_solver


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"

app = FastAPI(title="Alloy Cost Calculation API", version="0.1.0")

# 前端原型由本地静态服务托管，开发阶段只开放本机页面来源。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8018", "http://localhost:8018"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """服务健康检查。"""

    return HealthResponse(status="ok", service="alloy-cost-calculation")


def load_runtime_config() -> dict:
    """每次从 config.json 读取配置，保证前后端共享同一个事实源。"""

    return json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))


@app.get("/api/config")
def get_config() -> dict:
    """返回当前求解默认配置，前端不得再维护第二套默认配置。"""

    try:
        return load_runtime_config()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"读取配置失败：{exc}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"配置 JSON 格式错误：{exc}") from exc


@app.post("/api/optimize")
def optimize(request: OptimizeRequest) -> dict:
    """根据业务配置返回规则、LP、MILP 三种合金成本方案。"""

    try:
        solver = get_solver(request.solver)
        return solve_alloy_cost(request.config, solver)
    except OptimizerError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "details": exc.details}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
