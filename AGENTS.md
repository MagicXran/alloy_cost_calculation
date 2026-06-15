# Project AGENTS.md

## 项目定位

本项目是热卷炼钢合金成本优化工具，当前形态为：

- 后端：FastAPI + Pydantic + SciPy/HiGHS LP/MILP 求解。
- 前端：`prototype.html` + `ui.js` 静态页面，从后端 `/api/config` 读取 `config.json`。
- Excel：`热卷成本效益测算20260613版（基础参数表）---发徐老师(3).xlsx` 是当前正确版旧规则取证来源，铝耗和合金单价都维护在此单一 workbook 内；`alloy-batch-template-v1.xlsx` 是批量上传模板；`outputs/` 存放生成的分析/导出结果。

## 重要文件

- `app/core.py`：优化核心、元素边界、现场工艺规则、LP/MILP 组装。
- `app/batch_template.py`：批量模板生成、解析、校验、导出。
- `app/main.py`：FastAPI 入口、模板 API、静态资源托管。
- `config.json`：默认合金、目标、回收率、安全余量、现场工艺规则。
- `prototype.html`、`ui.js`：单炉计算页面。
- `tests/`：后端、模板、前端静态契约测试。
- `tools/recalculate_lp_actual_aluminum.py`：按当前 LP 新算法回算正确版单源 workbook；目标/终点/回收率/合金单价/铝块用量均来自 `热卷成本效益测算20260613版（基础参数表）---发徐老师(3).xlsx`。
- `readme.md`：面向新用户的项目说明，代码或逻辑变动时必须同步更新。
- `issue_log.md`：逻辑变更、历史错误、修复办法和防复发规则，修 bug 或改逻辑时必须同步更新。

## 运行与测试

Windows 当前优先使用项目自带虚拟环境：

```powershell
.venv-win\Scripts\python.exe -m pytest -q
node --test tests/ui_static.test.js
```

生成 LP + 实际铝耗对比表：

```powershell
.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py
```

后端开发启动：

```powershell
.venv-win\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8017
```

前端页面：

```text
http://127.0.0.1:8017/prototype.html
```

## 项目约束

- 唯一正式计算内核是后端；前端不得重新塞离线求解器。
- `ui.js` 不维护影子默认配置，默认值必须来自 `config.json`。
- 合金成分单位是百分数，例如 `Mn=65.66` 表示 `65.66%`。
- 元素增量公式是 `kg/t * 合金元素百分数 * 回收率 / 1000`。
- 控元素和现场确认规则集中在 `app/core.py` 的 `effective_bounds()`、`process_rules()`、`process_rule_alloy_upper_bound()`。
- 批量模板单值目标转换在 `app/batch_template.py`，但 LP 工艺修正必须在核心边界层统一生效。
- 铝块当前按 `process_rules.manual_aluminum` 单独维护，不参与 LP 自动优化；涉及正确版实际铝耗对比时必须从当前单源 workbook 的 `1.合金成本!AH` 取值再单独计入成本和消耗。
- 做 workbook 规则审计时，先读真实 Excel 的 sheet/cell/formula/cache 值，再改代码或生成结论；当前正确版回算不得再默认读取外部铝耗表或外部价格表。
- `mem/` 是本地记忆目录，默认忽略，不作为项目交付内容。

## 生成文件

- `outputs/` 下的分析 workbook 是可交付结果，但不要把临时预览、缓存、Office 锁文件纳入提交。
- `alloy-batch-template-v1.xlsx` 是受测试约束的模板文件；更新模板逻辑时必须同步重新生成并回读验证。

## 文档维护

- 每次修改业务逻辑、算法规则、模板结构、页面交互或生成脚本，都要同步更新 `readme.md` 与 `issue_log.md`。
- `readme.md` 说明项目需求、目标、开发环境、约束、技术架构、运行方式和功能逻辑。
- `issue_log.md` 用中文记录问题现象、原因、修复办法、验证方式、防复发要求。
