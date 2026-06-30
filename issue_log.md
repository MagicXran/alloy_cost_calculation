# Issue Log

本文档用于记录本项目中已经犯过的错误、产生原因、修复办法和后续防复发规则。

## 维护规则

- 每次修改业务逻辑、优化算法、前端交互、模板解析、配置结构或测试逻辑后，必须更新本文档。
- 每次发现并修复 bug 后，必须新增一条记录；如果是同类问题复发，则更新原记录并追加复发原因。
- 记录必须写清：问题现象、原因、修复办法、验证方式、防复发要求。
- 不记录空泛描述，例如“修复问题”“优化代码”；必须能让后续开发者知道当时哪里错了、为什么错、怎么避免。

## 记录模板

```md
### YYYY-MM-DD - 简短标题

- 问题现象：
- 原因：
- 修复办法：
- 验证方式：
- 防复发要求：
```

## 已记录问题

### 2026-06-30 - manual_aluminum=true 时铝块不得计入最终成本和消耗

- 问题现象：批量导出和单源回算曾把手工铝块/AH 铝耗作为单独维护物料重新叠加到 `总吨钢成本`、`总合金消耗kg/t`、`新算法合金成本元/t`、`新算法合金消耗kg/t`，与最新确认的 `manual_aluminum=true` 语义冲突。
- 原因：上一轮为了对齐“含 AH 铝块”的现场总量，把铝块从 LP 自动变量中禁用后又在结果汇总层加回，混淆了“现场记录值”和“模型最终合金成本/消耗”两个口径。
- 修复办法：`tools/recalculate_lp_actual_aluminum.py` 保留 `1.合金成本!AH` 作为审计记录，但新算法 `new_x` 中铝块固定为 `0`，新算法总耗/总成本只看 LP 自动口径；`app.batch_template.export_batch_result()` 保留 `手工铝块kg/t`、参考成本和“手工录入”明细，但 `总吨钢成本`、`总合金消耗kg/t`、`炉次总成本` 不再叠加铝块。
- 验证方式：新增/更新 `tests/test_recalculate_lp_actual_aluminum.py::test_recalculation_reason_records_manual_aluminum_without_counting_it`、`tests/test_batch_template.py::test_export_batch_result_records_manual_aluminum_without_adding_to_totals`，并运行后端/前端相关测试。
- 防复发要求：`manual_aluminum=true` 的硬口径是 Al/Als/Alt 不进目标约束、不进 LP 自动优化、不进最终合金成本、不进最终合金消耗；若需要展示 AH 或手工铝块，只能作为记录、参考成本或审计明细，不得汇入总口径。

### 2026-06-30 - 旧口径：批量 API 曾支持逐炉手工铝块计入总成本

- 问题现象：用正确版 workbook 填批量模板后，API 导出与 `tools/recalculate_lp_actual_aluminum.py` 的 LP 自动投料在不含铝口径下一致，但和后台脚本“含 AH 铝块”的总成本/总消耗不一致，容易被误判为 API 计算错误。
- 原因：`process_rules.manual_aluminum=true` 时铝块不参与 LP 自动优化；后台回算脚本会从源 workbook `1.合金成本!AH` 额外加回实际铝块，而批量模板/API 之前没有逐炉手工铝块输入字段，导出只能给出不含手工铝块的自动方案。
- 修复办法：在 `01_批量任务` 增加可选列 `手工铝块kg/t`，解析后写入任务级 `manualAluminum`；若该值大于 0，则按当前价格方案下铝块物料价格计算手工铝块成本。批量导出新增自动成本/自动消耗、手工铝块成本/用量、总成本/总消耗列，并在最优路线明细中追加“手工录入”的铝块行；LP 自动求解变量仍保持禁用铝块，不改变成分约束。
- 验证方式：新增 `tests/test_batch_template.py::test_parse_template_workbook_preserves_manual_aluminum_for_batch_totals` 和 `tests/test_batch_template.py::test_export_batch_result_adds_manual_aluminum_to_totals_and_route_details`，先确认旧实现失败，再实现后通过；重新生成 `alloy-batch-template-v1.xlsx` 并通过批量模板一致性测试。
- 防复发要求：本条已被 2026-06-30 的 `manual_aluminum=true` 口径修正覆盖；以后比较 API 导出和单源回算时必须明确口径：最终总成本/总消耗只看不含铝的自动 LP/MILP 口径，手工铝块只能作为记录或参考明细。凡是新增手工维护物料，都必须先确认是否允许进入最终汇总。

