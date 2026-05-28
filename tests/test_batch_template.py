from __future__ import annotations

from io import BytesIO

import openpyxl
from fastapi.testclient import TestClient

from app.batch_template import export_batch_result, generate_template_workbook, parse_template_workbook, run_batch_optimization
from app.main import app


def workbook_bytes(
    *,
    duplicate_target: bool = False,
    merge_tasks: bool = False,
    formula_price: bool = False,
    alloy_header: list[str] | None = None,
    alloy_rows: list[list] | None = None,
) -> bytes:
    """Build a minimal user-facing upload template in memory."""

    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    tasks = wb.create_sheet("01_批量任务")
    tasks.append(["任务编号", "适用牌号", "厚度mm", "炉重t", "价格方案", "炼钢牌号", "备注"])
    tasks.append(["T001", "Q235B", 10, 150, "2026-05", "Q235B-1", "正常样例"])
    tasks.append(["T002", "Q355C", 8, 150, "2026-05", "Q355C-1", "低合金样例"])
    if merge_tasks:
        tasks.merge_cells("A2:B2")

    targets = wb.create_sheet("02_目标成分上下限")
    targets.append(
        [
            "适用牌号",
            "最小厚度mm",
            "最大厚度mm",
            "炼钢牌号",
            "C下限",
            "C上限",
            "Si下限",
            "Si上限",
            "Mn下限",
            "Mn上限",
            "Cr下限",
            "Cr上限",
            "P上限",
            "S上限",
            "N上限",
        ]
    )
    targets.append(["Q235B", 1.5, 12, "Q235B-1", 0.06, 0.16, 0.05, 0.12, 0.20, 0.40, None, None, 0.025, 0.020, 60])
    if duplicate_target:
        targets.append(["Q235B", 1.5, 12, "Q235B-1", 0.06, 0.16, 0.05, 0.12, 0.20, 0.40, None, None, 0.025, 0.020, 60])
    targets.append(["Q355C", 3, 12, "Q355C-1", 0.08, 0.16, 0.10, 0.20, 0.90, 1.20, None, None, 0.018, 0.010, 40])

    endpoints = wb.create_sheet("03_转炉终点与回收率")
    endpoints.append(
        [
            "适用牌号",
            "最小厚度mm",
            "最大厚度mm",
            "炼钢牌号",
            "C终点",
            "Mn终点",
            "Cr终点",
            "Si回收率",
            "Mn回收率",
            "Cr回收率",
        ]
    )
    endpoints.append(["Q235B", 1.5, 12, "Q235B-1", 0.07, 0.12, 0, 0.75, 0.98, 0.96])
    endpoints.append(["Q355C", 3, 12, "Q355C-1", 0.07, 0.11, 0, 0.80, 0.98, 0.96])

    alloys = wb.create_sheet("04_合金成分库")
    default_alloy_header = ["合金名称", "价格物料名", "启用", "投料方式", "袋重kg", "最大投加kg每t", "C", "Si", "Mn", "Cr", "P", "S", "N", "备注"]
    alloys.append(alloy_header or default_alloy_header)
    for alloy_row in alloy_rows or [
        ["硅锰", "硅锰", "是", "连续", 0, 30, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, "N 不参与优化"],
        ["硅铁", "硅铁", "是", "连续", 0, 20, 0.2, 72.23, None, None, 0.03, 0.02, None, ""],
        ["低碳锰铁", "低碳锰铁", "是", "整袋", 25, 25, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
    ]:
        alloys.append(alloy_row)

    prices = wb.create_sheet("05_价格表")
    prices.append(["价格方案", "物料名称", "价格日期", "价格元每吨"])
    prices.append(["2026-05", "硅锰", "2026-05-07", 6130])
    prices.append(["2026-05", "硅铁", "2026-05-07", 5810])
    prices.append(["2026-05", "低碳锰铁", "2026-05-07", 10150])
    if formula_price:
        prices["D2"] = "=6000+130"

    rules = wb.create_sheet("06_填写说明与校验规则")
    rules.append(["模板版本", "1"])
    rules.append(["说明", "N 元素不参与合金优化。"])

    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def test_parse_template_workbook_builds_prevalidated_payload():
    report = parse_template_workbook(workbook_bytes())

    assert report["status"] == "ok"
    assert report["errors"] == []
    assert report["preview"]["taskCount"] == 2
    assert report["preview"]["alloyCount"] == 3
    assert "N" not in report["parsed"]["tasks"][0]["config"]["target"]
    assert report["parsed"]["tasks"][0]["config"]["residual"]["Si"] == 0


def test_batch_optimization_continues_when_one_task_fails():
    report = parse_template_workbook(workbook_bytes())
    parsed = report["parsed"]
    parsed["tasks"][1]["config"]["residual"]["P"] = 0.05

    result = run_batch_optimization(parsed, solver_name="internal")

    assert result["status"] == "partial_failed"
    assert result["summary"] == {"total": 2, "success": 1, "failed": 1}
    failed = next(item for item in result["results"] if item["taskId"] == "T002")
    assert failed["status"] == "failed"
    assert failed["errors"][0]["field"] == "P"


def test_template_validation_reports_duplicate_target_match():
    report = parse_template_workbook(workbook_bytes(duplicate_target=True))

    assert report["status"] == "error"
    assert any(error["code"] == "DUPLICATE_MATCH" and error["sheet"] == "01_批量任务" for error in report["errors"])


def test_template_validation_rejects_merged_cells_and_formula_inputs():
    merged = parse_template_workbook(workbook_bytes(merge_tasks=True))
    formula = parse_template_workbook(workbook_bytes(formula_price=True))

    assert any(error["code"] == "MERGED_CELLS_NOT_ALLOWED" for error in merged["errors"])
    assert any(error["code"] == "FORMULA_NOT_ALLOWED" and error["sheet"] == "05_价格表" for error in formula["errors"])


def test_template_api_validate_batch_and_export():
    client = TestClient(app)

    validate = client.post(
        "/api/template/validate",
        files={"file": ("template.xlsx", workbook_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert validate.status_code == 200
    payload = validate.json()
    assert payload["status"] == "ok"

    batch = client.post("/api/batch-optimize", json={"template": payload["parsed"], "solver": "internal"})
    assert batch.status_code == 200
    batch_payload = batch.json()
    assert batch_payload["status"] == "ok"
    assert batch_payload["summary"]["success"] == 2

    export = client.get(f"/api/batch-result/{batch_payload['batchId']}/export")
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    exported = openpyxl.load_workbook(BytesIO(export.content), data_only=True)
    assert {"批量计算汇总", "最优路线明细", "成分校核", "错误与警告"} <= set(exported.sheetnames)


def test_template_download_api_returns_parseable_standard_template():
    client = TestClient(app)

    response = client.get("/api/template/download")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    workbook = openpyxl.load_workbook(BytesIO(response.content), data_only=True)
    assert {
        "01_批量任务",
        "02_目标成分上下限",
        "03_转炉终点与回收率",
        "04_合金成分库",
        "05_价格表",
        "06_填写说明与校验规则",
    } <= set(workbook.sheetnames)
    report = parse_template_workbook(response.content)
    assert report["status"] == "ok"
    assert report["preview"]["taskCount"] == 2


def test_download_template_uses_feed_mode_without_addition_sequence():
    workbook = openpyxl.load_workbook(BytesIO(generate_template_workbook()), data_only=True)
    headers = [cell.value for cell in workbook["04_合金成分库"][1]]
    rules_text = "\n".join(str(row[1].value or "") for row in workbook["06_填写说明与校验规则"].iter_rows(min_row=1, max_col=2))

    assert headers[:6] == ["合金名称", "价格物料名", "启用", "投料方式", "袋重kg", "最大投加kg每t"]
    assert "投料方式" in headers
    assert "投加顺序" not in headers
    assert "连续" in rules_text
    assert "整袋" in rules_text
    assert "路线序号" in rules_text
    assert "真实投料顺序优化" not in rules_text


def test_feed_mode_continuous_allows_blank_or_zero_bag_size():
    rows = [
        ["硅锰", "硅锰", "是", "连续", None, 30, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, "空袋重连续"],
        ["硅铁", "硅铁", "是", "连续", 0, 20, 0.2, 72.23, None, None, 0.03, 0.02, None, "零袋重连续"],
        ["低碳锰铁", "低碳锰铁", "是", "整袋", 25, 25, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
    ]

    report = parse_template_workbook(workbook_bytes(alloy_rows=rows))

    assert report["status"] == "ok"
    alloys = report["parsed"]["tasks"][0]["config"]["alloys"]
    assert [alloy["feed_mode"] for alloy in alloys[:2]] == ["连续", "连续"]
    assert [alloy["bag_size_kg"] for alloy in alloys[:2]] == [0, 0]


def test_feed_mode_continuous_rejects_positive_bag_size():
    report = parse_template_workbook(
        workbook_bytes(
            alloy_rows=[
                ["硅锰", "硅锰", "是", "连续", 25, 30, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, ""],
                ["硅铁", "硅铁", "是", "连续", 0, 20, 0.2, 72.23, None, None, 0.03, 0.02, None, ""],
                ["低碳锰铁", "低碳锰铁", "是", "整袋", 25, 25, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
            ]
        )
    )

    assert report["status"] == "error"
    assert any(error["sheet"] == "04_合金成分库" and error["field"] == "袋重kg" for error in report["errors"])


def test_feed_mode_whole_bag_rejects_blank_or_zero_bag_size():
    for value in (None, 0):
        report = parse_template_workbook(
            workbook_bytes(
                alloy_rows=[
                    ["硅锰", "硅锰", "是", "连续", 0, 30, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, ""],
                    ["硅铁", "硅铁", "是", "连续", 0, 20, 0.2, 72.23, None, None, 0.03, 0.02, None, ""],
                    ["低碳锰铁", "低碳锰铁", "是", "整袋", value, 25, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
                ]
            )
        )

        assert report["status"] == "error"
        assert any(error["sheet"] == "04_合金成分库" and error["field"] == "袋重kg" for error in report["errors"])


def test_legacy_alloy_template_infers_feed_mode_and_warns():
    report = parse_template_workbook(
        workbook_bytes(
            alloy_header=["合金名称", "价格物料名", "启用", "袋重kg", "最大投加kg每t", "投加顺序", "C", "Si", "Mn", "Cr", "P", "S", "N", "备注"],
            alloy_rows=[
                ["硅锰", "硅锰", "是", 0, 30, 1, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, ""],
                ["硅铁", "硅铁", "是", None, 20, 2, 0.2, 72.23, None, None, 0.03, 0.02, None, ""],
                ["低碳锰铁", "低碳锰铁", "是", 25, 25, 3, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
            ],
        )
    )

    assert report["status"] == "ok"
    assert [alloy["feed_mode"] for alloy in report["parsed"]["tasks"][0]["config"]["alloys"]] == ["连续", "连续", "整袋"]
    assert any(warning["field"] == "投料方式" for warning in report["warnings"])
    assert any(warning["field"] == "投加顺序" for warning in report["warnings"])


def test_missing_feed_mode_without_legacy_sequence_is_structure_error():
    report = parse_template_workbook(
        workbook_bytes(
            alloy_header=["合金名称", "价格物料名", "启用", "袋重kg", "最大投加kg每t", "C", "Si", "Mn", "Cr", "P", "S", "N", "备注"],
            alloy_rows=[
                ["硅锰", "硅锰", "是", 0, 30, 1.72, 17.69, 65.66, None, 0.15, 0.02, 80, ""],
                ["硅铁", "硅铁", "是", 0, 20, 0.2, 72.23, None, None, 0.03, 0.02, None, ""],
                ["低碳锰铁", "低碳锰铁", "是", 25, 25, 0.64, None, 81.19, None, 0.20, 0.02, None, ""],
            ],
        )
    )

    assert report["status"] == "error"
    assert any(error["code"] == "MISSING_HEADER" and error["field"] == "投料方式" for error in report["errors"])


def test_batch_optimize_rejects_malformed_prevalidated_payload():
    client = TestClient(app)

    response = client.post("/api/batch-optimize", json={"template": {"tasks": [{"taskId": "T001"}]}, "solver": "internal"})

    assert response.status_code == 400
    assert "template 数据无效" in response.json()["detail"]


def test_batch_optimize_rejects_nested_malformed_prevalidated_payload():
    client = TestClient(app)

    response = client.post(
        "/api/batch-optimize",
        json={
            "solver": "internal",
            "template": {
                "tasks": [
                    {
                        "taskId": "T001",
                        "grade": "Q235B",
                        "thicknessMm": 10,
                        "config": {
                            "heat_weight_t": 150,
                            "target": [1],
                            "residual": {},
                            "recovery_rates": {},
                            "safety_margins": {},
                            "control_targets": {},
                            "alloys": [1],
                            "milp_settings": {},
                        },
                    }
                ]
            },
        },
    )

    assert response.status_code == 400
    assert "config.target" in response.json()["detail"]


def test_export_route_details_filters_and_sorts_by_cost_without_addition_sequence():
    content = export_batch_result(
        {
            "results": [
                {
                    "status": "ok",
                    "input": {"taskId": "T001", "grade": "Q235B", "thicknessMm": 10},
                    "result": {
                        "modes": {
                            "milp": {
                                "costPerTon": 100,
                                "heatCost": 15000,
                                "alloys": [
                                    {"name": "低成本", "kgPerTon": 0, "heatKg": 0, "bags": 0, "costPerTon": 99, "sequence": 9, "feedMode": "连续"},
                                    {"name": "B合金", "kgPerTon": 1.5, "heatKg": 225, "bags": 9, "costPerTon": 20, "sequence": 3, "feedMode": "整袋"},
                                    {"name": "A合金", "kgPerTon": 2.0, "heatKg": 300, "bags": 0, "costPerTon": 20, "sequence": 1, "feedMode": "连续"},
                                    {"name": "高成本", "kgPerTon": 0.5, "heatKg": 75, "bags": 0, "costPerTon": 30, "sequence": 2, "feedMode": "连续"},
                                ],
                                "chemistryChecks": [],
                            }
                        },
                        "warnings": [],
                    },
                }
            ]
        }
    )
    workbook = openpyxl.load_workbook(BytesIO(content), data_only=True)
    details = workbook["最优路线明细"]
    header = [cell.value for cell in details[1]]
    rows = [row for row in details.iter_rows(min_row=2, values_only=True)]

    assert header == ["任务编号", "路线序号", "合金", "kg/t", "炉次kg", "袋数", "成本贡献", "投料方式"]
    assert "投加顺序" not in header
    assert [(row[1], row[2], row[6], row[7]) for row in rows] == [
        (1, "高成本", 30, "连续"),
        (2, "A合金", 20, "连续"),
        (3, "B合金", 20, "整袋"),
    ]
