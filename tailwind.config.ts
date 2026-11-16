/**
 * @file tailwind.config.ts
 * @description Tailwind CSS configuration.
 *
 * Scans client sources for utility classes. Design tokens (colors, fonts,
 * radii, shadows, bull/bear semantic colors) are declared as CSS variables
 * in client/src/tailwind-theme.css and mapped via the `@theme inline` block
 * there; the typography plugin is registered from CSS (typography.css) via
 * `@plugin`, so this file only sets the content globs.
 */
export default {
  content: ['./client/**/*.{ts,tsx,html}'],
  plugins: [],
};
