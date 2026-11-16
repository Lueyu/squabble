'use strict';

/**
 * dev-processes.cjs — 跨平台的进程/端口管理工具集，供 scripts/dev.js（以及 dev.spec.cjs）复用。
 *
 * 职责边界：
 *  - processSnapshot：枚举全部进程（Windows 用 PowerShell Get-CimInstance；POSIX 用 ps）。
 *  - listeningPids：找出监听指定 TCP 端口的 PID（Windows netstat；POSIX lsof，缺失时退回 ss）。
 *  - planListenerCleanup：把旧监听者回溯到 dev.js/nest --watch 等旧监督者根进程，且拒绝清理
 *    当前进程或其祖先。
 *  - terminateTree / stopOwnedChild：整树终止进程（Windows taskkill /T /F；POSIX 进程组 SIGKILL）。
 *  - reclaimPorts：回收被占端口并轮询等待真正释放（10 秒超时）。
 * 上下游：
 *  - 上游（谁调用）：scripts/dev.js 编排启动前用 reclaimPorts 清端口、退出时用 stopOwnedChild
 *    收子进程；scripts/dev.spec.cjs 直接单测各纯函数。
 *  - 下游（连接什么）：只与本机 OS 进程/端口打交道（powershell/netstat/lsof/ss/taskkill）。
 * 关键约定：
 *  - 安全护栏：绝不终止当前进程自身或其祖先（PID <=1 同样拒绝）；Windows 上以 startedAt 复验
 *    PID 未被复用后才动手杀。
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const exec = promisify(execFile);
const options = { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' };

async function processSnapshot() {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startedAt=[string]$_.CreationDate.ToUniversalTime().Ticks; command=$_.CommandLine } } | ConvertTo-Json -Compress';
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      options,
    );
    const rows = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(rows) ? rows : [rows];
  }
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,command='], options);
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            startedAt: match[3],
            command: match[4],
          },
        ]
      : [];
  });
}

function parseWindowsListeners(output, ports) {
  const wanted = new Set(ports.map(Number));
  return [
    ...new Set(
      output.split(/\r?\n/).flatMap((line) => {
        const fields = line.trim().split(/\s+/);
        if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') return [];
        return wanted.has(Number(fields[1].split(':').pop())) ? [Number(fields[4])] : [];
      }),
    ),
  ];
}

async function listeningPids(ports) {
  if (process.platform === 'win32') {
    const { stdout } = await exec('netstat.exe', ['-ano', '-p', 'tcp'], options);
    return parseWindowsListeners(stdout, ports);
  }
  try {
    const { stdout } = await exec(
      'lsof',
      ['-nP', ...ports.map((port) => `-iTCP:${port}`), '-sTCP:LISTEN', '-t'],
      options,
    );
    return [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.code === 1 && !error.stderr?.trim()) return [];
    if (error.code !== 'ENOENT') throw error;
    const { stdout } = await exec('ss', ['-ltnp'], options);
    return [
      ...new Set(
        stdout.split('\n').flatMap((line) => {
          const fields = line.trim().split(/\s+/);
          if (!ports.includes(Number(fields[3]?.split(':').pop()))) return [];
          const matches = [...line.matchAll(/pid=(\d+)/g)];
          if (!matches.length)
            throw new Error(
              'Cannot identify a port owner. Check process permissions or install lsof.',
            );
          return matches.map((match) => Number(match[1]));
        }),
      ),
    ];
  }
}

function ancestors(pid, rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const result = new Set();
  while (pid > 1 && !result.has(pid)) {
    result.add(pid);
    pid = byPid.get(pid)?.parentPid;
  }
  return result;
}

function planListenerCleanup(listeners, rows, currentPid = process.pid) {
  const protectedPids = ancestors(currentPid, rows);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const roots = listeners.map((pid) => {
    if (pid <= 1 || protectedPids.has(pid))
      throw new Error(`Cannot clean port owned by current process or ancestor (PID ${pid}).`);
    let root = pid;
    for (const ancestor of ancestors(pid, rows)) {
      if (protectedPids.has(ancestor)) break;
      const command = byPid.get(ancestor)?.command || '';
      // 旧监督者/watcher 一并停掉，否则它会立刻重新拉起监听者。
      if (
        /(?:^|[\\/\s"'])scripts[\\/]dev\.js(?=["'\s]|$)/i.test(command) ||
        /(?:^|[\\/\s"'])nest(?:\.js)?["'\s].*\bstart\b.*--watch\b/i.test(command)
      )
        root = ancestor;
    }
    return root;
  });
  return [...new Set(roots)].filter(
    (pid) => !roots.some((other) => other !== pid && ancestors(pid, rows).has(other)),
  );
}

function sameProcess(record, rows) {
  return Boolean(
    record?.startedAt &&
    rows.some((row) => row.pid === record.pid && row.startedAt === record.startedAt),
  );
}

async function terminateTree(target, rows) {
  rows ||= await processSnapshot();
  if (
    typeof target === 'object' &&
    rows.some((row) => row.pid === target.pid) &&
    !sameProcess(target, rows)
  )
    return;
  const pid = typeof target === 'object' ? target.pid : target;
  if (ancestors(process.pid, rows).has(pid) || pid <= 1)
    throw new Error(`Refusing to stop current process or ancestor (PID ${pid}).`);
  const owned = rows.filter((row) => ancestors(row.pid, rows).has(pid));
  if (!owned.length) return;
  // 先杀父进程：否则 watcher 会在我们清理整树期间重启子进程。
  owned.sort((a, b) => (a.pid === pid ? -1 : b.pid === pid ? 1 : 0));
  if (process.platform === 'win32') {
    for (const record of owned) {
      // taskkill /T 之后大多数后代已消失；跳过这些已退出的进程，避免再逐个做 PowerShell 快照。
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') continue;
        throw error;
      }
      // 每次异步整树终止后都要复验；PID 可能已被复用。
      if (!sameProcess(record, await processSnapshot())) continue;
      try {
        await exec('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], options);
      } catch (error) {
        // taskkill 会连后代一起杀；队列里后续 PID 可能已经不在了。
        try {
          process.kill(record.pid, 0);
        } catch (check) {
          if (check.code === 'ESRCH') continue;
          throw check;
        }
        throw new Error(`Could not stop PID ${record.pid}: ${error.message}`);
      }
    }
  } else {
    for (const record of owned) {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

async function stopOwnedChild(child, rows) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // POSIX 上托管子进程是分离的进程组组长。即使其 watcher 已退出，
    // 进程组仍会保留孤儿化的孙进程，所以要按负 PID 杀整组。
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  await terminateTree(child.identity || child.pid, rows);
}

async function reclaimPorts(ports, log) {
  const listeners = await listeningPids(ports);
  if (listeners.length) {
    const rows = await processSnapshot();
    for (const pid of planListenerCleanup(listeners, rows)) {
      log(`Reclaiming ports ${ports.join(', ')}: stopping old process tree PID ${pid}`);
      await terminateTree(pid, rows);
    }
  }
  const deadline = Date.now() + 10000;
  while ((await listeningPids(ports)).length) {
    if (Date.now() > deadline)
      throw new Error(
        `Ports ${ports.join(', ')} are still occupied. Close the owning service and retry.`,
      );
    await delay(200);
  }
}

module.exports = {
  processSnapshot,
  parseWindowsListeners,
  listeningPids,
  planListenerCleanup,
  sameProcess,
  terminateTree,
  stopOwnedChild,
  reclaimPorts,
};