### 2026-06-19 - 工艺规则总开关必须真正关闭所有现场规则

- 问题现象：批量模板 `07_工艺规则参数` 中 `enabled=否` 后，合金禁投上限不再执行，但 `C目标-carbon_target_margin`、低 Si 上限语义、`Ti + ti_safety_addition`、铝目标移除、微量元素目标移除等边界编译规则仍会继续生效，导致“总开关”只关了一半。
- 原因：`process_rule_alloy_upper_bound()` 会检查 `process_rules.enabled`，但 `compile_rule_view()` 里的目标边界插件没有检查总开关；规则引擎缺少基础目标规则和现场工艺插件的分层。
- 修复办法：在规则引擎中新增基础单值目标规则；`enabled=false` 时只运行空/0 归一化、名义目标、旧区间目标和基础单值目标规则，跳过所有现场工艺插件。这样 `C/P/S` 单值仍按上限，其余单值按等值，但不再扣 C 余量、加 Ti 余量、禁投合金或移除铝/微量元素目标。
- 验证方式：新增 `tests/test_rule_engine.py::test_process_rules_enabled_false_disables_all_field_rules` 和 `tests/test_batch_template.py::test_rule_sheet_enabled_false_disables_batch_process_rules`，并运行 `.venv-win\Scripts\python.exe -m pytest tests\test_backend_optimizer.py tests\test_batch_template.py tests\test_rule_engine.py -q`。
- 防复发要求：以后新增现场工艺插件时，必须明确它是否受 `process_rules.enabled` 控制；默认现场规则必须受总开关控制，只有基础目标解释规则可以在总开关关闭时继续运行。

### 2026-06-19 - 回算原因列不能硬编码控碳余量

- 问题现象：`tools/recalculate_lp_actual_aluminum.py` 的回算原因列会显示 `C上限按目标...-0.005=...`，即使批量模板或配置已把 `carbon_target_margin` 改成其他值，结果说明仍像是固定扣 `0.005`。
- 原因：规则引擎和边界计算已经读取 `process_rules.carbon_target_margin`，但解释文本仍保留早期默认值硬编码，导致“实际按自定义余量算、文字按默认余量讲”的审计错觉。
- 修复办法：`explain_row()` 改为从 `compile_rule_view(config).resolved_rules_config["carbon_target_margin"]` 读取实际余量；新增规则引擎、批量模板和回算原因文本测试，覆盖 `carbon_target_margin=0.004` 时 `C目标=0.160 -> C上限=0.156`。
- 验证方式：运行 `.venv-win\Scripts\python.exe -m pytest tests\test_rule_engine.py tests\test_batch_template.py::test_rule_sheet_overrides_batch_process_rules tests\test_recalculate_lp_actual_aluminum.py -q`。
- 防复发要求：以后凡是结果 workbook、原因列、README 中展示规则阈值，必须从当前编译规则或配置读取，不允许把默认值写死在解释文本里。

### 2026-06-17 - 单源回算必须把成分结果导出为独立 sheet

