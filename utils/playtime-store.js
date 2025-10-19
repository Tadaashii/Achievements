// utils/playtime-store.js
const fs = require("fs");
const path = require("path");
const { preferencesPath } = require("./paths");

const STORE_PATH = path.join(
  path.dirname(preferencesPath),
  "playtime-totals.json"
);

function sanitizeKey(raw) {
  const s = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const base = s || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function readStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function writeStore(data) {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

function accumulatePlaytime(configName, millis) {
  const key = sanitizeKey(configName);
  if (!Number.isFinite(millis) || millis <= 0)
    return readStore()[key]?.totalMs || 0;

  const store = readStore();
  const current = Number(store[key]?.totalMs) || 0;
  const totalMs = current + millis;

  store[key] = {
    totalMs,
    updatedAt: Date.now(),
  };
  writeStore(store);
  return totalMs;
}

function getPlaytimeTotal(configName) {
  const key = sanitizeKey(configName);
  const store = readStore();
  return Number(store[key]?.totalMs) || 0;
}

module.exports = {
  accumulatePlaytime,
  getPlaytimeTotal,
  sanitizeConfigName: sanitizeKey,
};
