/**
 * @file types/global.d.ts
 * @description 静态资源与 CSS 导入的环境（ambient）模块声明。
 *
 * 让 TypeScript 能解析 Vite 在构建期处理的 `import x from './logo.png'`
 * 一类导入；同时扩充 React 的 CSSProperties，允许样式对象携带任意
 * CSS 自定义属性（如 `--brand-color`）。
 *
 * 职责边界：
 *  - 只做环境类型声明；无运行时代码
 * 上下游：
 *  - 上游（谁调用这里）：tsconfig 全局包含，对所有客户端文件生效
 *  - 下游（本文件调用谁）：无（纯声明）
 */

declare module '*.css';

// 静态资源导入的类型声明
declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare module '*.webp' {
  const value: string;
  export default value;
}

declare module '*.ico' {
  const value: string;
  export default value;
}

declare module '*.json' {
  const value: any;
  export default value;
}

declare module '*.md' {
  const value: string;
  export default value;
}

declare module '*.csv' {
  const value: string;
  export default value;
}

/**
 * 允许 React 内联样式在标准 CSSProperties 键之外携带 CSS 变量（`--*`），
 * Tailwind/shadcn 的工具样式依赖这一能力。
 */
declare namespace React {
  export interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
