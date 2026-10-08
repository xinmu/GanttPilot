/**
 * 日期算术（协议层）：Excel 序列号 ↔ ISO 日期。
 *
 * **硬性约束（ADR 0006 §8 / CONTRIBUTING 红线 1）**：
 * 写出真日期**必须**用 `Date.UTC(y, m-1, d)` 构造。
 * `exceljs` 的序列号公式是 `25569 + d.getTime() / 86400000`——即序列号由**绝对时刻**推导，
 * 而不是由「年月日」推导。用本地零点构造（`new Date(y, m-1, d)`）在 UTC+8 下会写出
 * `整数 - 1/3` 的小数序列号，Excel 按序列号显示时落入**前一天**（本仓库已三次复现，见 S2 §三.4）。
 */

const MS_PER_DAY = 86_400_000;

/**
 * 序列号 → 日序号（`1970-01-01 = 0`）的换算常量。
 *
 * 注意**符号**：Excel 的序列号 0 是 1899-12-30，而 `Date.UTC(1899,11,30) / 86400000 = -25569`
 * ——所以 `日序号 = 序列号 - 25569`（不是 `+`）。写成 `+25569` 会让每个日期都偏到 2040 年以后
 * 再往前推 126 年（实测：序列号 46300 会得到 2166-10-09 而不是 2026-10-05）。
 * 同一常量在 `xlsx.ts` 的 `dateFromSerial` 里也必须保持一致的符号。
 */
const SERIAL_EPOCH_DAY_NUMBER = -25_569;

/** 序列号可接受区间的下界：< 1 即 1900 年前（ADR 0006 §4）。 */
export const MIN_DATE_SERIAL = 1;

/** 序列号可接受区间的上界（9999-12-31）。 */
export const MAX_DATE_SERIAL = 2_958_465;

const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_PATTERN = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 年月日 → `yyyy-mm-dd`（不校验）——**唯一的 ISO 文本生产点**。 */
export function isoFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

interface IsoParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function validParts(parts: IsoParts): boolean {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    return false;
  }
  // 用 UTC 回写比对，拒绝 2026-02-31 这类"格式合法、日历非法"的日期。
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  );
}

/** ISO / `yyyy/m/d` / `yyyy.m.d` 文本 → 各段；非法返回 `undefined`。 */
export function parseDateText(text: string): IsoParts | undefined {
  const trimmed = text.trim();
  const match = ISO_PATTERN.exec(trimmed) ?? SLASH_PATTERN.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const parts: IsoParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return validParts(parts) ? parts : undefined;
}

/**
 * **规范导出**用的日期构造：UTC 零点。
 *
 * 这是本仓库唯一允许的"ISO → `Date`"路径；`exceljs` 会把 `Date.UTC(y,m-1,d)`
 * 落成**整数**序列号（有负向用例守住）。
 */
export function utcMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** ISO 文本 → 规范导出用的 `Date`（非法文本抛错：调用方必须先校验文档）。 */
export function utcMidnightFromIso(iso: string): Date {
  const parts = parseDateText(iso);
  if (parts === undefined) {
    throw new RangeError(`不是合法的 ISO 日期：${iso}`);
  }
  return utcMidnight(parts.year, parts.month, parts.day);
}

/**
 * 序列号 → ISO 文本；带小数的序列号按 **UTC 取日期部分**（ADR 0006 §4）。
 *
 * **不可表示的序列号返回 `null`**（调用方据此报 `XLSX_DATE_OUT_OF_RANGE`）。除了区间外的数值，
 * 这一条覆盖了 Excel 1900 闰年 bug 的虚构日：序列号 `60` 名义上是 `1900-02-29`（不存在的日期），
 * 归一化后会与解码结果不符，因此按"不可表示"处理（**报错而不是猜一个日期**）。
 */
export function isoFromSerial(serial: number): string | null {
  const wholeDays = Math.floor(serial);
  const epochMs = (SERIAL_EPOCH_DAY_NUMBER + wholeDays) * MS_PER_DAY;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const parts: IsoParts = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
  return validParts(parts) ? isoFromParts(parts.year, parts.month, parts.day) : null;
}

/** 序列号是否整日（非整数 = 带时刻 → `XLSX_DATE_HAS_TIME`）。 */
export function serialHasTime(serial: number): boolean {
  return !Number.isInteger(serial);
}

/**
 * `Date` 单元格 → ISO 文本。
 *
 * `exceljs` 读回真日期时给的是**序列号换算出的绝对时刻**（`excelToDate`），
 * 因此在"写与读同一时区"的常态下，用**本地** getter 读出的年月日恰好是用户看到的日历日
 * （实测：`Date.UTC(2026,9,5)` 写出后读回为 `2026-10-05T00:00:00Z`，本地 getter 给 `2026-10-05`）。
 * 用 UTC getter 反而会在 UTC+8 的常见场景下差一天——那是本项目显式避免的失败模式。
 *
 * 已知边界：跨时区（写与读的偏移不同）时序列号对应的本地日历日可能偏移一天。
 * 这是"真日期 + 序列号"编码的固有属性，不是本实现的取舍，已写入 `PROTOCOL.md` 已知限制。
 */
export function isoFromDate(date: Date): string {
  return isoFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
