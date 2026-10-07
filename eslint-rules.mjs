/**
 * 「零框架依赖 / 零 DOM 依赖」铁律与**计算层依赖方向**的**单一定义处**。
 *
 * 这里既被 `eslint.config.mjs` 引用（真正拦住违规），也被
 * `packages/engine/src/boundary.spec.ts`（护栏自检）与 `packages/render-core/src/boundary.spec.ts` 引用。
 * 之所以单独成文件：让断言用的是配置**本身**，而不是在测试里抄一份副本——
 * 否则改了 `eslint.config.mjs` 而测试仍对着副本断言，护栏就会假绿。
 */

/** 禁止被计算层 import 的框架（铁律 1）。 */
export const FORBIDDEN_FRAMEWORKS = ['vue', 'vue/*', 'react', 'react-dom', 'svelte', '@vue/*'];

/** 禁止被计算层直接使用的 DOM / 浏览器全局（铁律 1 的另一半）。 */
export const FORBIDDEN_DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'fetch',
  'XMLHttpRequest',
  'alert',
  'requestAnimationFrame',
  'HTMLElement',
  'Event',
  'Node',
];

/** 三包铁律的报错文案片段（测试据此断言「命中的确实是铁律」而不是别的规则）。 */
export const FRAMEWORK_RULE_MESSAGE = '零框架依赖铁律';
export const DOM_RULE_MESSAGE = '零 DOM 依赖铁律';

/** 违规夹具的路径模式：被 `pnpm lint` 忽略，只由护栏自检以文本方式加载。 */
export const LINT_FIXTURE_PATTERN = '**/lint-boundary/*.fixture.ts';

/** 被 ESLint 全局忽略的构建产物与生成物。 */
export const LINT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.vitest-reports/**',
  // 本地临时/草稿目录（`.gitignore` 同样排除它）：审计探针、差分中间产物、评估材料。
  // 它不进产物、也不作为交付物，让 lint 覆盖它只会把一次性脚本的噪声变成"门禁失败"，
  // 从而诱导 `git push --no-verify`——那才是真正的风险。
  '**/tmp/**',
  // 类型声明文件由 tsc 校验，不由 ESLint 解析
  '**/*.d.ts',
  '**/*.d.mts',
  LINT_FIXTURE_PATTERN,
];

/**
 * 框架依赖的受限**模式**（`no-restricted-imports` 的 `patterns` 项）。
 *
 * 这里刻意用 `patterns` 而不是 `paths`：`paths` 只按**字面名称**全等匹配，
 * 于是 `vue/*`、`@vue/*` 这两条声明此前**是空转的**——`import 'vue/dist/vue.esm-bundler.js'`
 * 三道门全绿（P3/C7-a 实测）。改成语义等价的 glob 组后，子路径导入同样被拦下
 * （`FORBIDDEN_FRAMEWORKS` 的取值与文案一字未改，只是它终于真的生效了）。
 */
const FRAMEWORK_RESTRICTION = {
  group: FORBIDDEN_FRAMEWORKS,
  message:
    `计算层禁止 import 框架（${FRAMEWORK_RULE_MESSAGE}）。框架与 DOM 只允许出现在 apps/web，` +
    '引擎/协议/导出三包必须是可独立测试的纯 TS。',
};

/**
 * 计算层各包的**依赖方向契约**（P3/C7-a）。
 *
 * ## 为什么需要显式的许可清单
 *
 * ADR 0008 §1 把方向冻结成 `engine ← render-core ← xlsx-protocol`，§3 又要求它"不靠人记"，
 * 但落下的只是一份**文本扫描**（`render-core/src/boundary.spec.ts` 断言本包不出现
 * `@ganttpilot/xlsx-protocol`），而 `no-restricted-imports` **从不禁止工作区依赖**：
 * 在 `packages/engine` 里写 `import ... from '@ganttpilot/render-core'`，
 * `pnpm lint` 全绿、构建也照过（P3/C7-a 实测）。"engine 不得依赖 render-core"因此仍是口头约定。
 *
 * 这里把方向图落成**可执行的许可清单**：
 *
 * - `allowed` = 该包**允许** import 的工作区包（其余一律报错，含子路径导入）；
 * - 本清单是**契约**，各包 `package.json` 是**事实**；`boundary.spec.ts` 断言「事实 ⊆ 契约」，
 *   并且断言 `packages/` 下的每个目录都已登记——**加一条跨包依赖必须两处都动**（评审看得见），
 *   而"顺手 import 一个没声明的包"会在两步里各被拦一次。
 *
 * 与 `LINT_IGNORES` 的 `paths`-式硬编码不同，这里每一项都是一条**方向裁决**，故写死而不推导：
 * 若允许集合从 package.json 推导，"把 render-core 加进 engine 的 dependencies 再 import"
 * 就会自动合法——那正是本规则要拦的那一步。
 */
