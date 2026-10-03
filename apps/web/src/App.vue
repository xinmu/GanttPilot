<script setup lang="ts">
/**
 * 状态骨架页：只证明「应用可构建、Vue 工具链可用」。
 * 甘特渲染、虚拟滚动与裁剪策略在 G4 落地（契约见 docs/02-adr/0007-渲染几何与裁剪契约.md），
 * 交互与撤销在 G5 落地。
 */
const plan = [
  { gate: 'G1.1', label: '日历与日期算术（工作日序号化）', done: true },
  { gate: 'G1.2', label: '文档 schema、版本迁移与 WBS 层级', done: true },
  { gate: 'G1.3', label: '命令层与事务（before 镜像逆操作）', done: true },
  { gate: 'G2', label: '最小正向传播内核', done: true },
  { gate: 'G3', label: 'xlsx 导入 / 导出（仅可见列）', done: true },
  { gate: 'G4', label: '纯 SVG 甘特渲染（含裁剪）', done: false },
  { gate: 'G5', label: '编辑体验：拖拽三语义 + 撤销重做', done: false },
  { gate: 'G6', label: '持久化：自动保存 + 命令回退栈', done: false },
  { gate: 'G7', label: '导出：SVG → PNG → PPTX 模板 A', done: false },
];
</script>

<template>
  <main class="shell">
    <h1>GanttPilot</h1>
    <p class="tagline">
      Excel 计划 → 排程引擎 → 原生可编辑 PPTX
    </p>
    <p class="status">
      <strong>G0</strong>（骨架与门禁护栏）、<strong>G1.1</strong>（日历与日期算术，工作日序号化）、
      <strong>G1.2</strong>（文档 schema、版本迁移与 WBS 层级）、
      <strong>G1.3</strong>（命令层与事务：唯一变更通道 + before 镜像 + 撤销/重做栈）、
      <strong>G2</strong>（最小正向传播内核）与 <strong>G3</strong>（xlsx 导入 / 导出，仅可见列）
      均已完成——<strong>「Excel 导入 → 排程」在协议层已跑通</strong>；
      尚无产品界面。下一步是 <strong>G4</strong>（纯 SVG 甘特渲染，含裁剪）：
      几何真相源与包边界、时间轴与 x 坐标、裁剪契约已在 <strong>ADR 0007</strong> 冻结，
      数值由 <strong>G4-S</strong> 准入定标实验回填。
    </p>
    <ol class="plan">
      <li
        v-for="item in plan"
        :key="item.gate"
        :class="{ done: item.done }"
      >
        <span class="gate">{{ item.gate }}</span>
        <span>{{ item.label }}</span>
      </li>
    </ol>
  </main>
</template>

<style scoped>
.shell {
  max-width: 44rem;
  margin: 4rem auto;
  padding: 0 1.5rem;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #1f2933;
}

h1 {
  margin: 0;
  font-size: 2rem;
}

.tagline {
  margin: 0.25rem 0 1.5rem;
  color: #52606d;
}

.status {
  padding: 0.75rem 1rem;
  border-left: 3px solid #3d7ea6;
  background: #f0f4f8;
}

.plan {
  padding-left: 1.25rem;
  line-height: 1.9;
}

.gate {
  display: inline-block;
  min-width: 2.25rem;
  margin-right: 0.5rem;
  font-weight: 600;
  color: #3d7ea6;
}

.done {
  color: #52606d;
}

.done::marker {
  color: #2f9e63;
}
</style>
