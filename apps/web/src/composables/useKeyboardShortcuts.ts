/**
 * **键盘快捷键**（P3/C6-f 从 `App.vue` 迁出）：`Esc` 取消手势、`Ctrl+Z` / `Ctrl+Y`（`Ctrl+Shift+Z` 等价）撤销重做。
 *
 * ## 编辑态优先
 *
 * 左表单元格正在编辑时（焦点在 `input` / `textarea` 上）把快捷键让给输入框的**原生撤销**——
 * 否则用户想撤掉刚敲的字，结果整份文档回退了一步（ADR 0008 §10）。
 *
 * 监听登记在本模块（`onMounted` / `onUnmounted` 配对），调用方不再手写两处。
 */

import { onMounted, onUnmounted } from 'vue';

export interface UseKeyboardShortcutsArgs {
  readonly undo: () => void;
  readonly redo: () => void;
  /** 取消进行中的手势（`useGesture.cancel`）。 */
  readonly cancel: () => void;
}

export interface UseKeyboardShortcuts {
  onKeyDown: (event: KeyboardEvent) => void;
}

export function useKeyboardShortcuts(args: UseKeyboardShortcutsArgs): UseKeyboardShortcuts {
  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    const editing =
      target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (event.key === 'Escape') {
      args.cancel();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && editing) return;
    if (key === 'z' && event.shiftKey) {
      event.preventDefault();
      args.redo();
      return;
    }
    if (key === 'z') {
      event.preventDefault();
      args.undo();
      return;
    }
    if (key === 'y') {
      event.preventDefault();
      args.redo();
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown);
  });
  onUnmounted(() => {
    window.removeEventListener('keydown', onKeyDown);
  });

  return { onKeyDown };
}
