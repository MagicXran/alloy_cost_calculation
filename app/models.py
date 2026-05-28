"""请求和响应数据模型。

这些模型只描述业务配置和求解结果，不暴露 SciPy、OR-Tools 等求解器内部对象，
目的是让业务 API 不被某个求解器绑死。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class OptimizeRequest(BaseModel):
    """前端提交的优化请求。"""

    config: dict[str, Any] = Field(..., description="合金数据库、目标成分、残余成分和工艺参数。")
    solver: Literal["internal", "highs", "scipy", "ortools"] = Field(
        default="highs",
        description="求解器选择；scipy 是 highs 的兼容别名，ortools 预留给第二阶段。",
    )


class BatchOptimizeRequest(BaseModel):
    """批量模板预检通过后的求解请求。"""

    template: dict[str, Any] = Field(..., description="由 /api/template/validate 返回的 parsed 数据。")
    solver: Literal["internal", "highs", "scipy", "ortools"] = Field(default="highs", description="批量求解器选择。")


class OptimizeResponse(BaseModel):
    """统一优化响应。"""

    model_config = ConfigDict(extra="allow")

    status: str
    solver: str


class HealthResponse(BaseModel):
    """健康检查响应。"""

    status: Literal["ok"]
    service: str