- 问题现象：`tools/recalculate_lp_actual_aluminum.py` 的主对比 sheet 已经有 `Excel原方案成分校核` 和 `新方案成分校核` 文本列，但这些列把所有元素压在一个字符串里，无法直接筛选某个元素，也不方便按 `Excel行号 + 元素` 逐条复核目标值、边界和新旧成分差。
- 原因：早期输出设计强调“一个 sheet 足够进行对比”，所以把成分校核作为行级说明字段塞进主表；当用户要求“测试结果中把成分结果导出来都整理一个 sheet 中”时，原结构缺少可审计的成分明细表。
- 修复办法：回算脚本在计算阶段保留 `old_chemistry`、`new_chemistry`、`终点成分` 和 `成分边界`，写 workbook 时新增 `成分结果` sheet，按 `Excel行号 + 元素` 展开 `目标值`、`约束下限/上限`、`终点成分`、`Excel方案成分`、`新算法成分`、`新-Excel成分`、`Excel校核`、`新算法校核`；默认输出文件名更新为 `热卷成本效益测算20260613版_LP新算法_单源对比_20260617_成分结果.xlsx`。
- 验证方式：新增 `tests/test_recalculate_lp_actual_aluminum.py`，先确认旧实现只生成 `LP新算法铝耗对比` 而缺少 `成分结果` sheet，再实现后通过；重新运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py --source "热卷成本效益测算20260613版（基础参数表）---发徐老师(3).xlsx"`，输出 328 行全部 LP 可行、旧 Excel 批准规则可行 292 行、不可行 35 行、输入异常 1 行，`成分结果` sheet 共 5248 条元素明细。
- 防复发要求：以后凡是回算产物中存在“多元素压缩文本”的校核字段，如果用户需要复核或筛选，必须同步提供结构化明细 sheet；不要只在主表原因列里堆字符串。

### 2026-06-16 - 规则语义分散会让 Ti、低目标不投和模板覆盖在不同入口被绕过去

- 问题现象：同一套业务规则分散在 `target_bounds_from_single_value()`、`effective_bounds()`、`nominal_target_value()`、`process_rule_alloy_upper_bound()`、batch 模板解析和单源回算脚本多个入口，结果是 `Ti +0.005` 在单值目标路径被绕掉，`Ni/Cu/Mo/Sb/B` 低目标不投也可能因为元素 bounds 被清空而丢失原始目标语义；模板 `07_工艺规则参数` 的数值也没有真正成为所有入口的统一事实源。
- 原因：历史上把“目标语义解释”“工艺规则修正”“禁投判断”“求解器边界”混在多个函数里各自推断，缺少一个唯一规则入口；单值目标先被压成 `target[min,max]` 后，很多原始业务语义已经丢失，后续入口只能猜。
- 修复办法：新增 `app/rules_engine.py`，实现 `target_spec -> RuleEngine -> CompiledRuleView` 的统一规则编译链；所有 magic number 默认值改为从 `config.json` 读取，batch 模板 `07_工艺规则参数` 先覆盖默认值，再统一编译目标语义、禁投逻辑和元素边界；`effective_bounds()`、`process_rule_alloy_upper_bound()`、`evaluate_plan_against_rules()`、回算脚本全部改为只读 `CompiledRuleView`。`Ti` 单值目标改为 `Ti = 目标值 + 0.005`，空值或 `0` 的元素目标统一视为“不约束”。
- 验证方式：新增 `tests/test_rule_engine.py` 覆盖 `Ti(single/range)`、空/0 忽略、低目标不投；`tests/test_batch_template.py` 更新为断言 `target_spec` 和最终编译边界；`tests/test_backend_optimizer.py`、全量 `pytest`、`node --test tests/ui_static.test.js` 全部通过；重新运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py` 后，正确版单源回算为 `328` 行 LP 全部可行，批准规则下旧 Excel 可行 `292` 行、不可行 `35` 行、输入异常 `1` 行。
- 防复发要求：以后新增、删除或调整规则时，只允许新增/调整规则插件和模板参数，不允许再把业务语义散落回 `core`、`batch_template`、回算脚本各自手写；任何入口只要需要“当前规则”，都必须先拿 `CompiledRuleView`，不能自己从 `target[min,max]` 反推。

