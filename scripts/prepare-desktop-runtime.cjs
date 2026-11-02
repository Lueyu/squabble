#!/usr/bin/env node
'use strict';

const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const project = resolve(__dirname, '..');
const runtime = join(project, 'output', 'desktop-runtime');
mkdirSync(runtime, { recursive: true });
for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
  if (existsSync(join(project, file))) copyFileSync(join(project, file), join(runtime, file));
}
// electron-builder's dependency traversal can omit hoisted dependencies of nested pg.
// A production-only install supplies the complete runtime tree on each target platform.
const install = spawnSync('npm ci --omit=dev --ignore-scripts', {
  cwd: runtime, shell: true, stdio: 'inherit', windowsHide: true,
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status || 1);
