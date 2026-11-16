#!/usr/bin/env node
'use strict';

/**
 * prepare-desktop-runtime.cjs — 打包前在 output/desktop-runtime 里准备一份生产依赖运行时树。
 *
 * 职责边界：
 *  - 建 output/desktop-runtime，拷贝 package.json / package-lock.json / .npmrc（存在才拷），
 *    然后在其中执行 `npm ci --omit=dev --ignore-scripts`。
 * 上下游：
 *  - 上游（谁调用）：npm script desktop:dist（"npm run build && node scripts/prepare-desktop-runtime.cjs
 *    && electron-builder …"），仅打包发布时执行。
 *  - 下游（连接什么）：electron-builder.yml 把 output/desktop-runtime/node_modules 作为 extraResources
 *    拷进安装包，供打包后的主进程 createRequire 加载 pg 等后端依赖。
 * 关键约定：
 *  - npm ci 失败（非零退出）会让本脚本以相同退出码结束，从而中止 desktop:dist 打包链。
 */
const { copyFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const project = resolve(__dirname, '..');
const runtime = join(project, 'output', 'desktop-runtime');
mkdirSync(runtime, { recursive: true });
for (const file of ['package.json', 'package-lock.json', '.npmrc']) {
  if (existsSync(join(project, file))) copyFileSync(join(project, file), join(runtime, file));
}
// electron-builder 的依赖遍历可能漏掉嵌套 pg 的提升依赖（hoisted）。
// 每个目标平台都用一次仅生产依赖的安装来补全完整运行时树。
const install = spawnSync('npm ci --omit=dev --ignore-scripts', {
  cwd: runtime,
  shell: true,
  stdio: 'inherit',
  windowsHide: true,
});
if (install.error) throw install.error;
if (install.status !== 0) process.exit(install.status || 1);
