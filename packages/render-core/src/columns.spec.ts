/**
 * 左表列宽的**屏幕几何**（P3/C6-e：从 `TaskTable.vue` 收回 `columns.ts`）。
 *
 * 这两条是本批次**行为不变**的判据：把换算规则与下限表从组件搬进本包之后，
 * 九列像素宽必须**逐个**与搬迁前一致（`[65, 208, 78, 78, 56, 130, 56, 56, 182]`、合计 909），
 * 否则左表与图表之间的横向对齐（以及 `README` 里"九列合计 909 px"的口径）就变了。
 *
 * **顺带订正**：`README` 与本文件原先的散文都写着"合计 992 px（下限之和 906 px）"——
 * 两个数都与实现不符（按 `max(下限, 宽度 × 6.5)` 算出来是 909，且从一开始就是 909）。
 * 这条断言就是补上那个缺失的"算一遍"。
 */

import { describe, expect, it } from 'vitest';

import {
  COLUMN_SPECS,
  TABLE_COLUMN_CHAR_PX,
  TABLE_COLUMN_MIN_PX,
  TABLE_COLUMNS,
  tableColumnTemplate,
  tableColumnWidths,
} from './columns.js';
import { EXPORT_LABEL_INDENT_PX } from './exportLabels.js';
import { INDENT_PX_PER_LEVEL } from './manifest.js';

describe('P3/C6-e：左表列宽（屏幕像素）单点派生', () => {
  it('九列像素宽与搬迁前逐个相同，合计 909 px（下限之和与它相等）', () => {
    const widths = tableColumnWidths();
    expect(widths).toStrictEqual([65, 208, 78, 78, 56, 130, 56, 56, 182]);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(909);
    const minSum = COLUMN_SPECS.reduce((sum, spec) => sum + TABLE_COLUMN_MIN_PX[spec.key], 0);
    expect(minSum).toBe(909);
    expect(widths).toHaveLength(TABLE_COLUMNS.length);
    expect(widths).toHaveLength(COLUMN_SPECS.length);
  });

  it('每列都是 `max(下限, round(字符宽 × 6.5))`——下限真的在兜底', () => {
    expect(TABLE_COLUMN_CHAR_PX).toBe(6.5);
    for (const [index, spec] of COLUMN_SPECS.entries()) {
      const normalized = Math.round(spec.width * TABLE_COLUMN_CHAR_PX);
      expect(tableColumnWidths()[index]).toBe(Math.max(TABLE_COLUMN_MIN_PX[spec.key], normalized));
    }
    // 判别力：`notes` 的字符宽归一（182）刚好等于下限，改小导出宽度就该被下限顶住
    expect(Math.round(28 * TABLE_COLUMN_CHAR_PX)).toBe(TABLE_COLUMN_MIN_PX.notes);
    expect(Math.max(TABLE_COLUMN_MIN_PX.notes, Math.round(4 * TABLE_COLUMN_CHAR_PX))).toBe(182);
  });

  it('`grid-template-columns` 与列宽同源（表头与表体共用同一串）', () => {
    expect(tableColumnTemplate()).toBe('65px 208px 78px 78px 56px 130px 56px 56px 182px');
  });

  it('层级缩进：屏幕与导出共用同一个值，且只在 `manifest.ts` 声明一处', () => {
    expect(INDENT_PX_PER_LEVEL).toBe(12);
    expect(EXPORT_LABEL_INDENT_PX).toBe(INDENT_PX_PER_LEVEL);
  });
});
