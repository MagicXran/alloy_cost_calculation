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
  main.py              FastAPI 入口和 CORS
  models.py            API 请求/响应模型
  core.py              业务计算核心、配置校验、三方案组装、warnings
  solvers/
    base.py            求解器接口
    factory.py         solver 名称到实现的映射
    highs.py           SciPy/HiGHS LP 与 MILP 求解器
    internal.py        无外部依赖兜底求解器

prototype.html         前端页面和样式
ui.js                  前端表单读取、调用后端、渲染结果
config.json            默认合金、目标、残余、回收率、安全余量
requirements.txt       Python 后端依赖
tests/
  test_backend_optimizer.py  后端/API/求解逻辑测试
  ui_static.test.js          前端静态结构和请求契约测试
docs/
  system_overview.md         面向人理解的系统说明
```

## 关键约束

- 前端不得再引入浏览器离线求解器；唯一计算内核是后端。
- `ui.js` 的 `DEFAULT_CONFIG` 必须与 `config.json` 保持一致，测试会校验。
- 当前元素集合是 `C, Si, Mn, Cr, P, S`；V/Nb/Ti/Ni/Cu/Mo/B/Sb 尚未进入模型。
- 合金成分单位是百分数，例如 `Mn=65.66` 表示 `65.66%`。
- 元素增量公式是 `kg/t * 合金元素百分数 * 回收率 / 1000`。
- `bag_size_kg > 0` 表示 MILP 整袋变量；`bag_size_kg = 0` 表示连续投料。
- `solver=highs` 是默认正式求解器；`solver=internal` 只作为兜底和对照。
