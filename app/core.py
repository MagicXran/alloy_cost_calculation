"""合金成本优化业务核心。

这里保留当前 JS 原型已经验证过的业务规则，同时把 LP/MILP 的实际求解下放到
Solver 接口，避免业务代码直接依赖 SciPy 或某个商业求解器。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from app.solvers.base import RawSolution, Solver


ELEMENTS = ["C", "Si", "Mn", "Cr", "P", "S"]
EPS = 1e-8


class OptimizerError(ValueError):
    """业务配置错误。"""

    def __init__(self, message: str, details: list[str] | None = None) -> None:
        super().__init__(message)
        self.details = details or []


@dataclass(frozen=True)
class LinearModel:
    """求解器需要的标准线性模型。"""

    c: list[float]
    constraints: list[dict[str, Any]]
    bounds: list[tuple[float, float]]

    def as_dict(self) -> dict[str, Any]:
        """返回普通 dict，方便不同 solver 适配器消费。"""

        return {"c": self.c, "constraints": self.constraints, "bounds": self.bounds}


def number_or_throw(value: Any, label: str) -> float:
    """读取数字并拒绝 JavaScript 那种空字符串变 0 的坑。"""

    if value is None or (isinstance(value, str) and value.strip() == ""):
        raise OptimizerError(f"{label} 不能为空")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise OptimizerError(f"{label} 不是有效数字") from exc
    if number != number or number in (float("inf"), float("-inf")):
        raise OptimizerError(f"{label} 不是有效数字")
    return number


def element_increment_kg_per_t(kg_per_ton: float, composition_percent: float, recovery_rate: float) -> float:
    """kg/t 投加量换算为最终成分百分点增量。"""

    return kg_per_ton * composition_percent * recovery_rate / 1000


def clone_config(config: dict[str, Any]) -> dict[str, Any]:
    """深拷贝配置，避免后端求解污染前端传入对象。"""

    return copy.deepcopy(config)


def effective_bounds(config: dict[str, Any], element: str) -> dict[str, float | None]:
    """计算安全余量后的成分边界。"""

    target = (config.get("target") or {}).get(element) or {}
    margin = (config.get("safety_margins") or {}).get(element) or {"low": 0, "high": 0}
    return {
        "min": None if "min" not in target else float(target["min"]) + float(margin.get("low") or 0),
        "max": None if "max" not in target else float(target["max"]) - float(margin.get("high") or 0),
    }


def alloy_coeff(alloy: dict[str, Any], element: str, config: dict[str, Any]) -> float:
    """返回某合金对某元素的成分贡献系数，单位是百分点/kg/t。"""

    percent = float((alloy.get("composition") or {}).get(element) or 0)
    overrides = alloy.get("recovery_overrides") or {}
    recovery_rates = config.get("recovery_rates") or {}
    rate = float(overrides[element] if element in overrides else recovery_rates.get(element, 1))
    return percent * rate / 1000


def validate_config(config: dict[str, Any]) -> None:
    """校验配置单位和范围，错误配置必须在求解前死掉。"""

    errors: list[str] = []
    heat_weight = number_or_throw(config.get("heat_weight_t"), "heat_weight_t")
    if heat_weight < 1 or heat_weight > 500:
        errors.append("heat_weight_t 应在 1~500 t 之间")

    for element, value in (config.get("recovery_rates") or {}).items():
        rate = number_or_throw(value, f"recovery_rates.{element}")
        if rate < 0 or rate > 1.2:
            errors.append(f"{element} 回收率异常，应在 0~1.2")

    for element, margin in (config.get("safety_margins") or {}).items():
        for side in ("low", "high"):
            value = number_or_throw((margin or {}).get(side, 0), f"safety_margins.{element}.{side}")
            if value < 0 or value > 0.5:
                errors.append(f"{element} 安全余量应在 0~0.5")
            if value > 0.1:
                errors.append(f"{element} 安全余量过大，确认是否单位错误")

    for element, spec in (config.get("target") or {}).items():
        for bound in ("min", "max"):
            if bound not in (spec or {}):
                continue
            value = number_or_throw(spec[bound], f"target.{element}.{bound}")
            if value < 0 or value > 10:
                errors.append(f"{element} 目标成分超过 0~10%，确认是否单位错误")
        if "min" in spec and "max" in spec and float(spec["min"]) > float(spec["max"]):
            errors.append(f"{element} 目标下限不能大于上限")
        bounds = effective_bounds(config, element)
        if bounds["min"] is not None and bounds["max"] is not None and bounds["min"] > bounds["max"]:
            errors.append(f"{element} 安全余量导致有效上下限交叉")

    for alloy in config.get("alloys") or []:
        if alloy.get("enabled") is False:
            continue
        name = alloy.get("name") or "未命名合金"
        price = number_or_throw(alloy.get("price_per_ton"), f"{name}.price_per_ton")
        if price < 100 or price > 200000:
            errors.append(f"{name} 价格应为 ¥/t，当前值疑似单位错误")
        bag_size = number_or_throw(alloy.get("bag_size_kg") or 0, f"{name}.bag_size_kg")
        if bag_size < 0 or bag_size > 2000:
            errors.append(f"{name} bag_size_kg 应在 0~2000 kg")
        max_add = number_or_throw(alloy.get("max_add_kg_per_t"), f"{name}.max_add_kg_per_t")
        if max_add <= 0 or max_add > 200:
            errors.append(f"{name} max_add_kg_per_t 应为合理正数")
        for element, value in (alloy.get("composition") or {}).items():
            percent = number_or_throw(value, f"{name}.composition.{element}")
            if percent < 0 or percent > 100:
                errors.append(f"{name} {element} 成分应在 0~100%")
            if element in ("Si", "Mn", "Cr") and 0 < percent < 1:
                errors.append(f"{name} {element}={value} 疑似百分比单位错误，是否应写成如 65.66 而不是 0.6566？")

    if errors:
        raise OptimizerError("；".join(errors), errors)


def precheck_residual_impurities(config: dict[str, Any]) -> None:
    """P/S 残余超标无法靠加合金修复，必须提前报错。"""

    for element in ("P", "S"):
        residual = float((config.get("residual") or {}).get(element) or 0)
        max_value = ((config.get("target") or {}).get(element) or {}).get("max")
        if max_value is not None and residual > float(max_value) + EPS:
            raise OptimizerError(
                f"当前{element}={format_number(residual, 4)}%已超过目标上限{format_number(float(max_value), 4)}%，"
                f"加合金无法降低{element}，需先做工艺处理"
            )


def build_linear_model(config: dict[str, Any], alloys: list[dict[str, Any]], fixed_bounds: dict[int, dict[str, float]] | None = None) -> LinearModel:
    """构建 LP/MILP 共用的线性模型。"""

    constraints: list[dict[str, Any]] = []
    residual = config.get("residual") or {}
    for element in ELEMENTS:
        bounds = effective_bounds(config, element)
        coeff = [alloy_coeff(alloy, element, config) for alloy in alloys]
        if bounds["max"] is not None:
            constraints.append({"a": coeff, "b": bounds["max"] - float(residual.get(element) or 0), "label": f"{element}上限"})
        if bounds["min"] is not None:
            constraints.append({"a": [-value for value in coeff], "b": -(bounds["min"] - float(residual.get(element) or 0)), "label": f"{element}下限"})

    model_bounds: list[tuple[float, float]] = []
    fixed_bounds = fixed_bounds or {}
    for index, alloy in enumerate(alloys):
        lower = 0.0
        upper = float(alloy.get("max_add_kg_per_t"))
        if index in fixed_bounds:
            override = fixed_bounds[index]
            lower = float(override.get("lower", lower))
            upper = float(override.get("upper", upper))
        model_bounds.append((lower, upper))

    return LinearModel(
        c=[float(alloy.get("price_per_ton")) / 1000 for alloy in alloys],
        constraints=constraints,
        bounds=model_bounds,
    )


def solve_alloy_cost(input_config: dict[str, Any], solver: Solver) -> dict[str, Any]:
    """求解规则、LP、MILP 三方案。"""

    config = clone_config(input_config)
    validate_config(config)
    precheck_residual_impurities(config)
    alloys = [alloy for alloy in config.get("alloys") or [] if alloy.get("enabled") is not False]

    lp_raw = solver.solve_lp(build_linear_model(config, alloys).as_dict())
    if lp_raw is None:
        return {"status": "infeasible", "solver": solver.name, "diagnostics": diagnose_infeasible(config, alloys)}

    if (config.get("milp_settings") or {}).get("enable_bag_rounding") is False:
        milp_raw = lp_raw
    else:
        milp_raw = solver.solve_milp(build_linear_model(config, alloys).as_dict(), float(config["heat_weight_t"]), alloys)
    if milp_raw is None:
        return {
            "status": "infeasible",
            "solver": solver.name,
            "diagnostics": diagnose_infeasible(config, alloys) + ["LP 可行但整袋 MILP 不可行，请放宽安全余量或调整袋重"],
        }
    if milp_raw.node_limit_hit:
        return {
            "status": "not_proven",
            "solver": solver.name,
            "diagnostics": ["MILP 分支节点超过上限，已找到的整数解未证明全局最优；请放宽约束、减少袋装变量或提高求解上限。"],
        }

    rule_raw = solve_rule_baseline(config, alloys, solver)
    result = {
        "status": "ok",
        "solver": solver.name,
        "heatWeightT": float(config["heat_weight_t"]),
        "enabledAlloys": [alloy["name"] for alloy in alloys],
        "modes": {
            "rule": make_mode_result("规则基线", config, alloys, rule_raw),
            "lp": make_mode_result("LP理论下限", config, alloys, lp_raw),
            "milp": make_mode_result("MILP现场方案", config, alloys, milp_raw),
        },
    }
    result["ruleFeasible"] = all(check["ok"] for check in result["modes"]["rule"]["chemistryChecks"])
    result["costDeltaVsRule"] = result["modes"]["milp"]["costPerTon"] - result["modes"]["rule"]["costPerTon"]
    result["costDeltaRateVsRule"] = result["costDeltaVsRule"] / result["modes"]["rule"]["costPerTon"]
    result["savingsVsRule"] = -result["costDeltaVsRule"] if result["ruleFeasible"] else None
    result["savingsRateVsRule"] = -result["costDeltaRateVsRule"] if result["ruleFeasible"] else None
    result["warnings"] = warnings_for(config, result)
    return result


def solve_rule_baseline(config: dict[str, Any], alloys: list[dict[str, Any]], solver: Solver) -> RawSolution:
    """规则基线优先使用低碳保守合金，不把经验规则伪装成全局最优。"""

    conservative_alloys = [alloy for alloy in alloys if float((alloy.get("composition") or {}).get("C") or 0) <= 5]
    if conservative_alloys:
        conservative = solver.solve_milp(
            build_linear_model(config, conservative_alloys).as_dict(),
            float(config["heat_weight_t"]),
            conservative_alloys,
        )
        if conservative is not None and not conservative.node_limit_hit:
            by_name = {alloy["name"]: conservative.x[index] for index, alloy in enumerate(conservative_alloys)}
            x = [by_name.get(alloy["name"], 0.0) for alloy in alloys]
            return RawSolution(x=x, cost_per_ton=cost_for(alloys, x))

    ordered = sorted(alloys, key=lambda item: float(item.get("addition_sequence") or 99))
    doses = {alloy["name"]: 0.0 for alloy in alloys}
    for alloy in ordered:
        for _ in range(120):
            current = chemistry_from_doses(config, alloys, doses)
            need = most_useful_need(config, alloy, current)
            if not need:
                break
            coeff = alloy_coeff(alloy, need, config)
            if coeff <= 0:
                break
            target = effective_bounds(config, need)["min"]
            step = min(0.25, max(0.02, (float(target) - current[need]) / coeff))
            if not can_add(config, alloys, doses, alloy["name"], step):
                break
            doses[alloy["name"]] += step

    x = [doses.get(alloy["name"], 0.0) for alloy in alloys]
    return RawSolution(x=x, cost_per_ton=cost_for(alloys, x))


def most_useful_need(config: dict[str, Any], alloy: dict[str, Any], current: dict[str, float]) -> str | None:
    """为贪心规则选择当前最需要补足的元素。"""

    best: dict[str, Any] | None = None
    for element in ("Cr", "Si", "Mn", "C"):
        bounds = effective_bounds(config, element)
        if bounds["min"] is None or current[element] >= bounds["min"] - EPS:
            continue
        if alloy_coeff(alloy, element, config) <= 0:
            continue
        deficit = bounds["min"] - current[element]
        if best is None or deficit > best["deficit"]:
            best = {"element": element, "deficit": deficit}
    return None if best is None else best["element"]


def can_add(config: dict[str, Any], alloys: list[dict[str, Any]], doses: dict[str, float], alloy_name: str, step: float) -> bool:
    """判断规则基线追加一步是否会撞上上限。"""

    next_doses = dict(doses)
    next_doses[alloy_name] = next_doses.get(alloy_name, 0.0) + step
    alloy = next(item for item in alloys if item["name"] == alloy_name)
    if next_doses[alloy_name] > float(alloy["max_add_kg_per_t"]) + EPS:
        return False
    chemistry = chemistry_from_doses(config, alloys, next_doses)
    for element in ELEMENTS:
        bounds = effective_bounds(config, element)
        if bounds["max"] is not None and chemistry[element] > bounds["max"] + 1e-6:
            return False
    return True


def cost_for(alloys: list[dict[str, Any]], x: list[float]) -> float:
    """计算每吨钢合金成本。"""

    return sum(float(alloy["price_per_ton"]) / 1000 * (x[index] or 0) for index, alloy in enumerate(alloys))


def chemistry_from_vector(config: dict[str, Any], alloys: list[dict[str, Any]], x: list[float]) -> dict[str, float]:
    """根据变量向量反算最终成分。"""

    doses = {alloy["name"]: x[index] or 0 for index, alloy in enumerate(alloys)}
    return chemistry_from_doses(config, alloys, doses)


def chemistry_from_doses(config: dict[str, Any], alloys: list[dict[str, Any]], doses: dict[str, float]) -> dict[str, float]:
    """根据合金投加量反算成分。"""

    chemistry = {element: float((config.get("residual") or {}).get(element) or 0) for element in ELEMENTS}
    for alloy in alloys:
        kg_per_ton = float(doses.get(alloy["name"]) or 0)
        for element in ELEMENTS:
            overrides = alloy.get("recovery_overrides") or {}
            recovery_rates = config.get("recovery_rates") or {}
            rate = float(overrides[element] if element in overrides else recovery_rates.get(element, 1))
            chemistry[element] += element_increment_kg_per_t(
                kg_per_ton,
                float((alloy.get("composition") or {}).get(element) or 0),
                rate,
            )
    return chemistry


def make_mode_result(name: str, config: dict[str, Any], alloys: list[dict[str, Any]], raw: RawSolution) -> dict[str, Any]:
    """把原始变量转换成前端可直接展示的方案。"""

    x: list[float] = []
    for index, value in enumerate(raw.x):
        clean = max(0.0, 0.0 if value < 1e-8 else float(value))
        bag_size = float(alloys[index].get("bag_size_kg") or 0)
        if bag_size > 0:
            bags = round(clean * float(config["heat_weight_t"]) / bag_size)
            x.append(bags * bag_size / float(config["heat_weight_t"]))
        else:
            x.append(clean)

    chemistry = chemistry_from_vector(config, alloys, x)
    cost_per_ton = cost_for(alloys, x)
    return {
        "name": name,
        "costPerTon": cost_per_ton,
        "heatCost": cost_per_ton * float(config["heat_weight_t"]),
        "totalKgPerTon": sum(x),
        "chemistry": chemistry,
        "chemistryChecks": chemistry_checks(config, chemistry),
        "alloys": [
            {
                "name": alloy["name"],
                "kgPerTon": x[index],
                "heatKg": x[index] * float(config["heat_weight_t"]),
                "bags": round(x[index] * float(config["heat_weight_t"]) / float(alloy.get("bag_size_kg") or 1))
                if float(alloy.get("bag_size_kg") or 0) > 0
                else None,
                "bagSizeKg": float(alloy.get("bag_size_kg") or 0),
                "sequence": float(alloy.get("addition_sequence") or 99),
                "costPerTon": float(alloy["price_per_ton"]) / 1000 * x[index],
            }
            for index, alloy in enumerate(alloys)
        ],
    }


def chemistry_checks(config: dict[str, Any], chemistry: dict[str, float]) -> list[dict[str, Any]]:
    """检查每个元素是否落在有效成分边界内。"""

    checks = []
    for element in ELEMENTS:
        bounds = effective_bounds(config, element)
        value = chemistry.get(element) or 0
        above_min = bounds["min"] is None or value >= bounds["min"] - 1e-7
        below_max = bounds["max"] is None or value <= bounds["max"] + 1e-7
        checks.append({"element": element, "value": value, "min": bounds["min"], "max": bounds["max"], "ok": above_min and below_max})
    return checks


def diagnose_infeasible(config: dict[str, Any], alloys: list[dict[str, Any]]) -> list[str]:
    """给出简单可解释的无可行解诊断。"""

    diagnostics: list[str] = []
    for element in ELEMENTS:
        bounds = effective_bounds(config, element)
        residual = float((config.get("residual") or {}).get(element) or 0)
        max_reach = residual + sum(float(alloy["max_add_kg_per_t"]) * alloy_coeff(alloy, element, config) for alloy in alloys)
        if bounds["min"] is not None and max_reach < bounds["min"] - EPS:
            diagnostics.append(f"{element}下限无法满足：最多 {format_number(max_reach, 4)}%，要求 {format_number(bounds['min'], 4)}%")
        if bounds["max"] is not None and residual > bounds["max"] + EPS:
            diagnostics.append(f"{element}上限无法满足：残余 {format_number(residual, 4)}%，上限 {format_number(bounds['max'], 4)}%")
    if not diagnostics:
        diagnostics.append("线性约束组合无可行解，请检查 C 上限、Mn/Cr 下限与启用合金组合")
    return diagnostics


def warnings_for(config: dict[str, Any], result: dict[str, Any]) -> list[str]:
    """生成不会阻塞求解但必须提示用户的风险。"""

    warnings = ["P/S 含量按配置值计算；若来自默认行业值，正式使用前必须用化验单覆盖。"]
    warnings.append("规则基线是系统按保守规则生成的对照方案，不等于现场历史真实投料。")
    warnings.extend(milp_relation_warnings(config, result))
    if not result["ruleFeasible"]:
        warnings.append("规则基线未通过成分校核，只能作为历史经验对照，不能作为节约金额基准。")
    if not ((config.get("temperature_drop") or {}).get("enabled")):
        warnings.append("温降估算 V1 禁用，避免输出未校准的假精度。")
    for alloy in result["modes"]["lp"]["alloys"]:
        source = next((item for item in config.get("alloys") or [] if item.get("name") == alloy["name"]), {})
        if alloy["kgPerTon"] > EPS and alloy["kgPerTon"] < 1 and float(source.get("bag_size_kg") or 0) == 0:
            warnings.append(f"{alloy['name']} LP 结果 {format_number(alloy['kgPerTon'], 2)} kg/t 为极小量，现场可考虑忽略或改用 MILP。")
    return warnings


def milp_relation_warnings(config: dict[str, Any], result: dict[str, Any]) -> list[str]:
    """解释 LP 与 MILP 为什么相同或不同，避免用户误判模型坏了。"""

    lp = result["modes"]["lp"]
    milp = result["modes"]["milp"]
    enabled_alloys = [alloy for alloy in config.get("alloys") or [] if alloy.get("enabled") is not False]
    bagged_alloys = [alloy for alloy in enabled_alloys if float(alloy.get("bag_size_kg") or 0) > 0]
    cost_delta = milp["costPerTon"] - lp["costPerTon"]
    same_cost = abs(cost_delta) < 1e-7
    same_dose = same_mode_doses(lp, milp)

    if (config.get("milp_settings") or {}).get("enable_bag_rounding") is False:
        return ["整袋约束已关闭，MILP 与 LP 使用同一连续解；此时两列一致是正常结果。"]
    if not bagged_alloys:
        return ["全部启用合金均为连续投料，没有整数袋变量，MILP 已退化为 LP；此时两列一致是正常结果。"]
    if same_cost and same_dose:
        names = "、".join(alloy["name"] for alloy in bagged_alloys)
        return [f"整袋约束存在（{names}），但 LP 连续解已经满足袋重步长，MILP 与 LP 一致是正常结果。"]
    if cost_delta > 1e-7:
        return [f"整袋约束使 MILP 成本比 LP 理论下限高 {format_number(cost_delta, 2)} ¥/t；这是把连续理论解转换为现场可投整数袋的代价。"]
    if not same_dose:
        return ["MILP 与 LP 成本接近但投料组合不同，说明存在同成本替代解；请优先按 MILP 的整袋投料单执行。"]
    return []


def same_mode_doses(left: dict[str, Any], right: dict[str, Any]) -> bool:
    """比较两个方案的合金投料向量是否一致。"""

    if len(left["alloys"]) != len(right["alloys"]):
        return False
    for index, alloy in enumerate(left["alloys"]):
        other = right["alloys"][index]
        if alloy["name"] != other["name"]:
            return False
        if abs(float(alloy["kgPerTon"]) - float(other["kgPerTon"])) > 1e-7:
            return False
    return True


def format_number(value: float | None, digits: int) -> str:
    """按中文现场习惯输出固定小数位。"""

    return f"{float(value or 0):,.{digits}f}"
