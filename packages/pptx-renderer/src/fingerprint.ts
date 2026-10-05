/**
 * 产物指纹与逐条目比对（golden 判据的载体，ADR 0010 §9）。
 *
 * ## 为什么这里**不用** `node:crypto`
 *
 * 本包是**计算层**（零 DOM、零框架），而且要同时跑在 Node（spec / golden）与浏览器（导出）里：
 * 引入 `node:crypto` 会让构建期的 `types: []` 直接失败，也会让浏览器打包多一个 polyfill。
 * 因此这里只用**纯 TS 的 CRC-32**：
 *
 * - 判"两份产物是否逐字节相等"用 {@link bytesEqual}（**不需要哈希**，逐字节比较就是最强判据）；
 * - 需要"是哪个部件变了"时用 {@link entryDigests}（CRC-32 足够定位；它不用于宣称密码学强度）。
 *
 * 需要 sha256 作**证据**的场合（`apps/web/evidence/*`、记录制脚本）在 Node 侧算——
 * 证据层用强哈希，产品代码不引入平台依赖。
 */

import JSZip from 'jszip';

/** 一个 zip 条目的摘要（CRC-32 + 尺寸 + 日期）。 */
export interface EntryDigest {
  readonly name: string;
  /** CRC-32（十六进制，8 位）。 */
  readonly crc32: string;
  readonly size: number;
  readonly dateIso: string;
}

/** 两份字节是否逐字节相等（golden 的**最强**判据：不做哈希，直接比）。 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** CRC-32（IEEE 802.3，反射多项式 0xEDB88320）；表在首次调用时构建。 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb8_8320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 一段字节的 CRC-32（十六进制，8 位小写）。 */
export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffff_ffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    crc = ((crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, '0');
}

/** 逐条目摘要（**按条目名排序**，故可直接逐项比较）。 */
export async function entryDigests(bytes: Uint8Array): Promise<readonly EntryDigest[]> {
  const zip = await JSZip.loadAsync(bytes);
  const out: EntryDigest[] = [];
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    if (entry === undefined || entry.dir) continue;
    const buffer = await entry.async('uint8array');
    out.push({ name, crc32: crc32Hex(buffer), size: buffer.length, dateIso: entry.date.toISOString() });
  }
  return out;
}

/** 一条差异（定位"哪一项不稳定"）。 */
export interface EntryDiff {
  readonly name: string;
  readonly kind: 'only-left' | 'only-right' | 'content' | 'date';
  readonly left: string;
  readonly right: string;
}

/**
 * 逐条目 diff：先比内容（CRC + 尺寸），再比日期。
 *
 * 归一化之后应当**空数组**；非空时它就是"golden 失败在哪一项"的答案
 * （S7-c 靠它定位到"19 个 zip 时间戳 + core.xml 内容"这 20 项）。
 */
export function diffDigests(
  left: readonly EntryDigest[],
  right: readonly EntryDigest[],
): readonly EntryDiff[] {
  const byName = new Map(right.map((entry) => [entry.name, entry]));
  const diffs: EntryDiff[] = [];
  for (const entry of left) {
    const other = byName.get(entry.name);
    if (other === undefined) {
      diffs.push({ name: entry.name, kind: 'only-left', left: entry.crc32, right: '(缺失)' });
      continue;
    }
    byName.delete(entry.name);
    if (entry.crc32 !== other.crc32 || entry.size !== other.size) {
      diffs.push({ name: entry.name, kind: 'content', left: `${entry.crc32}/${String(entry.size)}`, right: `${other.crc32}/${String(other.size)}` });
    } else if (entry.dateIso !== other.dateIso) {
      diffs.push({ name: entry.name, kind: 'date', left: entry.dateIso, right: other.dateIso });
    }
  }
  for (const rest of byName.values()) {
    diffs.push({ name: rest.name, kind: 'only-right', left: '(缺失)', right: rest.crc32 });
  }
  return diffs;
}
