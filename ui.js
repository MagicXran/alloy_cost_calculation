(function () {
  'use strict';

  // 默认配置内嵌在页面脚本中，保证直接双击 HTML 的 file:// 离线场景也能运行。
  var DEFAULT_CONFIG = {
    heat_weight_t: 132.2,
    steel_weight_kg: 1000,
    recovery_rates: { C: 0.90, Si: 0.75, Mn: 0.98, Cr: 0.95, P: 1.0, S: 1.0 },
    safety_margins: {
      C: { low: 0.000, high: 0.005 }, Si: { low: 0.010, high: 0.010 },
      Mn: { low: 0.010, high: 0.010 }, Cr: { low: 0.005, high: 0.005 },
      P: { low: 0.000, high: 0.002 }, S: { low: 0.000, high: 0.002 }
    },
    alloys: [
      { name: '硅锰', price_per_ton: 5088, composition: { C: 1.72, Si: 17.69, Mn: 65.66, P: 0.15, S: 0.02 }, enabled: true, addition_sequence: 3, bag_size_kg: 0, max_add_kg_per_t: 30, recovery_overrides: {}, notes: '脱氧+合金化' },
      { name: '高碳锰铁', price_per_ton: 5593, composition: { C: 6.69, Mn: 74.6, P: 0.20, S: 0.02 }, enabled: true, addition_sequence: 4, bag_size_kg: 25, max_add_kg_per_t: 25, recovery_overrides: {}, notes: '' },
      { name: '中碳锰铁', price_per_ton: 7420, composition: { C: 1.5, Mn: 78.54, P: 0.20, S: 0.02 }, enabled: true, addition_sequence: 6, bag_size_kg: 25, max_add_kg_per_t: 25, recovery_overrides: {}, notes: '' },
      { name: '低碳锰铁', price_per_ton: 7876, composition: { C: 0.64, Mn: 81.19, P: 0.20, S: 0.02 }, enabled: true, addition_sequence: 7, bag_size_kg: 25, max_add_kg_per_t: 25, recovery_overrides: {}, notes: '' },
      { name: '硅铁', price_per_ton: 4973, composition: { C: 0.2, Si: 72.23, P: 0.03, S: 0.02 }, enabled: true, addition_sequence: 5, bag_size_kg: 0, max_add_kg_per_t: 20, recovery_overrides: {}, notes: '' },
      { name: '高碳铬铁', price_per_ton: 7699, composition: { C: 10.0, Cr: 52.0, P: 0.03, S: 0.04 }, enabled: true, addition_sequence: 1, bag_size_kg: 0, max_add_kg_per_t: 20, recovery_overrides: {}, notes: '' },
      { name: '低碳铬铁', price_per_ton: 14956, composition: { C: 0.12, Cr: 59.44, P: 0.03, S: 0.03 }, enabled: true, addition_sequence: 2, bag_size_kg: 0, max_add_kg_per_t: 20, recovery_overrides: {}, notes: '' }
    ],
    target: {
      C: { min: 0.06, max: 0.10 }, Si: { min: 0.15, max: 0.25 },
      Mn: { min: 1.10, max: 1.30 }, Cr: { min: 0.35, max: 0.45 },
      P: { max: 0.025 }, S: { max: 0.020 }
    },
    residual: { C: 0.04, Si: 0.0, Mn: 0.08, Cr: 0.0, P: 0.008, S: 0.008 },
    milp_settings: { default_bag_size_kg: 25, enable_bag_rounding: true },
    temperature_drop: { enabled: false }
  };

  // 简单深拷贝用于从默认配置派生用户输入配置，避免直接改全局默认值。
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function byId(id) { return document.getElementById(id); }
  function num(id) {
    var value = byId(id).value;
    if (value === null || value === undefined || String(value).trim() === '') throw new Error(id + ' 不能为空');
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(id + ' 不是有效数字');
    return parsed;
  }
  function fmt(value, digits) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }

  // 首次加载时用配置渲染合金开关，计算数据保留在 JS 配置而不是 DOM 文本里。
  function renderAlloyInputs() {
    var container = byId('alloyList');
    container.innerHTML = DEFAULT_CONFIG.alloys.map(function (alloy, index) {
      var checked = alloy.enabled ? 'checked' : '';
      var bag = alloy.bag_size_kg > 0 ? alloy.bag_size_kg : 0;
      var bagLabel = alloy.bag_size_kg > 0 ? 'kg/袋' : '0=连续';
      return '<label class="alloy-row"><input type="checkbox" data-alloy-index="' + index + '" ' + checked + '><span class="alloy-name">' + alloy.name + '</span><span class="alloy-field"><span>¥/t</span><input class="compact-input" type="number" min="100" step="1" data-alloy-price-index="' + index + '" value="' + alloy.price_per_ton + '"></span><span class="alloy-field"><span>' + bagLabel + '</span><input class="compact-input" type="number" min="0" step="1" data-alloy-bag-index="' + index + '" value="' + bag + '"></span></label>';
    }).join('');
  }

  // 从页面输入生成求解配置，只允许用户改 V1 暴露的字段。
  function readInput() {
    var config = clone(DEFAULT_CONFIG);
    config.heat_weight_t = num('heatWeight');
    config.residual = { C: num('resC'), Si: num('resSi'), Mn: num('resMn'), Cr: num('resCr'), P: num('resP'), S: num('resS') };
    config.target = {
      C: { min: num('cMin'), max: num('cMax') }, Si: { min: num('siMin'), max: num('siMax') },
      Mn: { min: num('mnMin'), max: num('mnMax') }, Cr: { min: num('crMin'), max: num('crMax') },
      P: { max: num('pMax') }, S: { max: num('sMax') }
    };
    readAlloyInputs(config);

    return config;
  }

  // 合金价格和袋重是求解输入，不是展示文本；必须从控件写回配置。
  function readAlloyInputs(config) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-alloy-index]'), function (checkbox) {
      config.alloys[Number(checkbox.dataset.alloyIndex)].enabled = checkbox.checked;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-alloy-price-index]'), function (input) {
      var value = String(input.value || '').trim();
      if (value === '') throw new Error(config.alloys[Number(input.dataset.alloyPriceIndex)].name + ' 价格不能为空');
      config.alloys[Number(input.dataset.alloyPriceIndex)].price_per_ton = Number(value);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-alloy-bag-index]'), function (input) {
      var value = String(input.value || '').trim();
      if (value === '') throw new Error(config.alloys[Number(input.dataset.alloyBagIndex)].name + ' 袋重不能为空');
      config.alloys[Number(input.dataset.alloyBagIndex)].bag_size_kg = Number(value);
    });
    return config;
  }

  // 求解入口只做三件事：读输入、调用模型、渲染结果。
  function solveOffline() {
    var status = byId('runStatus');
    try {
      status.textContent = '正在离线求解：规则基线、LP 理论下限、MILP 整袋方案。';
      var config = readInput();
      var result = window.AlloyOptimizer.solveAlloyCost(config);
      if (result.status !== 'ok') {
        renderInfeasible(result);
        return;
      }
      renderResult(config, result);
    } catch (error) {
      status.textContent = '输入错误：' + error.message;
      status.style.borderColor = 'rgba(207,32,47,.5)';
    }
  }

  function renderResult(config, result) {
    var milp = result.modes.milp;
    var rule = result.modes.rule;
    byId('heatWeightBadge').textContent = fmt(config.heat_weight_t, 1) + ' t';
    byId('heroCost').innerHTML = fmt(milp.costPerTon, 1) + ' <span class="summary-unit">¥/t</span>';
    byId('heroCostSub').textContent = result.ruleFeasible
      ? 'MILP 整袋约束后，每炉约 ¥' + fmt(milp.heatCost, 0) + '；相对经验方案节约 ¥' + fmt(result.savingsVsRule * config.heat_weight_t, 0) + '/炉。'
      : 'MILP 整袋约束后，每炉约 ¥' + fmt(milp.heatCost, 0) + '；规则基线成分不合格，不拿它算节约。';
    renderSummary(config, result);
    renderComparison(result);
    renderChemistry(milp);
    renderSequence(milp);
    renderQuality(result);
    byId('runStatus').textContent = '已完成真实离线求解：数据来自当前输入，不上传服务器，不再展示 Mock 结果。';
  }

  function renderSummary(config, result) {
    var milp = result.modes.milp;
    var carbon = milp.chemistry.C;
    var cMax = window.AlloyOptimizer.effectiveBounds(config, 'C').max;
    byId('summaryGrid').innerHTML = [
      summaryCard('吨钢合金成本', fmt(milp.costPerTon, 1), '¥/t', '炉次成本 ¥' + fmt(milp.heatCost, 0), ''),
      result.ruleFeasible
        ? summaryCard('成本变化 vs经验', fmt(result.costDeltaRateVsRule * 100, 1), '%', (result.costDeltaVsRule <= 0 ? '每炉节约 ¥' : '每炉增加 ¥') + fmt(Math.abs(result.costDeltaVsRule * config.heat_weight_t), 0), result.costDeltaVsRule <= 0 ? 'text-up' : 'text-down')
        : summaryCard('规则基线状态', '不合格', '', '不计算节约金额', 'text-down'),
      summaryCard('总合金加入量', fmt(milp.totalKgPerTon, 2), 'kg/t', '炉次合计 ' + fmt(milp.totalKgPerTon * config.heat_weight_t, 0) + ' kg', ''),
      summaryCard('碳余量', fmt(cMax - carbon, 3), '%', '最终 C=' + fmt(carbon, 3) + '%', '')
    ].join('');
  }

  function summaryCard(label, value, unit, sub, extraClass) {
    return '<div class="summary-card"><div class="summary-label">' + label + '</div><div class="summary-value ' + extraClass + '">' + value + ' <span class="summary-unit">' + unit + '</span></div><div class="summary-sub">' + sub + '</div></div>';
  }

  function renderComparison(result) {
    var rows = result.modes.milp.alloys.map(function (alloy, index) {
      var rule = result.modes.rule.alloys[index];
      var lp = result.modes.lp.alloys[index];
      var milpText = fmt(alloy.kgPerTon, 2) + (alloy.bags !== null ? ' (' + alloy.bags + '袋)' : '');
      return '<tr><td>' + alloy.name + '</td><td>' + fmt(rule.kgPerTon, 2) + '</td><td>' + fmt(lp.kgPerTon, 2) + '</td><td>' + milpText + '</td></tr>';
    });
    rows.push('<tr class="row-summary"><td>吨钢成本 ¥/t</td><td>' + fmt(result.modes.rule.costPerTon, 1) + '</td><td>' + fmt(result.modes.lp.costPerTon, 1) + '</td><td>' + fmt(result.modes.milp.costPerTon, 1) + '</td></tr>');
    rows.push(result.ruleFeasible
      ? '<tr class="row-summary"><td>成本变化 vs经验</td><td class="muted">-</td><td>' + fmt((result.modes.lp.costPerTon - result.modes.rule.costPerTon) / result.modes.rule.costPerTon * 100, 1) + '%</td><td>' + fmt(result.costDeltaRateVsRule * 100, 1) + '%</td></tr>'
      : '<tr class="row-summary"><td>规则基线状态</td><td class="text-down">成分不合格</td><td class="muted">不比较</td><td class="muted">不比较</td></tr>');
    byId('comparisonBody').innerHTML = rows.join('');
  }

  function renderChemistry(mode) {
    var okCount = mode.chemistryChecks.filter(function (check) { return check.ok; }).length;
    byId('chemBadge').textContent = okCount + '/' + mode.chemistryChecks.length + ' OK';
    byId('chemBadge').className = okCount === mode.chemistryChecks.length ? 'badge badge-green' : 'badge';
    byId('chemList').innerHTML = mode.chemistryChecks.map(function (check) {
      var width = percentInRange(check);
      var valueClass = check.ok ? 'chem-value' : 'chem-value text-down';
      return '<div class="chem-row"><span class="chem-name">' + check.element + '</span><span class="chem-range"><span class="chem-fill" style="width:' + width + '%"></span></span><span class="' + valueClass + '">' + fmt(check.value, 3) + '</span></div>';
    }).join('');
  }

  function percentInRange(check) {
    var width = 0;
    if (check.min === null && check.max !== null) width = Math.max(0, Math.min(100, check.value / check.max * 100));
    if (check.min !== null && check.max !== null) width = Math.max(0, Math.min(100, (check.value - check.min) / (check.max - check.min) * 100));
    return check.ok && check.value > 0 ? Math.max(3, width) : width;
  }

  function renderSequence(mode) {
    var rows = mode.alloys.filter(function (alloy) { return alloy.kgPerTon > 1e-6; }).sort(function (a, b) { return a.sequence - b.sequence; });
    byId('sequenceList').innerHTML = rows.map(function (alloy, index) {
      var note = alloy.bags !== null ? alloy.bags + ' 袋，' + fmt(alloy.heatKg, 1) + ' kg/炉' : fmt(alloy.heatKg, 1) + ' kg/炉';
      return '<div class="step"><div class="step-index">' + (index + 1) + '</div><div class="step-name">' + alloy.name + '</div><div class="step-dose">' + fmt(alloy.kgPerTon, 2) + ' kg/t</div><div class="step-note">' + note + '</div></div>';
    }).join('');
  }

  function renderQuality(result) {
    byId('qualityStrip').innerHTML = '<strong>质控提醒</strong>' + result.warnings.map(function (warning) { return '<span>' + warning + '</span>'; }).join('');
  }

  function renderInfeasible(result) {
    byId('comparisonBody').innerHTML = '<tr><td colspan="4">无可行解：' + result.diagnostics.join('；') + '</td></tr>';
    byId('runStatus').textContent = '无可行解：' + result.diagnostics.join('；');
  }

  // 折叠按钮只处理界面状态，不混入求解逻辑。
  function toggleDetails() {
    var details = byId('alloyDetails');
    details.open = !details.open;
  }

  function requestSolveOffline() {
    byId('runStatus').textContent = '已收到求解请求，正在计算。';
    setTimeout(solveOffline, 0);
  }

  window.DEFAULT_CONFIG = DEFAULT_CONFIG;
  window.AlloyCostUI = { readInput: readInput, readAlloyInputs: readAlloyInputs, percentInRange: percentInRange };
  window.solveOffline = solveOffline;
  window.requestSolveOffline = requestSolveOffline;
  window.toggleDetails = toggleDetails;
  document.addEventListener('DOMContentLoaded', function () {
    renderAlloyInputs();
    solveOffline();
  });
})();
