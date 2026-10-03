/**
 * ADR 0007 §9 的第 ① ③ 层（**进 `pnpm gate`**）：
 *
 * - **① 几何期望值表**（声明式，内核无权改基准）：4 类关系的出/入边、stub 与正交折点、
 *   端点贴合条边中点、**跨周末右边界规则**；
 * - **③ 不变量**：反算往返（`dayAtX(xLeft) = dayOfOrdinal(es)` 等）、边端点落在条边上、汇总条覆盖子树；
 * - **④ 负向对照 NC3**：故意错的几何必须被检出（否则期望值表可能是恒真式）；
 * - **哨兵守卫**：`-1` 喂进几何必须抛 `RangeError`。
 *
 * 期望值表与检查器在 `checkers.spec.ts`（测试侧手段），本文件只负责"算出来、逐条比对、
 * 并证明判据有判别力"。
 */

import { describe, expect, it } from 'vitest';

import { buildFixture, DATASETS } from './fixtures.js';
import { buildView, DEFAULT_VIEWPORT } from './viewModel.js';
import {
  checkEdgeEndpointsAndSummaryCoverage,
  checkManualCases,
  checkRoundTrip,
  checkSentinelGuard,
  EXPECTED_ROUTE_SIDES,
  MANUAL_CASES,
  MANUAL_BASE_ISO,
} from './checkers.spec.js';
import { ROUTE_SIDES } from './route.js';

const primary = buildFixture(DATASETS[2]);

describe('G4 几何期望值表（ADR 0007 §9 ①；13/13，来自 G4-S）', () => {
  it('13 条声明式期望值全过（G4-S 实测 13/13）', () => {
    const results = checkManualCases({ calendar: primary.calendar });
    const failed = results.filter((row) => !row.pass);
    expect(failed.map((row) => `${row.name} —— ${row.detail}`)).toStrictEqual([]);
    expect(results).toHaveLength(13);
  });

  it('期望值表对三个档位都成立（ISO 边界与 pxPerDay 无关）', () => {
    for (const zoom of ['day', 'week', 'month'] as const) {
      const cases = MANUAL_CASES.filter((item) => item.zoom === zoom);
      expect(cases.length).toBeGreaterThan(0);
    }
  });

  it('基准日历的 baseDay 与 fixtures 的项目起点一致（序号 0 = 2026-10-05）', () => {
    expect(primary.calendar.isoOfDay(primary.calendar.dayOfOrdinal(0))).toBe(MANUAL_BASE_ISO);
  });

  it('ROUTE_SIDES 与 P-8 第 1 条逐条一致（唯一登记处仍是 P-8）', () => {
    expect(ROUTE_SIDES).toStrictEqual(EXPECTED_ROUTE_SIDES);
  });

  it('跨周末右边界规则真的被检查到了：`naiveRightIso` 与正确值必须在至少一条用例上不同', () => {
    const differ = MANUAL_CASES.filter(
      (item) => item.expect.xRightIso !== undefined && item.expect.xRightIso !== item.expect.naiveRightIso,
    );
    expect(differ.length).toBeGreaterThan(0);
  });
});

describe('NC3 负向对照：故意错的几何必须被检出（ADR 0007 §9 ④）', () => {
  const mutations = [
    {
      key: '右边界用 dayOfOrdinal(ef)（ADR 0007 §3 点名的错法）',
      options: { mutateRightBoundary: true },
      minDetected: 3,
    },
    { key: '交换出/入边（P-8 第 1 条的错法）', options: { mutateRouteSides: true }, minDetected: 3 },
    { key: '箭头朝向取反', options: { mutateArrowDir: true }, minDetected: 6 },
  ] as const;

  for (const mutation of mutations) {
    it(`${mutation.key} 必须被检出（G4-S 实测 ≥${String(mutation.minDetected)}/13）`, () => {
      const checked = checkManualCases({ calendar: primary.calendar, ...mutation.options });
      const detected = checked.filter((row) => !row.pass);
      expect(detected.length).toBeGreaterThanOrEqual(mutation.minDetected);
    });
  }

  it('未变造时零检出（证明上一条的检出确实来自变造，而不是判据无差别报错）', () => {
    const checked = checkManualCases({ calendar: primary.calendar });
    expect(checked.filter((row) => !row.pass)).toStrictEqual([]);
  });
});

describe('反算不变量与端点贴合（ADR 0007 §9 ③）', () => {
  for (const spec of DATASETS) {
    it(`${spec.name}·反算往返、端点贴合、汇总覆盖`, () => {
      const fixture = buildFixture(spec);
      const view = buildView({
        document: fixture.document,
        schedule: fixture.schedule,
        calendar: fixture.calendar,
        viewport: DEFAULT_VIEWPORT,
        zoom: 'day',
      });
      const checks = [
        ...checkRoundTrip({ view, calendar: fixture.calendar }),
        ...checkEdgeEndpointsAndSummaryCoverage({
          view,
          document: fixture.document,
          schedule: fixture.schedule,
          calendar: fixture.calendar,
        }),
      ];
      const failed = checks.filter((row) => !row.pass);
      expect(failed.map((row) => `${row.name} —— ${row.detail}`)).toStrictEqual([]);
    });
  }

  it('哨兵守卫：-1 喂进几何必须抛 RangeError（不得静默出 NaN）', () => {
    const checks = checkSentinelGuard({ calendar: primary.calendar });
    expect(checks.every((row) => row.pass)).toBe(true);
  });
});
