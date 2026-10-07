/**
 * **内存适配器**（P3/C4-c 从 \`persistence.ts\` 拆出）：Node 侧测试与浏览器**降级路径**共用同一实现。
 *
 * 两条纪律：写入**深拷贝后冻结**；**多标签互斥写保护只在这一条降级路径上成立**
 * （IndexedDB 路径不做，见 \`PERSISTENCE.md\` 的不变量 ④）。
 */

import { cloneJsonValue } from '../journal.js';
import { failure, type SnapshotStore, type StoredSession, type StoredSnapshot } from './types.js';

// ---------------------------------------------------------------- 内存适配器

/**
 * 内存适配器（**测试与浏览器降级共用同一实现**）。
 *
 * 两条纪律：
 * - 写入**深拷贝后冻结**：读出来的记录与写进去的对象零共享引用（否则测试里
 *   "改一下再读"会假绿）；
 * - **多标签防护只在这一条降级路径上成立**：已有记录的 `writerId` 与本次不同、且**更新**
 *   （`existing.updatedAtMs > record.updatedAtMs`）时拒绝本次写入。**IndexedDB 路径暂不做
 *   互斥写保护**（`apps/web` 的 `saveLatest` 是裸 `put`，`PERSIST_BLOCKED_BY_OTHER_TAB`
 *   在正常浏览器路径不可达）——这是**已登记**的差异，归 v0.5 实现，见 `PERSISTENCE.md`
 *   的「多标签与已知限制」一节。
 */
export function createMemorySnapshotStore(): SnapshotStore {
  const latest = new Map<string, StoredSession>();
  const checkpoints = new Map<string, StoredSnapshot[]>();
  let nextId = 1;

  const writerConflict = (record: StoredSession, existing: StoredSession | undefined): boolean =>
    existing !== undefined &&
    existing.writerId !== record.writerId &&
    existing.updatedAtMs > record.updatedAtMs;

  return {
    loadLatest(docId) {
      const found = latest.get(docId);
      return Promise.resolve({ ok: true, value: found === undefined ? null : cloneJsonValue(found) });
    },
    saveLatest(record) {
      const existing = latest.get(record.docId);
      if (writerConflict(record, existing)) {
        return Promise.resolve(
          failure(
            'PERSIST_BLOCKED_BY_OTHER_TAB',
            `另一个标签页（${existing?.writerId ?? '?'}）在 ${String(existing?.updatedAtMs ?? 0)} 更新过这份文档；本标签页已停止写入`,
          ),
        );
      }
      latest.set(record.docId, cloneJsonValue(record));
      return Promise.resolve({ ok: true, value: undefined });
    },
    loadCheckpoints(docId) {
      return Promise.resolve({
        ok: true,
        value: (checkpoints.get(docId) ?? []).map((item) => cloneJsonValue(item)),
      });
    },
    saveCheckpoint(snapshot) {
      const list = checkpoints.get(snapshot.docId) ?? [];
      const stored: StoredSnapshot = { ...cloneJsonValue(snapshot), id: nextId };
      nextId += 1;
      checkpoints.set(snapshot.docId, [...list, stored]);
      return Promise.resolve({ ok: true, value: undefined });
    },
    deleteCheckpoints(refs) {
      for (const ref of refs) {
        const list = checkpoints.get(ref.docId) ?? [];
        checkpoints.set(
          ref.docId,
          list.filter((item) => item.id !== ref.id),
        );
      }
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
}


