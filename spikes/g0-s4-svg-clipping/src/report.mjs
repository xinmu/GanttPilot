/**
 * 证据渲染（Markdown）。**稳定层**：同一份输入必须产出逐字节相同的文本
 * （所以这里不写时间戳、不写机器路径、不写随机量——时间与版本在 `env.md` 里以固定字符串登记）。
 *
 * 证据分级沿用 S3 的口径：
 * - **逐字节稳定**：几何期望值表 / 裁剪结构 / 不变量 / 定标判据 / 环境；
 * - **测量快照**：浏览器计时（按 Chrome 大版本分文件）。
 *
 * @typedef {import('./manifest.mjs').ZoomKey} ZoomKey
 */

import { EDGE_STUB_PX, EDGE_WRAP_PX, ELEMENT_MODEL, MACHINE, NODE_PRIMARY, SPACING, THRESHOLDS, VIEWPORT, WHEEL_NOTCH_PX, ZOOM_LABEL, ZOOM_ORDER } from './manifest.mjs';

/** @param {boolean} value */
const mark = (value) => (value ? '✅' : '❌');

/** @param {readonly { name: string, pass: boolean, detail: string }[]} checks */
export function renderChecks(checks) {
  return [
    '| 判据 | 结果 | 细节 |',
    '|---|---|---|',
    ...checks.map((check) => `| ${check.name} | ${mark(check.pass)} | ${check.detail} |`),
  ].join('\n');
}

/** 环境口径（与数字一起登记；ADR 0007 §9）。**稳定层不含时间戳**（时间由 git 历史承担）。 */
export function renderEnv({ nodeVersion, chromeVersion, chromeMode }) {
  return [
    '# G4-S 环境口径',
    '',
    '> 稳定层**不含时间戳**；本文件登记"机器与运行时"的固定字符串，任何数字都必须与本文件一起引用。',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 机器标识 | \`${MACHINE}\` |`,
    '| OS | Windows（本机开发机） |',
    `| Node 版本（本机实跑） | \`${nodeVersion}\` |`,
    `| Node 版本（主口径 / CONTRIBUTING·CI） | \`${NODE_PRIMARY}\` |`,
    `| 引擎来源 | \`packages/engine/dist\`（**构建产物**；不直接跑 \`src\`：引擎源码的相对 import 写的是 \`.js\`，Node 类型剥离解析不到） |`,
    `| 浏览器 | Chrome \`${chromeVersion}\`，\`${chromeMode}\` |`,
    `| 设备像素比 | 1（\`--force-device-scale-factor=1\`） |`,
    `| 视口 | ${String(VIEWPORT.width)}×${String(VIEWPORT.height)} CSS px，行高 ${String(VIEWPORT.rowHeight)}，缓冲 ${String(VIEWPORT.rowBuffer)} 行 |`,
    '',
    '## 复现命令',
    '',
    '```powershell',
    'pnpm --filter @ganttpilot/engine build        # 探针消费 dist，先构建',
    'cd spikes/g0-s4-svg-clipping',
    'pnpm typecheck                                # 两个 tsconfig（计算层无 DOM / 浏览器层含 DOM）',
    'node src/run-all.mts                          # L0 几何 + L1 裁剪 + L2 定标（写 evidence/）',
    'node src/browser-run.mts                      # L3 浏览器计时（需要本机 Chrome，记录制）',
    '```',
    '',
  ].join('\n');
}

