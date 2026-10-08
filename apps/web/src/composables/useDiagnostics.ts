/**
 * **诊断清单**（P3/C6-f 从 `App.vue` 迁出）：三层拼接 + 面板开关 + 冲突行集合。
 *
 * ## 三层为什么必须拼在一处
 *
 * ADR 0006 §7 的三层各有各的寿命：
 * - **协议层**（`XLSX_*`）：只在**导入那一刻**存在 ⇒ 必须由 `setImportDiagnostics` 存快照；
 * - **文档校验层** / **排程层**：**每帧重算**（`useProject` 的 computed）。
 *
 * G5 出口条件⑤要求"导入的成环边进问题清单"。此前应用层只把**条数**写进提示、没有保留数组，
 * 于是 `XLSX_CYCLE_EDGE_DROPPED` 从未进过面板（P-22 由第 13 条的记录制导入当场抓出）——
 * 因此"存快照"这件事必须有唯一的落点，就是这里。
 *
 * 类型写成**结构子集**而不是 `import type { XlsxDiagnostic }`：对协议包的静态 import 会在
 * 类型图上造出指向 `exceljs` 的边（ADR 0008 §1 的候选 B 正是因此被否），而本层只消费四个字段。
 */

import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import {
  type DocumentDiagnostic,
  type ScheduleDiagnostic,
} from '@ganttpilot/render-core';

import { conflictTaskIdsOf } from './useGesture.js';

/** 协议层诊断的**结构子集**（只消费这四个字段；见文件头的类型说明）。 */
export interface ImportDiagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: string;
  readonly message: string;
  readonly taskId?: string;
}

export interface UseDiagnosticsArgs {
  readonly documentDiagnostics: ComputedRef<readonly DocumentDiagnostic[]>;
  readonly scheduleDiagnostics: ComputedRef<readonly ScheduleDiagnostic[]>;
}

export interface UseDiagnostics {
  /** 协议层诊断（**导入那一刻的快照**）；由 `useImport` 在导入后写入。 */
  readonly importDiagnostics: ShallowRef<readonly ImportDiagnostic[]>;
  setImportDiagnostics: (next: readonly ImportDiagnostic[]) => void;
  /** 全部诊断（**三层拼接**；ADR 0006 §7）。 */
  readonly diagnostics: ComputedRef<
    readonly (ImportDiagnostic | DocumentDiagnostic | ScheduleDiagnostic)[]
  >;
  readonly diagnosticCount: ComputedRef<number>;
  /** 诊断清单是否展开（G-8 的**受控收口**：计数 + 可展开列表；完整向导形态归后续）。 */
  readonly open: Ref<boolean>;
  toggleOpen: () => void;
  /**
   * `anchorConflict` 的行（**判据来自引擎**，ADR 0008 §6）——冲突标红的唯一来源。
   *
   * 过滤器本体在 `useGesture.ts` 的 `conflictTaskIdsOf`（P3/C6-e）：它与"哪个码、哪个字段是
   * 任务 id"这条知识绑定，散成两份就会**静默漂**（引擎改码之后不报错，只是不再标红）。
   */
  readonly conflictTaskIds: ComputedRef<readonly string[]>;
}

export function useDiagnostics(args: UseDiagnosticsArgs): UseDiagnostics {
  const importDiagnostics = shallowRef<readonly ImportDiagnostic[]>([]);
  const open = ref(false);

  const diagnostics = computed(() => [
    ...importDiagnostics.value,
    ...args.documentDiagnostics.value,
    ...args.scheduleDiagnostics.value,
  ]);
  const diagnosticCount = computed(() => diagnostics.value.length);
  const conflictTaskIds = computed(() => conflictTaskIdsOf(args.scheduleDiagnostics.value));

  function setImportDiagnostics(next: readonly ImportDiagnostic[]): void {
    importDiagnostics.value = next;
  }

  function toggleOpen(): void {
    open.value = !open.value;
  }

  return {
    importDiagnostics,
    setImportDiagnostics,
    diagnostics,
    diagnosticCount,
    open,
    toggleOpen,
    conflictTaskIds,
  };
}
