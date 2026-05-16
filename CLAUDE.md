# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

热卷合金成本最优计算工具——一个纯离线、零依赖的合金配料优化器。面向炼钢现场，用 LP（线性规划）理论下限、MILP（混合整数线性规划）整袋投料方案和规则基线三种模式做同屏成本对比。

核心场景：给定钢水残余成分、目标成分范围、可用合金及其价格/成分/袋重，求最低成本配料方案，同时满足 C/Si/Mn/Cr/P/S 六元素的成分约束和整袋投料约束。

## 常用命令

```bash
# 运行全部测试（Node.js 内置 test runner，无需 npm install）
node --test tests/

# 运行单个测试文件
node --test tests/alloy_optimizer.test.js
node --test tests/ui_static.test.js

# CLI 求解（输出 JSON）
node alloy_optimizer.js
node alloy_optimizer.js --config config.json

# 浏览器使用：直接双击 prototype.html（file:// 协议离线可用）
```

## 架构

```
alloy_optimizer.js   求解引擎（UMD 模块，浏览器/Node 双端）
├─ validateConfig()        配置校验
├─ solveLP()               顶点枚举 LP 求解器
├─ solveMILP()             分支定界 MILP（袋装合金整数约束）
├─ solveRuleBaseline()     低碳优先的保守对照方案
└─ solveAlloyCost()        统一入口，返回 rule/lp/milp 三模式结果

ui.js                前端 UI 逻辑（IIFE，挂载到 window）
├─ readInput()             从 DOM 读取用户输入生成 config
├─ renderResult()          渲染求解结果到各面板
└─ DEFAULT_CONFIG          内嵌默认配置（必须与 config.json 同步）

prototype.html       单文件前端（内联 CSS + 引用两个 JS）
config.json          默认配置文件（合金参数/目标成分/回收率/安全余量）
```

### 关键约束

- **零外部依赖**：求解器用朴素高斯消元 + 顶点枚举实现 LP，分支定界实现 MILP，不引入第三方库。
- **UMD 双端**：`alloy_optimizer.js` 通过 UMD 包装同时支持 `require()` 和浏览器 `<script>` 加载。
- **ui.js 的 DEFAULT_CONFIG 必须与 config.json 保持完全一致**——有测试强制校验。
- **六元素模型**：ELEMENTS = `['C', 'Si', 'Mn', 'Cr', 'P', 'S']`，P/S 只有上限无下限。
- **单位约定**：合金成分用百分比（如 Mn=65.66 表示 65.66%），价格用 ¥/t，加入量用 kg/t。质量平衡公式的除数是 1000 而非 10000。
- **袋装合金**：`bag_size_kg > 0` 的合金在 MILP 中按整袋约束，`bag_size_kg = 0` 为连续变量。

### 数据流

```
config.json / UI 输入
      ↓
  validateConfig()    校验 + 单位异常检测
      ↓
  precheckResidualImpurities()   P/S 残余超标拦截
      ↓
  solveLP()           连续松弛最优解
  solveMILP()         整袋约束最优解
  solveRuleBaseline() 保守对照方案
      ↓
  makeModeResult()    统一输出格式 + 成分校核
```

## 设计风格

UI 采用 Coinbase 风格设计令牌（见 DESIGN.md）：白底、蓝色单主色 `#0052ff`、弱阴影、pill 按钮、深色 hero 区域。
