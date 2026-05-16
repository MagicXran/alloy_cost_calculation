(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlloyOptimizer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ELEMENTS = ['C', 'Si', 'Mn', 'Cr', 'P', 'S'];
  var EPS = 1e-8;

  // 业务错误类型：让 CLI、测试和浏览器都能给出同一套错误信息。
  function OptimizerError(message, details) {
    this.name = 'OptimizerError';
    this.message = message;
    this.details = details || [];
    if (Error.captureStackTrace) Error.captureStackTrace(this, OptimizerError);
  }
  OptimizerError.prototype = Object.create(Error.prototype);
  OptimizerError.prototype.constructor = OptimizerError;

  // 元素质量平衡公式：kg/t * 成分百分数 * 回收率 / 1000 = 最终成分百分点增量。
  function elementIncrementKgPerT(kgPerTon, compositionPercent, recoveryRate) {
    return kgPerTon * compositionPercent * recoveryRate / 1000;
  }

  // 深拷贝输入，避免求解器污染界面状态或测试对象。
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // 数字读取必须显式校验，不能让空字符串被 JavaScript 偷偷转成 0。
  function numberOrThrow(value, label) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      throw new OptimizerError(label + ' 不能为空');
    }
    var num = Number(value);
    if (!Number.isFinite(num)) throw new OptimizerError(label + ' 不是有效数字');
    return num;
  }

  // 加载配置后立刻校验；宁可报错，也不能输出看起来很真的错误结果。
  function validateConfig(config) {
    var errors = [];
    var heatWeight = numberOrThrow(config.heat_weight_t, 'heat_weight_t');
    if (heatWeight < 1 || heatWeight > 500) errors.push('heat_weight_t 应在 1~500 t 之间');

    Object.keys(config.recovery_rates || {}).forEach(function (element) {
      var value = numberOrThrow(config.recovery_rates[element], 'recovery_rates.' + element);
      if (value < 0 || value > 1.2) errors.push(element + ' 回收率异常，应在 0~1.2');
    });

    Object.keys(config.safety_margins || {}).forEach(function (element) {
      ['low', 'high'].forEach(function (side) {
        var value = numberOrThrow(config.safety_margins[element][side] || 0, 'safety_margins.' + element + '.' + side);
        if (value < 0 || value > 0.5) errors.push(element + ' 安全余量应在 0~0.5');
        if (value > 0.1) errors.push(element + ' 安全余量过大，确认是否单位错误');
      });
    });

    Object.keys(config.target || {}).forEach(function (element) {
      var spec = config.target[element];
      ['min', 'max'].forEach(function (bound) {
        if (spec[bound] === undefined) return;
        var value = numberOrThrow(spec[bound], 'target.' + element + '.' + bound);
        if (value < 0 || value > 10) errors.push(element + ' 目标成分超过 0~10%，确认是否单位错误');
      });
      if (spec.min !== undefined && spec.max !== undefined && Number(spec.min) > Number(spec.max)) {
        errors.push(element + ' 目标下限不能大于上限');
      }
      var bounds = effectiveBounds(config, element);
      if (bounds.min !== null && bounds.max !== null && bounds.min > bounds.max) {
        errors.push(element + ' 安全余量导致有效上下限交叉');
      }
    });

    (config.alloys || []).forEach(function (alloy) {
      if (alloy.enabled === false) return;
      var price = numberOrThrow(alloy.price_per_ton, alloy.name + '.price_per_ton');
      if (price < 100 || price > 200000) errors.push(alloy.name + ' 价格应为 ¥/t，当前值疑似单位错误');
      var bagSize = numberOrThrow(alloy.bag_size_kg || 0, alloy.name + '.bag_size_kg');
      if (bagSize < 0 || bagSize > 2000) errors.push(alloy.name + ' bag_size_kg 应在 0~2000 kg');
      var maxAdd = numberOrThrow(alloy.max_add_kg_per_t, alloy.name + '.max_add_kg_per_t');
      if (maxAdd <= 0 || maxAdd > 200) errors.push(alloy.name + ' max_add_kg_per_t 应为合理正数');
      Object.keys(alloy.composition || {}).forEach(function (element) {
        var value = numberOrThrow(alloy.composition[element], alloy.name + '.composition.' + element);
        if (value < 0 || value > 100) errors.push(alloy.name + ' ' + element + ' 成分应在 0~100%');
        if ((element === 'Si' || element === 'Mn' || element === 'Cr') && value > 0 && value < 1) {
          errors.push(alloy.name + ' ' + element + '=' + value + ' 疑似百分比单位错误，是否应写成如 65.66 而不是 0.6566？');
        }
      });
    });

    if (errors.length) throw new OptimizerError(errors.join('；'), errors);
    return true;
  }

  // P/S 残余超标是工艺问题，不是优化器能解决的问题。
  function precheckResidualImpurities(config) {
    ['P', 'S'].forEach(function (element) {
      var residual = Number((config.residual || {})[element] || 0);
      var max = Number(((config.target || {})[element] || {}).max);
      if (Number.isFinite(max) && residual > max + EPS) {
        throw new OptimizerError('当前' + element + '=' + formatNumber(residual, 4) + '%已超过目标上限' + formatNumber(max, 4) + '%，加合金无法降低' + element + '，需先做工艺处理');
      }
    });
  }

  // 每种合金对某元素的贡献系数，单位是成分百分点每 kg/t。
  function alloyCoeff(alloy, element, config) {
    var percent = Number((alloy.composition || {})[element] || 0);
    var overrides = alloy.recovery_overrides || {};
    var rate = Number(overrides[element] !== undefined ? overrides[element] : ((config.recovery_rates || {})[element] !== undefined ? config.recovery_rates[element] : 1));
    return percent * rate / 1000;
  }

  // 统一处理安全边界，P/S 没有下限时 min 保持 null。
  function effectiveBounds(config, element) {
    var target = (config.target || {})[element] || {};
    var margin = (config.safety_margins || {})[element] || { low: 0, high: 0 };
    return {
      min: target.min === undefined ? null : Number(target.min) + Number(margin.low || 0),
      max: target.max === undefined ? null : Number(target.max) - Number(margin.high || 0),
    };
  }

  function buildLinearModel(config, alloys, fixedKgPerTon) {
    var constraints = [];
    var residual = config.residual || {};
    ELEMENTS.forEach(function (element) {
      var bounds = effectiveBounds(config, element);
      var coeff = alloys.map(function (alloy) { return alloyCoeff(alloy, element, config); });
      if (bounds.max !== null) constraints.push({ a: coeff, b: bounds.max - Number(residual[element] || 0), label: element + '上限' });
      if (bounds.min !== null) constraints.push({ a: coeff.map(function (value) { return -value; }), b: -(bounds.min - Number(residual[element] || 0)), label: element + '下限' });
    });
    var boundsList = alloys.map(function (alloy, index) {
      if (fixedKgPerTon && fixedKgPerTon[index] !== undefined) {
        var override = fixedKgPerTon[index];
        if (typeof override === 'number') return { lower: override, upper: override };
        return { lower: override.lower !== undefined ? override.lower : 0, upper: override.upper !== undefined ? override.upper : Number(alloy.max_add_kg_per_t) };
      }
      return { lower: 0, upper: Number(alloy.max_add_kg_per_t) };
    });
    return { constraints: constraints, bounds: boundsList, c: alloys.map(function (alloy) { return Number(alloy.price_per_ton) / 1000; }) };
  }

  // 朴素高斯消元足够解决 7 变量小模型，没必要引入外部依赖。
  function solveLinearSystem(matrix, vector) {
    var n = vector.length;
    var a = matrix.map(function (row, i) { return row.slice().concat([vector[i]]); });
    for (var col = 0; col < n; col += 1) {
      var pivot = col;
      for (var row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-10) return null;
      var tmp = a[col]; a[col] = a[pivot]; a[pivot] = tmp;
      var divisor = a[col][col];
      for (var j = col; j <= n; j += 1) a[col][j] /= divisor;
      for (var r = 0; r < n; r += 1) {
        if (r === col) continue;
        var factor = a[r][col];
        for (var k = col; k <= n; k += 1) a[r][k] -= factor * a[col][k];
      }
    }
    return a.map(function (row) { return row[n]; });
  }

  function chooseActive(total, size, visit) {
    var picked = [];
    function dfs(start) {
      if (picked.length === size) { visit(picked.slice()); return; }
      for (var i = start; i <= total - (size - picked.length); i += 1) {
        picked.push(i); dfs(i + 1); picked.pop();
      }
    }
    dfs(0);
  }

  // LP 顶点枚举：小规模、确定性、离线可跑。
  function solveLP(config, alloys, fixedKgPerTon) {
    var model = buildLinearModel(config, alloys, fixedKgPerTon);
    var n = alloys.length;
    if (n === 0) return null;
    var active = model.constraints.map(function (item) { return { a: item.a, b: item.b, label: item.label }; });
    for (var i = 0; i < n; i += 1) {
      var upper = Array(n).fill(0); upper[i] = 1;
      active.push({ a: upper, b: model.bounds[i].upper, label: alloys[i].name + '上限' });
      var lower = Array(n).fill(0); lower[i] = -1;
      active.push({ a: lower, b: -model.bounds[i].lower, label: alloys[i].name + '下限' });
    }
    var best = null;
    chooseActive(active.length, n, function (indexes) {
      var matrix = indexes.map(function (index) { return active[index].a; });
      var vector = indexes.map(function (index) { return active[index].b; });
      var x = solveLinearSystem(matrix, vector);
      if (!x || !isFeasible(x, active)) return;
      var cost = dot(model.c, x);
      if (!best || cost < best.costPerTon - 1e-9) best = { x: x, costPerTon: cost };
    });
    return best;
  }

  function isFeasible(x, constraints) {
    return constraints.every(function (constraint) { return dot(constraint.a, x) <= constraint.b + 1e-7; }) && x.every(function (value) { return value >= -1e-7; });
  }

  function dot(a, b) {
    return a.reduce(function (sum, value, index) { return sum + value * b[index]; }, 0);
  }

  // 小规模分支定界：袋装合金整数袋，非袋装合金保持连续变量。
  function solveMILP(config, alloys) {
    var integerIndexes = [];
    alloys.forEach(function (alloy, index) { if (Number(alloy.bag_size_kg || 0) > 0) integerIndexes.push(index); });
    var best = null;
    var nodes = 0;
    var nodeLimitHit = false;
    var maxNodes = 20000;

    function isIntegerBag(index, kgPerTon) {
      var step = Number(alloys[index].bag_size_kg) / Number(config.heat_weight_t);
      var bags = kgPerTon / step;
      return Math.abs(bags - Math.round(bags)) < 1e-6;
    }

    function mergeBound(bounds, index, patch) {
      var next = Object.assign({}, bounds);
      var current = Object.assign({}, next[index] || {});
      if (patch.lower !== undefined) current.lower = Math.max(current.lower !== undefined ? current.lower : 0, patch.lower);
      if (patch.upper !== undefined) current.upper = Math.min(current.upper !== undefined ? current.upper : Number(alloys[index].max_add_kg_per_t), patch.upper);
      if (current.lower !== undefined && current.upper !== undefined && current.lower > current.upper + EPS) return null;
      next[index] = current;
      return next;
    }

    function branch(bounds) {
      nodes += 1;
      if (nodes > maxNodes) { nodeLimitHit = true; return; }
      var relaxed = solveLP(config, alloys, bounds);
      if (!relaxed) return;
      if (best && relaxed.costPerTon >= best.costPerTon - 1e-9) return;

      var fractional;
      for (var i = 0; i < integerIndexes.length; i += 1) {
        if (!isIntegerBag(integerIndexes[i], relaxed.x[integerIndexes[i]])) { fractional = integerIndexes[i]; break; }
      }
      if (fractional === undefined) { best = relaxed; best.nodes = nodes; return; }

      var step = Number(alloys[fractional].bag_size_kg) / Number(config.heat_weight_t);
      var bags = relaxed.x[fractional] / step;
      var floorKg = Math.floor(bags) * step;
      var ceilKg = Math.ceil(bags) * step;
      var left = mergeBound(bounds, fractional, { upper: floorKg });
      var right = mergeBound(bounds, fractional, { lower: ceilKg });

      if (left && right) {
        var leftGap = Math.abs(relaxed.x[fractional] - floorKg);
        var rightGap = Math.abs(ceilKg - relaxed.x[fractional]);
        if (rightGap < leftGap) { branch(right); branch(left); } else { branch(left); branch(right); }
      } else {
        if (left) branch(left);
        if (right) branch(right);
      }
    }

    branch({});
    if (best) best.nodes = nodes;
    if (nodeLimitHit) return { nodeLimitHit: true, best: best, nodes: nodes };
    return best;
  }

  // 规则基线是可行的保守对照：低碳优先，不和 MILP 抢“最优”这个名分。
  function solveRuleBaseline(config, alloys) {
    var conservativeAlloys = alloys.filter(function (alloy) {
      return Number((alloy.composition || {}).C || 0) <= 5;
    });
    var conservative = conservativeAlloys.length ? solveMILP(config, conservativeAlloys) : null;
    if (conservative && !conservative.nodeLimitHit) {
      var byName = {};
      conservativeAlloys.forEach(function (alloy, index) { byName[alloy.name] = conservative.x[index] || 0; });
      return { x: alloys.map(function (alloy) { return byName[alloy.name] || 0; }), costPerTon: costFor(alloys, alloys.map(function (alloy) { return byName[alloy.name] || 0; })) };
    }

    // 极端配置下保守基线可能不可行，退回顺序贪心并由成分校核标记，不伪造成合格方案。
    var ordered = alloys.slice().sort(function (a, b) { return Number(a.addition_sequence || 99) - Number(b.addition_sequence || 99); });
    var doses = {};
    alloys.forEach(function (alloy) { doses[alloy.name] = 0; });
    ordered.forEach(function (alloy) {
      for (var pass = 0; pass < 120; pass += 1) {
        var current = chemistryFromDoses(config, alloys, doses);
        var need = mostUsefulNeed(config, alloy, current);
        if (!need) break;
        var coeff = alloyCoeff(alloy, need, config);
        if (coeff <= 0) break;
        var target = effectiveBounds(config, need).min;
        var step = Math.min(0.25, Math.max(0.02, (target - current[need]) / coeff));
        if (!canAdd(config, alloys, doses, alloy.name, step)) break;
        doses[alloy.name] += step;
      }
    });
    var x = alloys.map(function (alloy) { return doses[alloy.name] || 0; });
    return { x: x, costPerTon: costFor(alloys, x) };
  }

  function mostUsefulNeed(config, alloy, current) {
    var best = null;
    ['Cr', 'Si', 'Mn', 'C'].forEach(function (element) {
      var bounds = effectiveBounds(config, element);
      if (bounds.min === null || current[element] >= bounds.min - EPS) return;
      if (alloyCoeff(alloy, element, config) <= 0) return;
      var deficit = bounds.min - current[element];
      if (!best || deficit > best.deficit) best = { element: element, deficit: deficit };
    });
    return best ? best.element : null;
  }

  function canAdd(config, alloys, doses, alloyName, step) {
    var next = Object.assign({}, doses);
    next[alloyName] = (next[alloyName] || 0) + step;
    var alloy = alloys.find(function (item) { return item.name === alloyName; });
    if (next[alloyName] > Number(alloy.max_add_kg_per_t) + EPS) return false;
    var chemistry = chemistryFromDoses(config, alloys, next);
    return ELEMENTS.every(function (element) {
      var bounds = effectiveBounds(config, element);
      return bounds.max === null || chemistry[element] <= bounds.max + 1e-6;
    });
  }

  function costFor(alloys, x) {
    return alloys.reduce(function (sum, alloy, index) { return sum + Number(alloy.price_per_ton) / 1000 * (x[index] || 0); }, 0);
  }

  function chemistryFromVector(config, alloys, x) {
    var doses = {};
    alloys.forEach(function (alloy, index) { doses[alloy.name] = x[index] || 0; });
    return chemistryFromDoses(config, alloys, doses);
  }

  function chemistryFromDoses(config, alloys, doses) {
    var chemistry = Object.assign({}, config.residual || {});
    ELEMENTS.forEach(function (element) { chemistry[element] = Number(chemistry[element] || 0); });
    alloys.forEach(function (alloy) {
      var kgPerTon = Number(doses[alloy.name] || 0);
      ELEMENTS.forEach(function (element) {
        var rate = (alloy.recovery_overrides || {})[element] !== undefined ? alloy.recovery_overrides[element] : ((config.recovery_rates || {})[element] !== undefined ? config.recovery_rates[element] : 1);
        chemistry[element] += elementIncrementKgPerT(kgPerTon, Number((alloy.composition || {})[element] || 0), Number(rate));
      });
    });
    return chemistry;
  }

  function makeModeResult(name, config, alloys, raw) {
    var x = raw.x.map(function (value, index) {
      var clean = Math.max(0, value < 1e-8 ? 0 : value);
      var bagSize = Number(alloys[index].bag_size_kg || 0);
      if (bagSize > 0) {
        var bags = Math.round(clean * Number(config.heat_weight_t) / bagSize);
        return bags * bagSize / Number(config.heat_weight_t);
      }
      return clean;
    });
    var chemistry = chemistryFromVector(config, alloys, x);
    var costPerTon = costFor(alloys, x);
    return {
      name: name,
      costPerTon: costPerTon,
      heatCost: costPerTon * Number(config.heat_weight_t),
      totalKgPerTon: x.reduce(function (sum, value) { return sum + value; }, 0),
      chemistry: chemistry,
      chemistryChecks: chemistryChecks(config, chemistry),
      alloys: alloys.map(function (alloy, index) {
        var kgPerTon = x[index];
        var heatKg = kgPerTon * Number(config.heat_weight_t);
        var bagSize = Number(alloy.bag_size_kg || 0);
        return {
          name: alloy.name,
          kgPerTon: kgPerTon,
          heatKg: heatKg,
          bags: bagSize > 0 ? Math.round(heatKg / bagSize) : null,
          bagSizeKg: bagSize,
          sequence: Number(alloy.addition_sequence || 99),
          costPerTon: Number(alloy.price_per_ton) / 1000 * kgPerTon,
        };
      }),
    };
  }

  function chemistryChecks(config, chemistry) {
    return ELEMENTS.map(function (element) {
      var bounds = effectiveBounds(config, element);
      var value = chemistry[element] || 0;
      var aboveMin = bounds.min === null || value >= bounds.min - 1e-7;
      var belowMax = bounds.max === null || value <= bounds.max + 1e-7;
      return { element: element, value: value, min: bounds.min, max: bounds.max, ok: aboveMin && belowMax };
    });
  }

  function diagnoseInfeasible(config, alloys) {
    var diagnostics = [];
    ELEMENTS.forEach(function (element) {
      var bounds = effectiveBounds(config, element);
      var residual = Number((config.residual || {})[element] || 0);
      var maxReach = residual + alloys.reduce(function (sum, alloy) { return sum + Number(alloy.max_add_kg_per_t) * alloyCoeff(alloy, element, config); }, 0);
      if (bounds.min !== null && maxReach < bounds.min - EPS) diagnostics.push(element + '下限无法满足：最多 ' + formatNumber(maxReach, 4) + '%，要求 ' + formatNumber(bounds.min, 4) + '%');
      if (bounds.max !== null && residual > bounds.max + EPS) diagnostics.push(element + '上限无法满足：残余 ' + formatNumber(residual, 4) + '%，上限 ' + formatNumber(bounds.max, 4) + '%');
    });
    if (!diagnostics.length) diagnostics.push('线性约束组合无可行解，请检查 C 上限、Mn/Cr 下限与启用合金组合');
    return diagnostics;
  }

  function warningsFor(config, result) {
    var warnings = ['P/S 含量按配置值计算；若来自默认行业值，正式使用前必须用化验单覆盖。'];
    if (!result.ruleFeasible) warnings.push('规则基线未通过成分校核，只能作为历史经验对照，不能作为节约金额基准。');
    if (!((config.temperature_drop || {}).enabled)) warnings.push('温降估算 V1 禁用，避免输出未校准的假精度。');
    result.modes.lp.alloys.forEach(function (alloy) {
      var source = (config.alloys || []).find(function (item) { return item.name === alloy.name; });
      if (alloy.kgPerTon > EPS && alloy.kgPerTon < 1 && Number((source || {}).bag_size_kg || 0) === 0) {
        warnings.push(alloy.name + ' LP 结果 ' + formatNumber(alloy.kgPerTon, 2) + ' kg/t 为极小量，现场可考虑忽略或改用 MILP。');
      }
    });
    return warnings;
  }

  function solveAlloyCost(inputConfig) {
    var config = clone(inputConfig);
    validateConfig(config);
    precheckResidualImpurities(config);
    var alloys = (config.alloys || []).filter(function (alloy) { return alloy.enabled !== false; });
    var lpRaw = solveLP(config, alloys);
    if (!lpRaw) return { status: 'infeasible', diagnostics: diagnoseInfeasible(config, alloys) };
    var milpRaw = (config.milp_settings || {}).enable_bag_rounding === false ? lpRaw : solveMILP(config, alloys);
    if (!milpRaw) return { status: 'infeasible', diagnostics: diagnoseInfeasible(config, alloys).concat(['LP 可行但整袋 MILP 不可行，请放宽安全余量或调整袋重']) };
    var ruleRaw = solveRuleBaseline(config, alloys);
    if (milpRaw && milpRaw.nodeLimitHit) {
      return { status: 'not_proven', diagnostics: ['MILP 分支节点超过上限，已找到的整数解未证明全局最优；请放宽约束、减少袋装变量或提高求解上限。'] };
    }
    var result = {
      status: 'ok',
      heatWeightT: Number(config.heat_weight_t),
      enabledAlloys: alloys.map(function (alloy) { return alloy.name; }),
      modes: {
        rule: makeModeResult('规则基线', config, alloys, ruleRaw),
        lp: makeModeResult('LP理论下限', config, alloys, lpRaw),
        milp: makeModeResult('MILP现场方案', config, alloys, milpRaw),
      },
    };
    result.ruleFeasible = result.modes.rule.chemistryChecks.every(function (check) { return check.ok; });
    result.costDeltaVsRule = result.modes.milp.costPerTon - result.modes.rule.costPerTon;
    result.costDeltaRateVsRule = result.costDeltaVsRule / result.modes.rule.costPerTon;
    result.savingsVsRule = result.ruleFeasible ? -result.costDeltaVsRule : null;
    result.savingsRateVsRule = result.ruleFeasible ? -result.costDeltaRateVsRule : null;
    result.warnings = warningsFor(config, result);
    return result;
  }

  function formatNumber(value, digits) {
    return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function cliMain() {
    var fs = require('node:fs');
    var path = require('node:path');
    var index = process.argv.indexOf('--config');
    var configPath = index >= 0 ? process.argv[index + 1] : 'config.json';
    var config = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8'));
    console.log(JSON.stringify(solveAlloyCost(config), null, 2));
  }

  var api = { OptimizerError: OptimizerError, ELEMENTS: ELEMENTS, elementIncrementKgPerT: elementIncrementKgPerT, validateConfig: validateConfig, solveAlloyCost: solveAlloyCost, effectiveBounds: effectiveBounds, chemistryFromVector: chemistryFromVector, formatNumber: formatNumber };
  if (typeof module === 'object' && module.exports && require.main === module) cliMain();
  return api;
});
