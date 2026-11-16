'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const exec = promisify(execFile);
const options = { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' };

async function processSnapshot() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startedAt=[string]$_.CreationDate.ToUniversalTime().Ticks; command=$_.CommandLine } } | ConvertTo-Json -Compress';
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    const rows = JSON.parse(stdout.trim() || '[]');
    return Array.isArray(rows) ? rows : [rows];
  }
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,lstart=,command='], options);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3], command: match[4] }] : [];
  });
}

function parseWindowsListeners(output, ports) {
  const wanted = new Set(ports.map(Number));
  return [...new Set(output.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') return [];
    return wanted.has(Number(fields[1].split(':').pop())) ? [Number(fields[4])] : [];
  }))];
}

async function listeningPids(ports) {
  if (process.platform === 'win32') {
    const { stdout } = await exec('netstat.exe', ['-ano', '-p', 'tcp'], options);
    return parseWindowsListeners(stdout, ports);
  }
  try {
    const { stdout } = await exec('lsof', ['-nP', ...ports.map(port => `-iTCP:${port}`), '-sTCP:LISTEN', '-t'], options);
    return [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (error) {
    if (error.code === 1 && !error.stderr?.trim()) return [];
    if (error.code !== 'ENOENT') throw error;
    const { stdout } = await exec('ss', ['-ltnp'], options);
    return [...new Set(stdout.split('\n').flatMap(line => {
      const fields = line.trim().split(/\s+/);
      if (!ports.includes(Number(fields[3]?.split(':').pop()))) return [];
      const matches = [...line.matchAll(/pid=(\d+)/g)];
      if (!matches.length) throw new Error('Cannot identify a port owner. Check process permissions or install lsof.');
      return matches.map(match => Number(match[1]));
    }))];
  }
}

function ancestors(pid, rows) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const result = new Set();
  while (pid > 1 && !result.has(pid)) {
    result.add(pid);
    pid = byPid.get(pid)?.parentPid;
  }
  return result;
}

function planListenerCleanup(listeners, rows, currentPid = process.pid) {
  const protectedPids = ancestors(currentPid, rows);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const roots = listeners.map(pid => {
    if (pid <= 1 || protectedPids.has(pid)) throw new Error(`Cannot clean port owned by current process or ancestor (PID ${pid}).`);
    let root = pid;
    for (const ancestor of ancestors(pid, rows)) {
      if (protectedPids.has(ancestor)) break;
      const command = byPid.get(ancestor)?.command || '';
      // Stop the old supervisor/watcher as well, or it will respawn its listener.
      if (/(?:^|[\\/\s"'])scripts[\\/]dev\.js(?=["'\s]|$)/i.test(command)
        || /(?:^|[\\/\s"'])nest(?:\.js)?["'\s].*\bstart\b.*--watch\b/i.test(command)) root = ancestor;
    }
    return root;
  });
  return [...new Set(roots)].filter(pid => !roots.some(other => other !== pid && ancestors(pid, rows).has(other)));
}

function sameProcess(record, rows) {
  return Boolean(record?.startedAt && rows.some(row => row.pid === record.pid && row.startedAt === record.startedAt));
}

async function terminateTree(target, rows) {
  rows ||= await processSnapshot();
  if (typeof target === 'object' && rows.some(row => row.pid === target.pid) && !sameProcess(target, rows)) return;
  const pid = typeof target === 'object' ? target.pid : target;
  if (ancestors(process.pid, rows).has(pid) || pid <= 1) throw new Error(`Refusing to stop current process or ancestor (PID ${pid}).`);
  const owned = rows.filter(row => ancestors(row.pid, rows).has(pid));
  if (!owned.length) return;
  // Parent first: a watcher must not restart a child while we stop the tree.
  owned.sort((a, b) => a.pid === pid ? -1 : b.pid === pid ? 1 : 0);
  if (process.platform === 'win32') {
    for (const record of owned) {
      // Most descendants are already gone after taskkill /T; avoid another
      // PowerShell snapshot for each of those exited processes.
      try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      // Revalidate after each asynchronous tree kill; PIDs can be reused.
      if (!sameProcess(record, await processSnapshot())) continue;
      try {
        await exec('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], options);
      } catch (error) {
        // taskkill also kills descendants; a subsequent PID may already be gone.
        try { process.kill(record.pid, 0); } catch (check) { if (check.code === 'ESRCH') continue; throw check; }
        throw new Error(`Could not stop PID ${record.pid}: ${error.message}`);
      }
    }
  } else {
    for (const record of owned) {
      try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

async function stopOwnedChild(child, rows) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    // Owned children are detached group leaders on POSIX. The group retains
    // orphaned grandchildren even after their watcher has exited.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
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
    if (Date.now() > deadline) throw new Error(`Ports ${ports.join(', ')} are still occupied. Close the owning service and retry.`);
    await delay(200);
  }
}

module.exports = { processSnapshot, parseWindowsListeners, listeningPids, planListenerCleanup, sameProcess, terminateTree, stopOwnedChild, reclaimPorts };