/** 几何声明式期望值表 + 正确性负向对照（NC3）。 */
export function renderGeometryExpectations({ manual, nc3, fixtures }) {
  return [
    '# G4-S 几何期望值表（声明式，内核无权改基准）',
    '',
    '期望值写在 `src/manifest.mjs` 的 `MANUAL_CASES`：条形的左右边界写成 **ISO 日期**',
    '（`xLeft = dayOfOrdinal(es)`、`xRight = dayOfOrdinal(ef − 1) + 1`——ADR 0007 §3 的规则本身），',
    '`naiveRightIso` 是"误用 `dayOfOrdinal(ef)`"会得到的值，用来证明判据**有判别力**；',
    '路由用例声明的是**出/入边枚举与箭头朝向**（P-8 第 1 条的内容）。',
    '',
    '## 逐条结果',
    '',
    renderChecks(manual),
    '',
    `合计 **${String(manual.filter((row) => row.pass).length)}/${String(manual.length)}** 条通过。`,
    '',
    '## 负向对照 NC3：故意错的几何必须被检出',
    '',
    '| 变造 | 被检出条数 / 检查条数 |',
    '|---|---|',
    ...nc3.results.map((row) => `| ${row.key} | ${String(row.detected)} / ${String(row.checked)} |`),
    '',
    `判定：${mark(nc3.pass)}（每条变造都必须至少被一条期望值检出；否则期望值表是恒真式）。`,
    '',
    '## 口径澄清（实测发现，不改语义）',
    '',
    '- **ADR 0007 §3 的右边界公式在 `ef === 0` 时未定义**：项目起点处的零时长任务（典型为里程碑）',
    '  会让 `dayOfOrdinal(ef − 1) = dayOfOrdinal(-1)` 抛 `RangeError`。',
    '  本实验把里程碑落成**菱形分支**（几何取"所在工作日格的中点" + 菱形包围盒），不调用该公式；',
    '  条形分支的公式**一字未改**。属口径澄清，追加进 ADR 0007 §11 的回填说明，不动 §3 的语义。',
    '',
    '## 夹具规模（与数字一起引用）',
    '',
    '| 数据集 | 任务 | 依赖 | FS/SS/FF/SF | 里程碑 | 声明跨屏长边 | 汇总端点边 | 被折叠隐藏的边 |',
    '|---|---|---|---|---|---|---|---|',
    ...fixtures.map(
      (item) =>
        `| ${item.stats.name} | ${String(item.stats.taskCount)} | ${String(item.stats.linkCount)} | ${String(item.stats.typeCounts.FS)}/${String(item.stats.typeCounts.SS)}/${String(item.stats.typeCounts.FF)}/${String(item.stats.typeCounts.SF)} | ${String(item.stats.milestoneCount)} | ${String(item.stats.longEdgeIds.length)} | ${String(item.stats.summaryEdgeIds.length)} | ${String(item.stats.hiddenEdgeIds.length)} |`,
    ),
    '',
  ].join('\n');
}

/**
 * 裁剪证据（S4-a / S4-b 的判据本体）。
 *
 * @param {object} args
 * @param {object[]} args.perDataset
 * @param {object[]} args.gradient
 * @param {object} args.nc1
 * @param {object} args.nc2
 * @param {object} args.judgement
 */
