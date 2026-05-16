"""FastAPI 服务入口。"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.core import OptimizerError, solve_alloy_cost
from app.models import HealthResponse, OptimizeRequest
from app.solvers import get_solver


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
