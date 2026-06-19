"""规则语义层与插件化编译引擎。"""

from __future__ import annotations

import copy
import json
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol


EPS = 1e-8
PROCESS_RULE_TEMPLATE_ROWS = [
    ("规则总开关", "enabled", "是否启用现场确认的 9 条工艺规则；是/否。"),
    ("控碳余量", "carbon_target_margin", "C 上限按 目标值-该余量 控制。"),
    ("禁硅阈值", "disable_silicon_alloys_si_max", "Si 目标 <= 该阈值时禁用硅锰/硅铁。"),
    ("低硅上限语义阈值", "single_target_si_upper_only_max", "Si 目标 <= 该阈值时只做低杂质控制，不要求补到目标值。"),
    ("铝块单独录入", "manual_aluminum", "铝块不参与 LP 自动优化，由现场单独录入。"),
    ("Ti 安全余量", "ti_safety_addition", "Ti 单值目标按 目标值+该余量 精确控制；Ti 区间目标只对下限加该余量。"),
    ("Ni 禁投阈值", "trace_alloy_thresholds.Ni", "Ni 目标 <= 该阈值时不投镍板。"),
    ("Cu 禁投阈值", "trace_alloy_thresholds.Cu", "Cu 目标 <= 该阈值时不投铜板。"),
    ("Mo 禁投阈值", "trace_alloy_thresholds.Mo", "Mo 目标 <= 该阈值时不投钼铁。"),
    ("Sb 禁投阈值", "trace_alloy_thresholds.Sb", "Sb 目标 <= 该阈值时不投锑锭。"),
    ("B 禁投阈值", "trace_alloy_thresholds.B", "B 目标 <= 该阈值时不投硼铁。"),
    ("磷铁禁投阈值", "phosphorus_alloy_max", "P 目标 <= 该阈值时不投磷铁。"),
    ("硫铁禁投阈值", "sulfur_alloy_max", "S 目标 <= 该阈值时不投硫铁。"),
]
_PHASE_ORDER = {"normalize": 0, "compile_target": 1, "compile_alloy": 2, "validate_explain": 3}
_CACHE_KEY = "_compiled_rule_view"
_CONTROLLED_ELEMENTS = ("C", "Si")
_ALUMINUM_ALIASES = ("铝块", "铝粒", "铝锭", "铝线")
_SILICON_ALLOY_ALIASES = ("硅锰", "硅铁")
_TRACE_ELEMENT_ALLOY_ALIASES = {
    "Ni": ("镍",),
    "Cu": ("铜",),
    "Mo": ("钼",),
    "Sb": ("锑",),
    "B": ("硼",),
}
_PHOSPHORUS_SULFUR_ALLOY_ALIASES = {"P": ("磷铁",), "S": ("硫铁",)}


@lru_cache(maxsize=1)
def _default_process_rules_snapshot() -> dict[str, Any]:
    if getattr(sys, "frozen", False):
        config_path = Path(sys.executable).resolve().parent / "config.json"
    else:
        config_path = Path(__file__).resolve().parents[1] / "config.json"
    payload = json.loads(config_path.read_text(encoding="utf-8-sig"))
    rules = payload.get("process_rules")
    if not isinstance(rules, dict):
        raise RuntimeError("config.json 缺少 process_rules 默认配置。")
    return copy.deepcopy(rules)


def default_process_rules() -> dict[str, Any]:
    """返回 config.json 里的默认工艺规则快照。"""

    return copy.deepcopy(_default_process_rules_snapshot())


def rule_template_rows() -> list[tuple[str, str, str]]:
    """返回模板规则元数据。"""

    return list(PROCESS_RULE_TEMPLATE_ROWS)


def rule_template_allowed_keys() -> set[str]:
    return {key for _, key, _ in PROCESS_RULE_TEMPLATE_ROWS}


def alloy_name_matches(name: str, aliases: tuple[str, ...]) -> bool:
    normalized = str(name or "").replace(" ", "")
    return any(alias in normalized for alias in aliases)


