const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('prototype.html 只接入后端求解入口，不再加载离线求解脚本', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  assert.match(html, /<script src="ui\.js\?v=[^"]+"><\/script>/);
  assert.doesNotMatch(html, /<script src="ui\.js"><\/script>/);
  assert.match(html, /onclick="requestSolveRemote\(\)"/);
  assert.match(html, /点击计算/);
  assert.match(html, /批量 Excel 计算/);
  assert.match(html, /id="batchFile"/);
  assert.match(html, /onclick="validateBatchTemplate\(\)"/);
  assert.match(html, /onclick="runBatchOptimize\(\)"/);
  assert.match(html, /onclick="exportBatchResult\(\)"/);
  assert.doesNotMatch(html, /下载批量模板/);
  assert.equal((html.match(/href="\/api\/template\/download"/g) || []).length, 1);
  assert.match(html, /<details class="panel batch-panel"[^>]*aria-label="批量 Excel 计算"/);
  assert.doesNotMatch(html, /<details class="panel batch-panel"[^>]*open/);
  assert.doesNotMatch(html, /手工录入，后端 FastAPI \+ HiGHS 求解/);
  assert.match(html, /backend calculator/);
  assert.doesNotMatch(html, /<script src="alloy_optimizer\.js"><\/script>/);
  assert.doesNotMatch(html, /offline calculator/);
  assert.doesNotMatch(html, /requestSolveOffline/);
  assert.doesNotMatch(html, /离线求解|离线计算模式/);
  assert.doesNotMatch(html, /mockSolve/);
  assert.doesNotMatch(html, /所有数据均为 Mock 值/);
  assert.doesNotMatch(html, /展开\/收起合金参数/);
  assert.doesNotMatch(html, /别再被|五个大区块|不上传服务器/);
  assert.doesNotMatch(html, /成本变化 vs经验|节约 vs经验|规则基线（经验）/);
  assert.match(html, /id="summaryGrid"/);
  assert.match(html, /id="comparisonBody"/);
  assert.match(html, /id="formulaPanel"/);
  assert.match(html, /<\/body>\s*<\/html>/);
});

test('页面文案不把路线明细误称为投料顺序', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const userFacingText = `${html}\n${script}`;
  assert.doesNotMatch(userFacingText, /投料顺序/);
  assert.match(userFacingText, /路线明细|成本路线|整袋方案/);
  assert.match(userFacingText, /投料方式/);
  assert.match(html, /<details class="panel batch-panel"[^>]*aria-label="批量 Excel 计算"/);
  assert.doesNotMatch(html, /<details class="panel batch-panel"[^>]*open/);
  assert.match(html, /onclick="validateBatchTemplate\(\)"/);
  assert.match(script, /window\.validateBatchTemplate = validateBatchTemplate/);
});

test('路线明细按成本贡献排序而不是旧 sequence 排序', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  assert.match(script, /Number\(b\.costPerTon \|\| 0\) - Number\(a\.costPerTon \|\| 0\)/);
  assert.match(script, /left < right \? -1 : 1/);
  assert.doesNotMatch(script, /localeCompare/);
  assert.doesNotMatch(script, /a\.sequence - b\.sequence/);
});

