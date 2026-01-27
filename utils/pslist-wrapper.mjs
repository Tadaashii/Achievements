// utils/pslist-wrapper.mjs
import psList from 'ps-list';
import { execFile } from 'node:child_process';

let cache = null;
let lastFetch = 0;
let inflight = null;

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function getWindowsProcesses() {
  const cmd =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const stdout = await runPowerShell([cmd]);
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter(Boolean)
    .map((p) => ({
      pid: Number(p.ProcessId) || 0,
      name: String(p.Name || ''),
      cmd: String(p.CommandLine || ''),
    }))
    .filter((p) => p.pid > 0 && p.name);
}

export async function getProcesses() {
  const now = Date.now();
  if (cache && now - lastFetch < 1000) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    let list = [];
    if (process.platform === 'win32') {
      try {
        list = await getWindowsProcesses();
      } catch {
        list = [];
      }
    }
    if (!list.length) {
      list = await psList();
    }
    cache = list;
    lastFetch = Date.now();
    return list;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
