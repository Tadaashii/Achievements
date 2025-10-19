// playtime-log-watcher.js
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { preferencesPath } = require("./paths");
const { pathToFileURL } = require("url");
const { accumulatePlaytime, sanitizeConfigName } = require("./playtime-store");

const playtimeStartMap = new Map();
const activeWatchers = new Map();

function notifyError(message) {
  try {
    const { webContents } = require("electron");
    const all = webContents.getAllWebContents();
    all.forEach((wc) => {
      try {
        wc.send("notify", { message: String(message), color: "#f44336" });
      } catch {}
    });
  } catch (e) {
    console.error("notifyError:", message);
  }
}

function readPrefsSafe() {
  try {
    if (fs.existsSync(preferencesPath)) {
      return JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    }
  } catch {}
  return {};
}

function isPlaytimeDisabled() {
  try {
    const prefs = readPrefsSafe();
    return !!prefs.disablePlaytime || global.disablePlaytime === true;
  } catch {
    return global.disablePlaytime === true;
  }
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode === 200) {
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        } else {
          fs.unlink(dest, () => {});
          reject(new Error(`Failed to download image: ${res.statusCode}`));
        }
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

function cacheHeaderImage(userDataDir, appid, headerUrl) {
  const imageDir = path.join(userDataDir, "images", String(appid));
  try {
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
  } catch {}
  const headerPath = path.join(imageDir, "header.jpg");

  const doDownload = async () => {
    try {
      if (!fs.existsSync(headerPath)) {
        await downloadImage(headerUrl, headerPath);
      }
    } catch (e) {
      return { headerUrl };
    }
    return { headerUrl: pathToFileURL(headerPath).toString() };
  };

  return doDownload();
}

async function getProcessesSafe() {
  const tryPaths = [
    path.join(
      process.resourcesPath || "",
      "app.asar.unpacked",
      "utils",
      "pslist-wrapper.mjs"
    ),
    path.join(__dirname, "pslist-wrapper.mjs"),
    path.join(__dirname, "utils", "pslist-wrapper.mjs"),
    path.join(process.resourcesPath || "", "utils", "pslist-wrapper.mjs"),
  ];

  let found = null;
  for (const p of tryPaths) {
    try {
      await fs.promises.access(p, fs.constants.R_OK);
      found = p;
      break;
    } catch {}
  }
  if (!found)
    throw new Error(`pslist-wrapper.mjs not found in:\n${tryPaths.join("\n")}`);

  const { pathToFileURL } = require("url");
  const { getProcesses } = await import(pathToFileURL(found).href);
  return getProcesses();
}

function sendPlaytimeNotification(playData) {
  try {
    ipcMain.emit("show-playtime", null, playData);
  } catch (e) {
    notifyError(`Failed to emit playtime: ${e.message}`);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    const sec = totalSeconds;
    return `You played for ${sec} second${sec !== 1 ? "s" : ""}`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    const mins = totalMinutes;
    const parts = [`${mins} minute${mins !== 1 ? "s" : ""}`];
    if (seconds) parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);
    return `You played for ${parts.join(" ")}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [`${hours}h`];
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  if (!minutes && seconds)
    parts.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);
  return `You played for ${parts.join(" ")}`;
}

/* ----------------- Main watcher ----------------- */
/**
 * @param {{appid:number|string, name?:string, displayName?:string, process_name?:string}} configData
 * @returns {() => void}
 */
function startPlaytimeLogWatcher(configData) {
  const appid = String(configData?.appid || "").trim();
  const processName = String(configData?.process_name || "").trim();
  const existing = activeWatchers.get(appid);
  if (existing) {
    if (configData?.__playtimeKey) {
      existing.playtimeKey = configData.__playtimeKey;
    }
    return existing.cleanup;
  }
  const gameName =
    configData?.displayName || configData?.name || "Unknown Game";

  if (!appid) {
    notifyError("🚨 Missing appid in configData!");
    return () => {};
  }
  if (!processName) {
    notifyError(`⚠️ Missing executable for app ${appid}`);
    return () => {};
  }

  const { preferencesPath } = require("./paths");
  const userDataDir = path.dirname(preferencesPath);

  // Header URLs
  const remoteHeaderUrl = `https://cdn.steamstatic.com/steam/apps/${appid}/header.jpg`;

  let interval = null;
  let closed = false;
  let startNotified = false;
  const tracker = {
    playtimeKey:
      configData?.__playtimeKey ||
      sanitizeConfigName(configData?.name || configData?.displayName || appid),
    cleanup: () => {},
  };
  activeWatchers.set(appid, tracker);
  const cleanup = () => {
    closed = true;
    playtimeStartMap.delete(appid);
    if (interval) clearInterval(interval);
    activeWatchers.delete(appid);
    interval = null;
  };
  tracker.cleanup = cleanup;

  const sendStart = (headerUrl) => {
    if (startNotified) return;
    startNotified = true;
    playtimeStartMap.set(appid, Date.now());
    if (!isPlaytimeDisabled()) {
      sendPlaytimeNotification({
        phase: "start",
        displayName: gameName,
        description: "Start Playtime!",
        headerUrl,
      });
    }
  };

  const sendStop = async (headerUrlLocal) => {
    const startedAt = playtimeStartMap.get(appid) || Date.now();
    const playedMs = Math.max(0, Date.now() - startedAt);
    const key = tracker.playtimeKey;
    const totalMs = accumulatePlaytime(key, playedMs);
    ipcMain.emit("playtime:session-ended", null, {
      configName: key,
      appid: String(appid),
      totalMs,
    });

    playtimeStartMap.delete(appid);
    const desc = formatDuration(playedMs);
    if (!isPlaytimeDisabled()) {
      sendPlaytimeNotification({
        phase: "stop",
        displayName: gameName,
        description: desc,
        headerUrl: headerUrlLocal,
      });
    }
  };

  sendStart(remoteHeaderUrl);

  cacheHeaderImage(userDataDir, appid, remoteHeaderUrl)
    .then(({ headerUrl }) => {
      if (closed) return;
      sendStart(headerUrl);
    })
    .catch((err) => {
      notifyError(`Header cache failed: ${err.message}`);
      if (!closed) {
        sendStart(remoteHeaderUrl);
      }
    });

  interval = setInterval(async () => {
    if (closed) return;
    try {
      const processes = await getProcessesSafe();
      const exeName = path.basename(processName).toLowerCase();
      const running = processes.some((p) => p.name.toLowerCase() === exeName);

      if (!running) {
        try {
          const headerPath = path.join(
            userDataDir,
            "images",
            String(appid),
            "header.jpg"
          );
          const headerLocal = fs.existsSync(headerPath)
            ? pathToFileURL(headerPath).toString()
            : remoteHeaderUrl;
          await sendStop(headerLocal);
        } catch {
          await sendStop(remoteHeaderUrl);
        } finally {
          cleanup();
        }
      }
    } catch (err) {
      notifyError(`⛔ Playtime watcher error: ${err.message}`);
    }
  }, 2000);

  return cleanup;
}

module.exports = { startPlaytimeLogWatcher };