export function renderClippingReport({ perDataset, gradient, nc1, nc2, judgement }) {
  const gradientTotals = gradient.map((row) => row.total);
  const c3ByZoom = ZOOM_ORDER.map(
    (zoom) => perDataset.find((row) => row.zoom === zoom)?.counts.c3 ?? 0,
  ).join('/');
  return [
    '# G4-S 裁剪有效性证据（S4-a / S4-b）',
    '',
    '## 元素预算：`#elements ≤ c₁ · visibleRows + c₂ · visibleEdges + c₃`',
    '',
    `元素模型（\`src/manifest.mjs\` 的 \`ELEMENT_MODEL\`）：每渲染行 ≤ **${String(ELEMENT_MODEL.perRenderedRow)}**`,
    `（\`<g>\` + 条 \`<rect>\` + 进度 \`<rect>\`；里程碑行为 2；进度未知不画填充），`,
    `每条渲染边 = **${String(ELEMENT_MODEL.perRenderedEdge)}**（折线 \`<path>\` + 箭头 \`<polygon>\` + ADR 0007 §5 要求的透明热区 \`<path>\`），`,
    '`c₃` = 轴（非工作日色带 + 网格线 + 标签），**按档位各一个常数**且**只与视口水平范围有关**。',
    '',
    '| 数据集 | 档位 | 渲染行 | 渲染边 | 元素总数 | 预算上界 | 在预算内 | c₃ | 轴构成（色带/线/标签） |',
    '|---|---|---|---|---|---|---|---|---|',
    ...perDataset.map(
      (row) =>
        `| ${row.dataset} | ${ZOOM_LABEL[row.zoom] ?? row.zoom} | ${String(row.counts.renderedRows)} | ${String(row.counts.renderedEdges)} | ${String(row.counts.total)} | ${String(row.counts.bound)} | ${mark(row.counts.withinBudget)} | ${String(row.counts.c3)} | ${String(row.counts.axisBreakdown.bands)}/${String(row.counts.axisBreakdown.gridlines)}/${String(row.counts.axisBreakdown.labels)} |`,
    ),
    '',
    '## 与文档总规模解耦（规模梯度 200 → 2,000 任务，局部结构一致）',
    '',
    '| 规模 | 依赖总数 | 渲染行 | 渲染边 | 元素总数 | 渲染边占文档总边数 |',
    '|---|---|---|---|---|---|',
    ...gradient.map(
      (row) =>
        `| ${String(row.size)} | ${String(row.linkCount)} | ${String(row.renderedRows)} | ${String(row.renderedEdges)} | ${String(row.total)} | ${(row.renderedEdges / row.linkCount * 100).toFixed(2)}% |`,
    ),
    '',
    `- 规模跨度 **10×**，渲染行恒为 **${String(gradient[0]?.renderedRows ?? 0)}** 行；`,
    `- 元素总数增长比 = **${(Math.max(...gradientTotals) / Math.min(...gradientTotals)).toFixed(3)}×**（阈值 ≤ ${String(THRESHOLDS.windowedGrowthRatio)}×）；`,
    '  对照：**关掉窗口裁剪**后同一规模跨度的增长比 = **' +
      `${nc2.ratio.toFixed(2)}×**（阈值 > ${String(THRESHOLDS.nc2GrowthRatio)}×）——两者相差一个数量级，说明判据有判别力。`,
    '',
    '### NC2：关掉窗口裁剪（负向对照）',
    '',
    '| 规模 | 渲染行 | 渲染边 | 元素总数 |',
    '|---|---|---|---|',
    ...nc2.rows.map(
      (row) => `| ${String(row.size)} | ${String(row.rows)} | ${String(row.edges)} | ${String(row.total)} |`,
    ),
    '',
    `判定：${mark(nc2.pass)}（元素数必须随规模增长，否则"与规模无关"是恒真式）。`,
    '',
    '## S4-b：求交裁剪的必要性（跨屏长边）',
    '',
    '「边所跨行区间 ∩ 渲染窗口」求交 vs「仅两端点可见才画」——同一几何、同一视口、同一滚动位置：',
    '',
    '| 滚动到行 | 求交渲染边数 | 端点可见性渲染边数 | 被误裁（丢）边数 | 其中跨屏长边 |',
    '|---|---|---|---|---|',
    ...nc1.positions.map(
      (row) =>
        `| ${String(row.offset)} | ${String(row.intersectEdges)} | ${String(row.endpointEdges)} | ${String(row.lost)} | ${String(row.lostSpanning)} |`,
    ),
    '',
    `合计被误裁 **${String(nc1.totalLost)}** 条；判定：${mark(nc1.pass)}`,
    `（判据：每个声明滚动位置至少丢 ${String(nc1.thresholds.minPerPosition)} 条、合计 ≥ ${String(nc1.thresholds.total)} 条；`,
    '**若为 0 则说明测试数据未覆盖跨屏长边 ⇒ 数据无效、必须重造**，不得记为"求交不必要"）。',
    '',
    '## S4-a / S4-b 判定',
    '',
    renderChecks(judgement.checks),
    '',
    '> **"可见行窗口"读作 §6.1 的渲染窗口（可见行 + 缓冲）**：§6.2 的原文是"∩ 可见行窗口"，',
    '> 而 §6.1 已把渲染行定义为"可见行 + `ROW_BUFFER`"。若读成"不含缓冲"，缓冲行内的边会被漏画，',
    '> 与 §6.1 自相矛盾。本实验按渲染窗口实现——属口径澄清，不是契约变更。',
    '',
    '> **第三维裁剪（发现）**：ADR 0007 §6 只写了"行窗口"与"边窗口"，但轴与刻度还有**水平窗口**。',
    '> 探针按视口 x 范围裁剪轴元素，`c₃` 因此只与"视口宽 ÷ `pxPerDay`"有关（实测（日/周/月）= ' +
      `${c3ByZoom}，按档位各一个常数），`,
    '> 与文档总规模无关。G4 落地时必须照此实现；若要把它写进契约，属 §6 的补充（另立 ADR）。',
    '',
    `被传播忽略的边（汇总端点）**照画**、用样式键 \`edge-ignored\` 区分（ADR 0007 §6.4，不新开诊断码）；`,
    '折叠隐藏的行不画其边（§6.3）——两条由**同一遍求交**完成（隐藏行没有可见行序号，端点映射为 `-1`）。',
    '',
  ].join('\n');
}

