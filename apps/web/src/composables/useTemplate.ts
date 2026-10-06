/**
 * **模板下载接线**（P-46 新增；ADR 0006 附录 §1 的多页签形态）。
 *
 * ## 分工（与 `useExport` 同一姿势）
 *
 * - **字节**来自 `@ganttpilot/xlsx-protocol` 的纯函数 `buildTemplateXlsx`（零 DOM、进门禁）；
 *   本文件**不拼 workbook**——列契约（`COLUMN_SPECS`）与容差只有一份真相源，
 *   应用层手搓工作表会当场造出第二份；
 * - **DOM 只在这里**：动态 `import()` + `Blob` + `<a download>`。
 *
 * ## 两条纪律
 *
 * 1. **动态 `import()`**：`xlsx-protocol` 背后是 925 KB 的 `exceljs`（ADR 0006 §11）
 *    ⇒ 不进首屏主 chunk；
 * 2. **仓库内不放 `.xlsx` 二进制**（P-46 §5）：模板**运行时生成**，避免"二进制与协议分叉"。
 */

import { ref, type Ref } from 'vue';

/** {@link useTemplate} 的入参。 */
export interface UseTemplateArgs {
  /** 提示通道（沿用既有 `notice`，P-30/P-31 的落点）。 */
  readonly notify: (level: 'info' | 'error', text: string) => void;
}

/** 模板下载控制器（App.vue 只消费它）。 */
export interface TemplateController {
  readonly busy: Ref<boolean>;
  downloadTemplate: () => Promise<void>;
}

/** 文件名（固定：模板是**版本化产物**，不做时间戳后缀——那会让同一份产物出现多个名字）。 */
export const TEMPLATE_FILENAME = 'GanttPilot-导入模板.xlsx';

/** 模板下载接线（见文件头）。 */
export function useTemplate(args: UseTemplateArgs): TemplateController {
  const busy = ref(false);

  async function downloadTemplate(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    try {
      // 用户动作才触发：`exceljs` 因此不进首屏主 chunk（ADR 0006 §11 的同一条纪律）。
      const { buildTemplateXlsx } = await import('@ganttpilot/xlsx-protocol');
      const result = await buildTemplateXlsx();
      if (!result.ok) {
        const first = result.diagnostics[0];
        args.notify(
          'error',
          `模板生成失败：${first === undefined ? '未知原因' : `${first.code} —— ${first.message}`}（EXPORT_TEMPLATE_FAILED）`,
        );
        return;
      }
      const blob = new Blob([result.bytes as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = TEMPLATE_FILENAME;
      anchor.style.display = 'none';
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // 立刻回收会把还在走的下载打断，给一个宏任务窗口（与 `useExport` 同口径）。
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 0);
      args.notify('info', `已下载导入模板（三个页签：任务 / 填写说明与约束 / 最小示例）`);
    } catch (error) {
      args.notify('error', `模板下载失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.value = false;
    }
  }

  return { busy, downloadTemplate };
}
