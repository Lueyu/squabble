/**
 * @file postcss.config.js
 * @description PostCSS pipeline: inlines @imports, runs Tailwind v4, then
 * autoprefixes vendor prefixes for cross-browser support.
 * @type {import('postcss-load-config').Config}
 */
module.exports = {
  plugins: {
    'postcss-import': {},
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
