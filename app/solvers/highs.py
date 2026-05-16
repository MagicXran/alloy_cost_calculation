"""SciPy HiGHS 求解器适配器。"""

from __future__ import annotations

from typing import Any

from app.solvers.base import RawSolution


class HighsSolver:
    """基于 scipy.optimize.linprog/milp 的求解器。"""

    name = "highs"

    def solve_lp(self, model: dict[str, Any]) -> RawSolution | None:
        """使用 HiGHS 求解连续 LP。"""

        try:
            from scipy.optimize import linprog
        except ImportError as exc:
            raise RuntimeError("缺少 scipy，无法使用 solver=highs；请安装 requirements.txt。") from exc

        constraints = model["constraints"]
        result = linprog(
            c=model["c"],
            A_ub=[item["a"] for item in constraints],
            b_ub=[item["b"] for item in constraints],
            bounds=model["bounds"],
            method="highs",
        )
        if not result.success:
            return None
        return RawSolution(x=[float(value) for value in result.x], cost_per_ton=float(result.fun))

    def solve_milp(self, model: dict[str, Any], heat_weight_t: float, alloys: list[dict]) -> RawSolution | None:
        """使用 HiGHS MILP 求解整数袋方案。"""

        try:
            import numpy as np
            from scipy.optimize import Bounds, LinearConstraint, milp
        except ImportError as exc:
            raise RuntimeError("缺少 scipy/numpy，无法使用 solver=highs；请安装 requirements.txt。") from exc

        steps = []
        c = []
        lower_bounds = []
        upper_bounds = []
        integrality = []
        for index, alloy in enumerate(alloys):
            bag_size = float(alloy.get("bag_size_kg") or 0)
            lower, upper = model["bounds"][index]
            if bag_size > 0:
                step = bag_size / heat_weight_t
                steps.append(step)
                c.append(float(model["c"][index]) * step)
                lower_bounds.append(0)
                upper_bounds.append(int(upper // step))
                integrality.append(1)
            else:
                steps.append(1.0)
                c.append(float(model["c"][index]))
                lower_bounds.append(float(lower))
                upper_bounds.append(float(upper))
                integrality.append(0)

        rows = []
        upper = []
        for constraint in model["constraints"]:
            rows.append([float(value) * steps[index] for index, value in enumerate(constraint["a"])])
            upper.append(float(constraint["b"]))

        constraints = LinearConstraint(
            A=np.array(rows, dtype=float),
            lb=np.full(len(rows), -np.inf),
            ub=np.array(upper, dtype=float),
        )
        result = milp(
            c=np.array(c, dtype=float),
            integrality=np.array(integrality, dtype=int),
            bounds=Bounds(np.array(lower_bounds, dtype=float), np.array(upper_bounds, dtype=float)),
            constraints=constraints,
            options={"time_limit": 10.0},
        )
        if not result.success:
            return None
        x = [float(value) * steps[index] for index, value in enumerate(result.x)]
        return RawSolution(x=x, cost_per_ton=float(result.fun), nodes=getattr(result, "mip_node_count", None))