test('静态首屏路线明细按成本贡献降序展示', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  const expectedOrder = ['硅锰', '低碳铬铁', '高碳铬铁', '低碳锰铁', '高碳锰铁', '硅铁'];
  const positions = expectedOrder.map((name) => html.indexOf(`<div class="step-name">${name}</div>`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('合金参数使用滑钮表达连续投料和整袋投料', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  assert.match(script, /data-alloy-bag-mode-index/);
  assert.match(script, /bag-size-field/);
  assert.match(script, /关闭=连续投料/);
  assert.match(script, /<div class="alloy-row">/);
  assert.match(html, /\.switch-field > input/);
  assert.doesNotMatch(html, /\.switch-field input \{/);
  assert.doesNotMatch(script, /0=连续/);
  assert.doesNotMatch(script, /toggleDetails/);
  assert.doesNotMatch(script, /<label class="alloy-row">/);
});

test('核心公式说明必须覆盖三种方案模型且使用整页宽度', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  assert.match(html, /经验方案模型/);
  assert.match(html, /LP 理论下限模型/);
  assert.match(html, /MILP 整袋模型/);
  assert.match(html, /控元素约束/);
  assert.match(html, /control_E - control_margin/);
  assert.match(html, /\/ 1000/);
  assert.doesNotMatch(html, /\/ 10<\/code>/);
  assert.match(html, /\.formula-panel \{ width: 100%;/);
  assert.doesNotMatch(html, /\.formula-panel \{ max-width: 980px;/);
});

test('页面提供默认开启的控 Si 和控 C 单值上限输入', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  assert.match(html, /id="controlSiEnabled"[^>]*checked/);
  assert.match(html, /id="controlCEnabled"[^>]*checked/);
  assert.match(html, /id="controlSiValue"/);
  assert.match(html, /id="controlCValue"/);
  assert.match(html, /id="controlMargin"/);
  assert.match(html, /控元素安全余量/);
});

test('ui.js 调用后端 /api/optimize，不再调用浏览器离线求解器', async () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  let captured = null;
  const sandbox = {
    window: {
      fetch(url, options) {
        captured = { url, options };
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify({ status: 'ok', modes: {} })) });
      }
    },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  const config = { heat_weight_t: 132.2 };
  const response = await sandbox.window.AlloyCostUI.requestOptimize(config);
  assert.equal(captured.url, '/api/optimize');
  assert.equal(JSON.parse(captured.options.body).solver, 'highs');
  assert.deepEqual(JSON.parse(captured.options.body).config, config);
  assert.equal(response.status, 'ok');
  assert.doesNotMatch(script, /AlloyOptimizer\.solveAlloyCost/);
  assert.doesNotMatch(script, /window\.AlloyOptimizer/);
  assert.doesNotMatch(script, /solveOffline|requestSolveOffline/);
});

test('页面支持点击选择三种方案并刷新对应路线明细', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  assert.match(html, /data-mode-key="milp"/);
  assert.match(html, /data-mode-key="lp"/);
  assert.match(html, /data-mode-key="rule"/);
  assert.match(html, /规则基线/);
  assert.match(html, /比规则基线省\/增/);
  assert.match(html, /id="chemActiveNote"/);
  assert.match(html, /id="sequenceTitle"/);
  assert.match(html, /id="sequenceBadge"/);
  assert.match(script, /function selectMode/);
  assert.match(script, /renderSelectedMode/);
  assert.match(script, /activeBoundNote/);
  assert.match(script, /window\.selectMode = selectMode/);
  assert.match(script, /LP 是连续变量理论下限，不是现场整袋方案/);
  assert.match(script, /规则基线是系统按保守规则生成的对照方案/);
  assert.doesNotMatch(script, /成本变化 vs经验|规则基线（经验）/);
});

test('ui.js 不得再内嵌默认合金配置', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  assert.equal(sandbox.window.DEFAULT_CONFIG, undefined);
  assert.match(script, /\/api\/config/);
  assert.doesNotMatch(script, /var DEFAULT_CONFIG/);
  assert.doesNotMatch(script, /composition:\s*\{/);
});

test('ui.js 从同源 config.json 读取运行时配置', async () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  let captured = null;
  const sandbox = {
    window: {
      fetch(url) {
        captured = url;
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(config)) });
      }
    },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  const payload = await sandbox.window.AlloyCostUI.requestConfig();
  assert.equal(captured, '/config.json');
  assert.equal(JSON.stringify(payload), JSON.stringify(config));
});

test('ui.js 暴露可测试的 UI 纯函数', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  assert.equal(typeof sandbox.window.AlloyCostUI.percentInRange, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.readAlloyInputs, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.requestConfig, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.requestValidateTemplate, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.requestBatchOptimize, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.activeBoundNote, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.syncControlTargetFields, 'function');
  assert.equal(typeof sandbox.window.selectMode, 'function');
  assert.equal(typeof sandbox.window.validateBatchTemplate, 'function');
  assert.equal(typeof sandbox.window.runBatchOptimize, 'function');
  assert.equal(typeof sandbox.window.exportBatchResult, 'function');
});

