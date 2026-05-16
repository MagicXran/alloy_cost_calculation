"""求解器抽象接口。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RawSolution:
    """求解器返回的原始变量向量。"""

    x: list[float]
    cost_per_ton: float
    nodes: int | None = None
    node_limit_hit: bool = False


class Solver(Protocol):
    """所有求解器必须实现的最小接口。"""

    name: str

    def solve_lp(self, model: dict) -> RawSolution | None:
        """求解连续 LP，返回 kg/t 决策变量。"""

    def solve_milp(self, model: dict, heat_weight_t: float, alloys: list[dict]) -> RawSolution | None:
        """求解现场整数袋 MILP，返回 kg/t 决策变量。"""