/** 不变量证据。 */
export function renderInvariantsReport({ checks }) {
  return [
    '# G4-S 不变量证据（ADR 0007 §9 第 ③ 层）',
    '',
    '| 项 | 结果 | 细节 |',
    '|---|---|---|',
    ...checks.map((row) => `| ${row.name} | ${mark(row.pass)} | ${row.detail} |`),
    '',
    `合计 **${String(checks.filter((row) => row.pass).length)}/${String(checks.length)}** 条通过。`,
    '',
  ].join('\n');
}

/**
 * 路由与折点证据（S4-d）。
 *
 * @param {object} args
 * @param {object} args.arrows
 * @param {object} args.fixed
 * @param {object} args.proportional
 * @param {object} args.clearance
 * @param {boolean} args.pass
 */
export function renderRoutingReport({ arrows, fixed, proportional, clearance, pass }) {
  const pairTable = arrows.pairs.map((row) => `| ${row.pair} | ${row.distance.toFixed(4)} |`);
  return [
    '# G4-S 依赖线路由与折点证据（S4-d）',
    '',
    '## 4 类关系箭头可区分性（**同尺量化，不得目视**；P-9）',
    '',
    `形态 = **填充**（\`ARROW_FILL\`：FS/FF 实心、SS/SF 空心）× **朝向**（由 P-8 第 1 条的入边侧决定：左入 ⇒ +x、右入 ⇒ −x）。`,
    '',
    `度量：在**真实渲染尺寸**（长 ${arrows.metrics.length.toFixed(1)} px = 行高 × ${String(SPACING.arrowLengthRatio)}、半宽 ${arrows.metrics.halfWidth.toFixed(1)} px）下`,
    '按 1 CSS px 网格在像素中心采样，算两两 **Jaccard 距离** `1 − |A∩B| / |A∪B|`。',
    '',
    '| 关系对 | 距离 |',
    '|---|---|',
    ...pairTable,
    '',
    `最小距离 = **${arrows.minDistance.toFixed(4)}**（阈值 ≥ ${String(arrows.threshold)}）⇒ ${mark(arrows.pass)}；`,
    `各形态覆盖采样格数：FS=${String(arrows.cellCounts.FS)}、SS=${String(arrows.cellCounts.SS)}、FF=${String(arrows.cellCounts.FF)}、SF=${String(arrows.cellCounts.SF)}` +
      `（"实心 vs 空心"与"朝 +x vs 朝 −x"各自贡献距离：FS|FF = 1.000 是纯镜像，FS|SS ≈ ${(arrows.pairs.find((row) => row.pair === 'FS|SS')?.distance ?? 0).toFixed(3)} 是纯填充差异）。`,
    '',
    '## 折点参数（`EDGE_STUB_PX` / `EDGE_WRAP_PX`）的常数性',
    '',
    '「折点在缩放时不跳变」被落成两条**可判定**的等价命题（原始表述在浮点下不可判别）：',
    '① 折点相对条边的偏移（stub 长度、回绕走廊宽度）在 `pxPerDay` 细扫下逐值等于声明常量；',
    '② 用**比例式 stub**（`stub ∝ pxPerDay`）作负向对照，同一条判据必须把它检出。',
    '',
    '| 模式 | `max\\|stub − EDGE_STUB_PX\\|` | `max\\|走廊 − EDGE_WRAP_PX\\|` | 判定 |',
    '|---|---|---|---|',
    `| 固定像素（选定：stub=${String(EDGE_STUB_PX)} px、wrap=${String(EDGE_WRAP_PX)} px） | ${String(fixed.maxStubDeviation)} | ${String(fixed.maxWrapDeviation)} | ${mark(fixed.maxStubDeviation === 0 && fixed.maxWrapDeviation === 0)} |`,
    `| 比例式（负向对照，必须被检出） | ${proportional.maxStubDeviation.toFixed(3)} | ${proportional.maxWrapDeviation.toFixed(3)} | ${mark(proportional.maxStubDeviation > 0)} |`,
    '',
    `扫描的 \`pxPerDay\` 值：${fixed.series.map((row) => String(row.pxPerDay)).join('、')}。`,
    '',
    '### 规则固有的不连续性（量化并记录，不是实现缺陷）',
    '',
    `回绕判据（\`exitSide === 'left' && enterStubX < exitStubX\`）会随 \`pxPerDay\` 变化而**翻转**：`,
    `本次扫描中被声明的 ${String(fixed.samples.length)} 条边的翻转次数 = **${String(fixed.wrapFlips.length)}**`,
    fixed.wrapFlips.length > 0 ? `（例如 ${fixed.wrapFlips.slice(0, 3).join('；')}）。` : '。',
    '翻转点竖向段位置会跳变——这是 ADR 0007 §5 规则的固有性质；要消掉它只能改规则（**另立 ADR**）。',
    '',
    '## 竖向段与条形矩形的间距（**发现型指标，不是 S4-d 的判据**）',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 参与测量的边 | ${String(clearance.measuredEdges)} |`,
    `| 竖向段穿过条形（间距 < 0）的边 | ${String(clearance.crossingEdges)}（${(clearance.crossingRatio * 100).toFixed(1)}%） |`,
    `| 间距 ∈ [0, ${String(THRESHOLDS.minStubClearancePx)} px) 的边 | ${String(clearance.closeEdges)} |`,
    `| 最小间距 | ${clearance.minClearance === null ? 'n/a' : clearance.minClearance.toFixed(2)} px |`,
    '',
    'v0.1 **明确不做同侧多线避让**（P-8 遗留 3），走线穿过条形是可接受的现状；',
    '这里量化"穿过比例"，供日后出现真实取舍时**另立 ADR** 的依据。',
    '',
    '## S4-d 判定',
    '',
    `箭头可区分：${mark(arrows.pass)}；折点常数性（固定式）：${mark(fixed.maxStubDeviation === 0 && fixed.maxWrapDeviation === 0)}；`,
    `整体判定：**${mark(pass)}**`,
    '',
  ].join('\n');
}

/** 定标证据（`pxPerDay` / 行高 / 缓冲 / gutter）。 */export function renderScaleParams({ params }) {
  const zoomRows = [];
  for (const zoom of ZOOM_ORDER) {
    for (const row of params.zoom[zoom].candidates) {
      zoomRows.push(
        `| ${ZOOM_LABEL[zoom] ?? zoom} | ${String(row.pxPerDay)} | ${row.barWidthPx.toFixed(0)} | ${mark(row.barOk)} | ${row.spacingPx.toFixed(0)} | ${row.labelWidthPx.toFixed(0)} | ${mark(row.ok)} | ${row.availablePx.toFixed(0)} | ${mark(row.availablePx >= row.neededPx)} | ${mark(row.pass)} |`,
      );
    }
  }
  return [
    '# G4-S 定标证据（ADR 0007 §11 第 1、2 项）',
    '',
    '> 常量不是"选的"，是**判据推出来的**。下表逐候选给出每条判据的实测值——',
    '> 改常量必然在证据里留下 diff（这也是"负向对照"精神的一部分）。',
    '',
    '## `pxPerDay` 三档（选取规则：**取通过全部判据的最小候选**）',
    '',
    '判据：① 日档 1 工作日条宽 ≥ ' +
      `${String(THRESHOLDS.minBarWidthPx)} px；② 刻度间距 ≥ 标签宽度估算 + 2 px；`,
    '③ 回绕走廊 `stub + wrap` 落在 gutter 内。',
    '',
    '| 档位 | 候选 px/day | 条宽 px | ① | 刻度间距 px | 标签宽 px | ② | 走廊可用 px | ③ | 通过 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...zoomRows,
    '',
    `选定：**日 ${String(params.selected.day)} / 周 ${String(params.selected.week)} / 月 ${String(params.selected.month)} px·day⁻¹**；`,
    '档位切换是**离散**的（只改 `pxPerDay` 与表头分组，不改变任何序号↔日期的对应，ADR 0007 §3）。',
    '',
    '## `ROW_HEIGHT`（选取规则：**取通过全部判据的最大候选**）',
    '',
    `| 行高 | 条高 px | 菱形 px | 4 的整数倍 | 可见行数（${String(VIEWPORT.height)} px 视口） | 通过 |`,
    '|---|---|---|---|---|---|',
    ...params.rowHeight.rows.map(
      (row) =>
        `| ${String(row.rowHeight)} | ${row.barHeightPx.toFixed(1)} | ${String(row.diamondPx)} | ${mark(row.multipleOfFour)} | ${String(row.visibleRows)} | ${mark(row.pass)} |`,
    ),
    '',
    `选定：**${String(params.rowHeight.selected)} px**。`,
    '',
    '## `ROW_BUFFER`（选取规则：**取通过判据的最小候选**）',
    '',
    `判据：一次滚轮档位（${String(WHEEL_NOTCH_PX)} px，Windows 典型值）跨过的行数 ≤ 缓冲行数 → 需要 ≥ **${String(params.rowBuffer.requiredRows)}** 行。`,
    '',
    '| 缓冲行 | 覆盖 px | 通过 |',
    '|---|---|---|',
    ...params.rowBuffer.rows.map((row) => `| ${String(row.rowBuffer)} | ${String(row.coveredPx)} | ${mark(row.pass)} |`),
    '',
    `选定：**${String(params.rowBuffer.selected)} 行**。`,
    '',
    '**实测佐证**（非主判据）：由 `node src/browser-run.mts` 的 10× 滚动页内断言给出——' +
      '每帧都断言"渲染行范围 ⊇ 可见行范围"，本轮**空白行 = 0**（见 `evidence/browser-timing-*.md` 的「空白行」列）。',
    '',
    '## `AXIS_LEFT_GUTTER_DAYS`（由回绕走廊反推）',
    '',
    `需要 ` +
      `\`stub + wrap = ${String(params.gutter.neededPx)} px\` 的空间，最窄档位为月档（\`pxPerDay = ${String(params.gutter.minPxPerDay)}\`）`,
    `⇒ \`ceil((${String(params.gutter.neededPx)} + 4) / ${String(params.gutter.minPxPerDay)}) = ${String(params.gutter.derived)}\` 天。`,
    '',
    '| 档位 | 左边距 px（= 8 天 × px/day） |',
    '|---|---|',
    ...ZOOM_ORDER.map((zoom) => `| ${ZOOM_LABEL[zoom] ?? zoom} | ${String(params.gutter.perZoomPx[zoom])} |`),
    '',
    `**代价（明确记录）**：日档下左边距 = ${String(params.gutter.perZoomPx.day)} px，占 ${String(params.gutter.viewportWidth)} px 视口的 ` +
      `${((params.gutter.perZoomPx.day / params.gutter.viewportWidth) * 100).toFixed(1)}%。`,
    '这是"gutter 以**天数**表达"（ADR 0007 §3）的固有代价——因为回绕走廊是**固定像素**长度，',
    '而 gutter 的像素宽度随档位缩放。改成本档位推导（`gutterDays(zoom) = ceil(走廊 / pxPerDay(zoom))`）',
    '会让左边距恒为约 24–32 px，但那是**语义变更**，须**另立 ADR**，不在本实验内顺手决定。',
    '',
  ].join('\n');
}

