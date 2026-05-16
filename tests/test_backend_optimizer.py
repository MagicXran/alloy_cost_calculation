import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import OptimizerError, element_increment_kg_per_t, solve_alloy_cost, validate_config
from app.main import app
from app.solvers import get_solver


ROOT = Path(__file__).resolve().parents[1]


def load_default_config():
    """读取真实默认配置，测试覆盖用户实际会运行的数据。"""

    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def test_mass_balance_uses_divide_by_1000_factor():
    """质量平衡必须使用 /1000，不能退回旧的 /10000 错误。"""

    assert round(element_increment_kg_per_t(10, 65.66, 0.98), 3) == 0.643


def test_validate_config_rejects_percent_unit_mistake():
    """配置校验必须拦截百分数写成小数的常见错误。"""

    config = load_default_config()
    config["alloys"][0]["composition"]["Mn"] = 0.6566
    with pytest.raises(OptimizerError, match="百分比|65.66|0.6566"):
        validate_config(config)


def test_internal_solver_returns_three_modes_and_feasible_milp():
    """internal 兜底求解器必须返回三方案，并保证 MILP 成分合格。"""

    result = solve_alloy_cost(load_default_config(), get_solver("internal"))
    assert result["status"] == "ok"
    assert result["solver"] == "internal"
    assert result["modes"]["rule"]["costPerTon"] > 0
    assert result["modes"]["lp"]["costPerTon"] > 0
    assert result["modes"]["milp"]["costPerTon"] > 0
    assert all(check["ok"] for check in result["modes"]["milp"]["chemistryChecks"])
    assert any("规则基线是系统按保守规则生成的对照方案" in warning for warning in result["warnings"])


def test_highs_solver_matches_internal_business_shape():
    """HiGHS 主求解器与 internal 兜底求解器应保持同一业务响应形态。"""

    config = load_default_config()
    highs = solve_alloy_cost(copy.deepcopy(config), get_solver("highs"))
    internal = solve_alloy_cost(copy.deepcopy(config), get_solver("internal"))
    assert highs["status"] == "ok"
    assert highs["solver"] == "highs"
    assert highs["enabledAlloys"] == internal["enabledAlloys"]
    assert highs["modes"].keys() == internal["modes"].keys()
    assert highs["modes"]["lp"]["costPerTon"] == pytest.approx(internal["modes"]["lp"]["costPerTon"], abs=1e-6)
    assert all(check["ok"] for check in highs["modes"]["milp"]["chemistryChecks"])


def test_api_optimize_defaults_to_highs():
    """API 默认使用 HiGHS，并返回前端需要的三方案。"""

    client = TestClient(app)
    response = client.post("/api/optimize", json={"config": load_default_config()})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["solver"] == "highs"
    assert set(payload["modes"]) == {"rule", "lp", "milp"}


def test_api_can_select_internal_solver():
    """前端可以通过 solver 字段切换求解器。"""

    client = TestClient(app)
    response = client.post("/api/optimize", json={"solver": "internal", "config": load_default_config()})
    assert response.status_code == 200
    assert response.json()["solver"] == "internal"


def test_infeasible_config_returns_diagnostics():
    """禁用关键合金导致无可行解时必须返回可读诊断。"""

    config = load_default_config()
    for alloy in config["alloys"]:
        if alloy["composition"].get("Mn"):
            alloy["enabled"] = False
    result = solve_alloy_cost(config, get_solver("highs"))
    assert result["status"] == "infeasible"
    assert "Mn" in "\n".join(result["diagnostics"])


def test_warns_when_all_alloys_are_continuous_and_milp_degenerates_to_lp():
    """全部连续投料时，必须提示 MILP 退化为 LP。"""

    config = load_default_config()
    for alloy in config["alloys"]:
        alloy["bag_size_kg"] = 0
    result = solve_alloy_cost(config, get_solver("highs"))
    assert result["status"] == "ok"
    assert result["modes"]["milp"]["costPerTon"] == pytest.approx(result["modes"]["lp"]["costPerTon"], abs=1e-7)
    assert any("全部启用合金均为连续投料" in warning and "MILP 已退化为 LP" in warning for warning in result["warnings"])


