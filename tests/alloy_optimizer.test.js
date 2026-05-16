const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const optimizer = require('../alloy_optimizer.js');

// 读取真实配置，测试必须覆盖用户实际会运行的默认数据。
function loadDefaultConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 深拷贝用于构造边界场景，避免测试之间共享可变对象。
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('质量平衡使用 /1000 因子，不允许退回 /10000 错误', () => {
  const increment = optimizer.elementIncrementKgPerT(10, 65.66, 0.98);
  assert.equal(Number(increment.toFixed(3)), 0.643);
});

test('配置校验能拦截疑似百分比单位错误', () => {
  const config = loadDefaultConfig();
  config.alloys[0].composition.Mn = 0.6566;
  assert.throws(() => optimizer.validateConfig(config), /百分比|65\.66|0\.6566/);
});

test('P/S 残余超标时直接终止，因为加合金无法降 P/S', () => {
  const config = loadDefaultConfig();
  config.residual.P = 0.030;
  assert.throws(() => optimizer.solveAlloyCost(config), /当前P=.*超过目标上限/);
});

test('默认配置能输出规则、LP、MILP 三种方案且满足成分边界', () => {
  const result = optimizer.solveAlloyCost(loadDefaultConfig());
  assert.equal(result.status, 'ok');
  assert.ok(result.modes.rule.costPerTon > 0);
  assert.ok(result.modes.lp.costPerTon > 0);
  assert.ok(result.modes.milp.costPerTon > 0);
  if (result.modes.rule.chemistryChecks.every((check) => check.ok)) {
    assert.ok(result.modes.lp.costPerTon <= result.modes.rule.costPerTon + 1e-6);
  }
  for (const check of result.modes.milp.chemistryChecks) {
    assert.equal(check.ok, true, check.element + ' should be inside target range');
  }
});

test('MILP 对 bag_size>0 的合金按 bag_size / heat_weight_t 输出步长', () => {
  const config = loadDefaultConfig();
  const result = optimizer.solveAlloyCost(config);
  const highMn = result.modes.milp.alloys.find((item) => item.name === '高碳锰铁');
  const lowMn = result.modes.milp.alloys.find((item) => item.name === '低碳锰铁');
  const step = 25 / config.heat_weight_t;
  // 袋装合金的 kg/t 必须能还原为整数袋数，不能输出现场无法投料的小数幻觉。
  for (const item of [highMn, lowMn]) {
    assert.equal(Number.isInteger(item.bags), true);
    assert.ok(Math.abs(item.kgPerTon - item.bags * step) < 1e-9);
  }
});

test('禁用关键合金导致无可行解时返回冲突诊断', () => {
  const config = loadDefaultConfig();
  for (const alloy of config.alloys) {
    if (alloy.composition.Mn) alloy.enabled = false;
  }
  const result = optimizer.solveAlloyCost(config);
  assert.equal(result.status, 'infeasible');
  assert.match(result.diagnostics.join('\n'), /Mn/);
});

test('价格敏感性：低碳锰铁涨价后 MILP 成本不应下降', () => {
  const base = optimizer.solveAlloyCost(loadDefaultConfig());
  const expensive = clone(loadDefaultConfig());
  expensive.alloys.find((item) => item.name === '低碳锰铁').price_per_ton *= 1.2;
  const changed = optimizer.solveAlloyCost(expensive);
  assert.equal(changed.status, 'ok');
  assert.ok(changed.modes.milp.costPerTon >= base.modes.milp.costPerTon - 1e-6);
});

test('空字符串不能被当作 0 参与配置校验', () => {
  const config = loadDefaultConfig();
  config.heat_weight_t = '';
  assert.throws(() => optimizer.validateConfig(config), /不能为空/);
});

test('禁用合金的坏成分不应炸掉求解', () => {
  const config = loadDefaultConfig();
  const disabled = config.alloys.find((item) => item.name === '中碳锰铁');
  disabled.enabled = false;
  disabled.composition.Mn = 0.7854;
  const result = optimizer.solveAlloyCost(config);
  assert.equal(result.status, 'ok');
});

test('规则基线不得被伪造成 LP 的固定倍率', () => {
  const result = optimizer.solveAlloyCost(loadDefaultConfig());
  const ratio = result.modes.rule.costPerTon / result.modes.lp.costPerTon;
  assert.notEqual(Number(ratio.toFixed(2)), 1.08);
});

test('默认规则基线应是可行对照并可计算节约金额', () => {
  const result = optimizer.solveAlloyCost(loadDefaultConfig());
  assert.equal(result.ruleFeasible, true);
  assert.ok(result.savingsVsRule > 0);
  assert.ok(result.modes.rule.costPerTon > result.modes.milp.costPerTon);
});
