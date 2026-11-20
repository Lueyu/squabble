#!/usr/bin/env node
'use strict';

/**
 * setup-git-hooks.js — 跨平台的 git 钩子安装器（npm prepare 钩子触发）。
 *
 * 职责边界：
 *  - 替代纯 shell 版 prepare 脚本（`chmod +x .githooks/pre-commit; git config core.hooksPath .githooks`）：
 *    给 .githooks/pre-commit 加执行位，并把 core.hooksPath 指到 .githooks。
 * 上下游：
 *  - 上游（谁调用）：package.json 的 "prepare" script，即每次 npm install 之后自动执行。
 *  - 下游（连接什么）：.githooks/pre-commit（shell）→ npm run precommit → scripts/hooks/run-precommit.js。
 * 关键约定：
 *  - 永不让 npm install 失败：不是 git 克隆或 git 不可用时仅打日志跳过；chmod 失败也静默忽略
 *    （部分文件系统无执行位概念，git 在 Windows 上也不看该位）。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const hookPath = path.join(repoRoot, '.githooks', 'pre-commit');

if (fs.existsSync(hookPath)) {
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // chmod 在部分文件系统上是空操作；git 在 Windows 上也不使用执行位。
  }
}

try {
  execSync('git config core.hooksPath .githooks', { cwd: repoRoot, stdio: 'ignore' });
} catch {
  console.log('[setup-git-hooks] skipped (git unavailable or not a git clone).');
}
