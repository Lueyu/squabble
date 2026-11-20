/**
 * @file lib/utils.ts
 * @description 共享底层工具集。
 * 目前只暴露 `cn` class-name 工具：各组件用它合并条件 Tailwind class 并消解冲突。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并条件 class 名，并消解 Tailwind class 冲突。
 *
 * 对 `clsx`（丢弃 falsy 值）与 `twMerge`（两个 Tailwind class 冲突时保留最后一个，
 * 如 `px-2 px-4` -> `px-4`）的轻量包装。调用方把期望生效的 class 放在最后，
 * 即可覆盖默认值。
 *
 * @param inputs - 字符串、对象、数组与 falsy 值的任意混合。
 * @returns 去重且冲突已消解的 class 名字符串。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
