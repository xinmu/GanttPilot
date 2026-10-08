/**
 * \`@ganttpilot/engine\` 的持久化模块入口（P3/C4-c 拆成 \`persistence/\` 之后，公共面**逐符号不变**）。
 *
 * | 文件 | 职责 |
 * |---|---|
 * | \`types.ts\` | 记录形状、数值常量、失败码闭集、存储接口 |
 * | \`record.ts\` | 记录的构造（\`sessionRecordOf\`）与恢复（\`restoreSessionOf\` / \`planRestoreOf\`） |
 * | \`guards.ts\` | 记录守卫与恢复候选的解析（\`checkJournalShape\` / \`sameRecord\` / \`decodeCandidates\`） |
 * | \`policy.ts\` | 检查点保留（\`planCheckpoint\`）与触发状态机（\`policyReduce\`） |
 * | \`memory.ts\` | 内存适配器（测试 + 浏览器降级） |
 *
 * 契约出处与三条边界见 \`docs/02-adr/0009-持久化契约.md\` 与 \`PERSISTENCE.md\`（原 \`persistence.ts\` 的文件头）。
 */

export {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  CHECKPOINT_EVERY_STEPS,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_KEEP,
  PERSIST_FAILURE_CODES,
  PERSIST_RECORD_VERSION,
  QUOTA_DEGRADED_KEEP,
  type CheckpointRef,
  type PersistFailure,
  type PersistFailureCode,
  type PersistResult,
  type RecordMeta,
  type RestoreCandidates,
  type RestorePlan,
  type SnapshotStore,
  type StoredSession,
  type StoredSnapshot,
  type StoredStep,
} from './types.js';
export { planRestoreOf, restoreFromSnapshot, restoreSessionOf, sessionRecordOf } from './record.js';
export { checkJournalShape, decodeCandidates, sameRecord, type DecodedCandidates } from './guards.js';
export { createPolicyState, createRetentionPolicy, effectiveKeep, planCheckpoint, policyReduce, type CheckpointKeepPlan, type GestureActivity, type PolicyAction, type PolicyEvent, type PolicyState, type PolicyStep, type RetentionPolicy } from './policy.js';
export { createMemorySnapshotStore } from './memory.js';
