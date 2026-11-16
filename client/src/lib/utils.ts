/**
 * @file lib/utils.ts
 * @description Shared low-level utilities.
 * Currently exposes the `cn` class-name helper used across components to merge
 * conditional Tailwind classes without conflicts.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and resolve Tailwind class conflicts.
 *
 * Thin wrapper over `clsx` (which drops falsy values) followed by `twMerge`
 * (which keeps the last utility when two Tailwind classes clash, e.g.
 * `px-2 px-4` -> `px-4`). This lets callers override defaults by passing the
 * desired class last.
 *
 * @param inputs - Any mix of strings, objects, arrays, and falsy values.
 * @returns A deduplicated, conflict-resolved class-name string.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
