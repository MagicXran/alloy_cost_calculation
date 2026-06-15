"""FastAPI 服务入口。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from app.batch_template import BATCH_RESULTS, export_batch_result, generate_template_workbook, parse_template_workbook, run_batch_optimization
from app.core import OptimizerError, solve_alloy_cost
from app.models import BatchOptimizeRequest, HealthResponse, OptimizeRequest
from app.solvers import get_solver


def app_root() -> Path:
    """返回资源根目录；打包后优先使用 exe 所在目录，便于外置配置可编辑。"""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[1]


def bundled_root() -> Path | None:
    """返回 PyInstaller 内置资源目录；开发态没有该目录。"""

    path = getattr(sys, "_MEIPASS", None)
    return None if path is None else Path(path).resolve()


def resource_file(name: str) -> Path:
    """优先返回 exe 同级外置文件，缺失时退回 PyInstaller 内置资源。"""

    external = app_root() / name
    if external.exists():
        return external
    bundled = bundled_root()
    if bundled is not None:
        candidate = bundled / name
        if candidate.exists():
            return candidate
    return external


app = FastAPI(title="Alloy Cost Calculation API", version="0.1.0")

# 前端原型由本地静态服务托管，开发阶段只开放本机页面来源。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8018", "http://localhost:8018"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def frontend_file(name: str) -> Path:
    """返回前端资源路径，并限制只能访问发布包内的固定文件。"""

    allowed = {"prototype.html", "ui.js", "config.json"}
    if name not in allowed:
        raise HTTPException(status_code=404, detail="Not Found")
    path = resource_file(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{name} 不存在")
    return path


@app.get("/")
def index() -> FileResponse:
    """单服务发布入口，直接打开页面。"""

    return FileResponse(frontend_file("prototype.html"))


@app.get("/prototype.html")
def prototype() -> FileResponse:
    """返回前端页面。"""

    return FileResponse(frontend_file("prototype.html"))


@app.get("/ui.js")
def ui_script() -> FileResponse:
    """返回前端交互脚本。"""

    return FileResponse(frontend_file("ui.js"), media_type="application/javascript")


@app.get("/config.json")
def config_file() -> FileResponse:
    """返回同一个外置配置文件，供浏览器启动时读取。"""

    return FileResponse(frontend_file("config.json"), media_type="application/json")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """服务健康检查。"""

    return HealthResponse(status="ok", service="alloy-cost-calculation")


def load_runtime_config() -> dict:
    """每次从 config.json 读取配置，保证前后端共享同一个事实源。"""

    return json.loads(resource_file("config.json").read_text(encoding="utf-8-sig"))


@app.get("/api/config")
def get_config() -> dict:
    """返回当前求解默认配置，前端不得再维护第二套默认配置。"""

    try:
        return load_runtime_config()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"读取配置失败：{exc}") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"配置 JSON 格式错误：{exc}") from exc


@app.get("/api/template/download")
def download_template() -> Response:
    """下载系统推荐的批量计算 Excel 模板。"""

    content = generate_template_workbook(load_runtime_config().get("process_rules"))
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="alloy-batch-template-v1.xlsx"'},
    )


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


@app.post("/api/template/validate")
async def validate_template(file: UploadFile = File(...)) -> dict:
    """上传批量计算模板，只做结构解析和预检。"""

    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="请上传 .xlsx 模板文件")
    content = await file.read()
    return parse_template_workbook(content)


@app.post("/api/batch-optimize")
def batch_optimize(request: BatchOptimizeRequest) -> dict:
    """对预检通过的模板数据逐行求解。"""

    try:
        return run_batch_optimization(request.template, request.solver)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/batch-result/{batch_id}/export")
def export_batch(batch_id: str) -> Response:
    """导出批量计算结果。"""

    result = BATCH_RESULTS.get(batch_id)
    if result is None:
        raise HTTPException(status_code=404, detail="批量结果不存在或已过期")
    content = export_batch_result(result)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="alloy-batch-result-{batch_id}.xlsx"'},
    )