### 2026-06-15 - 高 Si 和常规单值目标不能只按下限，必须按等值目标约束

- 问题现象：规则澄清后，`Si目标>0.05` 以及 Mn/V/Nb/Ti/Als/Alt/Cr/Ni/Cu/Mo/B/Sb 等常规单值目标如果仍只生成下限，会允许最终成分高于目标值；这不符合“达到目标值就是必须等于目标值、没有安全余量”的业务口径。
- 原因：上一轮规则洁净化只把低 Si 从下限语义改回上限语义，但保留了“其余单值目标按下限”的旧实现；同时 Ti 安全余量若继续叠加到单值等值目标，会把 `min=max=目标值` 改成 `min>max` 的交叉边界。
- 修复办法：`target_bounds_from_single_value()` 对非 C/P/S、非低 Si、非低目标禁投元素返回 `{"min": target, "max": target}`；`effective_bounds()` 对已经是等值的 Ti 边界不再叠加 `ti_safety_addition`；批量模板说明、签入模板和 README 同步改为“其余元素单值目标按等值控制”。
- 验证方式：新增/更新 `tests/test_batch_template.py::test_single_target_values_follow_confirmed_exact_target_semantics_without_hidden_margins`，先确认旧代码失败，再修改实现后通过；重新生成 `alloy-batch-template-v1.xlsx` 并通过模板一致性测试；运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py`，正确版单源回算为 `328` 行 LP 全部可行，批准规则下旧 Excel 可行 `86` 行、不可行 `241` 行、输入异常 `1` 行。
- 防复发要求：以后再改单值目标语义时，必须同时检查低杂质上限、禁投阈值、等值目标、Ti 工艺余量四类规则是否互相冲突；不能再把“达到目标值”偷换成“只要不低于目标值”。

### 2026-06-15 - 低 Si 目标语义不能误收成下限，否则会把整批低硅牌号算成不可行

- 问题现象：在第一次规则洁净化中，按“除 C/P/S 外其余单值目标默认按下限”的口径把 `Si` 也收进了下限语义，导致一批 `Si目标<=0.04` 的低硅牌号在禁用 `硅锰/硅铁` 后直接变成不可行；回算一度出现 `328` 行中 `21` 行 LP 不可行，诊断全部是 `Si下限无法满足`。
- 原因：用户最终确认的业务语义不是“低 Si 也要补到目标值”，而是“低 Si 只是低杂质控制，不要求补到这个值，只要求别超；高 Si 大于 0.05 才按目标值”。第一次清理时把 `Si<=0.05` 的旧隐式上限语义一起删掉了，只保留了 `Si<=0.04` 禁硅规则，导致 `Si` 既要满足下限、又没有主补硅合金可用，形成规则冲突。
- 修复办法：把 `Si` 单值目标语义显式化：新增 `process_rules.single_target_si_upper_only_max`，默认值 `0.05`；当 `Si目标<=0.05` 时按上限控制，不要求补到目标值；当 `Si目标>0.05` 时按等值目标处理。该阈值同步写入 `config.json`、模板 `07_工艺规则参数`、batch 解析链路和单源回算脚本；同时保留 `disable_silicon_alloys_si_max=0.04` 作为“低 Si 禁用硅锰/硅铁”的单独阈值。
- 验证方式：重新运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py`，正确版单源回算恢复为 `328` 行全部 LP 可行；在最新等值目标口径下，批准规则下旧 Excel 可行 `86` 行、不可行 `241` 行、输入异常 `1` 行；回读 `SPHC-ZT` 等低硅行，确认约束显示为 `Si<=0.015` 而非 `Si>=0.015`。
- 防复发要求：以后凡是规则清理、模板参数化或“只保留批准规则”类改动，必须把“目标语义”和“禁用阈值”分开核对。不能因为删隐式规则，就把用户已经确认的业务语义一起删掉；尤其 `Si` 这种既有“低杂质上限语义”又有“高 Si 达标语义”的元素，必须显式配阈值。

