(function () {
  'use strict';

  // 运行时配置只允许来自后端 /api/config，避免前后端各维护一套默认合金数据。
  var runtimeConfig = null;

  // 简单深拷贝用于从运行时配置派生用户输入配置，避免直接改全局配置。
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function byId(id) { return document.getElementById(id); }
  var lastResult = null;
  var batchParsedTemplate = null;
  var latestBatchResult = null;
  var selectedModeKey = 'milp';
  var MODE_META = {
    rule: { label: '规则基线', note: '规则基线是系统按保守规则生成的对照方案，不等于现场历史真实投料。', sequenceBadge: '规则基线对照' },
    lp: { label: 'LP 理论下限', note: 'LP 是连续变量理论下限，不是现场整袋方案；路线明细仅用于阅读理论用量。', sequenceBadge: '理论路线参考' },
    milp: { label: 'MILP 整袋方案', note: 'MILP 是按整袋约束生成的成本路线。', sequenceBadge: '按成本路线阅读' }
  };
  function num(id) {
    var value = byId(id).value;
    if (value === null || value === undefined || String(value).trim() === '') throw new Error(id + ' 不能为空');
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(id + ' 不是有效数字');
    return parsed;
  }
  function fmt(value, digits) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 首次加载时用运行时配置渲染合金开关，计算数据保留在配置对象而不是 DOM 文本里。
  function renderAlloyInputs() {
    ensureConfigLoaded();
    var container = byId('alloyList');
    container.innerHTML = runtimeConfig.alloys.map(function (alloy, index) {
      var checked = alloy.enabled ? 'checked' : '';
      var bag = alloy.bag_size_kg > 0 ? alloy.bag_size_kg : runtimeConfig.milp_settings.default_bag_size_kg;
      var bagChecked = alloy.bag_size_kg > 0 ? 'checked' : '';
      var modeText = alloy.bag_size_kg > 0 ? '整袋' : '连续';
      var safeName = escapeHtml(alloy.name);
      return '<div class="alloy-row"><input type="checkbox" aria-label="启用' + safeName + '" data-alloy-index="' + index + '" ' + checked + '><span class="alloy-name">' + safeName + '</span><span class="alloy-controls"><label class="alloy-field"><span>¥/t</span><input class="compact-input" type="number" min="100" step="1" data-alloy-price-index="' + index + '" value="' + escapeHtml(alloy.price_per_ton) + '"></label><label class="switch-field"><input type="checkbox" data-alloy-bag-mode-index="' + index + '" ' + bagChecked + '><span class="switch-track" aria-hidden="true"></span><span class="switch-text" data-alloy-mode-text="' + index + '">' + modeText + '</span><span class="alloy-field bag-size-field" data-alloy-bag-field="' + index + '"><span>kg/袋</span><input class="compact-input" type="number" min="1" step="1" data-alloy-bag-index="' + index + '" value="' + escapeHtml(bag) + '"></span></label></span></div>';
    }).join('');
    syncBagModeLabels();
  }

  // 将 config.json 中的默认值回填到页面输入，避免 HTML value 成为第二套默认配置。
  function applyConfigToForm(config) {
    byId('heatWeight').value = config.heat_weight_t;
    setElementValues('res', config.residual || {}, { C: 'C', Si: 'Si', Mn: 'Mn', Cr: 'Cr', P: 'P', S: 'S' });
    setBoundValues(config.target || {});
    setControlTargets(config);
    setProcessRules(config);
    var badge = byId('heatWeightBadge');
    if (badge) badge.textContent = fmt(config.heat_weight_t, 1) + ' t';
  }

  function setElementValues(prefix, values, elementMap) {
    Object.keys(elementMap).forEach(function (element) {
      var input = byId(prefix + elementMap[element]);
      if (input && values[element] !== undefined) input.value = values[element];
    });
  }

  function setBoundValues(target) {
    var fields = {
      cMin: ['C', 'min'], cMax: ['C', 'max'], siMin: ['Si', 'min'], siMax: ['Si', 'max'],
      mnMin: ['Mn', 'min'], mnMax: ['Mn', 'max'], crMin: ['Cr', 'min'], crMax: ['Cr', 'max'],
      pMax: ['P', 'max'], sMax: ['S', 'max']
    };
    Object.keys(fields).forEach(function (id) {
      var spec = fields[id];
      var value = ((target[spec[0]] || {})[spec[1]]);
      if (value !== undefined) byId(id).value = value;
    });
  }

  function setControlTargets(config) {
    var control = config.control_targets || {};
    var elements = control.elements || {};
    setChecked('controlSiEnabled', controlEnabled(control, elements.Si));
    setChecked('controlCEnabled', controlEnabled(control, elements.C));
    setValue('controlSiValue', controlValue(config, 'Si'));
    setValue('controlCValue', controlValue(config, 'C'));
    setValue('controlMargin', control.margin === undefined ? 0 : control.margin);
    syncControlTargetFields();
  }

  function controlEnabled(control, elementConfig) {
    return control.enabled !== false && !!(elementConfig && elementConfig.enabled);
  }

  function controlValue(config, element) {
    var control = ((config.control_targets || {}).elements || {})[element] || {};
    var target = (config.target || {})[element] || {};
    return control.value !== undefined ? control.value : target.max;
  }

  function setChecked(id, checked) {
    var input = byId(id);
    if (input) input.checked = !!checked;
  }

  function setValue(id, value) {
    var input = byId(id);
    if (input && value !== undefined) input.value = value;
  }

  function ensureConfigLoaded() {
    if (!runtimeConfig) throw new Error('配置尚未从后端 /api/config 加载');
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
    ensureConfigLoaded();
    var config = clone(runtimeConfig);
    config.heat_weight_t = num('heatWeight');
    config.residual = { C: num('resC'), Si: num('resSi'), Mn: num('resMn'), Cr: num('resCr'), P: num('resP'), S: num('resS') };
    config.target = {
      C: { min: num('cMin'), max: num('cMax') }, Si: { min: num('siMin'), max: num('siMax') },
      Mn: { min: num('mnMin'), max: num('mnMax') }, Cr: { min: num('crMin'), max: num('crMax') },
      P: { max: num('pMax') }, S: { max: num('sMax') }
    };
    config.control_targets = readControlTargets();
    config.process_rules = readProcessRules(config.process_rules);
    readAlloyInputs(config);

    return config;
  }

  function readControlTargets() {
    var siEnabled = !!byId('controlSiEnabled').checked;
    var cEnabled = !!byId('controlCEnabled').checked;
    return {
      enabled: siEnabled || cEnabled,
      margin: num('controlMargin'),
      elements: {
        Si: { enabled: siEnabled, value: num('controlSiValue') },
        C: { enabled: cEnabled, value: num('controlCValue') }
      }
    };
  }

  // 现场工艺规则里的固定数字必须可在页面调整，这里回填到对应输入。
  var PROCESS_RULE_NUMERIC_FIELDS = {
    carbonTargetMargin: 'carbon_target_margin',
    disableSiliconAlloysSiMax: 'disable_silicon_alloys_si_max',
    tiSafetyAddition: 'ti_safety_addition',
    phosphorusAlloyMax: 'phosphorus_alloy_max',
    sulfurAlloyMax: 'sulfur_alloy_max'
  };
  var PROCESS_RULE_TRACE_FIELDS = {
    traceNiMax: 'Ni',
    traceCuMax: 'Cu',
    traceMoMax: 'Mo',
    traceSbMax: 'Sb',
    traceBMax: 'B'
  };

  function setProcessRules(config) {
    var rules = config.process_rules || {};
    setChecked('processRulesEnabled', rules.enabled !== false);
    setChecked('manualAluminumEnabled', rules.manual_aluminum !== false);
    Object.keys(PROCESS_RULE_NUMERIC_FIELDS).forEach(function (id) {
      setValue(id, rules[PROCESS_RULE_NUMERIC_FIELDS[id]]);
    });
    var thresholds = rules.trace_alloy_thresholds || {};
    Object.keys(PROCESS_RULE_TRACE_FIELDS).forEach(function (id) {
      setValue(id, thresholds[PROCESS_RULE_TRACE_FIELDS[id]]);
    });
    syncProcessRuleFields();
  }

  // 只有真实 DOM 控件（带 dataset）才覆盖配置，缺控件时保留运行时配置原值。
  function isRealField(input) {
    return !!(input && input.dataset);
  }

  function readNumericField(id, fallback) {
    var input = byId(id);
    if (!isRealField(input)) return fallback;
    var raw = String(input.value === undefined || input.value === null ? '' : input.value).trim();
    if (raw === '') return fallback;
    var parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(id + ' 不是有效数字');
    return parsed;
  }

  function readToggleField(id, fallback) {
    var input = byId(id);
    if (!isRealField(input)) return fallback;
    return !!input.checked;
  }

  function readProcessRules(base) {
    var rules = base ? clone(base) : {};
    rules.enabled = readToggleField('processRulesEnabled', rules.enabled !== false);
    rules.manual_aluminum = readToggleField('manualAluminumEnabled', rules.manual_aluminum !== false);
    Object.keys(PROCESS_RULE_NUMERIC_FIELDS).forEach(function (id) {
      var key = PROCESS_RULE_NUMERIC_FIELDS[id];
      rules[key] = readNumericField(id, rules[key]);
    });
    var thresholds = rules.trace_alloy_thresholds ? clone(rules.trace_alloy_thresholds) : {};
    Object.keys(PROCESS_RULE_TRACE_FIELDS).forEach(function (id) {
      var element = PROCESS_RULE_TRACE_FIELDS[id];
      thresholds[element] = readNumericField(id, thresholds[element]);
    });
    rules.trace_alloy_thresholds = thresholds;
    return rules;
  }

  function syncProcessRuleFields() {
    var enabled = readToggleField('processRulesEnabled', true);
    var ids = ['manualAluminumEnabled']
      .concat(Object.keys(PROCESS_RULE_NUMERIC_FIELDS))
      .concat(Object.keys(PROCESS_RULE_TRACE_FIELDS));
    ids.forEach(function (id) {
      var input = byId(id);
      if (isRealField(input)) input.disabled = !enabled;
    });
    var card = byId('processRulesCard');
    if (card && card.classList) card.classList.toggle('is-disabled', !enabled);
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

  function requestConfig() {
    var fetchImpl = window.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('当前浏览器不支持 fetch，无法读取配置');
    return fetchJson('/config.json');
  }

  function fetchJson(url) {
    return window.fetch(url).then(function (response) {
      return response.text().then(function (text) {
        var payload = text ? JSON.parse(text) : {};
        if (!response.ok) {
          var error = new Error(apiErrorMessage(payload, response.status));
          error.statusCode = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function initializeFromConfig() {
    var status = byId('runStatus');
    if (status) status.textContent = '正在从 config.json 读取配置。';
    return requestConfig().then(function (config) {
      runtimeConfig = config;
      window.RUNTIME_CONFIG = runtimeConfig;
      applyConfigToForm(runtimeConfig);
      renderAlloyInputs();
      wireBatchFileInput();
      renderBatchPreview(null, 0, 0);
      document.addEventListener('change', function (event) {
        if (event.target && event.target.matches('[data-alloy-bag-mode-index]')) syncBagModeLabels();
        if (event.target && event.target.matches('[data-control-target]')) syncControlTargetFields();
        if (event.target && event.target.matches('[data-process-rule]')) syncProcessRuleFields();
      });
      return solveRemote();
    }).catch(function (error) {
      if (status) {
        status.textContent = '读取配置失败：' + error.message;
        status.style.borderColor = 'rgba(207,32,47,.5)';
      }
    });
  }

  function setRuntimeConfigForTest(config) {
    runtimeConfig = clone(config);
    window.RUNTIME_CONFIG = runtimeConfig;
  }

  function apiBaseUrl() {
    if (window.ALLOY_API_BASE_URL) return window.ALLOY_API_BASE_URL.replace(/\/$/, '');
    return '';
  }

  function apiErrorMessage(payload, statusCode) {
    var detail = payload && payload.detail;
    if (detail && detail.message) return detail.message;
    if (typeof detail === 'string') return detail;
    return 'HTTP ' + statusCode;
  }

  function wireBatchFileInput() {
    var input = byId('batchFile');
    if (!input || input.dataset.wired === 'true') return;
    input.dataset.wired = 'true';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      var label = byId('batchFileLabel');
      if (label) label.textContent = file ? file.name : '选择 .xlsx 文件';
      batchParsedTemplate = null;
      latestBatchResult = null;
      setBatchButtons(false, false);
      setBatchStatus(file ? '已选择文件：' + file.name + '。请点击“上传预检”。' : '请先选择 .xlsx 文件。', 'pending');
    });
  }

  function validateBatchTemplate() {
    try {
      var file = selectedBatchFile();
      setBatchStatus('正在上传并预检模板：' + file.name, 'pending');
      setBatchButtons(false, false);
      latestBatchResult = null;
      return requestValidateTemplate(file).then(function (payload) {
        batchParsedTemplate = payload.status === 'ok' ? payload.parsed : null;
        renderBatchPreview(payload.preview, payload.errors.length, payload.warnings.length);
        renderBatchIssues(payload.errors, payload.warnings);
        if (payload.status !== 'ok') {
          setBatchStatus('预检失败：发现 ' + payload.errors.length + ' 个错误。请按表格提示修改后重新上传。', 'error');
          setBatchButtons(false, false);
          return payload;
        }
        setBatchStatus('预检通过：可执行批量计算。', payload.warnings.length ? 'warning' : 'ok');
        setBatchButtons(true, false);
        return payload;
      }).catch(function (error) {
        batchParsedTemplate = null;
        renderBatchPreview(null, 1, 0);
        renderBatchIssues([{ message: error.message, suggestion: '确认文件是系统模板，且后端服务正在运行。' }], []);
        setBatchStatus('预检接口失败：' + error.message, 'error');
        setBatchButtons(false, false);
      });
    } catch (error) {
      setBatchStatus('预检前置错误：' + error.message, 'error');
      setBatchButtons(false, false);
      return Promise.resolve();
    }
  }

  function requestValidateTemplate(file) {
    if (typeof window.fetch !== 'function') throw new Error('当前浏览器不支持 fetch，无法上传模板');
    if (typeof window.FormData !== 'function') throw new Error('当前浏览器不支持 FormData，无法上传模板');
    var form = new window.FormData();
    form.append('file', file);
    return window.fetch(apiBaseUrl() + '/api/template/validate', { method: 'POST', body: form }).then(readApiJson);
  }

  function runBatchOptimize() {
    if (!batchParsedTemplate) {
      setBatchStatus('请先上传模板并通过预检。', 'error');
      return Promise.resolve();
    }
    setBatchStatus('正在批量计算，单行失败不会阻断其他任务。', 'pending');
    setBatchButtons(false, false);
    return requestBatchOptimize(batchParsedTemplate).then(function (payload) {
      latestBatchResult = payload;
      renderBatchResult(payload);
      setBatchButtons(true, true);
      return payload;
    }).catch(function (error) {
      latestBatchResult = null;
      setBatchStatus('批量计算失败：' + error.message, 'error');
      setBatchButtons(true, false);
    });
  }

  function requestBatchOptimize(parsedTemplate) {
    if (typeof window.fetch !== 'function') throw new Error('当前浏览器不支持 fetch，无法批量计算');
    return window.fetch(apiBaseUrl() + '/api/batch-optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solver: 'highs', template: parsedTemplate })
    }).then(readApiJson);
  }

  function exportBatchResult() {
    if (!latestBatchResult || !latestBatchResult.batchId) {
      setBatchStatus('没有可导出的批量结果，请先批量计算。', 'error');
      return;
    }
    window.location.href = apiBaseUrl() + '/api/batch-result/' + latestBatchResult.batchId + '/export';
  }

  function readApiJson(response) {
    return response.text().then(function (text) {
      var payload = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
      return payload;
    });
  }

  function selectedBatchFile() {
    var input = byId('batchFile');
    var file = input && input.files && input.files[0];
    if (!file) throw new Error('请先选择 .xlsx 文件');
    if (!/\.xlsx$/i.test(file.name || '')) throw new Error('只能上传 .xlsx 文件');
    return file;
  }

  function setBatchButtons(canRun, canExport) {
    var run = byId('runBatchButton');
    var exportButton = byId('exportBatchButton');
    if (run) run.disabled = !canRun;
    if (exportButton) exportButton.disabled = !canExport;
  }

  function setBatchStatus(message, level) {
    var status = byId('batchStatus');
    var badge = byId('batchStatusBadge');
    if (status) status.textContent = message;
    if (!badge) return;
    var badgeClass = 'badge';
    if (level === 'ok') badgeClass += ' badge-green';
    if (level === 'pending') badgeClass += ' badge-blue';
    if (level === 'warning') badgeClass += ' badge-yellow';
    badge.className = badgeClass;
    badge.textContent = level === 'ok' ? '已通过' : level === 'error' ? '有错误' : level === 'warning' ? '有警告' : '处理中';
  }

  function renderBatchPreview(preview, errorCount, warningCount) {
    var safePreview = preview || { taskCount: '-', alloyCount: '-', priceCount: '-' };
    renderBatchCards([
      ['任务数', safePreview.taskCount],
      ['合金数', safePreview.alloyCount],
      ['价格数', safePreview.priceCount],
      ['错误/警告', String(errorCount || 0) + '/' + String(warningCount || 0)]
    ]);
  }

  function renderBatchResult(payload) {
    var summary = payload.summary || { total: 0, success: 0, failed: 0 };
    renderBatchCards([
      ['总任务', summary.total],
      ['成功', summary.success],
      ['失败', summary.failed],
      ['结果ID', payload.batchId ? payload.batchId.slice(0, 8) : '-']
    ]);
    renderBatchIssues(batchResultErrors(payload), []);
    var message = '批量计算完成：总任务 ' + summary.total + '，成功 ' + summary.success + '，失败 ' + summary.failed + '。';
    setBatchStatus(message, summary.failed ? 'warning' : 'ok');
  }

  function batchResultErrors(payload) {
    var issues = [];
    (payload.results || []).forEach(function (item) {
      (item.errors || []).forEach(function (error) {
        issues.push(error);
      });
    });
    return issues;
  }

  function previewCard(label, value) {
    return '<div class="preview-card"><div class="preview-label">' + escapeHtml(label) + '</div><div class="preview-value">' + escapeHtml(value) + '</div></div>';
  }

  function renderBatchCards(cards) {
    var container = byId('batchPreview');
    if (!container) return;
    container.innerHTML = cards.map(function (card) { return previewCard(card[0], card[1]); }).join('');
  }

  function renderBatchIssues(errors, warnings) {
    var body = byId('batchIssuesBody');
    if (!body) return;
    var rows = [];
    (errors || []).forEach(function (issue) { rows.push(issueRow('错误', issue)); });
    (warnings || []).forEach(function (issue) { rows.push(issueRow('警告', issue)); });
    body.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="6">暂无错误或警告。</td></tr>';
  }

  function issueRow(type, issue) {
    return '<tr><td>' + escapeHtml(type) + '</td><td>' + escapeHtml(issue.sheet || '') + '</td><td>' + escapeHtml(issue.row || '') + '</td><td>' + escapeHtml(issue.field || '') + '</td><td>' + escapeHtml(issue.message || issue.code || '') + '</td><td>' + escapeHtml(issue.suggestion || '') + '</td></tr>';
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

  // 方案选择只影响右侧校核和下方路线明细，不改变三方案同屏对比表。
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
    byId('sequenceTitle').textContent = meta.label + '路线明细';
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
    return '<div class="summary-card"><div class="summary-label">' + escapeHtml(label) + '</div><div class="summary-value ' + escapeHtml(extraClass) + '">' + escapeHtml(value) + ' <span class="summary-unit">' + escapeHtml(unit) + '</span></div><div class="summary-sub">' + escapeHtml(sub) + '</div></div>';
  }

  function renderComparison(result) {
    var rows = result.modes.milp.alloys.map(function (alloy, index) {
      var rule = result.modes.rule.alloys[index];
      var lp = result.modes.lp.alloys[index];
      var milpText = fmt(alloy.kgPerTon, 2) + (alloy.bags !== null ? ' (' + alloy.bags + '袋)' : '');
      return '<tr><td>' + escapeHtml(alloy.name) + '</td><td>' + fmt(rule.kgPerTon, 2) + '</td><td>' + fmt(lp.kgPerTon, 2) + '</td><td>' + escapeHtml(milpText) + '</td></tr>';
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
      return '<div class="chem-row"><span class="chem-name">' + escapeHtml(check.element) + '</span><span class="chem-range"><span class="chem-fill" style="width:' + width + '%"></span></span><span class="' + valueClass + '">' + fmt(check.value, 3) + '</span></div>';
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
    var control = config.control_targets || {};
    var controlled = (control.elements || {})[element] || {};
    if (control.enabled !== false && controlled.enabled === true) {
      return {
        min: null,
        max: Number(controlled.value) - Number(control.margin || 0)
      };
    }
    var target = (config.target || {})[element] || {};
    var margin = (config.safety_margins || {})[element] || { low: 0, high: 0 };
    return {
      min: target.min === undefined ? null : Number(target.min) + Number(margin.low || 0),
      max: target.max === undefined ? null : Number(target.max) - Number(margin.high || 0)
    };
  }

  function syncControlTargetFields() {
    syncControlTargetField('Si');
    syncControlTargetField('C');
  }

  function syncControlTargetField(element) {
    var lower = element.toLowerCase();
    var enabled = !!byId('control' + element + 'Enabled').checked;
    var single = byId('control' + element + 'Value');
    var min = byId(lower + 'Min');
    var max = byId(lower + 'Max');
    var row = byId('control' + element + 'Row');
    if (single) single.disabled = !enabled;
    if (min) min.disabled = enabled;
    if (max) max.disabled = enabled;
    if (row) row.classList.toggle('is-disabled', !enabled);
  }

  function renderSequence(mode) {
    var rows = mode.alloys.filter(function (alloy) { return alloy.kgPerTon > 1e-8; }).sort(function (a, b) {
      var costDelta = Number(b.costPerTon || 0) - Number(a.costPerTon || 0);
      if (Math.abs(costDelta) > 1e-9) return costDelta;
      return routeNameCompare(a, b);
    });
    byId('sequenceList').innerHTML = rows.map(function (alloy, index) {
      var note = alloy.bags !== null ? alloy.bags + ' 袋，' + fmt(alloy.heatKg, 1) + ' kg/炉' : fmt(alloy.heatKg, 1) + ' kg/炉';
      return '<div class="step"><div class="step-index">' + (index + 1) + '</div><div class="step-name">' + escapeHtml(alloy.name) + '</div><div class="step-dose">' + fmt(alloy.kgPerTon, 2) + ' kg/t</div><div class="step-note">' + escapeHtml(note) + '</div></div>';
    }).join('');
  }

  function routeNameCompare(a, b) {
    var left = String(a.name || '');
    var right = String(b.name || '');
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  function renderQuality(result) {
    var parts = ['<strong>质控提醒</strong>'];
    parts = parts.concat(result.warnings.map(function (warning) { return '<span>' + escapeHtml(warning) + '</span>'; }));
    parts = parts.concat(controlTargetStatusHints(result));
    byId('qualityStrip').innerHTML = parts.join('');
  }

  function controlTargetStatusHints(result) {
    var config = runtimeConfig || {};
    var control = config.control_targets || {};
    var elements = control.elements || {};
    if (control.enabled === false) return ['<span>控元素未启用。</span>'];
    var hints = [];
    ['Si', 'C'].forEach(function (element) {
      var elementConfig = elements[element] || {};
      if (elementConfig.enabled !== true) {
        hints.push('<span>' + element + ' 控制已关闭。</span>');
        return;
      }
      var bound = effectiveBounds(config, element);
      var check = nextCheckByElement(result.modes.milp.chemistryChecks, element);
      if (!check) return;
      var max = bound.max;
      var current = Number(check.value);
      var gap = max - current;
      if (!Number.isFinite(max)) {
        hints.push('<span>' + element + ' 控制上限无效，检查配置。</span>');
        return;
      }
      if (gap <= 5e-4) {
        hints.push('<span>' + element + ' 控制上限已生效，当前解已贴近上限 ' + fmt(max, 3) + '%。</span>');
      } else {
        hints.push('<span>' + element + ' 控制上限未卡住当前解，当前值 ' + fmt(current, 3) + '%，上限 ' + fmt(max, 3) + '%，还差 ' + fmt(gap, 3) + '%；这条约束是活的，但这次没压住解。</span>');
      }
    });
    return hints;
  }

  function nextCheckByElement(checks, element) {
    for (var i = 0; i < checks.length; i += 1) {
      if (checks[i].element === element) return checks[i];
    }
    return null;
  }

  function renderInfeasible(result) {
    byId('comparisonBody').innerHTML = '<tr><td colspan="4">无可行解：' + escapeHtml(result.diagnostics.join('；')) + '</td></tr>';
    byId('runStatus').textContent = '无可行解：' + result.diagnostics.join('；');
  }

  function requestSolveRemote() {
    byId('runStatus').textContent = '已收到后端求解请求，正在计算。';
    setTimeout(solveRemote, 0);
  }

  window.AlloyCostUI = { readInput: readInput, readAlloyInputs: readAlloyInputs, percentInRange: percentInRange, syncBagModeLabels: syncBagModeLabels, syncControlTargetFields: syncControlTargetFields, syncProcessRuleFields: syncProcessRuleFields, setProcessRules: setProcessRules, readProcessRules: readProcessRules, activeBoundNote: activeBoundNote, effectiveBounds: effectiveBounds, renderResult: renderResult, renderQuality: renderQuality, requestOptimize: requestOptimize, requestConfig: requestConfig, initializeFromConfig: initializeFromConfig, setRuntimeConfigForTest: setRuntimeConfigForTest, apiBaseUrl: apiBaseUrl, requestValidateTemplate: requestValidateTemplate, requestBatchOptimize: requestBatchOptimize, renderBatchPreview: renderBatchPreview, renderBatchIssues: renderBatchIssues };
  window.solveRemote = solveRemote;
  window.requestSolveRemote = requestSolveRemote;
  window.selectMode = selectMode;
  window.validateBatchTemplate = validateBatchTemplate;
  window.runBatchOptimize = runBatchOptimize;
  window.exportBatchResult = exportBatchResult;
  document.addEventListener('DOMContentLoaded', function () {
    initializeFromConfig();
  });
})();