/**
 * 浏览器计时证据（**测量快照**，按 Chrome 大版本命名：同一份内核在不同 Chrome 上数值必然不同）。
 *
 * @param {object} args
 * @param {{ browser: string, mode: string }} args.chrome
 * @param {{ key: string, result: object }[]} args.runs
 * @param {{ name: string, pass: boolean, detail: string }[]} args.checks
 */
export function renderBrowserTiming({ chrome, runs, checks }) {
  const lines = [
    '# G4-S 浏览器计时证据（S4-c，**记录制**）',
    '',
    '> **测量快照**：换 Chrome 版本、换机器、换档位都会变。与数字一起引用的口径见下。',
    '',
    '## 环境',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 浏览器 | ${chrome.browser} |`,
    `| 模式 | ${chrome.mode}（\`--headless=new\`，\`--force-device-scale-factor=1\`） |`,
    `| 视口 | ${String(VIEWPORT.width)}×${String(VIEWPORT.height)} CSS px（行高 ${String(VIEWPORT.rowHeight)}、缓冲 ${String(VIEWPORT.rowBuffer)}） |`,
    '| 数据来源 | 合成夹具 JSON + 页面内 `createScheduleCalendar` + `compute`（**不含 xlsx 导入**；`exceljs` 不出现） |',
    '| 元素模型 | 与 `count.mjs` 一一对应（行 `<g>`+条/菱形+进度；边 `<path>`+箭头+透明热区） |',
    '',
    '## 首屏（起止事件：「文档与 Schedule 就绪」→「含依赖线的首帧完成」）',
    '',
  ];
  for (const run of runs) {
    lines.push(`### ${run.key}`, '');
    lines.push('| 档位 | 口径值（第 1 轮：就绪→首帧） | 逐轮首帧 p50 / p95 ms | 几何 p50 ms | 渲染 p50 ms | 渲染行 | 渲染边 | 元素数 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const entry of run.result.firstScreen) {
      const samples = entry.samples ?? [];
      // 口径值只有第 1 轮成立（后续轮次自"就绪"起会累计前几轮的时间）；
      // 逐轮重复测量看的是**每轮自己的首帧耗时** `frameMs`。
      lines.push(
        `| ${entry.label} | **${entry.primaryFromReadyMs.toFixed(1)}** | ${percentileOf(samples.map((sample) => sample.frameMs), 0.5).toFixed(1)} / ${percentileOf(samples.map((sample) => sample.frameMs), 0.95).toFixed(1)} | ${percentileOf(samples.map((sample) => sample.geometryMs), 0.5).toFixed(2)} | ${percentileOf(samples.map((sample) => sample.renderMs), 0.5).toFixed(2)} | ${String(entry.counts.renderedRows)} | ${String(entry.counts.renderedEdges)} | ${String(entry.counts.elements)} |`,
      );
    }
    lines.push('');
    lines.push(
      `分层（自 \`navigationStart\` 起）：模块与页面就绪 ${String(run.result.marks.readyFromNavigationMs ?? 0)} ms，` +
        `其中夹具 fetch+parse ${String(run.result.marks.fixtureFetchAndParseMs ?? 0)} ms、页面内 \`compute\` ${String(run.result.marks.computeMs ?? 0)} ms；` +
        `文档规模 ${String(run.result.documentShape?.tasks ?? 0)} 任务 / ${String(run.result.documentShape?.links ?? 0)} 依赖、排程诊断 ${String(run.result.documentShape?.diagnostics ?? 0)} 条。`,
    );
    lines.push('');
  }

  lines.push('## 10× 滚动（与《评估报告》§5.4 的 2,200 边 / 约 2.0s **同尺**对照）', '');
  lines.push('| 夹具 | 步数 | 总墙钟 ms | 主线程合计 ms | 主线程 p50/p95 ms | 帧间隔 p50/p95 ms | longtask 数 / 合计 ms | 空白行 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const scroll = run.result.scroll;
    if (scroll === null || scroll === undefined) continue;
    lines.push(
      `| ${run.key} | ${String(scroll.steps.length)} | ${scroll.totalWallMs.toFixed(1)} | ${scroll.totalWorkMs.toFixed(1)} | ${scroll.p50WorkMs.toFixed(2)} / ${scroll.p95WorkMs.toFixed(2)} | ${scroll.rafP50Ms.toFixed(2)} / ${scroll.rafP95Ms.toFixed(2)} | ${String(scroll.longTaskCount)} / ${scroll.longTaskTotalMs.toFixed(1)} | ${String(run.result.blankRowGaps)} |`,
    );
  }
  lines.push('');
  lines.push('逐帧明细（`step`：主线程 ms / 渲染边 / 元素）：', '');
  for (const run of runs) {
    const scroll = run.result.scroll;
    if (scroll === null || scroll === undefined) continue;
    lines.push(
      `- **${run.key}**：` +
        scroll.steps
          .map((step) => `${String(step.step)}:${step.workMs.toFixed(1)}/${String(step.renderedEdges)}/${String(step.elements)}`)
          .join('　'),
    );
  }
  lines.push('');
  lines.push(
    '> **口径澄清（实测订正）**：滚动步的"帧时长"**不能**用双 `requestAnimationFrame` 测——',
    '> 那会把我们自己的等待（两帧 ≈ 33 ms）算进去（本探针第一版就是这么错的，会把 1.2 ms 的工作量报成 33 ms）。',
    '> 现在记录两个量：① **主线程耗时**（几何 + DOM 的同步部分，我们真正控制的量，**判据用它**）；',
    '> ② 滚动期间连续 `rAF` 的**真实帧间隔**（含浏览器空闲/节流，**记录制、不作门禁**）。',
  );
  lines.push('');
  lines.push(
    '> **首屏数字怎么读**：几何 p50 ≈ 0.5 ms + 渲染 p50 ≈ 0.7 ms 才是"我们的工作量"；',
    '> 首屏的 20–35 ms 里绝大部分是**双 `rAF`（两帧）与绘制调度的固有下界**（同量级下会抖动）。',
    '> 因此它与 1,000 ms 预算的差距**不是**"我们的余量"，而是"排程 + 几何 + 首帧不构成瓶颈"的证据；',
    '> G4/G8 在打包产物上复测时，请用同一套分层字段（`marks` / 逐轮 `frameMs`）对齐口径。',
  );
  lines.push('');

  lines.push('## S4-c 判定', '');
  lines.push('| 判据 | 结果 | 细节 |');
  lines.push('|---|---|---|');
  for (const check of checks) lines.push(`| ${check.name} | ${check.pass ? '✅' : '❌'} | ${check.detail} |`);
  lines.push('');
  lines.push('## 口径限制（必须与数字一起读）', '');
  lines.push('- 探针页**无打包器**（单页 + 原生 ESM 模块）：因此"模块加载"这一层不代表生产壳；');
  lines.push('  **G4/G8 必须在打包产物上复测首屏**，本实验只能判"排程 + 几何 + 首帧 + 依赖线"这一段是否满足预算；');
  lines.push('- 首屏**不含**左表（本实验边界：不写产品级组件）与 xlsx 导入（`exceljs` 只准动态 `import()`）；');
  lines.push('- 滚动是**程序化步进**（每步一屏、同步重绘 + 双 rAF），不是真实滚轮事件序列；与 §5.4 的对照因此是');
  lines.push('  "同样的滚动量与断言方式"，不是"同样的输入通道"；');
  lines.push('- `--headless=new` 使用软件光栅；headed 与 DPR>1 需在 G4/G8 复测；');
  lines.push('- `longtask` 只统计 >50 ms 的主线程任务，探针里通常是 0（这本身是结论的一部分）。');
  lines.push('');
  return lines.join('\n');
}

/** @param {readonly number[]} values @param {number} ratio */
function percentileOf(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}