test('批量 UI 调用模板预检和批量计算 API', async () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const calls = [];
  function MockFormData() {
    this.items = [];
  }
  MockFormData.prototype.append = function append(key, value) {
    this.items.push([key, value]);
  };
  const sandbox = {
    window: {
      FormData: MockFormData,
      fetch(url, options) {
        calls.push({ url, options });
        const payload = url.includes('/api/template/validate')
          ? { status: 'ok', errors: [], warnings: [], preview: { taskCount: 1, alloyCount: 2, priceCount: 3 }, parsed: { tasks: [] } }
          : { batchId: 'batch-1', summary: { total: 1, success: 1, failed: 0 }, results: [] };
        return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(payload)) });
      }
    },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  await sandbox.window.AlloyCostUI.requestValidateTemplate({ name: 'template.xlsx' });
  await sandbox.window.AlloyCostUI.requestBatchOptimize({ tasks: [] });
  assert.equal(calls[0].url, '/api/template/validate');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].url, '/api/batch-optimize');
  assert.equal(JSON.parse(calls[1].options.body).solver, 'highs');
  assert.deepEqual(JSON.parse(calls[1].options.body).template, { tasks: [] });
});

test('控 Si/C 输入会写入 control_targets 并影响有效边界', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const elements = {
    heatWeight: { value: '132.2' }, resC: { value: '0.04' }, resSi: { value: '0' }, resMn: { value: '0.08' }, resCr: { value: '0' }, resP: { value: '0.008' }, resS: { value: '0.008' },
    cMin: { value: '0.06', disabled: false }, cMax: { value: '0.10', disabled: false }, siMin: { value: '0.15', disabled: false }, siMax: { value: '0.25', disabled: false },
    mnMin: { value: '1.10' }, mnMax: { value: '1.30' }, crMin: { value: '0.35' }, crMax: { value: '0.45' }, pMax: { value: '0.025' }, sMax: { value: '0.020' },
    controlSiEnabled: { checked: true }, controlCEnabled: { checked: false }, controlSiValue: { value: '0.22', disabled: false }, controlCValue: { value: '0.10', disabled: false }, controlMargin: { value: '0.005' },
    controlSiRow: { classList: { toggle() {} } }, controlCRow: { classList: { toggle() {} } },
    alloyList: { innerHTML: '' }, runStatus: { textContent: '', style: {} }
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return [];
        if (selector === '[data-alloy-price-index]') return [];
        if (selector === '[data-alloy-bag-mode-index]') return [];
        return [];
      },
      querySelector() { return null; }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  sandbox.window.AlloyCostUI.setRuntimeConfigForTest(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')));
  const config = sandbox.window.AlloyCostUI.readInput();
  assert.equal(config.control_targets.enabled, true);
  assert.equal(config.control_targets.margin, 0.005);
  assert.equal(config.control_targets.elements.Si.enabled, true);
  assert.equal(config.control_targets.elements.Si.value, 0.22);
  assert.equal(config.control_targets.elements.C.enabled, false);
  const siBounds = sandbox.window.AlloyCostUI.effectiveBounds(config, 'Si');
  assert.equal(siBounds.min, null);
  assert.equal(siBounds.max, 0.215);
});

test('质控提醒应提示控元素上限是否真正卡住当前解', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const elements = {
    qualityStrip: { innerHTML: '' },
    heatWeight: { value: '132.2' },
    resC: { value: '0.039' }, resSi: { value: '0' }, resMn: { value: '0.08' }, resCr: { value: '0' }, resP: { value: '0.001' }, resS: { value: '0.001' },
    cMin: { value: '0.06' }, cMax: { value: '0.10' }, siMin: { value: '0.15' }, siMax: { value: '0.25' }, mnMin: { value: '0.84' }, mnMax: { value: '0.87' }, crMin: { value: '0.35' }, crMax: { value: '0.38' }, pMax: { value: '0.9' }, sMax: { value: '0.9' },
    controlSiEnabled: { checked: true }, controlCEnabled: { checked: true }, controlSiValue: { value: '0.22' }, controlCValue: { value: '0.39' }, controlMargin: { value: '0' },
    controlSiRow: { classList: { toggle() {} } }, controlCRow: { classList: { toggle() {} } },
    runStatus: { textContent: '', style: {} },
    alloyList: { innerHTML: '' }, summaryGrid: { innerHTML: '' }, comparisonBody: { innerHTML: '' }, chemBadge: { textContent: '', className: '' }, chemList: { innerHTML: '' }, chemActiveNote: { textContent: '' }, sequenceTitle: { textContent: '' }, sequenceBadge: { textContent: '' }, sequenceList: { innerHTML: '' }, heroCost: { innerHTML: '' }, heroCostSub: { textContent: '' }, heatWeightBadge: { textContent: '' }, modeNote: { textContent: '' }
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return [];
        if (selector === '[data-alloy-price-index]') return [];
        if (selector === '[data-alloy-bag-mode-index]') return [];
        if (selector === '[data-mode-key]') return [];
        return [];
      },
      querySelector() { return null; }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  sandbox.window.AlloyCostUI.setRuntimeConfigForTest(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')));
  sandbox.window.AlloyCostUI.setRuntimeConfigForTest({
    heat_weight_t: 132.2,
    residual: { C: 0.039, Si: 0, Mn: 0.08, Cr: 0, P: 0.001, S: 0.001 },
    target: { C: { min: 0.06, max: 0.10 }, Si: { min: 0.15, max: 0.25 }, Mn: { min: 0.84, max: 0.87 }, Cr: { min: 0.35, max: 0.38 }, P: { max: 0.9 }, S: { max: 0.9 } },
    control_targets: { enabled: true, margin: 0, elements: { Si: { enabled: true, value: 0.22 }, C: { enabled: true, value: 0.39 } } },
    alloys: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')).alloys
  });
  sandbox.window.AlloyCostUI.renderQuality({
    warnings: [],
    modes: {
      milp: {
        chemistryChecks: [
          { element: 'C', value: 0.166954, min: null, max: 0.39, ok: true },
          { element: 'Si', value: 0.000488, min: null, max: 0.22, ok: true },
        ]
      }
    }
  });
  assert.match(elements.qualityStrip.innerHTML, /C 控制上限未卡住当前解/);
  assert.match(elements.qualityStrip.innerHTML, /Si 控制上限未卡住当前解/);
});