### 2026-06-15 - 规则洁净化后必须把“批准规则”和“旧 Excel 可行性”分开显示

- 问题现象：当前 LP 规则里混有未拍板的隐式口径，例如单值目标自动上限余量、`Ti` 双加 `+0.005`、以及 batch 路径还会把 `V/Nb/Cr` 等终点残余直接带入计算，导致“LP 比 Excel 贵”时很难判断到底是批准规则更严，还是程序多收紧了边界。
- 原因：规则编译分散在 `target_bounds_from_single_value()`、`effective_bounds()`、batch residual 构造和回算脚本多个入口；旧 Excel `AY:BJ` 只是解释层，但之前产物里没有直接标出“Excel 原方案在批准规则下是否可行”，导致成本差很容易被误判成求解器问题。
- 修复办法：按用户拍板的 8 条规则和两个 `A` 方案做规则洁净化：`C/P/S` 单值按上限，`Si<=0.05` 按低杂质上限语义、`Si>0.05` 及其余常规单值目标按等值目标语义；`Ti` 只对非等值下限/范围在下限侧加一次 `+0.005`；去掉 `Mn/V/Nb/Cr/Ni/Cu/Mo/Sb/B` 的自动上限余量；batch residual 与回算脚本统一只扣 `C/Mn` 终点；新增 `07_工艺规则参数` 模板 sheet，让用户显式修改 `process_rules` 阈值；回算产物新增 `Excel是否满足批准规则`、`Excel原方案成分校核`、`Excel不满足批准规则原因` 三列，并在表头汇总可行/不可行计数。
- 验证方式：`tests/test_batch_template.py` 与 `tests/test_backend_optimizer.py` 共 `64` 个测试全部通过，`node --test tests/ui_static.test.js` `24` 个测试全部通过；重新运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py` 后，正确版单源回算得到 `328` 行中 `328` 行 LP 可行、批准规则下旧 Excel 可行 `86` 行、不可行 `241` 行、输入异常 `1` 行；`X80M-1`、`X80M-2`、`X60M-2` 仍因当时默认 `carbon_target_margin=0.005` 导致金属锰替代低碳锰铁而更贵，但现在会明确标出“原 Excel 在批准规则下不可行”。
- 防复发要求：以后所有规则改动必须同时更新核心求解、batch residual、模板规则 sheet、回算产物列和文档；不能再让“隐藏规则”只存在于代码。凡是 `LP > Excel` 的行，都必须先看 `Excel是否满足批准规则`，再讨论成本差是否异常。

### 2026-06-15 - 正确版 workbook 已统一维护铝耗和合金单价，回算不能再读外部表

- 问题现象：用户确认 `热卷成本效益测算20260613版（基础参数表）---发徐老师(3).xlsx` 是当前正确版本，铝耗和合金单价都已维护在该文件内；旧脚本仍硬编码读取 `合金计算.xlsx` 和外部 `副本4.铝耗分析(1).xlsx`，且固定只循环到第 327 行，会漏掉正确版新增到第 332 行的尾部数据。
- 原因：上一版脚本是为“旧合金计算表 + 外部铝耗表”临时审计场景写的，没有把数据源口径抽成参数，也没有按 `F列炼钢牌号` 动态识别有效数据行。正确版 workbook 的 `1.合金成本!AB4:AU4` 已是单价来源，`1.合金成本!AH` 已是逐行铝块用量，再走外部匹配会制造错误来源。
- 修复办法：把 `tools/recalculate_lp_actual_aluminum.py` 改为单源读取，默认源文件为正确版 workbook，并支持 `--source` 指定同结构文件；按 `1.合金成本!F` 动态识别第 5 到 332 行共 328 条数据；合金单价从 `AB4:AU4` 读取；铝块按同源 `AH` 固定计入新方案这一旧口径已在 2026-06-30 被修正为“只记录不计入新算法总耗/总成本”；输出表新增源表审计状态和提示，复算 `AV/AW` 并标记负投料等异常。
- 验证方式：运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py`，输出 328 行全部 LP 可行、Excel 原结果错误 0、AH 铝耗缺失 0、源表审计提示 1 行；回读 `outputs/lp_actual_aluminum/热卷成本效益测算20260613版_LP新算法_单源对比_20260615.xlsx`，确认 `LP新算法铝耗对比` 无公式错误，且第 229 行 `800L-1` 的 `硅锰=-1.413228 kg/t` 被标为源表审计警告。
- 防复发要求：以后正确版 workbook 回算只认一个源文件，不得再默认读取外部铝耗/价格 Excel；行范围必须由真实数据列动态识别，不能写死旧行号；源表公式缓存即使没有 `#DIV/0!`，也要审计负投料、`AV/AW` 复算和行级牌号对齐。

