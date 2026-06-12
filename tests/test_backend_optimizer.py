import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.core import (
    MAX_PRICE_PER_TON,
    OptimizerError,
    build_linear_model,
    diagnose_infeasible,
    effective_bounds,
    element_increment_kg_per_t,
    solve_alloy_cost,
    solve_element_limit_under_other_constraints,
    validate_config,
)
from app.main import app, load_runtime_config
from app.solvers import get_solver


ROOT = Path(__file__).resolve().parents[1]


def load_default_config():
    """读取真实默认配置，测试覆盖用户实际会运行的数据。"""

    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def test_api_config_returns_config_json():
    """前端默认配置必须来自后端读取的 config.json，不能再维护影子配置。"""

    client = TestClient(app)
    response = client.get("/api/config")
    assert response.status_code == 200
    assert response.json() == load_default_config()


def test_runtime_config_contains_server_settings():
    """发布形态必须由 config.json 控制监听地址和端口。"""

    config = load_runtime_config()
    assert config["server"]["host"] == "127.0.0.1"
    assert isinstance(config["server"]["port"], int)


def test_backend_serves_frontend_assets():
    """单文件发布时后端必须自己托管页面和前端资源。"""

    client = TestClient(app)
    assert client.get("/").status_code == 200
    assert client.get("/prototype.html").status_code == 200
    assert client.get("/ui.js").status_code == 200
    assert client.get("/config.json").status_code == 200


def test_resource_file_falls_back_to_pyinstaller_internal_dir(monkeypatch, tmp_path):
    """PyInstaller 6 的 _internal 布局不能让发布包找不到前端资源。"""

    exe_root = tmp_path / "release"
    bundled = exe_root / "_internal"
    exe_root.mkdir()
    bundled.mkdir()
    (bundled / "prototype.html").write_text("<html></html>", encoding="utf-8")
    monkeypatch.setattr(app_main.sys, "frozen", True, raising=False)
    monkeypatch.setattr(app_main.sys, "executable", str(exe_root / "alloy_cost_calculation.exe"))
    monkeypatch.setattr(app_main.sys, "_MEIPASS", str(bundled), raising=False)
    assert app_main.resource_file("prototype.html") == bundled / "prototype.html"


def test_resource_file_prefers_external_editable_config(monkeypatch, tmp_path):
    """exe 同级 config.json 必须优先于内置配置，迁移后现场才能直接改参数。"""

    exe_root = tmp_path / "release"
    bundled = exe_root / "_internal"
    exe_root.mkdir()
    bundled.mkdir()
    (exe_root / "config.json").write_text("{}", encoding="utf-8")
    (bundled / "config.json").write_text('{"bundled": true}', encoding="utf-8")
    monkeypatch.setattr(app_main.sys, "frozen", True, raising=False)
    monkeypatch.setattr(app_main.sys, "executable", str(exe_root / "alloy_cost_calculation.exe"))
    monkeypatch.setattr(app_main.sys, "_MEIPASS", str(bundled), raising=False)
    assert app_main.resource_file("config.json") == exe_root / "config.json"


def test_mass_balance_uses_divide_by_1000_factor():
    """质量平衡必须使用 /1000，不能退回旧的 /10000 错误。"""

    assert round(element_increment_kg_per_t(10, 65.66, 0.98), 3) == 0.643


def test_validate_config_rejects_percent_unit_mistake():
    """配置校验必须拦截百分数写成小数的常见错误。"""

    config = load_default_config()
    config["alloys"][0]["composition"]["Mn"] = 0.6566
    with pytest.raises(OptimizerError, match="百分比|65.66|0.6566"):
        validate_config(config)


def test_validate_config_accepts_expensive_microalloy_prices():
    """Nb/Mo 等微合金真实价格可能超过 20 万元/t，不能误判为单位错误。"""

    config = load_default_config()
    alloy = config["alloys"][0]
    alloy["name"] = "钼铁"
    alloy["price_per_ton"] = 272566.37

    validate_config(config)


