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
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DOC_INDEX_TARGET, renderDocIndex } from './doc-artifacts.mjs';
import { repoRoot } from './paths.mjs';

const rendered = renderDocIndex();
writeFileSync(join(repoRoot, DOC_INDEX_TARGET), rendered.text, 'utf8');
console.log(
  `[docs] 已刷新 ${DOC_INDEX_TARGET}（${String(rendered.docCount)} 份文档 / ${rendered.totalKb.toFixed(1)} KB / 未决 ${String(rendered.pendingCount)} 条）`,
);
