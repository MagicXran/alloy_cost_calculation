"""无外部依赖的内部求解器。

这个适配器用于测试、离线兜底和 SciPy 不可用时的明确降级。它不是长期主力，
但能保护业务层接口不被单个求解器绑定。
"""

from __future__ import annotations

import math
from itertools import combinations
from typing import Any

from app.solvers.base import RawSolution


EPS = 1e-8


class InternalSolver:
    """小规模 LP 顶点枚举 + 分支定界求解器。"""

    name = "internal"

    def solve_lp(self, model: dict[str, Any]) -> RawSolution | None:
        """枚举顶点求解 LP，小模型足够稳定。"""

        c = [float(value) for value in model["c"]]
        bounds = [(float(lower), float(upper)) for lower, upper in model["bounds"]]
        n = len(c)
        if n == 0:
            return None

        active = [{"a": list(item["a"]), "b": float(item["b"])} for item in model["constraints"]]
        for index, (lower, upper) in enumerate(bounds):
            upper_row = [0.0] * n
            upper_row[index] = 1.0
            active.append({"a": upper_row, "b": upper})
            lower_row = [0.0] * n
            lower_row[index] = -1.0
            active.append({"a": lower_row, "b": -lower})

        best: RawSolution | None = None
        for indexes in combinations(range(len(active)), n):
            matrix = [active[index]["a"] for index in indexes]
            vector = [active[index]["b"] for index in indexes]
            x = solve_linear_system(matrix, vector)
            if x is None or not is_feasible(x, active):
                continue
            cost = dot(c, x)
            if best is None or cost < best.cost_per_ton - 1e-9:
                best = RawSolution(x=x, cost_per_ton=cost)
        return best

    def solve_milp(self, model: dict[str, Any], heat_weight_t: float, alloys: list[dict]) -> RawSolution | None:
        """对袋装变量做分支定界，非袋装变量保持连续。"""

        integer_indexes = [index for index, alloy in enumerate(alloys) if float(alloy.get("bag_size_kg") or 0) > 0]
        best: RawSolution | None = None
        nodes = 0
        node_limit_hit = False
        max_nodes = 20000

        def is_integer_bag(index: int, kg_per_ton: float) -> bool:
            """判断 kg/t 是否能还原为整数袋。"""

            step = float(alloys[index]["bag_size_kg"]) / heat_weight_t
            bags = kg_per_ton / step
            return abs(bags - round(bags)) < 1e-6

        def merge_bound(bounds: dict[int, dict[str, float]], index: int, patch: dict[str, float]) -> dict[int, dict[str, float]] | None:
            """合并分支上下界，发现空区间就剪枝。"""

            lower, upper = model["bounds"][index]
            current = dict(bounds.get(index) or {"lower": float(lower), "upper": float(upper)})
            if "lower" in patch:
                current["lower"] = max(current.get("lower", 0.0), patch["lower"])
            if "upper" in patch:
                current["upper"] = min(current.get("upper", float(upper)), patch["upper"])
            if current["lower"] > current["upper"] + EPS:
                return None
            next_bounds = dict(bounds)
            next_bounds[index] = current
            return next_bounds

        def with_bounds(bounds: dict[int, dict[str, float]]) -> dict[str, Any]:
            """把当前分支边界复制到线性模型。"""

            next_model = {"c": model["c"], "constraints": model["constraints"], "bounds": list(model["bounds"])}
            for index, bound in bounds.items():
                next_model["bounds"][index] = (bound["lower"], bound["upper"])
            return next_model

        def branch(bounds: dict[int, dict[str, float]]) -> None:
            """递归搜索整数袋方案。"""

            nonlocal best, nodes, node_limit_hit
            nodes += 1
            if nodes > max_nodes:
                node_limit_hit = True
                return
            relaxed = self.solve_lp(with_bounds(bounds))
            if relaxed is None:
                return
            if best is not None and relaxed.cost_per_ton >= best.cost_per_ton - 1e-9:
                return

            fractional = None
            for index in integer_indexes:
                if not is_integer_bag(index, relaxed.x[index]):
                    fractional = index
                    break
            if fractional is None:
                best = RawSolution(x=relaxed.x, cost_per_ton=relaxed.cost_per_ton, nodes=nodes)
                return

            step = float(alloys[fractional]["bag_size_kg"]) / heat_weight_t
            bags = relaxed.x[fractional] / step
            floor_kg = math.floor(bags) * step
            ceil_kg = math.ceil(bags) * step
            left = merge_bound(bounds, fractional, {"upper": floor_kg})
            right = merge_bound(bounds, fractional, {"lower": ceil_kg})
            if left and right:
                if abs(ceil_kg - relaxed.x[fractional]) < abs(relaxed.x[fractional] - floor_kg):
                    branch(right)
                    branch(left)
                else:
                    branch(left)
                    branch(right)
            elif left:
                branch(left)
            elif right:
                branch(right)

        branch({})
        if node_limit_hit:
            return RawSolution(x=best.x if best else [], cost_per_ton=best.cost_per_ton if best else 0.0, nodes=nodes, node_limit_hit=True)
        return best


def solve_linear_system(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    """高斯消元求解小规模线性方程组。"""

    n = len(vector)
    a = [list(row) + [vector[index]] for index, row in enumerate(matrix)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda row: abs(a[row][col]))
        if abs(a[pivot][col]) < 1e-10:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        divisor = a[col][col]
        for item in range(col, n + 1):
            a[col][item] /= divisor
        for row in range(n):
            if row == col:
                continue
            factor = a[row][col]
            for item in range(col, n + 1):
                a[row][item] -= factor * a[col][item]
    return [row[n] for row in a]


def is_feasible(x: list[float], constraints: list[dict[str, Any]]) -> bool:
    """检查所有不等式约束是否满足。"""

    return all(dot(item["a"], x) <= item["b"] + 1e-7 for item in constraints) and all(value >= -1e-7 for value in x)


def dot(a: list[float], b: list[float]) -> float:
    """计算向量点积。"""

    return sum(value * b[index] for index, value in enumerate(a))
