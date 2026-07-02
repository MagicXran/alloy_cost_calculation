# CLAUDE.md

This file gives agent-facing guidance for the current codebase.

## 项目概述

热卷合金成本最优计算工具。当前系统是“前端静态页面 + FastAPI 后端 + SciPy/HiGHS 求解器”，不是旧的浏览器离线双内核版本。

核心场景：给定钢水残余成分、目标成分范围、可用合金及其价格/成分/袋重，后端返回三类方案：

- `rule`：系统生成的规则基线，仅作为对照，不等于现场历史真实投料。
- `lp`：连续变量理论最低成本。
- `milp`：考虑整袋投料约束后的现场执行方案。

## 常用命令

```bash
# 安装依赖
uv venv .venv
. .venv/bin/activate
uv pip install -r requirements.txt

# 后端测试
. .venv/bin/activate
python -m pytest -q

# 前端静态测试
node --test tests/ui_static.test.js

# 启动后端
. .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8017

# 启动前端静态服务
python3 -m http.server 8018 --bind 127.0.0.1
```

访问前端：

```text
http://127.0.0.1:8018/prototype.html
```

后端健康检查：

```text
http://127.0.0.1:8017/health
```

## 当前文件结构

```text
app/
  main.py              FastAPI 入口、CORS、静态托管、批量 API
  models.py            API 请求/响应模型
  core.py              业务计算核心、配置校验、三方案组装、warnings
  rules_engine.py      规则语义层：19 个插件按 phase×priority 执行
                       （normalize → compile_target → compile_alloy → validate_explain 预留），
                       输出 CompiledRuleView（compiled_bounds/disabled_alloys/rule_flags）
  batch_template.py    批量 Excel 模板生成/解析/校验/逐行求解/结果导出，
                       BATCH_RESULTS 内存字典暂存结果
  solvers/
    base.py            求解器接口
    factory.py         solver 名称到实现的映射
    highs.py           SciPy/HiGHS LP 与 MILP 求解器
    internal.py        无外部依赖兜底求解器

prototype.html         前端页面和样式
ui.js                  前端表单读取、调用后端、渲染结果
config.json            默认合金、目标、残余、回收率、安全余量、工艺规则（单一事实源）
run_app.py             PyInstaller 单服务发布入口（配 alloy_cost_calculation.spec）
requirements.txt       Python 后端依赖
tools/
  recalculate_lp_actual_aluminum.py  用当前 LP 规则重算实际投料工作簿，单 sheet 审计输出
tests/
  test_backend_optimizer.py          后端/API/求解逻辑测试
  test_rule_engine.py                规则引擎插件测试
  test_batch_template.py             批量模板解析/校验/求解/导出测试
  test_recalculate_lp_actual_aluminum.py  重算工具测试
  ui_static.test.js                  前端静态结构和请求契约测试
docs/
  system_overview.md         面向人理解的系统说明
  外部接口文档.md            外部牌号/价格同步接口 v1.6（alloyCode 唯一主键）
  系统蓝图设计方案.md        平台化升级蓝图评审底稿（六域功能全景 + 数据模型）
```

## 批量计算流程

1. `GET /api/template/download` 生成 7-sheet 模板：01_批量任务 / 02_目标成分上下限 / 03_转炉终点与回收率 / 04_合金成分库 / 05_价格表 / 06_填写说明与校验规则 / 07_工艺规则参数。
2. `POST /api/template/validate` 上传 xlsx，只做结构解析与预检，返回逐行 issue。
3. `POST /api/batch-optimize` 对预检通过的模板逐行调用 `solve_alloy_cost`，结果存入 `BATCH_RESULTS`。
4. `GET /api/batch-result/{batch_id}/export` 导出结果工作簿。
5. 手工铝双轨：`手工铝块kg/t` 列由现场单独录入，铝块不进 LP 优化，且**不计入最终成本合计口径**。

## 关键约束

- 前端不得再引入浏览器离线求解器；唯一计算内核是后端。
- `ui.js` 不再内嵌 `DEFAULT_CONFIG`，必须从 `/config.json` 读取并回填页面；`config.json` 是单一事实源，测试会校验前后端是否读取同一份配置。
- 元素覆盖分两层：单算页面默认展示核心 `C, Si, Mn, Cr, P, S`；批量链路元素全集是 `TEMPLATE_ELEMENTS = C, Si, Mn, P, S, V, Nb, Ti, Als, Alt, Ca, Cr, Ni, Cu, Mo, B, Sb`（17 个，忽略 N，目标忽略 Ca，Als/Alt 固定回收率 0.15）。
- 工艺规则以 `config.json` 的 `process_rules` 为默认快照（禁硅阈值、控碳余量、Ti 余量、微量元素禁投阈值、手工铝等）；规则逻辑一律走 `rules_engine.compile_rule_view()`，不要在 core/solver 里散落 if。
- 合金成分单位是百分数，例如 `Mn=65.66` 表示 `65.66%`。
- 元素增量公式是 `kg/t * 合金元素百分数 * 回收率 / 1000`。
- `control_targets` 默认控 `Si+C`；控元素只生成上限约束，不生成下限约束。边界编译统一在 `rules_engine`（`core.effective_bounds()` 只是 `compile_rule_view` 的薄封装），不要污染求解器适配层。
- `bag_size_kg > 0` 表示 MILP 整袋变量；`bag_size_kg = 0` 表示连续投料。
- `solver=highs` 是默认正式求解器；`solver=internal` 只作为兜底和对照。