def test_validate_config_still_rejects_extreme_price_unit_mistake():
    """放宽微合金价格上限后，极端价格仍应被当作单位错误拦截。"""

    config = load_default_config()
    config["alloys"][0]["price_per_ton"] = MAX_PRICE_PER_TON + 1

    with pytest.raises(OptimizerError, match="价格应为"):
        validate_config(config)


def test_control_targets_replace_si_c_ranges_with_upper_limits():
    """控 Si/C 启用后必须取消下限，只保留扣除控元素安全余量后的上限。"""

    config = load_default_config()
    config["control_targets"]["margin"] = 0.005
    si_bounds = effective_bounds(config, "Si")
    c_bounds = effective_bounds(config, "C")
    mn_bounds = effective_bounds(config, "Mn")
    assert si_bounds == {"min": None, "max": pytest.approx(0.245)}
    assert c_bounds == {"min": None, "max": pytest.approx(0.095)}
    assert mn_bounds["min"] == pytest.approx(1.11)
    assert mn_bounds["max"] == pytest.approx(1.29)


def test_control_targets_can_be_disabled_per_element():
    """单个控元素关闭后，应退回原 target 范围语义。"""

    config = load_default_config()
    config["control_targets"]["elements"]["C"]["enabled"] = False
    bounds = effective_bounds(config, "C")
    assert bounds["min"] == pytest.approx(0.06)
    assert bounds["max"] == pytest.approx(0.095)


def test_confirmed_process_rules_adjust_targets_and_alloy_bounds():
    """现场确认的 LP 新算法规则必须先进入线性模型，再交给求解器。"""

    config = {
        "heat_weight_t": 100,
        "target": {
            "C": {"max": 0.10},
            "Si": {"max": 0.04},
            "Mn": {"min": 0.50, "max": 0.70},
            "Ti": {"min": 0.020, "max": 0.025},
            "Ni": {"min": 0.010, "max": 0.020},
            "B": {"min": 0.0001, "max": 0.0002},
            "P": {"max": 0.040},
            "S": {"max": 0.030},
            "Als": {"min": 0.010, "max": 0.020},
        },
        "residual": {"C": 0.04, "Si": 0, "Mn": 0.10, "Ti": 0, "Ni": 0, "B": 0, "P": 0.010, "S": 0.010, "Als": 0},
        "recovery_rates": {"C": 0.9, "Si": 0.75, "Mn": 0.98, "Ti": 0.7, "Ni": 0.98, "B": 0.7, "P": 1, "S": 1, "Als": 0.15},
        "safety_margins": {},
        "control_targets": {"enabled": False, "margin": 0, "elements": {}},
        "alloys": [
            {"name": "硅锰", "price_per_ton": 5000, "max_add_kg_per_t": 30, "bag_size_kg": 0, "composition": {"C": 1.72, "Si": 17.69, "Mn": 65.66}},
            {"name": "硅铁", "price_per_ton": 5000, "max_add_kg_per_t": 20, "bag_size_kg": 0, "composition": {"Si": 72.23}},
            {"name": "金属锰", "price_per_ton": 16000, "max_add_kg_per_t": 20, "bag_size_kg": 0, "composition": {"Mn": 90}},
            {"name": "铝块", "price_per_ton": 22000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"Als": 99}},
            {"name": "钛铁", "price_per_ton": 24000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"Ti": 71.58}},
            {"name": "镍板", "price_per_ton": 130000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"Ni": 99}},
            {"name": "硼铁", "price_per_ton": 24000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"B": 18}},
            {"name": "磷铁", "price_per_ton": 3000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"P": 23.94}},
            {"name": "硫铁", "price_per_ton": 3000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"S": 29}},
        ],
    }

    model = build_linear_model(config, config["alloys"])
    bounds_by_name = {alloy["name"]: model.bounds[index] for index, alloy in enumerate(config["alloys"])}
    constraints = {(item["element"], item["side"]): item for item in model.constraints}

    assert constraints[("C", "max")]["b"] == pytest.approx(0.055)
    assert constraints[("Ti", "min")]["b"] == pytest.approx(-0.025)
    assert ("Als", "min") not in constraints
    assert ("Ni", "min") not in constraints
    assert ("B", "min") not in constraints
    assert bounds_by_name["硅锰"] == (0.0, 0.0)
    assert bounds_by_name["硅铁"] == (0.0, 0.0)
    assert bounds_by_name["金属锰"] == (0.0, 20.0)
    assert bounds_by_name["铝块"] == (0.0, 0.0)
    assert bounds_by_name["镍板"] == (0.0, 0.0)
    assert bounds_by_name["硼铁"] == (0.0, 0.0)
    assert bounds_by_name["磷铁"] == (0.0, 0.0)
    assert bounds_by_name["硫铁"] == (0.0, 0.0)