export const CALCULATION_LAYER_PACKAGES = [
  {
    name: '@ganttpilot/engine',
    dir: 'packages/engine',
    allowed: [],
    note: '排程/文档/命令内核：计算层的最底层，不依赖任何工作区包',
  },
  {
    name: '@ganttpilot/render-core',
    dir: 'packages/render-core',
    allowed: ['@ganttpilot/engine'],
    note: '列身份 + 几何 + 日期文本：只依赖 engine（ADR 0008 §1）',
  },
  {
    name: '@ganttpilot/xlsx-protocol',
    dir: 'packages/xlsx-protocol',
    allowed: ['@ganttpilot/engine', '@ganttpilot/render-core'],
    note: '字节流 ↔ 文档（exceljs 只在这一层）：依赖 engine 与 render-core，反向不成立',
  },
  {
    name: '@ganttpilot/pptx-renderer',
    dir: 'packages/pptx-renderer',
    allowed: ['@ganttpilot/engine', '@ganttpilot/render-core'],
    note: 'PPTX 形状与 OOXML 补丁：只依赖 render-core（engine 仅 `import type`）；不碰 xlsx-protocol——那会把 exceljs 牵进导出链',
  },
];

/** 依赖方向的报错文案片段（自检据此断言「命中的确实是方向契约」而不是别的规则）。 */
export const WORKSPACE_DEPENDENCY_RULE_MESSAGE = '计算层依赖方向';

/** 按包名取契约条目（未登记即抛：宁可炸在配置层，也不要静默放过一个包）。 */
export function calculationLayerPackage(name) {
  const entry = CALCULATION_LAYER_PACKAGES.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`未登记的计算层包：${String(name)}（见 eslint-rules.mjs 的 CALCULATION_LAYER_PACKAGES）`);
  }
  return entry;
}

/** 某包**不许** import 的工作区包。 */
export function forbiddenWorkspacePackagesFor(name) {
  const entry = calculationLayerPackage(name);
  return CALCULATION_LAYER_PACKAGES.filter(
    (candidate) => candidate.name !== entry.name && !entry.allowed.includes(candidate.name),
  );
}

/**
 * 某包的 `no-restricted-imports` **完整取值**：框架（铁律 1）+ 方向契约。
 *
 * 之所以返回完整值而不是"只加一条"：flat config 里同一规则的**后一块整体覆盖前一块**，
 * 增量式写法会让先前的框架限制静默失效。
 */
export function restrictedImportsFor(name) {
  const entry = calculationLayerPackage(name);
  return [
    'error',
    {
      patterns: [
        FRAMEWORK_RESTRICTION,
        ...forbiddenWorkspacePackagesFor(name).map((forbidden) => ({
          // 子路径导入（如 `@ganttpilot/render-core/align`）同样算依赖，故两条 glob 一起给。
          group: [forbidden.name, `${forbidden.name}/*`],
          message:
            `计算层依赖方向：${entry.name} 不得 import ${forbidden.name}（${entry.note}）。` +
            '许可清单是契约，见 eslint-rules.mjs 的 CALCULATION_LAYER_PACKAGES；' +
            '要改方向须一并登记裁决，不能只改 package.json。',
        })),
      ],
    },
  ];
}

/** 计算层（各包）的完整限制规则集（框架 + DOM；**方向部分各包不同**，见 `restrictedImportsFor`）。 */
export const CALCULATION_LAYER_RESTRICTIONS = {
  'no-restricted-imports': ['error', { patterns: [FRAMEWORK_RESTRICTION] }],
  'no-restricted-globals': [
    'error',
    ...FORBIDDEN_DOM_GLOBALS.map((name) => ({
      name,
      message: `计算层禁止访问 DOM/浏览器全局（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    })),
  ],
  // 堵住 `globalThis.document` / `globalThis.window` 这类绕过 no-restricted-globals 的写法
  'no-restricted-properties': [
    'error',
    {
      object: 'globalThis',
      property: 'document',
      message: `计算层禁止访问 DOM（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    },
    {
      object: 'globalThis',
      property: 'window',
      message: `计算层禁止访问 window（${DOM_RULE_MESSAGE}）；DOM 只允许出现在 apps/web。`,
    },
  ],
};