### 2026-06-13 - LP 回算铝耗列位和 26MnB5 回收率不能按字面硬套

- 问题现象：回算 `合金计算.xlsx` 时，用户口径要求从铝耗文件 `F列炼钢牌号` 和 `AP 实际铝铝耗` 匹配；实际打开 `副本4.铝耗分析(1).xlsx` 后发现 `铝耗` sheet 只使用到 `AF`，`AF1=实际铝铝耗`，`AP` 为空/未使用。首次严格建模时，`26MnB5` 因原表 `Si回收率=0` 被误判为 Si 无法补足。
- 原因：铝耗 workbook 的实际列位与口头列名不一致；同时当前项目的批量解析已经有现场确认修正规则 `26MNB5` 的 `Si=0` 按 `0.8` 处理，直接从旧 workbook 抽值会绕过这条新算法规则。后续复查又发现 `26MnB5` 原 Excel `AV133/AW133` 本身是 `#DIV/0!`，不能把错误值当 0 去算 `新-Excel` 差值。
- 修复办法：新增 `tools/recalculate_lp_actual_aluminum.py`，回算时明确读取 `铝耗!F` 和 `铝耗!AF`，在输出表中写明 AP/AF 差异；铝块不进入 LP 自动优化，匹配到的实际铝耗单独计入新方案总耗和成本这一旧口径已在 2026-06-30 被修正为“只记录不计入新算法总耗/总成本”；构建回收率时复用 `FIELD_CONFIRMED_RECOVERY_OVERRIDES`，使 `26MnB5` 的 Si 回收率按 `0.8` 修正；原 Excel `AV/AW` 为错误值时，输出 `Excel结果状态`，差值留空，并从有效可比汇总中排除。
- 验证方式：运行 `.venv-win\Scripts\python.exe tools\recalculate_lp_actual_aluminum.py --output outputs\lp_actual_aluminum\合金计算_LP新算法_实际铝耗对比_修正版_20260613.xlsx`，输出 323 行全部 LP 可行、Excel 原结果错误 1、铝耗缺失 0；回读生成 workbook，确认 `26MnB5` 的 `新-Excel成本元/t` 为空且原因列记录 `AV/AW=#DIV/0!`。
- 防复发要求：以后处理现场 Excel 时，不要按用户口头列号直接取数；必须先搜索表头并给出实际 sheet/cell。凡是绕过模板解析直接建模的脚本，都必须显式复用项目已有的现场修正规则；原 Excel 缓存值为错误时必须标注不可比，不能静默转成 0。

### 2026-06-13 - LP 工艺规则固定值先硬编码，后补页面可调接口

