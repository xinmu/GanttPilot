/**
 * **xlsx 导入接线 + 重置为演示**（P3/C6-f 从 `App.vue` 迁出）。
 *
 * - 入口是**用户动作**，因此 925 KB 的 `exceljs` **只准动态 `import()`**（ADR 0006 §11）；
 * - 导入产物经 `document.replace` 落库（命令层唯一通道）；
 * - 问题清单进**诊断面板**（G-8 的受控收口：计数 + 可展开列表）——快照的落点是
 *   `useDiagnostics.setImportDiagnostics`；
 * - **重置**与导入是一对：两者都"换掉整份文档"，因此上一次导入的协议层诊断都必须作废
 *   （否则面板会显示别份文档的问题）。
 */

import type { ComputedRef, Ref } from 'vue';
import type { ProjectDocument } from '@ganttpilot/render-core';

import type { DispatchResult } from './useProject.js';
import type { ImportDiagnostic } from './useDiagnostics.js';

export interface UseImportArgs {
  readonly document: Ref<ProjectDocument>;
  /** 落库（命令层唯一通道）。 */
  readonly ingestDocument: (document: ProjectDocument) => DispatchResult;
  readonly scheduleError: ComputedRef<{
    readonly code: string;
    readonly message: string;
    readonly cyclePath: readonly string[];
  } | null>;
  /** 把"外部产生的成环路径"交给高亮层（`useGesture.showCyclePath`）。 */
  readonly showCyclePath: (path: readonly string[]) => void;
  /** 命令结果的应用（"受影响行 + 受影响边"的重绘在应用外壳里）。 */
  readonly applyCommandResult: (result: DispatchResult) => void;
  readonly setImportDiagnostics: (next: readonly ImportDiagnostic[]) => void;
  /** 新建一份演示口径会话（`useProject.reset()` 不带参数 = 演示口径，裁决 P-34）。 */
  readonly reset: () => void;
  readonly notify: (level: 'info' | 'error', text: string) => void;
}

export interface UseImport {
  onImportFile: (file: File) => Promise<void>;
  resetToDemo: () => void;
}

export function useImport(args: UseImportArgs): UseImport {
  async function onImportFile(file: File): Promise<void> {
    args.notify('info', `正在导入 ${file.name}…`);
    try {
      const { importXlsx } = await import('@ganttpilot/xlsx-protocol');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importXlsx(bytes);
      // 协议层诊断**必须留下来**（见 `useDiagnostics` 的文件头）——它只在导入那一刻存在。
      args.setImportDiagnostics(result.diagnostics);
      const problems = result.diagnostics.length;
      if (!result.ok) {
        args.notify('error', `导入失败：${String(problems)} 条问题 —— 详见诊断清单`);
        return;
      }
      args.applyCommandResult(args.ingestDocument(result.document));
      args.notify(
        'info',
        `已导入 ${file.name}：${String(result.document.tasks.length)} 个任务、${String(result.document.links.length)} 条依赖；问题 ${String(problems)} 条`,
      );
      // 导入的成环边已由 G3 按确定性顺序丢弃（ADR 0006 §1）——这里把"是否还有环"如实呈现：
      // 若导入产物仍不可排程，`scheduleError` 会带出 `cyclePath`，由图表层高亮。
      const failed = args.scheduleError.value;
      if (failed !== null && failed.cyclePath.length > 0) {
        args.showCyclePath(failed.cyclePath);
        args.notify('error', `导入产物仍不可排程：${failed.message}`);
      }
    } catch (error) {
      args.notify('error', `导入出错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function resetToDemo(): void {
    args.reset();
    // 重置会换掉整份文档：上一次导入的协议层诊断随之作废（否则面板会显示别份文档的问题）。
    args.setImportDiagnostics([]);
    // 数字一律从**实际文档**派生：写死的"1,000 任务 / 1,500 依赖"在演示口径变更后立刻变成假话。
    args.notify(
      'info',
      `已重置为演示计划：${String(args.document.value.tasks.length)} 个任务 / ${String(args.document.value.links.length)} 条依赖`,
    );
  }

  return { onImportFile, resetToDemo };
}