def _float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _normalize_mode_dict(spec: dict[str, Any]) -> dict[str, Any]:
    mode = str(spec.get("mode") or "").strip().lower()
    if mode == "single":
        return {"mode": "single", "value": _float_or_none(spec.get("value"))}
    if mode == "range":
        return {"mode": "range", "min": _float_or_none(spec.get("min")), "max": _float_or_none(spec.get("max"))}
    if mode == "none":
        return {"mode": "none"}
    if "min" in spec or "max" in spec:
        return {"mode": "range", "min": _float_or_none(spec.get("min")), "max": _float_or_none(spec.get("max"))}
    if "value" in spec:
        return {"mode": "single", "value": _float_or_none(spec.get("value"))}
    return {"mode": "none"}


def build_initial_target_spec(raw_config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """把外部 target/target_spec 统一转成原始 target_spec。"""

    merged: dict[str, dict[str, Any]] = {}
    explicit = raw_config.get("target_spec")
    if isinstance(explicit, dict):
        for element, spec in explicit.items():
            if isinstance(spec, dict):
                merged[element] = _normalize_mode_dict(spec)
            elif isinstance(spec, (int, float)):
                merged[element] = {"mode": "single", "value": float(spec)}

    legacy = raw_config.get("target")
    if isinstance(legacy, dict):
        for element, spec in legacy.items():
            if element in merged:
                continue
            if isinstance(spec, dict):
                merged[element] = _normalize_mode_dict(spec)
            elif isinstance(spec, (int, float)):
                merged[element] = {"mode": "single", "value": float(spec)}

    return merged


def normalize_target_spec_dict(target_spec: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return copy.deepcopy(target_spec)


def resolve_process_rules(raw_config: dict[str, Any]) -> dict[str, Any]:
    """合并配置里的工艺规则，默认值只来自 config.json。"""

    defaults = default_process_rules()
    configured = raw_config.get("process_rules")
    if configured is False:
        return {**defaults, "enabled": False}
    if not isinstance(configured, dict):
        return defaults

    merged = copy.deepcopy(defaults)
    merged.update({key: value for key, value in configured.items() if key != "trace_alloy_thresholds"})
    if isinstance(configured.get("trace_alloy_thresholds"), dict):
        thresholds = copy.deepcopy(defaults.get("trace_alloy_thresholds") or {})
        thresholds.update(configured["trace_alloy_thresholds"])
        merged["trace_alloy_thresholds"] = thresholds
    return merged


@dataclass
class RuleContext:
    raw_config: dict[str, Any]
    resolved_rules_config: dict[str, Any]
    target_spec: dict[str, dict[str, Any]]
    compiled_bounds: dict[str, dict[str, float | None]] = field(default_factory=dict)
    nominal_targets: dict[str, float] = field(default_factory=dict)
    disabled_alloys: dict[str, list[str]] = field(default_factory=dict)
    rule_flags: dict[str, set[str]] = field(default_factory=dict)
    rule_notes: list[str] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)

    def add_flag(self, element: str, flag: str) -> None:
        self.rule_flags.setdefault(element, set()).add(flag)

    def add_disabled_alloys(self, reason: str, aliases: tuple[str, ...]) -> None:
        for alloy in self.raw_config.get("alloys") or []:
            name = str((alloy or {}).get("name") or "")
            if alloy_name_matches(name, aliases):
                reasons = self.disabled_alloys.setdefault(name, [])
                if reason not in reasons:
                    reasons.append(reason)


class RulePlugin(Protocol):
    rule_id: str
    phase: str
    priority: int

    def apply(self, ctx: RuleContext) -> None:
        ...


def process_rules_are_enabled(ctx: RuleContext) -> bool:
    return ctx.resolved_rules_config.get("enabled") is not False


@dataclass(frozen=True)
class CompiledRuleView:
    target_spec: dict[str, dict[str, Any]]
    compiled_bounds: dict[str, dict[str, float | None]]
    nominal_targets: dict[str, float]
    disabled_alloys: dict[str, list[str]]
    rule_flags: dict[str, tuple[str, ...]]
    resolved_rules_config: dict[str, Any]
    rule_notes: tuple[str, ...]
    diagnostics: tuple[str, ...]

    def as_legacy_target(self) -> dict[str, dict[str, float]]:
        target: dict[str, dict[str, float]] = {}
        for element, bounds in self.compiled_bounds.items():
            item: dict[str, float] = {}
            if bounds.get("min") is not None:
                item["min"] = float(bounds["min"])
            if bounds.get("max") is not None:
                item["max"] = float(bounds["max"])
            if item:
                target[element] = item
        return target


class RuleEngine:
    def __init__(self, plugins: list[RulePlugin]) -> None:
        self._plugins = sorted(plugins, key=lambda item: (_PHASE_ORDER[item.phase], item.priority, item.rule_id))

    def run(self, ctx: RuleContext) -> RuleContext:
        for plugin in self._plugins:
            if not process_rules_are_enabled(ctx) and not getattr(plugin, "run_when_process_rules_disabled", False):
                continue
            plugin.apply(ctx)
        return ctx


class EmptyOrZeroTargetRule:
    rule_id = "empty-or-zero-target"
    phase = "normalize"
    priority = 10
    run_when_process_rules_disabled = True

    def apply(self, ctx: RuleContext) -> None:
        for element, spec in list(ctx.target_spec.items()):
            mode = spec.get("mode")
            if mode == "single":
                value = _float_or_none(spec.get("value"))
                if value is None or value <= 0:
                    ctx.target_spec[element] = {"mode": "none"}
                else:
                    ctx.target_spec[element] = {"mode": "single", "value": value}
            elif mode == "range":
                minimum = _float_or_none(spec.get("min"))
                maximum = _float_or_none(spec.get("max"))
                minimum = None if minimum is None or minimum <= 0 else minimum
                maximum = None if maximum is None or maximum <= 0 else maximum
                if minimum is None and maximum is None:
                    ctx.target_spec[element] = {"mode": "none"}
                else:
                    ctx.target_spec[element] = {"mode": "range", "min": minimum, "max": maximum}
            else:
                ctx.target_spec[element] = {"mode": "none"}


class NominalTargetRule:
    rule_id = "nominal-target"
    phase = "compile_target"
    priority = 5
    run_when_process_rules_disabled = True

    def apply(self, ctx: RuleContext) -> None:
        ctx.nominal_targets = {}
        for element, spec in ctx.target_spec.items():
            mode = spec.get("mode")
            if mode == "single":
                value = _float_or_none(spec.get("value"))
                if value is not None and value > 0:
                    ctx.nominal_targets[element] = value
            elif mode == "range":
                maximum = _float_or_none(spec.get("max"))
                minimum = _float_or_none(spec.get("min"))
                if maximum is not None:
                    ctx.nominal_targets[element] = maximum
                elif minimum is not None:
                    ctx.nominal_targets[element] = minimum

        control = ctx.raw_config.get("control_targets") or {}
        if control.get("enabled") is False:
            return
        for element in _CONTROLLED_ELEMENTS:
            item = (control.get("elements") or {}).get(element) or {}
            if item.get("enabled") is True and _float_or_none(item.get("value")) is not None:
                ctx.nominal_targets[element] = float(item["value"])


class LegacyRangeTargetRule:
    rule_id = "legacy-range-target"
    phase = "compile_target"
    priority = 10
    run_when_process_rules_disabled = True

    def apply(self, ctx: RuleContext) -> None:
        margins = ctx.raw_config.get("safety_margins") or {}
        for element, spec in ctx.target_spec.items():
            if spec.get("mode") != "range":
                continue
            margin = (margins.get(element) or {}) if isinstance(margins.get(element), dict) else {}
            minimum = spec.get("min")
            maximum = spec.get("max")
            compiled = {
                "min": None if minimum is None else float(minimum) + float(margin.get("low") or 0),
                "max": None if maximum is None else float(maximum) - float(margin.get("high") or 0),
            }
            if compiled["min"] is not None or compiled["max"] is not None:
                ctx.compiled_bounds[element] = compiled
                ctx.add_flag(element, "range")


class BasicSingleTargetRule:
    rule_id = "basic-single-target"
    phase = "compile_target"
    priority = 11
    run_when_process_rules_disabled = True

    def apply(self, ctx: RuleContext) -> None:
        for element, spec in ctx.target_spec.items():
            if spec.get("mode") != "single":
                continue
            value = _float_or_none(spec.get("value"))
            if value is None:
                continue
            if element in {"C", "P", "S"}:
                ctx.compiled_bounds[element] = {"min": None, "max": value}
                ctx.add_flag(element, "upper-only")
            else:
                ctx.compiled_bounds[element] = {"min": value, "max": value}
                ctx.add_flag(element, "exact")


class CarbonMarginRule:
    rule_id = "carbon-margin"
    phase = "compile_target"
    priority = 20

    def apply(self, ctx: RuleContext) -> None:
        spec = ctx.target_spec.get("C") or {}
        value = ctx.nominal_targets.get("C")
        if value is None:
            return
        margin = float(ctx.resolved_rules_config["carbon_target_margin"])
        current = ctx.compiled_bounds.get("C", {"min": None, "max": None})
        upper = value - margin
        if current.get("max") is not None:
            upper = min(float(current["max"]), upper)
        ctx.compiled_bounds["C"] = {"min": current.get("min"), "max": upper}
        ctx.add_flag("C", "upper-only")


class PhosphorusSulfurUpperOnlyRule:
    rule_id = "phosphorus-sulfur-upper-only"
    phase = "compile_target"
    priority = 30

    def apply(self, ctx: RuleContext) -> None:
        for element in ("P", "S"):
            spec = ctx.target_spec.get(element) or {}
            if spec.get("mode") != "single":
                continue
            value = _float_or_none(spec.get("value"))
            if value is None:
                continue
            ctx.compiled_bounds[element] = {"min": None, "max": value}
            ctx.add_flag(element, "upper-only")


class LowSiliconUpperOnlyRule:
    rule_id = "low-silicon-upper-only"
    phase = "compile_target"
    priority = 40

    def apply(self, ctx: RuleContext) -> None:
        spec = ctx.target_spec.get("Si") or {}
        if spec.get("mode") != "single":
            return
        value = _float_or_none(spec.get("value"))
        if value is None:
            return
        limit = float(ctx.resolved_rules_config["single_target_si_upper_only_max"])
        if value <= limit + EPS:
            ctx.compiled_bounds["Si"] = {"min": None, "max": value}
            ctx.add_flag("Si", "upper-only")


class TraceElementNoAdditionTargetRule:
    rule_id = "trace-element-no-addition-target"
    phase = "compile_target"
    priority = 45

    def apply(self, ctx: RuleContext) -> None:
        thresholds = ctx.resolved_rules_config.get("trace_alloy_thresholds") or {}
        for element, threshold in thresholds.items():
            value = ctx.nominal_targets.get(element)
            if value is None or value > float(threshold) + EPS:
                continue
            ctx.compiled_bounds.pop(element, None)
            ctx.add_flag(element, "no-addition")


class TitaniumSingleOffsetRule:
    rule_id = "titanium-single-offset"
    phase = "compile_target"
    priority = 50

    def apply(self, ctx: RuleContext) -> None:
        spec = ctx.target_spec.get("Ti") or {}
        if spec.get("mode") != "single":
            return
        value = _float_or_none(spec.get("value"))
        if value is None:
            return
        offset = float(ctx.resolved_rules_config["ti_safety_addition"])
        adjusted = value + offset
        ctx.compiled_bounds["Ti"] = {"min": adjusted, "max": adjusted}
        ctx.add_flag("Ti", "exact-with-offset")


class HighSiliconExactRule:
    rule_id = "high-silicon-exact"
    phase = "compile_target"
    priority = 60

    def apply(self, ctx: RuleContext) -> None:
        spec = ctx.target_spec.get("Si") or {}
        if spec.get("mode") != "single":
            return
        value = _float_or_none(spec.get("value"))
        if value is None:
            return
        limit = float(ctx.resolved_rules_config["single_target_si_upper_only_max"])
        if value > limit + EPS:
            ctx.compiled_bounds["Si"] = {"min": value, "max": value}
            ctx.add_flag("Si", "exact")


class ExactSingleTargetRule:
    rule_id = "exact-single-target"
    phase = "compile_target"
    priority = 70

    def apply(self, ctx: RuleContext) -> None:
        for element, spec in ctx.target_spec.items():
            if spec.get("mode") != "single":
                continue
            if element in {"C", "P", "S", "Si", "Ti"}:
                continue
            if "no-addition" in ctx.rule_flags.get(element, set()):
                continue
            value = _float_or_none(spec.get("value"))
            if value is None:
                continue
            ctx.compiled_bounds[element] = {"min": value, "max": value}
            ctx.add_flag(element, "exact")


class TitaniumRangeOffsetRule:
    rule_id = "titanium-range-offset"
    phase = "compile_target"
    priority = 80

    def apply(self, ctx: RuleContext) -> None:
        spec = ctx.target_spec.get("Ti") or {}
        if spec.get("mode") != "range":
            return
        bounds = ctx.compiled_bounds.get("Ti")
        if not bounds:
            return
        offset = float(ctx.resolved_rules_config["ti_safety_addition"])
        if bounds.get("min") is not None:
            bounds["min"] = float(bounds["min"]) + offset
        ctx.compiled_bounds["Ti"] = bounds
        ctx.add_flag("Ti", "range-offset")


class ControlTargetOverlayRule:
    rule_id = "control-target-overlay"
    phase = "compile_target"
    priority = 90

    def apply(self, ctx: RuleContext) -> None:
        control = ctx.raw_config.get("control_targets") or {}
        if control.get("enabled") is False:
            return
        margin = float(control.get("margin") or 0)
        for element in _CONTROLLED_ELEMENTS:
            item = (control.get("elements") or {}).get(element) or {}
            if item.get("enabled") is not True:
                continue
            raw_value = _float_or_none(item.get("value"))
            if raw_value is None:
                continue
            max_value = raw_value - margin
            if element == "C":
                carbon_margin = float(ctx.resolved_rules_config["carbon_target_margin"])
                max_value = min(max_value, raw_value - carbon_margin)
            ctx.compiled_bounds[element] = {"min": None, "max": max_value}
            ctx.add_flag(element, "control-target")


class ManualAluminumTargetRule:
    rule_id = "manual-aluminum-target"
    phase = "compile_target"
    priority = 95

    def apply(self, ctx: RuleContext) -> None:
        if ctx.resolved_rules_config.get("manual_aluminum") is not True:
            return
        for element in ("Als", "Alt"):
            ctx.compiled_bounds.pop(element, None)
            ctx.add_flag(element, "manual-aluminum")


class DisableSiliconAlloyRule:
    rule_id = "disable-silicon-alloy"
    phase = "compile_alloy"
    priority = 10

    def apply(self, ctx: RuleContext) -> None:
        target = ctx.nominal_targets.get("Si")
        if target is None:
            return
        limit = float(ctx.resolved_rules_config["disable_silicon_alloys_si_max"])
        if target <= limit + EPS:
            ctx.add_disabled_alloys(self.rule_id, _SILICON_ALLOY_ALIASES)


class ManualAluminumRule:
    rule_id = "manual-aluminum"
    phase = "compile_alloy"
    priority = 20

    def apply(self, ctx: RuleContext) -> None:
        if ctx.resolved_rules_config.get("manual_aluminum") is True:
            ctx.add_disabled_alloys(self.rule_id, _ALUMINUM_ALIASES)


class TraceElementNoAdditionRule:
    rule_id = "trace-element-no-addition"
    phase = "compile_alloy"
    priority = 30

    def apply(self, ctx: RuleContext) -> None:
        thresholds = ctx.resolved_rules_config.get("trace_alloy_thresholds") or {}
        for element, threshold in thresholds.items():
            target = ctx.nominal_targets.get(element)
            if target is None or target > float(threshold) + EPS:
                continue
            ctx.add_disabled_alloys(self.rule_id, _TRACE_ELEMENT_ALLOY_ALIASES.get(element, ()))


class PhosphorusSulfurNoAdditionRule:
    rule_id = "phosphorus-sulfur-no-addition"
    phase = "compile_alloy"
    priority = 40

    def apply(self, ctx: RuleContext) -> None:
        thresholds = {
            "P": float(ctx.resolved_rules_config["phosphorus_alloy_max"]),
            "S": float(ctx.resolved_rules_config["sulfur_alloy_max"]),
        }
        for element, aliases in _PHOSPHORUS_SULFUR_ALLOY_ALIASES.items():
            target = ctx.nominal_targets.get(element)
            if target is None or target > thresholds[element] + EPS:
                continue
            ctx.add_disabled_alloys(self.rule_id, aliases)


class ManganeseFallbackRule:
    rule_id = "manganese-fallback"
    phase = "compile_alloy"
    priority = 50

    def apply(self, ctx: RuleContext) -> None:
        ctx.disabled_alloys.pop("金属锰", None)


def default_rule_plugins() -> list[RulePlugin]:
    return [
        EmptyOrZeroTargetRule(),
        NominalTargetRule(),
        LegacyRangeTargetRule(),
        BasicSingleTargetRule(),
        CarbonMarginRule(),
        PhosphorusSulfurUpperOnlyRule(),
        LowSiliconUpperOnlyRule(),
        TraceElementNoAdditionTargetRule(),
        TitaniumSingleOffsetRule(),
        HighSiliconExactRule(),
        ExactSingleTargetRule(),
        TitaniumRangeOffsetRule(),
        ControlTargetOverlayRule(),
        ManualAluminumTargetRule(),
        DisableSiliconAlloyRule(),
        ManualAluminumRule(),
        TraceElementNoAdditionRule(),
        PhosphorusSulfurNoAdditionRule(),
        ManganeseFallbackRule(),
    ]


def _freeze_rule_flags(flags: dict[str, set[str]]) -> dict[str, tuple[str, ...]]:
    return {element: tuple(sorted(values)) for element, values in flags.items()}


def compile_rule_view(config: dict[str, Any], *, force_recompute: bool = False) -> CompiledRuleView:
    """把原始配置编译成统一规则视图，并缓存到 config。"""

    if not force_recompute and isinstance(config, dict):
        cached = config.get(_CACHE_KEY)
        if isinstance(cached, CompiledRuleView):
            return cached

    ctx = RuleContext(
        raw_config=config,
        resolved_rules_config=resolve_process_rules(config),
        target_spec=normalize_target_spec_dict(build_initial_target_spec(config)),
    )
    RuleEngine(default_rule_plugins()).run(ctx)
    view = CompiledRuleView(
        target_spec=copy.deepcopy(ctx.target_spec),
        compiled_bounds=copy.deepcopy(ctx.compiled_bounds),
        nominal_targets=copy.deepcopy(ctx.nominal_targets),
        disabled_alloys=copy.deepcopy(ctx.disabled_alloys),
        rule_flags=_freeze_rule_flags(ctx.rule_flags),
        resolved_rules_config=copy.deepcopy(ctx.resolved_rules_config),
        rule_notes=tuple(ctx.rule_notes),
        diagnostics=tuple(ctx.diagnostics),
    )
    if isinstance(config, dict):
        config[_CACHE_KEY] = view
    return view
