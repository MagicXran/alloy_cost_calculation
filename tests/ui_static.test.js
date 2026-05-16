const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('prototype.html 接入真实离线求解脚本且不再使用 mockSolve', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'prototype.html'), 'utf8');
  assert.match(html, /<script src="alloy_optimizer\.js"><\/script>/);
  assert.match(html, /<script src="ui\.js"><\/script>/);
  assert.ok(html.includes('onclick="requestSolveOffline()"'));
  assert.doesNotMatch(html, /mockSolve/);
  assert.doesNotMatch(html, /所有数据均为 Mock 值/);
  assert.match(html, /id="summaryGrid"/);
  assert.match(html, /id="comparisonBody"/);
  assert.match(html, /<\/body>\s*<\/html>/);
});

test('ui.js 内嵌默认配置必须与 config.json 保持一致', () => {
  const vm = require('node:vm');
  const htmlConfig = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(htmlConfig, sandbox, { filename: 'ui.js' });
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  assert.equal(JSON.stringify(sandbox.window.DEFAULT_CONFIG), JSON.stringify(config));
});

test('ui.js 暴露可测试的 UI 纯函数', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: { AlloyOptimizer: { solveAlloyCost() { return { status: 'infeasible', diagnostics: [] }; } } },
    document: { addEventListener() {}, getElementById() { return { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; }, querySelectorAll() { return []; } },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  assert.equal(typeof sandbox.window.AlloyCostUI.percentInRange, 'function');
  assert.equal(typeof sandbox.window.AlloyCostUI.readAlloyInputs, 'function');
});

test('Cr 等于有效下限时进度条仍应有最小可见宽度', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8');
  const sandbox = {
    window: { AlloyOptimizer: { solveAlloyCost() { return { status: 'infeasible', diagnostics: [] }; } } },
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
  const bags = [{ dataset: { alloyBagIndex: '1' }, value: '50' }];
  const sandbox = {
    window: { AlloyOptimizer: { solveAlloyCost() { return { status: 'infeasible', diagnostics: [] }; } } },
    document: {
      addEventListener() {},
      getElementById(id) { return elements[id] || { value: '0', innerHTML: '', textContent: '', style: {}, className: '' }; },
      querySelectorAll(selector) {
        if (selector === '[data-alloy-index]') return checkboxes;
        if (selector === '[data-alloy-price-index]') return prices;
        if (selector === '[data-alloy-bag-index]') return bags;
        return [];
      }
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'ui.js' });
  const config = sandbox.window.AlloyCostUI.readInput();
  assert.equal(config.alloys[1].price_per_ton, 6000);
  assert.equal(config.alloys[1].bag_size_kg, 50);
});
