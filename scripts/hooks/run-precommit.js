#!/usr/bin/env node
/**
 * run-precommit.js — git pre-commit 钩子入口（.githooks/pre-commit 经 `npm run precommit` 调到这里）。
 *
 * 只做一件事：执行 `npm run lint`，退出码非零就中止提交。lint 的具体编排（eslint + type-check +
 * stylelint，默认/选择性两种模式）都在 scripts/lint.js。用户可用 `git commit --no-verify` 跳过。
 */
// FULLSTACK_PRECOMMIT_V1
'use strict';

const { spawnSync } = require('node:child_process');

const SEP = '  ' + '─'.repeat(36);

function failAndExit(step, body) {
  process.stderr.write('\n✗ pre-commit failed: ' + step + '\n');
  process.stderr.write(SEP + '\n');
  if (body && body.length > 0) {
    process.stderr.write(body.replace(/\s+$/, '') + '\n');
  }
  process.stderr.write(SEP + '\n');
  process.stderr.write('  bypass: git commit --no-verify\n');
  process.exit(1);
}

function runLint() {
  const cwd = process.cwd();
  // 字符串命令 + shell：跨平台必需。用 argv 数组时 Node 无法在 Windows 上解析 npm
  // （CVE-2024-27980 之后对 .cmd 抛 spawn EINVAL / ENOENT）。
  const res = spawnSync('npm run lint', {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: true,
  });
  if (res.error) {
    failAndExit('lint', String(res.error.message || res.error));
  }
  if (res.status !== 0) {
    const stdout = res.stdout ? res.stdout.toString() : '';
    const stderr = res.stderr ? res.stderr.toString() : '';
    failAndExit('lint', stdout + '\n' + stderr);
  }
}

runLint();
