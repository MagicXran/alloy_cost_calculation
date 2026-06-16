import json
from pathlib import Path

import pytest

from app.rules_engine import compile_rule_view


ROOT = Path(__file__).resolve().parents[1]


def load_default_config():
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def make_config(*, target_spec: dict, process_rules: dict | None = None, alloys: list[dict] | None = None) -> dict:
    config = load_default_config()
    config["control_targets"] = {"enabled": False, "margin": 0, "elements": {}}
    config["safety_margins"] = {}
    config["target_spec"] = target_spec
    config["alloys"] = alloys or []
    if process_rules is not None:
        config["process_rules"] = process_rules
    return config


def test_compile_rule_view_applies_ti_single_value_offset_as_exact_bound():
    config = make_config(target_spec={"Ti": {"mode": "single", "value": 0.025}})

    view = compile_rule_view(config)

    assert view.nominal_targets["Ti"] == pytest.approx(0.025)
    assert view.compiled_bounds["Ti"]["min"] == pytest.approx(0.030)
    assert view.compiled_bounds["Ti"]["max"] == pytest.approx(0.030)


def test_compile_rule_view_applies_ti_range_offset_only_on_lower_bound():
    config = make_config(target_spec={"Ti": {"mode": "range", "min": 0.025, "max": 0.040}})

    view = compile_rule_view(config)

    assert view.compiled_bounds["Ti"]["min"] == pytest.approx(0.030)
    assert view.compiled_bounds["Ti"]["max"] == pytest.approx(0.040)


def test_compile_rule_view_treats_empty_or_zero_targets_as_unconstrained():
    config = make_config(
        target_spec={
            "Mn": {"mode": "single", "value": 0},
            "Cr": {"mode": "range", "min": 0, "max": 0.45},
            "Mo": {"mode": "range", "min": 0, "max": 0},
        }
    )

    view = compile_rule_view(config)

    assert "Mn" not in view.compiled_bounds
    assert "Mn" not in view.nominal_targets
    assert view.compiled_bounds["Cr"] == {"min": None, "max": pytest.approx(0.45)}
    assert "Mo" not in view.compiled_bounds
    assert view.target_spec["Mn"]["mode"] == "none"
    assert view.target_spec["Mo"]["mode"] == "none"


def test_compile_rule_view_preserves_low_trace_target_for_disable_check_without_bounds():
    alloys = [
        {"name": "镍板", "price_per_ton": 130000, "max_add_kg_per_t": 5, "bag_size_kg": 0, "composition": {"Ni": 99}},
        {"name": "低碳锰铁", "price_per_ton": 7876, "max_add_kg_per_t": 25, "bag_size_kg": 0, "composition": {"Mn": 81.19}},
    ]
    config = make_config(target_spec={"Ni": {"mode": "single", "value": 0.02}}, alloys=alloys)

    view = compile_rule_view(config)

    assert view.nominal_targets["Ni"] == pytest.approx(0.02)
    assert "Ni" not in view.compiled_bounds
    assert "镍板" in view.disabled_alloys
    assert "低碳锰铁" not in view.disabled_alloys