- 问题现象：LP 新算法里的增碳余量、Ti 安全余量、禁用合金阈值等固定数字已经进入 `process_rules`，但一开始只在后端和 `config.json` 中维护，页面上不能直接调整。
- 原因：先按现场确认规则完成求解逻辑落地，但没有同步考虑现场运行时需要临时调参，导致固定数字仍偏“开发配置”，不够贴近现场使用。
- 修复办法：在页面新增“现场工艺规则（可改）”卡片，暴露总开关、铝块单独录入开关、增碳余量、Ti 安全余量、禁硅锰/硅铁阈值、P/S 禁投阈值、Ni/Cu/Mo/Sb/B 不投阈值；`ui.js` 增加 `setProcessRules`、`readProcessRules`、`syncProcessRuleFields`，求解时写回 `config.process_rules`。
- 验证方式：`node --test tests/ui_static.test.js` 覆盖页面输入存在性和 `process_rules` 写回；用 `effective_bounds` 脚本确认默认值、自定义值、关闭规则三种场景都生效。
- 防复发要求：凡是新增“经验阈值”“安全余量”“禁投阈值”这类现场可变数字，不能只写死在代码里；要么进配置，要么在页面/模板入口可维护，并补测试。

### 2026-06-13 - Ti 安全余量存在双重叠加风险

- 问题现象：批量模板解析和核心 LP 边界都有机会处理 Ti 安全余量，存在同一条规则被重复加两次的风险。
- 原因：模板解析负责把单值目标扩展成上下限，核心求解负责应用现场工艺规则；两层职责边界如果不清晰，很容易把“目标转换”和“工艺修正”混在一起。
- 修复办法：保持批量模板解析出的 Ti 目标为原始范围，只在 `app/core.py` 的 `effective_bounds()` 中统一应用 Ti 安全余量。
- 验证方式：`tests/test_batch_template.py` 断言解析后的 Ti 目标仍为原始值，同时 `effective_bounds()` 返回加安全余量后的有效边界。
- 防复发要求：模板解析只做数据清洗和目标格式转换；所有 LP 工艺修正统一放在核心求解边界层，避免同一规则分散在多处。

### 2026-06-13 - 无可行诊断和规则基线曾未继承工艺禁用上限

- 问题现象：LP/MILP 变量上限已经按工艺规则禁用了硅锰/硅铁等合金，但无可行诊断和规则基线的辅助逻辑仍可能按原始 `max_add_kg_per_t` 估算，诊断会偏乐观。
- 原因：主线性模型使用了 `process_rule_alloy_upper_bound()`，但辅助路径没有复用同一套上限函数，导致主求解和诊断/基线口径不一致。
- 修复办法：让 `diagnose_infeasible()` 的最大可达量估算和 `can_add()` 的规则基线加料校验都调用 `process_rule_alloy_upper_bound()`。
- 验证方式：新增回归测试，构造 `Si目标<=0.04` 且只有硅锰可补 Mn 的场景，确认诊断最大 Mn 可达量不再把已禁用硅锰算进去。
- 防复发要求：凡是会影响合金可用性或变量上限的规则，主求解、诊断、基线、敏感性分析必须复用同一个入口函数，不允许各自手写一套。

### 2026-06-12 - 只看 LP 结果容易误判现场可执行性

- 问题现象：Q460MD-1 对比中 LP 相比 Excel 出现约 `-27.29 元/t` 差价，单看结果容易以为 LP 找到了真实节省空间。
- 原因：LP 按最低成本和成分上下限求数学最优，未继承 Excel/现场“低碳余量不足时禁用或慎用硅锰”等经验规则，导致用硅锰替代低碳锰铁和硅铁的方案数学上可行但现场风险高。
- 修复办法：把现场确认的控碳、禁硅锰/硅铁、微量元素不投、P/S 不投、Ti 安全余量、铝块单独维护等规则写入 LP 新算法，并提供页面可调参数。
- 验证方式：通过行级合金投料差异拆分定位主因，再用后端单测和 UI 静态测试覆盖工艺规则进入模型、合金上限和页面输入回写。
- 防复发要求：Excel vs LP 成本差异不能只看总价差；必须拆到合金投料、元素边界、回收率、经验禁用规则和现场可执行性。
