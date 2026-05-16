"""求解器工厂。"""

from __future__ import annotations

from app.solvers.highs import HighsSolver
from app.solvers.internal import InternalSolver


def get_solver(name: str):
    """按名称创建求解器，业务层不关心具体依赖。"""

    normalized = (name or "highs").lower()
    if normalized == "scipy":
        normalized = "highs"
    if normalized == "internal":
        return InternalSolver()
    if normalized == "highs":
        return HighsSolver()
    if normalized == "ortools":
        raise ValueError("solver=ortools 已预留，但当前阶段尚未接入。")
    raise ValueError(f"未知 solver: {name}")
