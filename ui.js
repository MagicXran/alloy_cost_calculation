(function () {
  'use strict';

  // 默认配置用于初始化表单；实际计算必须交给后端 API，不能在浏览器里跑一套影子模型。
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
  var lastResult = null;
  var selectedModeKey = 'milp';
  var MODE_META = {
    rule: { label: '规则基线', note: '规则基线是系统按保守规则生成的对照方案，不等于现场历史真实投料。', sequenceBadge: '规则基线对照' },
    lp: { label: 'LP 理论下限', note: 'LP 是连续变量理论下限，不是现场整袋投料单；顺序仅用于阅读理论用量。', sequenceBadge: '理论顺序参考' },
    milp: { label: 'MILP 现场方案', note: 'MILP 是按整袋约束生成的现场投料方案。', sequenceBadge: '按现场投料阅读' }
  };
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
      var bag = alloy.bag_size_kg > 0 ? alloy.bag_size_kg : DEFAULT_CONFIG.milp_settings.default_bag_size_kg;
      var bagChecked = alloy.bag_size_kg > 0 ? 'checked' : '';
      var modeText = alloy.bag_size_kg > 0 ? '整袋' : '连续';
      return '<div class="alloy-row"><input type="checkbox" aria-label="启用' + alloy.name + '" data-alloy-index="' + index + '" ' + checked + '><span class="alloy-name">' + alloy.name + '</span><span class="alloy-controls"><label class="alloy-field"><span>¥/t</span><input class="compact-input" type="number" min="100" step="1" data-alloy-price-index="' + index + '" value="' + alloy.price_per_ton + '"></label><label class="switch-field"><input type="checkbox" data-alloy-bag-mode-index="' + index + '" ' + bagChecked + '><span class="switch-track" aria-hidden="true"></span><span class="switch-text" data-alloy-mode-text="' + index + '">' + modeText + '</span><span class="alloy-field bag-size-field" data-alloy-bag-field="' + index + '"><span>kg/袋</span><input class="compact-input" type="number" min="1" step="1" data-alloy-bag-index="' + index + '" value="' + bag + '"></span></label></span></div>';
    }).join('');
    syncBagModeLabels();
  }

  // 滑钮表达投料方式：关闭=连续投料，打开=按袋重做整数袋 MILP 约束。
  function syncBagModeLabels() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-alloy-bag-mode-index]'), function (toggle) {
      var text = document.querySelector('[data-alloy-mode-text="' + toggle.dataset.alloyBagModeIndex + '"]');
      var input = document.querySelector('[data-alloy-bag-index="' + toggle.dataset.alloyBagModeIndex + '"]');
      var field = document.querySelector('[data-alloy-bag-field="' + toggle.dataset.alloyBagModeIndex + '"]');
      if (text) text.textContent = toggle.checked ? '整袋' : '连续';
      if (input) input.disabled = !toggle.checked;
      if (toggle.parentElement) toggle.parentElement.classList.toggle('is-continuous', !toggle.checked);
      if (field) field.setAttribute('aria-hidden', toggle.checked ? 'false' : 'true');
    });
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
    Array.prototype.forEach.call(document.querySelectorAll('[data-alloy-bag-mode-index]'), function (toggle) {
      var index = Number(toggle.dataset.alloyBagModeIndex);
      var input = document.querySelector('[data-alloy-bag-index="' + index + '"]');
      var value = String((input && input.value) || '').trim();
      if (toggle.checked && value === '') throw new Error(config.alloys[index].name + ' 袋重不能为空');
      var bagSize = Number(value);
      if (toggle.checked && (!Number.isFinite(bagSize) || bagSize <= 0)) throw new Error(config.alloys[index].name + ' 袋重必须大于 0 kg');
      config.alloys[index].bag_size_kg = toggle.checked ? bagSize : 0;
    });
    syncBagModeLabels();
    return config;
  }

  // 求解入口只做三件事：读输入、调用后端、渲染结果。
  function solveRemote() {
    var status = byId('runStatus');
    try {
      status.textContent = '正在调用后端求解：FastAPI + SciPy/HiGHS。';
      var config = readInput();
      return requestOptimize(config).then(function (result) {
        if (result.status !== 'ok') {
          renderInfeasible(result);
          return;
        }
        renderResult(config, result);
      }).catch(function (error) {
        status.textContent = '后端求解失败：' + error.message;
        status.style.borderColor = 'rgba(207,32,47,.5)';
      });
    } catch (error) {
      status.textContent = '输入错误：' + error.message;
      status.style.borderColor = 'rgba(207,32,47,.5)';
      return Promise.resolve();
    }
  }

  function requestOptimize(config) {
    var fetchImpl = window.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('当前浏览器不支持 fetch，无法调用后端 API');
    return fetchImpl(apiBaseUrl() + '/api/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solver: 'highs', config: config })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
        return payload;
      });
    });
  }

  function apiBaseUrl() {
    if (window.ALLOY_API_BASE_URL) return window.ALLOY_API_BASE_URL.replace(/\/$/, '');
    return 'http://127.0.0.1:8017';
  }

  function apiErrorMessage(payload, statusCode) {
    var detail = payload && payload.detail;
    if (detail && detail.message) return detail.message;
    if (typeof detail === 'string') return detail;
    return 'HTTP ' + statusCode;
  }

  function renderResult(config, result) {
    var milp = result.modes.milp;
    var rule = result.modes.rule;
    lastResult = result;
    if (!result.modes[selectedModeKey]) selectedModeKey = 'milp';
    byId('heatWeightBadge').textContent = fmt(config.heat_weight_t, 1) + ' t';
    byId('heroCost').innerHTML = fmt(milp.costPerTon, 1) + ' <span class="summary-unit">¥/t</span>';
    byId('heroCostSub').textContent = result.ruleFeasible
      ? 'MILP 整袋约束后，每炉约 ¥' + fmt(milp.heatCost, 0) + '；相对经验方案节约 ¥' + fmt(result.savingsVsRule * config.heat_weight_t, 0) + '/炉。'
      : 'MILP 整袋约束后，每炉约 ¥' + fmt(milp.heatCost, 0) + '；规则基线成分不合格，不拿它算节约。';
    renderSummary(config, result);
    renderComparison(result);
    renderSelectedMode(result);
    renderQuality(result);
    byId('runStatus').textContent = '求解完成：结果已按当前输入刷新。';
  }

  // 方案选择只影响右侧校核和下方顺序，不改变三方案同屏对比表。
  function selectMode(modeKey) {
    selectedModeKey = MODE_META[modeKey] ? modeKey : 'milp';
    if (lastResult) renderSelectedMode(lastResult);
  }

  function renderSelectedMode(result) {
    var mode = result.modes[selectedModeKey] || result.modes.milp;
    var meta = MODE_META[selectedModeKey] || MODE_META.milp;
    Array.prototype.forEach.call(document.querySelectorAll('[data-mode-key]'), function (button) {
      button.classList.toggle('is-active', button.dataset.modeKey === selectedModeKey);
    });
    byId('modeNote').textContent = meta.note;
    byId('sequenceTitle').textContent = meta.label + '加入顺序';
    byId('sequenceBadge').textContent = meta.sequenceBadge;
    renderChemistry(mode);
    renderSequence(mode);
  }

  function renderSummary(config, result) {
    var milp = result.modes.milp;
    var carbon = milp.chemistry.C;
    var cMax = effectiveBounds(config, 'C').max;
    byId('summaryGrid').innerHTML = [
      summaryCard('吨钢合金成本', fmt(milp.costPerTon, 1), '¥/t', '炉次成本 ¥' + fmt(milp.heatCost, 0), ''),
      result.ruleFeasible
        ? summaryCard('比规则基线省/增', fmt(result.costDeltaRateVsRule * 100, 1), '%', (result.costDeltaVsRule <= 0 ? '每炉节约 ¥' : '每炉增加 ¥') + fmt(Math.abs(result.costDeltaVsRule * config.heat_weight_t), 0), result.costDeltaVsRule <= 0 ? 'text-up' : 'text-down')
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
      ? '<tr class="row-summary"><td>比规则基线省/增</td><td class="muted">-</td><td>' + fmt((result.modes.lp.costPerTon - result.modes.rule.costPerTon) / result.modes.rule.costPerTon * 100, 1) + '%</td><td>' + fmt(result.costDeltaRateVsRule * 100, 1) + '%</td></tr>'
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
    byId('chemActiveNote').textContent = activeBoundNote(mode.chemistryChecks);
  }

  function activeBoundNote(checks) {
    var active = [];
    checks.forEach(function (check) {
      if (check.min !== null && Math.abs(check.value - check.min) < 5e-4) active.push(check.element + '贴下限');
      if (check.max !== null && Math.abs(check.value - check.max) < 5e-4) active.push(check.element + '贴上限');
    });
    return active.length ? ' 当前方案：' + active.join('，') + '。' : '';
  }

  function percentInRange(check) {
    var width = 0;
    if (check.min === null && check.max !== null) width = Math.max(0, Math.min(100, check.value / check.max * 100));
    if (check.min !== null && check.max !== null) width = Math.max(0, Math.min(100, (check.value - check.min) / (check.max - check.min) * 100));
    return check.ok && check.value > 0 ? Math.max(3, width) : width;
  }

  function effectiveBounds(config, element) {
    var target = (config.target || {})[element] || {};
    var margin = (config.safety_margins || {})[element] || { low: 0, high: 0 };
    return {
      min: target.min === undefined ? null : Number(target.min) + Number(margin.low || 0),
      max: target.max === undefined ? null : Number(target.max) - Number(margin.high || 0)
    };
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

  function requestSolveRemote() {
    byId('runStatus').textContent = '已收到后端求解请求，正在计算。';
    setTimeout(solveRemote, 0);
  }

  window.DEFAULT_CONFIG = DEFAULT_CONFIG;
  window.AlloyCostUI = { readInput: readInput, readAlloyInputs: readAlloyInputs, percentInRange: percentInRange, syncBagModeLabels: syncBagModeLabels, activeBoundNote: activeBoundNote, effectiveBounds: effectiveBounds, requestOptimize: requestOptimize, apiBaseUrl: apiBaseUrl };
  window.solveRemote = solveRemote;
  window.requestSolveRemote = requestSolveRemote;
  window.selectMode = selectMode;
  document.addEventListener('DOMContentLoaded', function () {
    renderAlloyInputs();
    document.addEventListener('change', function (event) {
      if (event.target && event.target.matches('[data-alloy-bag-mode-index]')) syncBagModeLabels();
    });
    solveRemote();
  });
})();