test('质控提醒会转义后端 warning 文本', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const elements = { qualityStrip: { innerHTML: '' } };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll() { return []; },
      querySelector() { return null; }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });

  sandbox.window.AlloyCostUI.renderQuality({
    warnings: ['<img src=x onerror=alert(1)>'],
    modes: { milp: { chemistryChecks: [] } }
  });

  assert.doesNotMatch(elements.qualityStrip.innerHTML, /<img/);
  assert.match(elements.qualityStrip.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('批量问题和路线渲染会转义后端文本', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const elements = {
    batchIssuesBody: { innerHTML: '' },
    heatWeightBadge: { textContent: '' },
    heroCost: { innerHTML: '' },
    heroCostSub: { textContent: '' },
    summaryGrid: { innerHTML: '' },
    comparisonBody: { innerHTML: '' },
    chemBadge: { textContent: '', className: '' },
    chemList: { innerHTML: '' },
    chemActiveNote: { textContent: '' },
    sequenceTitle: { textContent: '' },
    sequenceBadge: { textContent: '' },
    sequenceList: { innerHTML: '' },
    qualityStrip: { innerHTML: '' },
    modeNote: { textContent: '' },
    runStatus: { textContent: '', style: {} },
  };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll() { return []; },
      querySelector() { return null; }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  sandbox.window.AlloyCostUI.setRuntimeConfigForTest({
    heat_weight_t: 100,
    target: { C: { min: 0, max: 1 } },
    residual: {},
    control_targets: { enabled: false },
    safety_margins: {},
    alloys: [],
  });

  sandbox.window.AlloyCostUI.renderBatchIssues(
    [{ sheet: '<img src=x onerror=alert(1)>', row: 2, field: '字段', message: '<img src=x onerror=alert(1)>', suggestion: '<img src=x onerror=alert(1)>' }],
    []
  );
  sandbox.window.AlloyCostUI.renderResult(
    { heat_weight_t: 100, target: { C: { min: 0, max: 1 } }, safety_margins: {} },
    {
      ruleFeasible: true,
      costDeltaRateVsRule: 0,
      costDeltaVsRule: 0,
      savingsVsRule: 0,
      warnings: [],
      modes: {
        rule: { costPerTon: 1, alloys: [{ name: '<img src=x onerror=alert(1)>', kgPerTon: 1 }], chemistryChecks: [], chemistry: { C: 0.1 } },
        lp: { costPerTon: 1, alloys: [{ name: '<img src=x onerror=alert(1)>', kgPerTon: 1 }], chemistryChecks: [], chemistry: { C: 0.1 } },
        milp: {
          costPerTon: 1,
          heatCost: 100,
          totalKgPerTon: 1,
          alloys: [{ name: '<img src=x onerror=alert(1)>', kgPerTon: 1, heatKg: 100, bags: null, costPerTon: 1 }],
          chemistryChecks: [{ element: '<img src=x onerror=alert(1)>', value: 0.1, min: 0, max: 1, ok: true }],
          chemistry: { C: 0.1 },
        },
      },
    }
  );

  const rendered = [elements.batchIssuesBody.innerHTML, elements.comparisonBody.innerHTML, elements.sequenceList.innerHTML, elements.chemList.innerHTML].join('\n');
  assert.doesNotMatch(rendered, /<img/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('成分校核能提示贴边约束', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; }, querySelectorAll() { return []; }, querySelector() { return null; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  const note = sandbox.window.AlloyCostUI.activeBoundNote([
    { element: 'Cr', value: 0.355, min: 0.355, max: 0.445 },
    { element: 'C', value: 0.095, min: 0.06, max: 0.095 }
  ]);
  assert.match(note, /Cr贴下限/);
  assert.match(note, /C贴上限/);
});

test('Cr 等于有效下限时进度条仍应有最小可见宽度', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  const width = sandbox.window.AlloyCostUI.percentInRange({ element: 'Cr', value: 0.355, min: 0.355, max: 0.445, ok: true });
  assert.ok(width >= 3);
});

test('合金价格和袋重输入会写入求解配置', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const elements = {
    heatWeight: { value: '132.2' }, resC: { value: '0.04' }, resSi: { value: '0' }, resMn: { value: '0.08' }, resCr: { value: '0' }, resP: { value: '0.008' }, resS: { value: '0.008' },
    cMin: { value: '0.06' }, cMax: { value: '0.10' }, siMin: { value: '0.15' }, siMax: { value: '0.25' }, mnMin: { value: '1.10' }, mnMax: { value: '1.30' }, crMin: { value: '0.35' }, crMax: { value: '0.45' }, pMax: { value: '0.025' }, sMax: { value: '0.020' },
    alloyList: { innerHTML: '' }, runStatus: { textContent: '', style: {} }
  };
  const checkboxes = [{ dataset: { alloyIndex: '1' }, checked: true }];
  const prices = [{ dataset: { alloyPriceIndex: '1' }, value: '6000' }];
  const bagModes = [{ dataset: { alloyBagModeIndex: '1' }, checked: true }];
  const bags = [{ value: '50' }];
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return checkboxes;
        if (selector === '[data-alloy-price-index]') return prices;
        if (selector === '[data-alloy-bag-mode-index]') return bagModes;
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-alloy-bag-index="1"]') return bags[0];
        return null;
      }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  sandbox.window.AlloyCostUI.setRuntimeConfigForTest(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')));
  const config = sandbox.window.AlloyCostUI.readInput();
  assert.equal(config.alloys[1].price_per_ton, 6000);
  assert.equal(config.alloys[1].bag_size_kg, 50);
});