def test_infeasible_diagnostics_respect_process_disabled_alloys():
    """诊断最大可达量不能把已被工艺规则禁用的合金算进去。"""

    config = {
        "heat_weight_t": 100,
        "target": {
            "Si": {"max": 0.04},
            "Mn": {"min": 0.50, "max": 0.70},
        },
        "residual": {"Si": 0, "Mn": 0.10},
        "recovery_rates": {"Si": 0.75, "Mn": 0.98},
        "safety_margins": {},
        "control_targets": {"enabled": False, "margin": 0, "elements": {}},
        "alloys": [
            {"name": "硅锰", "price_per_ton": 5000, "max_add_kg_per_t": 30, "bag_size_kg": 0, "composition": {"Si": 17.69, "Mn": 65.66}},
        ],
    }

    diagnostics = diagnose_infeasible(config, config["alloys"])

    assert diagnostics == ["Mn下限无法满足：最多 0.1000%，要求 0.5000%"]


def test_control_target_margin_cannot_cross_zero():
    """控元素上限扣余量后不能变成负数。"""

    config = load_default_config()
    config["control_targets"]["elements"]["Si"]["value"] = 0.002
    config["control_targets"]["margin"] = 0.005
    with pytest.raises(OptimizerError, match="Si 控制目标扣除安全余量后不能小于 0"):
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
    chemistry_by_element = {check["element"]: check for check in result["modes"]["milp"]["chemistryChecks"]}
    assert chemistry_by_element["Si"]["min"] is None
    assert chemistry_by_element["C"]["min"] is None
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


def test_infeasible_config_reports_coupled_element_reach_limit():
    """单元素最大量够但多元素组合冲突时，应报告排除本元素约束后的可达边界。"""

    config = load_default_config()
    config["control_targets"] = {"enabled": False, "margin": 0, "elements": {}}
    config["target"] = {
        "C": {"min": 0.39, "max": 0.41},
        "Si": {"min": 0.05, "max": 0.12},
        "Mn": {"min": 0.20, "max": 0.40},
        "P": {"max": 0.025},
        "S": {"max": 0.020},
    }
    config["residual"] = {"C": 0.07, "Si": 0, "Mn": 0.12, "P": 0, "S": 0, "Cr": 0}
    config["recovery_rates"].update({"C": 0.9, "Si": 0.75, "Mn": 0.98, "Cr": 0.96, "P": 1, "S": 1})
    for alloy in config["alloys"]:
        alloy["enabled"] = True
        alloy["bag_size_kg"] = 0
        if alloy["name"] == "高碳锰铁":
            alloy["composition"]["C"] = 6.69
        if alloy["name"] == "硅锰":
            alloy["composition"].update({"C": 1.72, "Si": 17.69, "Mn": 65.66, "P": 0.15, "S": 0.02})

    result = solve_alloy_cost(config, get_solver("highs"))
    max_c = solve_element_limit_under_other_constraints(config, config["alloys"], get_solver("highs"), "C", maximize=True)

    assert result["status"] == "infeasible"
    assert max_c == pytest.approx(0.2748, abs=5e-4)
    assert max_c < config["target"]["C"]["min"]
    diagnostics = "\n".join(result["diagnostics"])
    assert "C" in diagnostics
    assert "其他元素约束" in diagnostics
    assert "最多" in diagnostics
    assert "低于下限 0.3900%" in diagnostics


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
