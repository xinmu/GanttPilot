/**
 * IndexedDB 适配器（G6 的**唯一**浏览器存储实现；形状见 ADR 0009 §5）。
 *
 * ## 为什么它住 `apps/web` 而不是 `packages/engine`
 *
 * 引擎包的铁律是**不得访问 DOM 全局**（`lint-boundary/dom-globals.fixture.ts` 以可执行检查守着）。
 * `indexedDB` 是 DOM 全局，因此驱动只能住应用层；
 * 判据住在引擎侧的 `SnapshotStore` 接口与内存适配器上——**Node 门禁测的是记录形状与策略，
 * IDB 的字节行为只在浏览器侧可测**（记录制，ADR 0009 §5）。
 *
 * ## 三条口径
 *
 * 1. **失败是结构化码，不是异常**：`QuotaExceededError` 要降级 + 提示（配额溢出是用户级事件），
 *    `blocked`（另一个标签页占着升级）与"没有 IDB"都映射到闭集里的码；
 * 2. **读出来的记录一定过形状守卫**（`decodeCandidates`）——库里的东西可能是旧版本写的；
 * 3. **不缓存任何东西**：一次写只有一条记录，开事务的开销远小于序列化开销。
 */

import {
  createMemorySnapshotStore,
  type PersistFailureCode,
  type PersistResult,
  type SnapshotStore,
  type StoredSession,
  type StoredSnapshot,
} from '@ganttpilot/engine';

/** 库名与版本（改形状必须同时改版本 + 迁移；见 ADR 0009 §明确不做）。 */
const DB_NAME = 'GanttPilotPersistence';
const DB_VERSION = 1;
const SNAPSHOTS = 'snapshots';
const SESSIONS = 'sessions';

function failure<T>(code: PersistFailureCode, message: string): PersistResult<T> {
  return { ok: false, code, message };
}

/** 把浏览器抛出的错误归一到闭集里的码（**唯一**一处做这个判断）。 */
function classify(error: unknown): { code: PersistFailureCode; message: string } {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return { code: 'PERSIST_QUOTA_EXCEEDED', message };
  }
  if (error instanceof Error && (error.name === 'InvalidStateError' || error.name === 'SecurityError')) {
    return { code: 'PERSIST_UNAVAILABLE', message };
  }
  return { code: 'PERSIST_WRITE_FAILED', message };
}

/** 浏览器是否提供可用的 IndexedDB（隐私模式 / 策略禁用时可能没有）。 */
export function isIdbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** 打开（并按需建）数据库。 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        const store = db.createObjectStore(SNAPSHOTS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('docId', 'docId', { unique: false });
      }
      if (!db.objectStoreNames.contains(SESSIONS)) {
        db.createObjectStore(SESSIONS, { keyPath: 'docId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open 失败'));
    request.onblocked = () => reject(new Error('数据库升级被另一个标签页阻塞'));
  });
}

/** 一个请求的 Promise 化（读路径用它：`get`/`getAll` 在两种源上都有）。 */
function runRequest<T>(
  source: IDBObjectStore | IDBIndex,
  action: (source: IDBObjectStore | IDBIndex) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = action(source);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 同上，但**限定对象存储**（`put`/`add`/`delete` 只存在于 `IDBObjectStore` 上）。 */
function runStoreRequest<T>(
  store: IDBObjectStore,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return runRequest<T>(store, (source) => action(source as IDBObjectStore));
}

/**
 * 建 IndexedDB 版 `SnapshotStore`。
 *
 * 第一次写入时才真正建库（`openDatabase` 在每次操作内部调用，由浏览器缓存连接）——
 * 这样"用户只看了一眼没编辑"的会话不会在磁盘上留下任何东西。
 */
export function createIdbSnapshotStore(): SnapshotStore {
  async function withStore<T>(
    name: string,
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => Promise<T>,
  ): Promise<PersistResult<T>> {
    if (!isIdbAvailable()) {
      return failure('PERSIST_UNAVAILABLE', '这个环境没有可用的 IndexedDB（隐私模式或策略禁用）');
    }
    try {
      const db = await openDatabase();
      const transaction = db.transaction(name, mode);
      const result = await action(transaction.objectStore(name));
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('事务失败'));
        transaction.onabort = () => reject(transaction.error ?? new Error('事务被中止'));
      });
      db.close();
      return { ok: true, value: result };
    } catch (error) {
      const classified = classify(error);
      return failure(classified.code, classified.message);
    }
  }

  return {
    loadLatest: (docId) =>
      withStore<StoredSession | null>(SESSIONS, 'readonly', async (store) => {
        const found = await runRequest<StoredSession | undefined>(store, (target) => target.get(docId));
        return found ?? null;
      }),

    saveLatest: (record) =>
      withStore<void>(SESSIONS, 'readwrite', async (store) => {
        await runStoreRequest(store, (target) => target.put(record));
      }),

    loadCheckpoints: (docId) =>
      withStore<readonly StoredSnapshot[]>(SNAPSHOTS, 'readonly', async (store) => {
        const index = store.index('docId');
        const found = await runRequest<StoredSnapshot[]>(index, (target) =>
          (target as IDBIndex).getAll(docId) as IDBRequest<StoredSnapshot[]>,
        );
        return found;
      }),

    saveCheckpoint: (snapshot) =>
      withStore<void>(SNAPSHOTS, 'readwrite', async (store) => {
        await runStoreRequest(store, (target) => target.add(snapshot));
      }),

    deleteCheckpoints: (refs) =>
      withStore<void>(SNAPSHOTS, 'readwrite', async (store) => {
        for (const ref of refs) {
          await runStoreRequest(store, (target) => target.delete(ref.id));
        }
      }),
  };
}

/**
 * 选存储：有 IndexedDB 用它，否则**降级为内存适配器**（会话内行为不变）+ 如实报告。
 *
 * 返回 `degraded: true` 时调用方要提示"本次会话不自动保存"——提示的口径由 `usePersistence` 决定，
 * 本函数只回答"用哪个实现"。
 */
export function createSnapshotStore(): { store: SnapshotStore; degraded: boolean } {
  if (isIdbAvailable()) {
    return { store: createIdbSnapshotStore(), degraded: false };
  }
  return { store: createMemorySnapshotStore(), degraded: true };
}
