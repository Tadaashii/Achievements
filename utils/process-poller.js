const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DEFAULT_INTERVAL_MS = 2000;

let pollIntervalMs = DEFAULT_INTERVAL_MS;
let timer = null;
let inflight = false;
let lastSnapshot = [];
let lastUpdated = 0;
let lastError = null;
const subscribers = new Set();

let psListModulePromise = null;
async function loadPsListModule() {
  if (psListModulePromise) return psListModulePromise;
  psListModulePromise = (async () => {
    const tryPaths = [
      path.join(__dirname, "pslist-wrapper.mjs"),
      path.join(__dirname, "utils", "pslist-wrapper.mjs"),
      path.join(
        process.resourcesPath || "",
        "app.asar.unpacked",
        "utils",
        "pslist-wrapper.mjs",
      ),
      path.join(process.resourcesPath || "", "utils", "pslist-wrapper.mjs"),
    ];

    for (const p of tryPaths) {
      try {
        await fs.promises.access(p, fs.constants.R_OK);
        return await import(pathToFileURL(p).href);
      } catch {
        /* continue */
      }
    }
    throw new Error(`pslist-wrapper.mjs not found in:\n${tryPaths.join("\n")}`);
  })();
  return psListModulePromise;
}

async function fetchProcesses() {
  const mod = await loadPsListModule();
  return mod.getProcesses();
}

async function tick() {
  if (inflight) return;
  inflight = true;
  try {
    const list = await fetchProcesses();
    lastSnapshot = Array.isArray(list) ? list : [];
    lastUpdated = Date.now();
    lastError = null;
    const meta = { updatedAt: lastUpdated };
    for (const cb of Array.from(subscribers)) {
      try {
        cb(lastSnapshot, meta);
      } catch {}
    }
  } catch (err) {
    lastError = err;
  } finally {
    inflight = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, pollIntervalMs);
  tick();
}

function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function subscribe(callback) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  start();
  if (lastUpdated) {
    try {
      callback(lastSnapshot, { updatedAt: lastUpdated });
    } catch {}
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) stop();
  };
}

function getSnapshot() {
  return lastSnapshot;
}

function getStatus() {
  return {
    running: !!timer,
    subscribers: subscribers.size,
    updatedAt: lastUpdated,
    lastError: lastError ? String(lastError?.message || lastError) : "",
  };
}

function setIntervalMs(value) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return;
  pollIntervalMs = Math.max(250, Math.floor(next));
  if (timer) {
    stop();
    start();
  }
}

module.exports = {
  subscribe,
  getSnapshot,
  getStatus,
  setIntervalMs,
};
