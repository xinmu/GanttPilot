/**
 * **与 `pptxgenjs` 的唯一接触面**（P3/C3 拆出）。
 *
 * 为什么用**结构类型**而不是 `import PptxGenJS from 'pptxgenjs'`：该包的 `exports` 字段没有 `.` 键
 * （写成 `{"types": …, "import": …, "require": …}`），在 `moduleResolution: nodenext` 下
 * TypeScript 解析出的默认导入不是构造函数（S1 的 spike 用 `Bundler` 解析因此没暴露这个问题）。
 * 这里改为**动态 import + 结构类型**：既绕开包的导出映射瑕疵，又让"我们依赖了库的哪几样东西"
 * 在类型层面一目了然（换库/升级时编译器会告诉我们）——因此本文件也是**唯一的换库落点**。
 */

/** `addText` 的选项（只声明本包用到的面）。 */
export interface PptxTextOptions {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fontSize: number;
  readonly color: string;
  readonly bold: boolean;
  readonly align: 'left';
  readonly valign: 'top';
  readonly margin: number;
  readonly objectName: string;
}

/** 幻灯片（只用到 `addText`）。 */
export interface PptxSlideLike {
  addText(text: string, options: PptxTextOptions): unknown;
}

/** 演示文稿（只用到版面、属性、加页与写出）。 */
export interface PptxPresentationLike {
  layout: string;
  subject: string;
  title: string;
  author: string;
  company: string;
  defineLayout(layout: { readonly name: string; readonly width: number; readonly height: number }): void;
  addSlide(): PptxSlideLike;
  write(options: { readonly outputType: 'uint8array' }): Promise<unknown>;
}

/** pptxgenjs 的构造函数签名。 */
export type PptxConstructor = new () => PptxPresentationLike;

/** 取 pptxgenjs 的构造函数（**动态 import**：浏览器里它因此不进首屏主 chunk）。 */
export async function loadPptxGenJS(): Promise<PptxConstructor> {
  const loaded = (await import('pptxgenjs')) as unknown as { default?: PptxConstructor };
  const ctor = loaded.default;
  if (typeof ctor !== 'function') throw new Error('pptxgenjs 未导出构造函数（上游导出映射变了？）');
  return ctor;
}
