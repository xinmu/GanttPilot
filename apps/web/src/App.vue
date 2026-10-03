<script setup lang="ts">
/**
 * G0 骨架页：只证明「应用可构建、Vue 工具链可用」。
 * 甘特渲染、虚拟滚动与裁剪策略在 G4 落地，交互与撤销在 G5 落地。
 */
const plan = [
  { gate: 'G1', label: '数据模型、命令层与日历语义' },
  { gate: 'G2', label: '最小正向传播内核' },
  { gate: 'G3', label: 'xlsx 导入 / 导出（仅可见列）' },
  { gate: 'G4', label: '纯 SVG 甘特渲染（含裁剪）' },
  { gate: 'G5', label: '编辑体验：拖拽三语义 + 撤销重做' },
  { gate: 'G6', label: '持久化：自动保存 + 命令回退栈' },
  { gate: 'G7', label: '导出：SVG → PNG → PPTX 模板 A' },
];
</script>

<template>
  <main class="shell">
    <h1>GanttPilot</h1>
    <p class="tagline">
      Excel 计划 → 排程引擎 → 原生可编辑 PPTX
    </p>
    <p class="status">
      当前为 <strong>G0</strong> 骨架：仓库结构与质量护栏已就位，尚无产品能力。渲染能力见 G4。
    </p>
    <ol class="plan">
      <li
        v-for="item in plan"
        :key="item.gate"
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
</style>