def test_warns_when_bag_rounding_is_disabled():
    """关闭整袋约束时，必须提示 MILP 与 LP 使用同一连续解。"""

    config = load_default_config()
    config["milp_settings"]["enable_bag_rounding"] = False
    result = solve_alloy_cost(config, get_solver("highs"))
    assert result["status"] == "ok"
    assert result["modes"]["milp"]["costPerTon"] == pytest.approx(result["modes"]["lp"]["costPerTon"], abs=1e-7)
    assert any("整袋约束已关闭" in warning and "MILP 与 LP 使用同一连续解" in warning for warning in result["warnings"])


def test_warns_when_integer_constraints_do_not_change_solution():
    """存在整袋合金但连续解刚好满足袋重步长时，也要解释 LP/MILP 一致。"""

    result = solve_alloy_cost(load_default_config(), get_solver("highs"))
    assert result["status"] == "ok"
    assert any("整袋约束存在" in warning and "LP 连续解已经满足袋重步长" in warning for warning in result["warnings"])


def test_warns_when_integer_constraints_increase_cost():
    """整袋约束抬高成本时，必须提示 MILP 相对 LP 的成本差。"""

    config = load_default_config()
    for alloy in config["alloys"]:
        if alloy["composition"].get("Mn"):
            alloy["bag_size_kg"] = 50
    result = solve_alloy_cost(config, get_solver("highs"))
    assert result["status"] == "ok"
    assert result["modes"]["milp"]["costPerTon"] > result["modes"]["lp"]["costPerTon"]
    assert any("整袋约束使 MILP 成本比 LP 理论下限高" in warning for warning in result["warnings"])


def test_api_rejects_unknown_solver():
    """未知 solver 不能静默降级，否则排查问题会很痛苦。"""

    client = TestClient(app)
    response = client.post("/api/optimize", json={"solver": "gurobi", "config": load_default_config()})
    assert response.status_code == 422


def test_residual_impurity_over_limit_rejects_before_solving():
    """P/S 残余超标是工艺问题，不允许优化器假装能靠加合金解决。"""

    config = load_default_config()
    config["residual"]["P"] = 0.030
    with pytest.raises(OptimizerError, match="当前P=.*超过目标上限"):
        solve_alloy_cost(config, get_solver("highs"))


def test_price_sensitivity_does_not_reduce_milp_cost():
    """合金涨价后 MILP 成本不应下降，防止成本目标函数接错。"""

    base = solve_alloy_cost(load_default_config(), get_solver("highs"))
    expensive = load_default_config()
    next(alloy for alloy in expensive["alloys"] if alloy["name"] == "低碳锰铁")["price_per_ton"] *= 1.2
    changed = solve_alloy_cost(expensive, get_solver("highs"))
    assert changed["status"] == "ok"
    assert changed["modes"]["milp"]["costPerTon"] >= base["modes"]["milp"]["costPerTon"] - 1e-6


def test_empty_string_is_not_treated_as_zero():
    """空字符串不能被当作 0 参与计算，现场录入错误必须暴露。"""

    config = load_default_config()
    config["heat_weight_t"] = ""
    with pytest.raises(OptimizerError, match="不能为空"):
        validate_config(config)


def test_disabled_alloy_bad_composition_is_ignored():
    """禁用合金的数据脏值不应影响当前启用集合求解。"""

    config = load_default_config()
    disabled = next(alloy for alloy in config["alloys"] if alloy["name"] == "中碳锰铁")
    disabled["enabled"] = False
    disabled["composition"]["Mn"] = 0.7854
    result = solve_alloy_cost(config, get_solver("highs"))
    assert result["status"] == "ok"
