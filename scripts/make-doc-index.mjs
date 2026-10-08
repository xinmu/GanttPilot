#!/usr/bin/env node
/**
 * 生成 `docs/01-roadmap/首版-文档索引.md`：文档集合、角色、体量与台账统计的快照。
 *
 * 为什么要有它：会话之间交接、以及把上下文注入新会话时，只需要这份索引 +
 * `docs/README.md` + `docs/00-baseline/裁决记录.md` 三份，不必整读 200 KB 的存档。
 * **本文件是生成物**（`doc-index.json` 的 `generated: true` 登记了它），不手写、不含时间戳
 * （重跑应逐字节一致）。
 *
 * P3/C7-i 起渲染逻辑搬进 `doc-artifacts.mjs`（**纯函数**）⇒ `check-docs.mjs` 能"就地重算一遍
 * 再与盘上的文件逐字节比对"（登记项 `N10` 的第二条修法）；本文件只剩"写盘 + 一行日志"。
 *
 * P3/C8-d 起**迭代到不动点**：这份生成物是**自指**的——它的「合计」与它自己那一行都按**盘上**的体量算，
 * 而它自己也在被索引之列 ⇒ 写下去会改变下一轮读到的数。实测（`tmp/c8d-probe.mjs`）：新增一份文档后
 * **跑一次**得到的仍是陈旧件（合计 `2059.6` vs 重算 `2059.7`、自己那一行 `14.5` vs `14.6 KB`），
 * 而 `docs:check` 会照实判红"与来源不一致（陈旧）"——即"照它说的跑一遍 `pnpm docs:index`"**并不够**。
 * 现在：写到"盘上内容 == 就地重算"为止（通常 2 轮），超过上界就**响亮地失败**，不留一个"看起来跑过了"的陈旧件。
 * （`make-round-index.mjs` **自身**不需要这套：它的输入是 `裁决R*.md` 的扫盘结果，不含任何体量 ⇒ 无自指。
 * **但两者有单向依赖**（P5-c2）：本索引的输入**包含 `轮次导读.md` 的体量** ⇒ `pnpm docs:index` 里
 * 本脚本必须排在 `make-round-index.mjs` **之后**，否则轮次导读写完的瞬间本索引就陈旧了。见 `package.json`。）
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DOC_INDEX_TARGET, renderDocIndex } from './doc-artifacts.mjs';
import { repoRoot } from './paths.mjs';

/** 自指收敛的上界：实测 2 轮，留到 5 轮足够；不收敛就是 totalKb 的算法出了问题。 */
const MAX_PASSES = 5;
const absolute = join(repoRoot, DOC_INDEX_TARGET);

let rendered = renderDocIndex();
let text = rendered.text;
writeFileSync(absolute, text, 'utf8');
let passes = 1;
let next = renderDocIndex().text;
while (next !== text) {
  if (passes >= MAX_PASSES) {
    console.error(
      `[docs] ${DOC_INDEX_TARGET} 在 ${String(MAX_PASSES)} 轮内没有收敛（生成物自指：` +
        '「合计」与它自己那一行都含它自己的体量，见 doc-artifacts.mjs 的 renderDocIndex）——请检查 totalKb 的算法',
    );
    process.exit(1);
  }
  text = next;
  writeFileSync(absolute, text, 'utf8');
  passes += 1;
  next = renderDocIndex().text;
}

console.log(
  `[docs] 已刷新 ${DOC_INDEX_TARGET}（${String(rendered.docCount)} 份文档 / ${rendered.totalKb.toFixed(1)} KB / 未决 ${String(rendered.pendingCount)} 条；${String(passes)} 轮收敛）`,
);