test('合金投料方式为连续时写回 bag_size_kg=0', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const config = { alloys: [{ name: '硅锰', enabled: true, price_per_ton: 5088, bag_size_kg: 25 }] };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return [{ dataset: { alloyIndex: '0' }, checked: true }];
        if (selector === '[data-alloy-price-index]') return [{ dataset: { alloyPriceIndex: '0' }, value: '5088' }];
        if (selector === '[data-alloy-bag-mode-index]') return [{ dataset: { alloyBagModeIndex: '0' }, checked: false }];
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-alloy-bag-index="0"]') return { value: '25' };
        return null;
      }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  sandbox.window.AlloyCostUI.readAlloyInputs(config);
  assert.equal(config.alloys[0].bag_size_kg, 0);
});

test('整袋模式下袋重必须大于 0 kg', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const config = { alloys: [{ name: '硅锰', enabled: true, price_per_ton: 5088, bag_size_kg: 25 }] };
  const sandbox = {
    window: {},
    document: {
      addEventListener() {},
      getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return [{ dataset: { alloyIndex: '0' }, checked: true }];
        if (selector === '[data-alloy-price-index]') return [{ dataset: { alloyPriceIndex: '0' }, value: '5088' }];
        if (selector === '[data-alloy-bag-mode-index]') return [{ dataset: { alloyBagModeIndex: '0' }, checked: true }];
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-alloy-bag-index="0"]') return { value: '0' };
        return null;
      }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  assert.throws(() => sandbox.window.AlloyCostUI.readAlloyInputs(config), /袋重必须大于 0 kg/);
});
