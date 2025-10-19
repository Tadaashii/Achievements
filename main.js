const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  globalShortcut,
  Menu,
  Tray,
} = require("electron");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-hid-blocklist");
const { spawn, fork } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ini = require("ini");
const chokidar = require("chokidar");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const CRC32 = require("crc-32");
const { copyFolderOnce } = require("./utils/fileCopy");
const {
  defaultSoundsFolder,
  defaultPresetsFolder,
  userSoundsFolder,
  userPresetsFolder,
  preferencesPath,
  configsDir,
  cacheDir,
} = require("./utils/paths");
const { startPlaytimeLogWatcher } = require("./utils/playtime-log-watcher");
const getConfigInflight = new Map();

function looksLikeSchemaArray(json) {
  if (!Array.isArray(json)) return false;
  if (json.length === 0) return true;
  const a = json[0] || {};
  return (
    typeof a.name === "string" &&
    (typeof a.displayName === "string" || typeof a.displayName === "object") &&
    ("icon" in a || "icon_gray" in a || "icongray" in a)
  );
}

function looksLikeSaveJson(json) {
  if (!json || typeof json !== "object") return false;
  if (Array.isArray(json)) {
    const a = json[0] || {};
    return (
      "Achieved" in a ||
      "UnlockTime" in a ||
      "CurProgress" in a ||
      "MaxProgress" in a ||
      "earned" in a
    );
  }
  const firstVal = Object.values(json)[0];
  return (
    firstVal &&
    typeof firstVal === "object" &&
    ("Achieved" in firstVal ||
      "UnlockTime" in firstVal ||
      "CurProgress" in firstVal ||
      "MaxProgress" in firstVal ||
      "earned" in firstVal)
  );
}

function readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function findConfigDirFromSelection(selDir) {
  // 1) <sel>/steam_settings/achievements.json
  const cSteam = path.join(selDir, "steam_settings", "achievements.json");
  if (fs.existsSync(cSteam) && looksLikeSchemaArray(readJsonSafe(cSteam))) {
    return path.join(selDir, "steam_settings");
  }
  // 2) <sel>/achievements.json
  const cTop = path.join(selDir, "achievements.json");
  if (fs.existsSync(cTop) && looksLikeSchemaArray(readJsonSafe(cTop))) {
    return selDir;
  }
  return null;
}

function findSaveBaseFromSelection(selDir, appid) {
  // 1) <sel>/steam_settings/<appid>/achievements.json → save_path = <sel>/steam_settings
  const s1 = path.join(
    selDir,
    "steam_settings",
    String(appid),
    "achievements.json"
  );
  if (fs.existsSync(s1) && looksLikeSaveJson(readJsonSafe(s1))) {
    return path.join(selDir, "steam_settings");
  }
  // 2) <sel>/<appid>/achievements.json → save_path = <sel>
  const s2 = path.join(selDir, String(appid), "achievements.json");
  if (fs.existsSync(s2) && looksLikeSaveJson(readJsonSafe(s2))) {
    return selDir;
  }
  // 3) <sel>/achievements.json → save_path = <sel>
  const s3 = path.join(selDir, "achievements.json");
  if (fs.existsSync(s3) && looksLikeSaveJson(readJsonSafe(s3))) {
    return selDir;
  }
  return null;
}

function resolveSaveFilePath(saveBase, appid) {
  const candidates = [
    path.join(saveBase, "steam_settings", String(appid), "achievements.json"),
    path.join(saveBase, String(appid), "achievements.json"),
    path.join(saveBase, "achievements.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return path.join(saveBase, String(appid), "achievements.json");
}

function resolveSaveSidecarPaths(saveBase, appid) {
  const dirs = [
    path.join(saveBase, "steam_settings", String(appid)),
    path.join(saveBase, String(appid)),
    saveBase,
  ];
  for (const d of dirs) {
    const iniPath = path.join(d, "achievements.ini");
    const ofx = path.join(d, "Stats", "achievements.ini");
    const bin = path.join(d, "stats.bin");
    if (fs.existsSync(ofx))
      return { dir: d, ini: null, ofx, bin: fs.existsSync(bin) ? bin : null };
    if (fs.existsSync(iniPath))
      return {
        dir: d,
        ini: iniPath,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };
    if (fs.existsSync(bin)) return { dir: d, ini: null, ofx: null, bin };
  }
  return {
    dir: path.join(saveBase, String(appid)),
    ini: null,
    ofx: null,
    bin: null,
  };
}

const ACHGEN_BUFFER_MAX = 300;
const achgenBuffer = [];

function pushAchgen(level, message) {
  const msg = String(message || "").trim();
  if (!msg) return;

  const payload = { type: "achgen:log", level, message: msg, ts: Date.now() };
  achgenBuffer.push(payload);
  if (achgenBuffer.length > ACHGEN_BUFFER_MAX) achgenBuffer.shift();

  // broadcast “achgen:log”
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("achgen:log", payload);
    } catch {}
  }

  const color =
    level === "error" ? "#f44336" : level === "warn" ? "#FFC107" : "#2196f3";
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed())
        win.webContents.send("notify", { message: msg, color });
    } catch {}
  }

  try {
    const fn =
      level === "error"
        ? originalConsole.error
        : level === "warn"
        ? originalConsole.warn
        : originalConsole.info;
    fn(`${msg}`);
  } catch {}
}

ipcMain.handle("achgen:get-backlog", () => achgenBuffer);

function emitSchemaReady(data, senderWC = null) {
  try {
    if (senderWC && !senderWC.isDestroyed?.())
      senderWC.send("config:schema-ready", data);
  } catch {}
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("config:schema-ready", data);
    } catch {}
  }
}

function notifyWarn(message) {
  originalConsole.warn(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#FFC107" });
  }
}

const infoOnceKeys = new Set();
function infoOnce(key, message) {
  if (infoOnceKeys.has(key)) return;
  infoOnceKeys.add(key);
  notifyInfo(message);
  setTimeout(() => infoOnceKeys.delete(key), 60_000);
}

const warnedOnce = new Set();
function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  notifyWarn(message);
  setTimeout(() => warnedOnce.delete(key), 60_000);
}

const warnedOnceLogOnly = new Set();
function warnOnceLog(key, message) {
  if (warnedOnceLogOnly.has(key)) return;
  warnedOnceLogOnly.add(key);
  originalConsole.warn(message);
  setTimeout(() => warnedOnceLogOnly.delete(key), 60_000);
}

function notifyError(message) {
  originalConsole.error(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#f44336" });
  }
}

function notifyInfo(message) {
  originalConsole.info(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#2196f3" });
  }
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

//Achievements Image
function resolveIconAbsolutePath(configPath, rel) {
  try {
    if (!rel || !isNonEmptyString(configPath)) return null;
    const base = path.basename(String(rel));
    const candidates = [];

    candidates.push(path.join(configPath, rel));
    candidates.push(path.join(configPath, "achievement_images", base));
    candidates.push(
      path.join(configPath, "steam_settings", "achievement_images", base)
    );
    candidates.push(path.join(configPath, "img", base));
    candidates.push(path.join(configPath, "steam_settings", "img", base));
    candidates.push(path.join(configPath, "images", base));
    candidates.push(path.join(configPath, "steam_settings", "images", base));

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  } catch {}
  return null;
}

//Config Name Sanitize
function sanitizeConfigName(raw) {
  const s = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "") // Windows-illegal
    .replace(/\s+/g, " ") // multiple spaces
    .trim()
    .replace(/[. ]+$/, ""); // without dot/space at end
  const base = s || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function registerOverlayShortcut(newShortcut) {
  if (!newShortcut || typeof newShortcut !== "string") return;

  try {
    globalShortcut.unregisterAll();

    const registered = globalShortcut.register(newShortcut, () => {
      console.log(`Overlay Shortcut Pressed : ${newShortcut}`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        if (overlayWindow.isVisible()) {
          overlayWindow.close();
        } else {
          overlayWindow.show();
        }
      } else {
        createOverlayWindow(selectedConfig);
      }
    });

    if (!registered) {
      notifyError(`Could not save shortcut: ${newShortcut}`);
    } else {
      console.log(`Overlay shortcut saved: ${newShortcut}`);
    }
  } catch (err) {
    notifyError(`Failed to save shortcut: ${newShortcut} – ${err.message}`);
  }
}

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function sendConsoleMessageToUI(message, color) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color });
  }
}

console.log = (...args) => {
  originalConsole.log(...args);
  sendConsoleMessageToUI(args.join(" "), "#4CAF50");
};

console.info = (...args) => {
  originalConsole.info(...args);
  sendConsoleMessageToUI(args.join(" "), "#2196F3");
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  sendConsoleMessageToUI(args.join(" "), "#FFC107");
};

console.error = (...args) => {
  originalConsole.error(...args);
  sendConsoleMessageToUI(args.join(" "), "#f44336");
};

if (!fs.existsSync(configsDir)) {
  fs.mkdirSync(configsDir, { recursive: true });
}

// === Watcher on configsDir ===
let configsWatcher = chokidar.watch(configsDir, {
  persistent: true,
  ignoreInitial: true,
  depth: 0,
  awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
});

function broadcastToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch {}
  }
}

function notifyConfigsChanged() {
  broadcastToAll("configs:changed");
}

configsWatcher
  .on("add", (p) => {
    if (p.endsWith(".json")) notifyConfigsChanged();
  })
  .on("unlink", (p) => {
    if (p.endsWith(".json")) notifyConfigsChanged();
  })
  .on("change", (p) => {
    if (p.endsWith(".json")) notifyConfigsChanged();
  });

let selectedLanguage = "english";
let manualLaunchInProgress = false;
let cachedPreferences = readPrefsSafe();
if (cachedPreferences && typeof cachedPreferences === "object") {
  if (typeof cachedPreferences.language === "string") {
    selectedLanguage = cachedPreferences.language;
  }
  if ("disableProgress" in cachedPreferences) {
    global.disableProgress = cachedPreferences.disableProgress === true;
  }
  if ("disablePlaytime" in cachedPreferences) {
    global.disablePlaytime = cachedPreferences.disablePlaytime === true;
  }
  if ("startMaximized" in cachedPreferences) {
    global.startMaximized = !!cachedPreferences.startMaximized;
  }
  if ("startInTray" in cachedPreferences) {
    global.startInTray = !!cachedPreferences.startInTray;
  }
} else {
  cachedPreferences = {};
}
ipcMain.handle("save-preferences", async (event, newPrefs) => {
  const freshPrefs = readPrefsSafe();
  const mergedPrefs = { ...freshPrefs, ...newPrefs };

  if (mergedPrefs.language) {
    selectedLanguage = mergedPrefs.language;
  }
  if ("disableProgress" in newPrefs) {
    global.disableProgress = newPrefs.disableProgress;
  }

  if ("disablePlaytime" in newPrefs) {
    global.disablePlaytime = newPrefs.disablePlaytime;
  }
  if ("startMaximized" in newPrefs) {
    global.startMaximized = !!newPrefs.startMaximized;
  }
  if ("startInTray" in newPrefs) {
    global.startInTray = !!newPrefs.startInTray;
  }
  try {
    fs.writeFileSync(preferencesPath, JSON.stringify(mergedPrefs, null, 2));
  } catch (err) {
    notifyError("Error writing merged preferences: " + err.message);
  }
  if ("overlayShortcut" in newPrefs) {
    global.overlayShortcut = newPrefs.overlayShortcut;
    registerOverlayShortcut(newPrefs.overlayShortcut);
  }

  cachedPreferences = { ...mergedPrefs };
});

ipcMain.on("set-zoom", (_event, zoomFactor) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(zoomFactor);

    try {
      const updatedPrefs = {
        ...cachedPreferences,
        windowZoomFactor: zoomFactor,
      };
      fs.writeFileSync(preferencesPath, JSON.stringify(updatedPrefs, null, 2));
      cachedPreferences = updatedPrefs;
    } catch (err) {
      notifyError("❌ Failed to save zoom preference: " + err.message);
    }
    mainWindow.webContents.send("zoom-factor-changed", zoomFactor);
  }
});

function getScreenshotRootFolder() {
  const prefs = readPrefsSafe();
  // Default Pictures\Achievements Screenshots
  const fallback = path.join(
    app.getPath("pictures"),
    "Achievements Screenshots"
  );
  const root = prefs.screenshotFolder || fallback;
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.warn("Cannot create screenshot root folder:", e.message);
  }
  return root;
}

function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    console.warn("Cannot create dir:", p, e.message);
  }
}

function sanitizeFilename(name) {
  return (
    String(name || "achievement")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || "achievement"
  );
}

// --- Achievements schema generator (manual configs) ---
async function runAchievementsGenerator(appid, schemaBaseDir, userDataDir) {
  return new Promise((resolve, reject) => {
    const script = path.join(
      __dirname,
      "utils",
      "generate_achievements_schema.js"
    );
    const args = [
      String(appid),
      "--apps-concurrency=1",
      `--out=${schemaBaseDir}`,
      `--user-data-dir=${userDataDir}`,
    ];
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
      windowsHide: true,
    });

    // forward logs to UI (same topic as auto-configs)
    const flushLines = (chunk, level) => {
      String(chunk)
        .split(/\r?\n/)
        .forEach((line) => {
          const s = line.trim();
          if (s) pushAchgen(level, s);
        });
    };

    cp.on("message", (msg) => {
      if (!msg || msg.type !== "achgen:log") return;
      const line = `${msg.message || ""}`;
      const lvl = (msg.level || "info").toLowerCase();
      if (lvl === "error") console.error(line);
      else if (lvl === "warn") console.warn(line);
      else console.log(line);
    });
    cp.on("error", reject);
    cp.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Code: ${code}`))
    );
  });
}

async function ensureSchemaForApp(appid) {
  if (!/^\d+$/.test(String(appid || ""))) return null;

  const schemaBase = path.join(configsDir, "schema"); // %APPDATA%\Achievements\configs\schema
  const destDir = path.join(schemaBase, String(appid));
  const achJson = path.join(destDir, "achievements.json");

  try {
    if (!fs.existsSync(schemaBase))
      fs.mkdirSync(schemaBase, { recursive: true });
  } catch {}
  // if achievements schema exist
  if (fs.existsSync(achJson)) {
    return { dir: destDir, existed: true };
  }
  try {
    await runAchievementsGenerator(appid, schemaBase, app.getPath("userData"));
    if (fs.existsSync(achJson)) {
      return { dir: destDir, existed: false };
    }
    warnOnce(`${appid}:nojson`, `Schema was not generated!`);
  } catch (e) {
    warnOnce(`${appid}:fail`, `Generate schema failed: ${e.message}`);
  }
  return null;
}

/* <root>/<gameName>/<displayName>.png  (timestamp if exists) */
async function saveFullScreenShot(gameName, achDisplayName) {
  if (!screenshot) throw new Error("screenshot-desktop is not installed");
  const root = getScreenshotRootFolder();
  const gameFolder = path.join(
    root,
    sanitizeFilename(gameName || "Unknown Game")
  );
  ensureDir(gameFolder);

  let file = path.join(gameFolder, sanitizeFilename(achDisplayName) + ".png");
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    file = path.join(
      gameFolder,
      `${sanitizeFilename(achDisplayName)}_${ts}.png`
    );
  }

  const buf = await screenshot({ format: "png" }); // full desktop
  fs.writeFileSync(file, buf);
  return file;
}

ipcMain.handle("load-preferences", () => {
  cachedPreferences = readPrefsSafe();
  return { ...cachedPreferences };
});

ipcMain.handle("get-sound-files", () => {
  if (!fs.existsSync(userSoundsFolder)) return [];
  const files = fs
    .readdirSync(userSoundsFolder)
    .filter((file) => file.endsWith(".wav"));
  return files;
});

ipcMain.handle("get-sound-path", (_event, fileName) => {
  const fullPath = path.join(app.getPath("userData"), "sounds", fileName);
  return `file://${fullPath.replace(/\\/g, "/")}`;
});

ipcMain.handle("ui:confirm", async (e, { title, message, detail }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Cancel", "OK"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    modal: true,
    title: title || "Confirm",
    message,
    detail: detail || "",
  });
  try {
    win.setIgnoreMouseEvents(false);
    if (!win.isVisible()) win.show();
    win.focus();
  } catch {}
  return res.response === 1;
});

ipcMain.handle("ui:refocus", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  try {
    win.setAlwaysOnTop(true, "screen-saver");
    setTimeout(() => {
      win.setAlwaysOnTop(false);
      win.focus();
    }, 0);
  } catch {}
});

// List existing configs
function listConfigs() {
  const files = fs.readdirSync(configsDir);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(".json", ""));
}

// Handler for config saving
ipcMain.handle("saveConfig", async (event, config) => {
  try {
    const safeName = sanitizeConfigName(config.name);
    if (!fs.existsSync(configsDir))
      fs.mkdirSync(configsDir, { recursive: true });
    const filePath = path.join(configsDir, `${safeName}.json`);

    const payload = {
      ...config,
      name: safeName,
      displayName: config.displayName || config.name,
      config_path: isNonEmptyString(config.config_path)
        ? config.config_path
        : null,
      save_path: isNonEmptyString(config.save_path) ? config.save_path : null,
      executable: isNonEmptyString(config.executable)
        ? config.executable
        : null,
      arguments: isNonEmptyString(config.arguments) ? config.arguments : "",
      process_name: isNonEmptyString(config.process_name)
        ? config.process_name
        : "",
    };

    const hasAppId = /^\d+$/.test(String(payload.appid || ""));
    if (!hasAppId) {
      return { success: false, message: "AppID is required." };
    }

    const wc = event.sender;

    // 1) Manually selected config_path
    let finalSchemaDir = null;
    if (isNonEmptyString(payload.config_path)) {
      const bySel = findConfigDirFromSelection(payload.config_path);
      if (bySel) {
        finalSchemaDir = bySel;
      }
    }

    // 2) Search schema locally
    let needBackground = false;
    if (!finalSchemaDir) {
      const schemaBase = path.join(configsDir, "schema");
      const candidateDir = path.join(schemaBase, String(payload.appid));
      const achPath = path.join(candidateDir, "achievements.json");
      if (
        fs.existsSync(achPath) &&
        looksLikeSchemaArray(readJsonSafe(achPath))
      ) {
        finalSchemaDir = candidateDir;
      } else {
        needBackground = true;
      }
    }
    if (finalSchemaDir) payload.config_path = finalSchemaDir;

    try {
      const selForSave = isNonEmptyString(config.save_path)
        ? config.save_path
        : isNonEmptyString(config.config_path)
        ? config.config_path
        : payload.config_path;

      if (isNonEmptyString(selForSave) && fs.existsSync(selForSave)) {
        const detectedBase = findSaveBaseFromSelection(
          selForSave,
          payload.appid
        );
        if (detectedBase) {
          payload.save_path = detectedBase; // ex: <root>/steam_settings
        } else if (!isNonEmptyString(payload.save_path)) {
          payload.save_path = selForSave; // fallback
        }
      }
    } catch {}
    // 3) Create config
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    notifyConfigsChanged();

    // 4) Schema exists
    if (finalSchemaDir && !needBackground) {
      const txt = `⏭ [${payload.appid}] Achievements schema exists. Skip generating!`;

      const reply = {
        success: true,
        message: "Configuration saved successfully!",
        schemaReady: true,
        config_path: finalSchemaDir,
        save_path: payload.save_path || null,
      };

      setTimeout(() => {
        console.log(`${txt}`);
        emitSchemaReady(
          {
            name: payload.name,
            appid: payload.appid,
            config_path: finalSchemaDir,
          },
          wc
        );
      }, 15);

      return reply;
    }

    // 5) Generate Achievements Schema
    if (needBackground) {
      const startTxt = `↪ Generate achievements schema for ${payload.appid}...`;

      const reply = {
        success: true,
        message: "Configuration saved. Generating schema in background…",
        schemaReady: false,
        config_path: null,
        save_path: payload.save_path || null,
      };

      (async () => {
        try {
          const res = await ensureSchemaForApp(payload.appid);
          if (res?.dir) {
            try {
              const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
              if (curr.config_path !== res.dir) {
                curr.config_path = res.dir;
                fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
              }
            } catch (e) {
              notifyError(
                "Failed to persist config_path after generation: " + e.message
              );
            }

            // 2) Schema Done (set new config path)
            emitSchemaReady(
              {
                name: payload.name,
                appid: payload.appid,
                config_path: res.dir,
              },
              wc
            );
            notifyConfigsChanged();
          } else {
          }
        } catch (e) {
          console.warn(
            `Generate schema failed for ${payload.appid}: ${e.message}`
          );
          notifyError(`Generate schema failed: ${e.message}`);
        }
      })();
      setTimeout(() => {
        console.log(`${startTxt}`);
      }, 15);
      return reply;
    }
  } catch (error) {
    return { success: false, message: "Error saving configuration!" };
  }
});

// Handler for config load
ipcMain.handle("loadConfigs", () => {
  const configFiles = fs
    .readdirSync(configsDir)
    .filter((file) => file.endsWith(".json"));
  const configs = configFiles.map((file) => path.basename(file, ".json"));
  return configs;
});

// Handler for folder load
ipcMain.handle("selectFolder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

// Handler for json load
ipcMain.handle("load-achievements", async (event, configName) => {
  try {
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const cfgDir = isNonEmptyString(config?.config_path)
      ? config.config_path
      : "";
    if (!cfgDir) {
      event.sender.send("achievements-missing", {
        configName,
        reason: !cfgDir ? "no-config-path" : "no-file",
      });
      return { achievements: null, config_path: cfgDir || "" };
    }

    // 1) <cfgDir>/steam_settings/achievements.json
    const p1 = path.join(cfgDir, "steam_settings", "achievements.json");
    // 2) <cfgDir>/achievements.json
    const p2 = path.join(cfgDir, "achievements.json");
    // 3) (opțional) <cfgDir>/<appid>/achievements.json – auto-generated
    const p3 =
      config.appid != null
        ? path.join(cfgDir, String(config.appid), "achievements.json")
        : null;

    let foundPath = null;
    if (fs.existsSync(p1)) foundPath = p1;
    else if (fs.existsSync(p2)) foundPath = p2;
    else if (p3 && fs.existsSync(p3)) foundPath = p3;

    if (!foundPath) {
      event.sender.send("achievements-missing", {
        configName,
        reason: "no-file",
      });
      return { achievements: null, config_path: cfgDir };
    }

    const achievements = JSON.parse(fs.readFileSync(foundPath, "utf-8"));
    return { achievements, config_path: path.dirname(foundPath) };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      notifyError("Error reading achievements.json file: " + error.message);
    }
    return { achievements: null, config_path: "" };
  }
});

ipcMain.handle("load-saved-achievements", async (_event, configName) => {
  try {
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const saveBase = config.save_path;
    const appid = String(config.appid || "");
    const saveJsonPath = resolveSaveFilePath(saveBase, appid);
    const {
      ini: achievementsIniPath,
      ofx: achievementsIniOnlineFixPath,
      bin: achievementsBinPath,
    } = resolveSaveSidecarPaths(saveBase, appid);

    let effectiveSavePath = "";
    if (fs.existsSync(saveJsonPath))
      effectiveSavePath = path.dirname(saveJsonPath);
    else if (fs.existsSync(achievementsIniPath))
      effectiveSavePath = path.dirname(achievementsIniPath);
    else if (fs.existsSync(achievementsIniOnlineFixPath))
      effectiveSavePath = path.dirname(achievementsIniOnlineFixPath);
    else if (fs.existsSync(achievementsBinPath))
      effectiveSavePath = path.dirname(achievementsBinPath);

    const schemaPath = resolveConfigSchemaPath(config);
    const achievements = loadAchievementsFromSaveFile(
      effectiveSavePath || saveBase,
      {},
      {
        configMeta: config,
        fullSchemaPath: schemaPath,
      }
    );

    return {
      achievements: achievements || {},
      save_path: effectiveSavePath || saveBase || "",
    };
  } catch (error) {
    return { achievements: {}, save_path: "", error: error.message };
  }
});

// Handler for config deletion
ipcMain.handle("delete-config", async (_event, configName) => {
  try {
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${safe}.json`);
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      return { success: true };
    }
    return { success: false, error: "File not found." };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.on("set-animation-duration", (_event, duration) => {
  global.animationDuration = Number(duration);
});

function getPresetAnimationDuration(presetFolder) {
  const presetIndexPath = path.join(presetFolder, "index.html");
  try {
    const content = fs.readFileSync(presetIndexPath, "utf-8");
    const durationMatch = content.match(
      /<meta\s+name="duration"\s+content="(\d+)"\s*\/>/i
    );
    if (durationMatch && !isNaN(durationMatch[1])) {
      const duration = parseInt(durationMatch[1], 10);
      return duration;
    }
  } catch (error) {
    notifyError(
      "Error reading animation duration from preset:" + error.message
    );
  }
  return 5000; // fallback default
}

function getUserPreferredSound() {
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    return prefs.sound || null;
  } catch (err) {
    console.warn("Could not load sound preference:", err);
    return null;
  }
}

let mainWindow;
let tray = null;
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico") // in installer: resources\icon.ico
  : path.join(__dirname, "icon.ico");

function showMainWindowRespectingPrefs() {
  if (!mainWindow) return;
  const prefs = readPrefsSafe();
  if (prefs.startMaximized) {
    mainWindow.maximize();
  }
  mainWindow.show();
}

function createTray() {
  tray = new Tray(ICON_PATH);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show App",
      click: () => {
        showMainWindowRespectingPrefs();
      },
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Achievements App");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    showMainWindowRespectingPrefs();
  });
}

let achievementsFilePath; // achievements.json path
let currentConfigPath;
let previousAchievements = {};

function createMainWindow() {
  let initialZoom = 1;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};
    initialZoom = Number(prefs.windowZoomFactor) || 1;
  } catch {}
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    frame: false,
    show: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 10 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
      zoomFactor: initialZoom,
    },
  });

  const ICON_URL = pathToFileURL(ICON_PATH).toString();
  mainWindow.loadFile("index.html", { query: { icon: ICON_URL } });

  mainWindow.webContents.on("did-finish-load", () => {
    try {
      const prefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
        : {};
      const shouldStartInTray = !!prefs.startInTray;
      const shouldStartMaximized = !!prefs.startMaximized;
      const zoom = Number(prefs.windowZoomFactor) || 1;
      mainWindow.webContents.setZoomFactor(zoom);
      if (!shouldStartInTray) {
        if (shouldStartMaximized) {
          mainWindow.maximize();
        }
        mainWindow.show();
      }
      mainWindow.webContents.send("zoom-factor-changed", zoom);
    } catch (e) {
      mainWindow.webContents.setZoomFactor(1);
      mainWindow.show();
    }
    mainWindow.webContents.send(
      "window-state-change",
      mainWindow.isMaximized()
    );
  });
  global.mainWindow = mainWindow;

  // Track window state changes
  mainWindow.on("maximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", true);
    }
  });

  mainWindow.on("unmaximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", false);
    }
  });
}

function getPresetDimensions(presetFolder) {
  const presetIndexPath = path.join(presetFolder, "index.html");
  try {
    const content = fs.readFileSync(presetIndexPath, "utf-8");
    const metaRegex =
      /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i;
    const match = content.match(metaRegex);
    if (match) {
      return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
  } catch (error) {
    notifyError("Error reading preset: " + error.message);
  }
  // Default values if not defined
  return { width: 400, height: 200 };
}

function createNotificationWindow(message) {
  const preset = message.preset || "default";
  // Check in both scalable and non-scalable folders
  const scalableFolder = path.join(userPresetsFolder, "Scalable", preset);
  const nonScalableFolder = path.join(
    userPresetsFolder,
    "Non-scalable",
    preset
  );
  const oldStyleFolder = path.join(userPresetsFolder, preset);

  // Determine which folder contains the preset
  let presetFolder;
  if (fs.existsSync(scalableFolder)) {
    presetFolder = scalableFolder;
  } else if (fs.existsSync(nonScalableFolder)) {
    presetFolder = nonScalableFolder;
  } else {
    presetFolder = oldStyleFolder; // Fallback to the old structure
  }

  const presetHtml = path.join(presetFolder, "index.html");
  const position = message.position || "center-bottom";
  const scale = parseFloat(message.scale || 1);

  const { width: windowWidth, height: windowHeight } =
    getPresetDimensions(presetFolder);

  // Apply scaling to window dimensions to prevent content overflow
  // at higher scale factors by increasing the window size proportionally
  const scaledWidth = Math.ceil(windowWidth * (scale > 1 ? scale : 1));
  const scaledHeight = Math.ceil(windowHeight * (scale > 1 ? scale : 1));

  const {
    x: ax,
    y: ay,
    width: aw,
    height: ah,
  } = screen.getPrimaryDisplay().workArea;
  const gapX = Math.round(16 * scale);
  const gapY = Math.round(0 * scale);

  let x = 0,
    y = 0;

  switch (position) {
    case "center-top":
      x = ax + Math.floor((aw - scaledWidth) / 2);
      y = ay + gapY;
      break;

    case "top-right":
      x = ax + aw - scaledWidth - gapX;
      y = ay + gapY;
      break;

    case "bottom-right":
      x = ax + aw - scaledWidth - gapX;
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;

    case "top-left":
      x = ax + gapX;
      y = ay + gapY;
      break;

    case "bottom-left":
      x = ax + gapX;
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;

    case "center-bottom":
    default:
      x = ax + Math.floor((aw - scaledWidth) / 2);
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;
  }

  const notificationWindow = new BrowserWindow({
    width: scaledWidth,
    height: scaledHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: "notification",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  notificationWindow.setAlwaysOnTop(true, "screen-saver");
  notificationWindow.setVisibleOnAllWorkspaces(true);
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(false);

  notificationWindow.loadFile(presetHtml);

  notificationWindow.webContents.on("did-finish-load", () => {
    const iconPathToSend =
      message.iconPath ||
      (message.icon ? path.join(message.config_path, message.icon) : "");
    notificationWindow.webContents.send("show-notification", {
      displayName: message.displayName,
      description: message.description,
      iconPath: iconPathToSend,
      scale,
    });
  });

  return notificationWindow;
}

ipcMain.on("show-notification", (_event, achievement) => {
  const displayName = getSafeLocalizedText(
    achievement.displayName,
    selectedLanguage
  );
  const descriptionText = getSafeLocalizedText(
    achievement.description,
    selectedLanguage
  );

  if (displayName && descriptionText) {
    const notificationData = {
      displayName,
      description: descriptionText,
      icon: achievement.icon,
      icon_gray: achievement.icon_gray || achievement.icongray,
      config_path: achievement.config_path,
      preset: achievement.preset,
      position: achievement.position,
      sound: achievement.sound,
    };

    queueAchievementNotification(notificationData);

    const achName = achievement.name;
    if (achName) {
      if (!previousAchievements) previousAchievements = {};
      previousAchievements[achName] = {
        earned: true,
        progress: achievement.progress || undefined,
        max_progress: achievement.max_progress || undefined,
        earned_time: Date.now(),
      };
      if (selectedConfig) {
        savePreviousAchievements(selectedConfig, previousAchievements);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("refresh-achievements-table", selectedConfig);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", selectedLanguage);
    }
  } else {
    notifyError("Achievement syntax not correct:", achievement);
  }
});

// New Image Windows
// Return path to image if exists locally
ipcMain.handle("checkLocalGameImage", async (_event, appid) => {
  const imagePath = path.join(
    app.getPath("userData"),
    "images",
    `${appid}.jpg`
  );
  try {
    await fs.promises.access(imagePath, fs.constants.F_OK);
    return imagePath;
  } catch {
    return null;
  }
});

// Save image locally from renderer
ipcMain.handle("saveGameImage", async (_event, appid, buffer) => {
  try {
    const imageDir = path.join(app.getPath("userData"), "images");
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    const fullPath = path.join(imageDir, `${appid}.jpg`);
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    broadcastToAll("update-image", { appid: String(appid) });
    return { success: true, path: fullPath };
  } catch (err) {
    notifyError("❌ Error saving image: " + err.message);
    return { success: false, error: err.message };
  }
});

// Add new IPC handler for test achievements that doesn't require a config
ipcMain.on("show-test-notification", (event, options) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;

  const notificationData = {
    displayName: "This is a testing achievement notification",
    description: "This is a testing achievement notification for this app",
    icon: "icon.ico", // Use app icon
    icon_gray: "icon.ico", // Use app icon
    config_path: baseDir, // Use app's directory
    preset: options.preset || "default",
    position: options.position || "center-bottom",
    sound: options.sound || "mute",
    scale: parseFloat(
      options.scale != null
        ? options.scale
        : prefs.notificationScale != null
        ? prefs.notificationScale
        : 1
    ),
    skipScreenshot: true,
    isTest: true,
  };

  queueAchievementNotification(notificationData);
});

ipcMain.handle("load-presets", async () => {
  if (!fs.existsSync(userPresetsFolder)) return [];

  try {
    const scalableFolder = path.join(userPresetsFolder, "Scalable");
    const nonScalableFolder = path.join(userPresetsFolder, "Non-scalable");

    const hasScalable = fs.existsSync(scalableFolder);
    const hasNonScalable = fs.existsSync(nonScalableFolder);

    if (hasScalable || hasNonScalable) {
      const scalableDirs = hasScalable
        ? fs
            .readdirSync(scalableFolder, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name)
        : [];

      const nonScalableDirs = hasNonScalable
        ? fs
            .readdirSync(nonScalableFolder, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name)
        : [];

      return {
        scalable: scalableDirs,
        nonScalable: nonScalableDirs,
        isStructured: true,
      };
    }

    const dirs = fs
      .readdirSync(userPresetsFolder, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    const flatDirs = dirs.filter(
      (dir) => dir !== "Scalable" && dir !== "Non-scalable"
    );

    return flatDirs;
  } catch (error) {
    notifyError("Error reading presets: " + error.message);
    return [];
  }
});

const earnedNotificationQueue = [];
let isNotificationShowing = false;
let selectedNotificationScale = 1;
const progressNotificationQueue = [];
let isProgressShowing = false;

function queueAchievementNotification(achievement) {
  const prefs = cachedPreferences || {};
  const preferredScale =
    achievement.scale != null
      ? achievement.scale
      : prefs.notificationScale != null
      ? prefs.notificationScale
      : 1;
  achievement.scale = preferredScale;
  const lang = selectedLanguage || "english";

  const displayName = getSafeLocalizedText(achievement.displayName, lang);
  const description = getSafeLocalizedText(achievement.description, lang);

  const notificationData = {
    displayName: displayName || "",
    description: description || "",
    icon: achievement.icon,
    icon_gray: achievement.icon_gray || achievement.icongray,
    config_path: achievement.config_path,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: !!achievement.skipScreenshot,
    isTest: !!achievement.isTest,
  };

  earnedNotificationQueue.push(notificationData);
  processNextNotification();
}

function processNextNotification() {
  if (isNotificationShowing || earnedNotificationQueue.length === 0) return;

  const achievement = earnedNotificationQueue.shift();
  isNotificationShowing = true;

  const lang = selectedLanguage || "english";

  const notificationData = {
    displayName: achievement.displayName,
    description: achievement.description,
    icon: achievement.icon,
    icon_gray: achievement.icon_gray,
    config_path: achievement.config_path,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: !!achievement.skipScreenshot,
    isTest: !!achievement.isTest,
  };

  const iconCandidate = notificationData.icon || notificationData.icon_gray;
  let iconPathFinal = resolveIconAbsolutePath(
    notificationData.config_path,
    iconCandidate
  );

  if (!iconPathFinal) {
    iconPathFinal = ICON_PATH;
  }
  notificationData.iconPath = iconPathFinal;

  const preset = achievement.preset || "default";
  // Check in both scalable and non-scalable folders
  const scalableFolder = path.join(userPresetsFolder, "Scalable", preset);
  const nonScalableFolder = path.join(
    userPresetsFolder,
    "Non-scalable",
    preset
  );
  const oldStyleFolder = path.join(userPresetsFolder, preset);

  // Determine which folder contains the preset
  let presetFolder;
  if (fs.existsSync(scalableFolder)) {
    presetFolder = scalableFolder;
  } else if (fs.existsSync(nonScalableFolder)) {
    presetFolder = nonScalableFolder;
  } else {
    presetFolder = oldStyleFolder; // Fallback to the old structure
  }

  const duration = getPresetAnimationDuration(presetFolder);
  const notificationWindow = createNotificationWindow(notificationData);

  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    achievement.sound &&
    achievement.sound !== "mute"
  ) {
    mainWindow.webContents.send("play-sound", achievement.sound);
  }

  // Screenshot
  const disableByPrefs = !!cachedPreferences.disableAchievementScreenshot;
  const shouldScreenshot =
    !notificationData.isTest &&
    !notificationData.skipScreenshot &&
    !disableByPrefs;

  const doShot = async () => {
    try {
      if (!screenshot) {
        console.warn("[shot] screenshot-desktop not installed");
        return;
      }
      const gameName = selectedConfig || "Unknown Game";
      const achName = notificationData.displayName || "Achievement";
      const saved = await saveFullScreenShot(gameName, achName);
      console.log("📸 Screenshot saved:", saved);
    } catch (err) {
      console.warn("Screenshot failed:", err.message);
    }
  };

  if (shouldScreenshot) {
    if (notificationWindow.webContents.isLoading()) {
      notificationWindow.webContents.once("did-finish-load", () => {
        setTimeout(doShot, 250);
      });
    } else {
      setTimeout(doShot, 250);
    }
  }

  notificationWindow.on("closed", () => {
    isNotificationShowing = false;
    processNextNotification();
  });

  setTimeout(() => {
    if (!notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  }, duration);
}

function queueProgressNotification(data) {
  progressNotificationQueue.push(data);
  processNextProgressNotification();
}

function processNextProgressNotification() {
  if (isProgressShowing || progressNotificationQueue.length === 0) return;

  const data = progressNotificationQueue.shift();
  isProgressShowing = true;

  const progressWindow = showProgressNotification(data);

  if (progressWindow) {
    progressWindow.on("closed", () => {
      isProgressShowing = false;
      processNextProgressNotification();
    });
  } else {
    isProgressShowing = false;
    processNextProgressNotification();
  }
}

let currentAchievementsFilePath = null;
let achievementsWatcher = null;

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function getCachePath(configName) {
  return path.join(cacheDir, `${configName}_achievements_cache.json`);
}

function loadPreviousAchievements(configName) {
  const cachePath = getCachePath(configName);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch (e) {
      notifyError("Error reading achievement cache: " + e.message);
    }
  }
  return {};
}

function savePreviousAchievements(configName, data) {
  const cachePath = getCachePath(configName);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  } catch (e) {
    notifyError("Error reading achievement cache: " + e.message);
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function readJsonWithRetries(filePath, maxTries = 12, baseDelayMs = 45) {
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      if (
        msg.includes("Unexpected end of JSON input") ||
        msg.includes("Unexpected token") ||
        e.code === "EBUSY"
      ) {
        sleepSync(baseDelayMs + i * 35);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function monitorAchievementsFile(filePath) {
  if (!filePath) {
    if (achievementsWatcher && currentAchievementsFilePath) {
      fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
      achievementsWatcher = null;
    }
    currentAchievementsFilePath = null;
    return;
  }

  if (currentAchievementsFilePath === filePath && achievementsWatcher) {
    return;
  }

  if (achievementsWatcher && currentAchievementsFilePath) {
    fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
    achievementsWatcher = null;
  }

  currentAchievementsFilePath = filePath;
  const safeConfigName = selectedConfig
    ? sanitizeConfigName(selectedConfig)
    : null;
  const configFile = safeConfigName
    ? path.join(configsDir, `${safeConfigName}.json`)
    : null;
  const configName = selectedConfig;
  const configPath = path.join(configsDir, `${configName}.json`);
  let configMeta = null;
  let previousAchievements = loadPreviousAchievements(configName);
  let isFirstLoad = true;
  let touchedInLoop = false;
  let fullConfig = [];
  let crcMap = {};
  try {
    configMeta =
      configFile && fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8"))
        : null;
  } catch (err) {
    console.warn(`Failed to load config ${safeConfigName}: ${err.message}`);
  }
  try {
    if (
      fullAchievementsConfigPath &&
      fs.existsSync(fullAchievementsConfigPath)
    ) {
      fullConfig = JSON.parse(
        fs.readFileSync(fullAchievementsConfigPath, "utf8")
      );
      crcMap = buildCrcNameMap(fullConfig);
    } else {
      fullConfig = [];
      crcMap = {};
    }
  } catch (e) {
    warnOnce(
      `${selectedConfig}`,
      `Could not parse achievements.json": ${e.message}`
    );
    fullConfig = [];
    crcMap = {};
  }
  const processSnapshot = (isRetry = false) => {
    const currentAchievements = loadAchievementsFromSaveFile(
      path.dirname(filePath),
      previousAchievements,
      {
        configMeta,
        selectedConfigPath,
        fullSchemaPath: fullAchievementsConfigPath,
      }
    );
    const hitFallback = currentAchievements === previousAchievements;
    if (hitFallback) {
      if (!isRetry) {
        setTimeout(() => processSnapshot(true), 220);
      }
      return;
    }

    const isFirstTime = Object.keys(previousAchievements).length === 0;
    if (isFirstLoad && isFirstTime) {
      const earnedKeys = Object.keys(currentAchievements).filter(
        (key) =>
          currentAchievements[key].earned === true ||
          currentAchievements[key].earned === 1
      );

      if (earnedKeys.length > 0) {
        earnedKeys.forEach((key) => {
          const current = currentAchievements[key];
          const isBin = path.basename(filePath).endsWith(".bin");
          const achievementConfig = fullConfig.find((a) => a.name === key);

          const lang = selectedLanguage || "english";
          const selectedSound = getUserPreferredSound();
          const displayName = getSafeLocalizedText(
            achievementConfig?.displayName,
            lang
          );
          const description = getSafeLocalizedText(
            achievementConfig?.description,
            lang
          );

          if (achievementConfig) {
            queueAchievementNotification({
              displayName,
              description,
              icon: achievementConfig.icon,
              icon_gray: achievementConfig.icon_gray,
              config_path: selectedConfigPath,
              preset: selectedPreset,
              position: selectedPosition,
              sound: selectedSound || "mute",
              soundPath: selectedSound
                ? path.join(app.getAppPath(), "sounds", selectedSound)
                : null,
            });
            previousAchievements[key] = {
              earned: true,
              earned_time: current.earned_time || Date.now(),
              progress: current.progress,
              max_progress: current.max_progress,
            };
          }
        });
      }

      if (!global.disableProgress) {
        const pendingProgress = Object.keys(currentAchievements).filter(
          (key) => {
            const cur = currentAchievements[key];
            const alreadyEarned =
              cur?.earned === true || cur?.earned === 1 || false;
            const curProg = Number(cur?.progress);
            const curMax = Number(cur?.max_progress);
            return (
              !alreadyEarned &&
              Number.isFinite(curProg) &&
              Number.isFinite(curMax) &&
              curMax > 0 &&
              curProg > 0
            );
          }
        );

        if (pendingProgress.length) {
          const isBin = path.basename(filePath).endsWith(".bin");
          for (const key of pendingProgress) {
            const cur = currentAchievements[key];
            const achievementConfig = isBin
              ? crcMap[key.toLowerCase()]
              : fullConfig.find((a) => a.name === key || a.name === cur?.name);
            if (!achievementConfig) continue;

            queueProgressNotification({
              displayName: getSafeLocalizedText(
                achievementConfig.displayName,
                selectedLanguage
              ),
              icon: achievementConfig.icon,
              progress: cur.progress,
              max_progress: cur.max_progress,
              config_path: selectedConfigPath,
            });
          }
        }
      }
      if (isFirstLoad) {
        previousAchievements = { ...currentAchievements };
      }
    }

    touchedInLoop = false;

    Object.keys(currentAchievements).forEach((key) => {
      const current = currentAchievements[key];
      const previous = previousAchievements[key];
      const lang = selectedLanguage || "english";
      const newlyEarned =
        Boolean(current.earned) && (!previous || !Boolean(previous.earned));

      if (newlyEarned) {
        touchedInLoop = true;
        const isBin = path.basename(filePath).endsWith(".bin");
        const achievementConfig = fullConfig.find((a) => a.name === key);

        if (!achievementConfig) {
          console.warn(`Achievement config not found for key: ${key}`);
          return;
        }
        if (achievementConfig) {
          const notificationData = {
            displayName:
              typeof achievementConfig.displayName === "object"
                ? achievementConfig.displayName[lang] ||
                  achievementConfig.displayName.english ||
                  Object.values(achievementConfig.displayName)[0]
                : achievementConfig.displayName,

            description:
              typeof achievementConfig.description === "object"
                ? achievementConfig.description[lang] ||
                  achievementConfig.description.english ||
                  Object.values(achievementConfig.description)[0]
                : achievementConfig.description,
            icon: achievementConfig.icon,
            icon_gray:
              achievementConfig.icon_gray || achievementConfig.icongray,
            config_path: selectedConfigPath,
            preset: selectedPreset,
            position: selectedPosition,
            sound: getUserPreferredSound() || "mute",
          };

          queueAchievementNotification(notificationData);

          mainWindow.webContents.send("refresh-achievements-table");
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send("load-overlay-data", selectedConfig);
            overlayWindow.webContents.send("set-language", selectedLanguage);
          }
        }
      }
      const stillLocked = !(current?.earned === true || current?.earned === 1);
      const curProgress = Number(current?.progress);
      const curMax = Number(current?.max_progress);
      const prevProgress = Number(previous?.progress);
      const prevMax = Number(previous?.max_progress);
      const hasProgress =
        Number.isFinite(curProgress) && Number.isFinite(curMax) && curMax > 0;
      const progressChanged =
        stillLocked &&
        hasProgress &&
        (!Number.isFinite(prevProgress) ||
          !Number.isFinite(prevMax) ||
          curProgress !== prevProgress ||
          curMax !== prevMax);

      if (progressChanged) {
        touchedInLoop = true;
        const isBin = path.basename(filePath).endsWith(".bin");
        const achievementConfig = isBin
          ? crcMap[key.toLowerCase()]
          : fullConfig.find((a) => a.name == key || a.name == current?.name);

        if (achievementConfig) {
          if (!global.disableProgress) {
            queueProgressNotification({
              displayName: getSafeLocalizedText(
                achievementConfig.displayName,
                selectedLanguage
              ),
              icon: achievementConfig.icon,
              progress: current.progress,
              max_progress: current.max_progress,
              config_path: selectedConfigPath,
            });
          }

          mainWindow.webContents.send("refresh-achievements-table");
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send("load-overlay-data", selectedConfig);
            overlayWindow.webContents.send("set-language", selectedLanguage);
          }
        }
      }
    });

    if (touchedInLoop) {
      broadcastToAll("achievements:file-updated", {
        appid: currentAppId || null,
        configName,
      });
    }
    const appid = String(configMeta?.appid || currentAppId || "");
    currentAppId = appid || null;
    previousAchievements = currentAchievements;
    savePreviousAchievements(configName, previousAchievements);
    isFirstLoad = false;
  };
  achievementsWatcher = () => processSnapshot(false);
  const checkFileLoop = () => {
    if (fs.existsSync(filePath)) {
      processSnapshot(false);

      mainWindow.webContents.send("refresh-achievements-table");
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", selectedLanguage);
      }

      fs.watchFile(filePath, { interval: 1000 }, achievementsWatcher);
    } else {
      const baseDir = path.dirname(filePath);
      const iniPath = path.join(baseDir, "achievements.ini");
      const onlineFixIniPath = path.join(baseDir, "Stats", "achievements.ini");
      const binPath = path.join(baseDir, "stats.bin");

      if (fs.existsSync(iniPath)) {
        monitorAchievementsFile(iniPath);
        return;
      }

      if (fs.existsSync(onlineFixIniPath)) {
        monitorAchievementsFile(onlineFixIniPath);
        return;
      }

      if (fs.existsSync(binPath)) {
        monitorAchievementsFile(binPath);
        return;
      }

      setTimeout(checkFileLoop, 1000);
    }
  };

  checkFileLoop();
}

let fullAchievementsConfigPath;
let selectedConfigPath = null;
let selectedConfig = null;
let selectedSound = "mute";
let selectedPreset = "default";
let selectedPosition = "center-bottom";

ipcMain.on("update-config", (event, { configName, preset, position }) => {
  const safeName = configName ? sanitizeConfigName(configName) : null;

  if (!safeName) {
    if (achievementsWatcher && achievementsFilePath) {
      fs.unwatchFile(achievementsFilePath, achievementsWatcher);
      achievementsWatcher = null;
    }
    achievementsFilePath = null;
    selectedConfig = null;

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", selectedLanguage);
    }
    return;
  }

  const cfgFile = path.join(configsDir, `${safeName}.json`);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
  } catch (err) {
    notifyError("Error reading configPath: " + err.message);
    return;
  }

  selectedPreset = preset || "default";
  selectedPosition = position || "center-bottom";
  selectedConfig = configName;
  selectedConfigPath = isNonEmptyString(config.config_path)
    ? config.config_path
    : null;
  fullAchievementsConfigPath = isNonEmptyString(config.config_path)
    ? path.join(config.config_path, "achievements.json")
    : null;

  if (!isNonEmptyString(config.save_path)) {
    monitorAchievementsFile(null);
    achievementsFilePath = null;
    event.sender.send("achievements-missing", {
      configName,
      reason: "no-save-path",
    });
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", selectedLanguage);
    }
    return;
  }
  if (selectedConfigPath) {
    const c1 = fullAchievementsConfigPath; // <config_path>/achievements.json
    const c2 =
      config.appid != null
        ? path.join(
            selectedConfigPath,
            String(config.appid),
            "achievements.json"
          )
        : null;

    if (c1 && fs.existsSync(c1)) {
    } else if (c2 && fs.existsSync(c2)) {
      fullAchievementsConfigPath = c2;
      selectedConfigPath = path.dirname(c2);
    }
    const appid = String(config.appid || "");
    currentAppId = appid || null;
  }

  const appid = String(config.appid || "");
  const saveBase = config.save_path;

  const saveJsonPath = resolveSaveFilePath(saveBase, appid);
  const {
    ini: iniPath,
    ofx: onlineFixIniPath,
    bin: binPath,
  } = resolveSaveSidecarPaths(saveBase, appid);

  if (fs.existsSync(saveJsonPath)) achievementsFilePath = saveJsonPath;
  else if (onlineFixIniPath) achievementsFilePath = onlineFixIniPath;
  else if (iniPath) achievementsFilePath = iniPath;
  else if (binPath) achievementsFilePath = binPath;
  else achievementsFilePath = saveJsonPath; // fallback

  monitorAchievementsFile(achievementsFilePath);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", selectedLanguage);
  }
});

async function waitForPathExists(p, tries = 50, delay = 60) {
  return new Promise((resolve) => {
    const tick = (n) => {
      try {
        if (fs.existsSync(p)) return resolve(true);
      } catch {}
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), delay);
    };
    tick(tries);
  });
}

ipcMain.handle("get-config-by-name", async (_event, name) => {
  const safe = sanitizeConfigName(name || "");
  if (!safe) throw new Error("Invalid name");

  if (getConfigInflight.has(safe)) return getConfigInflight.get(safe);

  const job = (async () => {
    let configPath = path.join(configsDir, `${safe}.json`);
    if (!fs.existsSync(configPath)) {
      await waitForPathExists(configPath, 60, 70);
    }

    if (!fs.existsSync(configPath)) {
      try {
        const files = fs
          .readdirSync(configsDir)
          .filter((f) => f.toLowerCase().endsWith(".json"));
        const target = safe.toLowerCase();

        const matchName = (val) =>
          sanitizeConfigName(String(val || "")).toLowerCase() === target;

        for (const f of files) {
          const full = path.join(configsDir, f);
          let obj;
          try {
            obj = readJsonWithRetries(full, 6, 35);
          } catch {
            obj = null;
          }
          const base = path.basename(f, ".json");

          const nameCandidates = [
            obj?.name,
            obj?.displayName,
            obj?.appid,
            obj?.appId,
            obj?.steamAppId,
            base,
          ].filter(Boolean);

          const ok = nameCandidates.some((val) => {
            if (/^\d+$/.test(target) && /^\d+$/.test(String(val || ""))) {
              return String(val) === target;
            }
            return matchName(val);
          });

          if (ok) {
            configPath = full;
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!fs.existsSync(configPath)) {
      return { __notFound: true, name: safe };
    }

    let data;
    try {
      data = readJsonWithRetries(configPath, 8, 40);
    } catch (e) {
      return { __notFound: true, name: safe, __error: "corrupt-or-busy" };
    }

    const appid = String(data?.appid || data?.appId || data?.steamAppId || "");
    const hasAppId = /^\d+$/.test(appid);
    const hasConfigPath = isNonEmptyString(data?.config_path);

    const probe = [];
    if (hasConfigPath) {
      probe.push(path.join(data.config_path, "achievements.json"));
      probe.push(
        path.join(data.config_path, "steam_settings", "achievements.json")
      );
      if (hasAppId)
        probe.push(path.join(data.config_path, appid, "achievements.json"));
    }

    let foundSchemaPath = null;
    for (const p of probe) {
      if (p && fs.existsSync(p) && looksLikeSchemaArray(readJsonSafe(p))) {
        foundSchemaPath = p;
        break;
      }
    }

    if (!foundSchemaPath && hasAppId) {
      const candidateDir = path.join(configsDir, "schema", appid);
      const candidateJson = path.join(candidateDir, "achievements.json");
      if (!fs.existsSync(candidateJson))
        await waitForPathExists(candidateJson, 80, 60);
      if (
        fs.existsSync(candidateJson) &&
        looksLikeSchemaArray(readJsonSafe(candidateJson))
      ) {
        data.config_path = candidateDir;
        try {
          const now = readJsonWithRetries(configPath, 3, 40);
          if (now.config_path !== candidateDir) {
            now.config_path = candidateDir;
            fs.writeFileSync(configPath, JSON.stringify(now, null, 2));
            data = now;
          }
        } catch {}
        foundSchemaPath = candidateJson;
      }
    }

    if (!isNonEmptyString(data.save_path)) {
      try {
        const tryBase = data.config_path || "";
        if (isNonEmptyString(tryBase) && hasAppId) {
          const detected = findSaveBaseFromSelection(tryBase, appid);
          if (detected) {
            data.save_path = detected;
            try {
              const now = readJsonWithRetries(configPath, 2, 40);
              if (now.save_path !== detected) {
                now.save_path = detected;
                fs.writeFileSync(configPath, JSON.stringify(now, null, 2));
                data = now;
              }
            } catch {}
          }
        }
      } catch {}
    }

    const schemaReady =
      !!foundSchemaPath ||
      (hasConfigPath &&
        [
          path.join(data.config_path, "achievements.json"),
          path.join(data.config_path, "steam_settings", "achievements.json"),
          hasAppId
            ? path.join(data.config_path, appid, "achievements.json")
            : null,
        ].some((p) => p && fs.existsSync(p)));

    return { ...data, __schemaReady: schemaReady };
  })()
    .catch((err) => ({
      __error: String(err?.message || err),
      __failed: true,
      name: safe,
    }))
    .finally(() => {
      getConfigInflight.delete(safe);
    });

  getConfigInflight.set(safe, job);
  return job;
});

ipcMain.handle("renameAndSaveConfig", async (event, oldName, newConfig) => {
  try {
    const safeOld = sanitizeConfigName(oldName);
    const safeNew = sanitizeConfigName(newConfig.name);

    const oldConfigPath = path.join(configsDir, `${safeOld}.json`);
    const newConfigPath = path.join(configsDir, `${safeNew}.json`);
    const oldCachePath = getCachePath(safeOld);
    const newCachePath = getCachePath(safeNew);

    if (safeOld !== safeNew && fs.existsSync(oldConfigPath)) {
      fs.renameSync(oldConfigPath, newConfigPath);
    }

    const payload = {
      ...newConfig,
      name: safeNew,
      displayName: newConfig.displayName || newConfig.name,
      config_path: isNonEmptyString(newConfig.config_path)
        ? newConfig.config_path
        : null,
      save_path: isNonEmptyString(newConfig.save_path)
        ? newConfig.save_path
        : null,
      executable: isNonEmptyString(newConfig.executable)
        ? newConfig.executable
        : null,
      arguments: isNonEmptyString(newConfig.arguments)
        ? newConfig.arguments
        : "",
      process_name: isNonEmptyString(newConfig.process_name)
        ? newConfig.process_name
        : "",
    };

    // missing config_path, generate and set path
    if (!payload.config_path && /^\d+$/.test(String(payload.appid || ""))) {
      try {
        global.mainWindow = BrowserWindow.fromWebContents(event.sender);
      } catch {}
      const res = await ensureSchemaForApp(payload.appid);
      if (res && res.dir) payload.config_path = res.dir;
    }
    try {
      const selForSave = isNonEmptyString(payload.save_path)
        ? payload.save_path
        : isNonEmptyString(payload.config_path)
        ? payload.config_path
        : null;

      if (
        isNonEmptyString(selForSave) &&
        fs.existsSync(selForSave) &&
        /^\d+$/.test(String(payload.appid || ""))
      ) {
        const detectedBase = findSaveBaseFromSelection(
          selForSave,
          payload.appid
        );
        if (detectedBase) payload.save_path = detectedBase;
      }
    } catch {}
    fs.writeFileSync(newConfigPath, JSON.stringify(payload, null, 2));

    if (fs.existsSync(oldCachePath)) {
      fs.renameSync(oldCachePath, newCachePath);
    }
    notifyConfigsChanged();
    return {
      success: true,
      message: `Config "${oldName}" has been renamed and saved.`,
    };
  } catch (error) {
    return { success: false, message: "Failed to rename and save config." };
  }
});

ipcMain.on("close-notification-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }, global.animationDuration);
});

let overlayWindow = null;

function createOverlayWindow(selectedConfig) {
  const { width, height } =
    require("electron").screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 450,
    height: 950,
    x: width - 470,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setFocusable(false);
  overlayWindow.blur();
  const ICON_URL = pathToFileURL(ICON_PATH).toString();
  overlayWindow.loadFile("overlay.html", { query: { icon: ICON_URL } });

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", selectedLanguage);
  });

  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};

    if (prefs.language) {
      selectedLanguage = prefs.language;
    }
  } catch (err) {
    notifyError("❌ Failed to load language preference: " + err.message);
  }

  let overlayShortcut = null;

  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};

    overlayShortcut = prefs.overlayShortcut || null;

    selectedLanguage = prefs.language || "english";

    if (overlayShortcut) {
      registerOverlayShortcut(overlayShortcut);
    }
  } catch (err) {
    notifyError("❌ Failed to load preferences: " + err.message);
  }

  let registeredShortcut = null;

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

ipcMain.handle("selectExecutable", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("launchExecutable", async (_event, exePath, argsString) => {
  try {
    const args = argsString.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const child = spawn(exePath, args, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        notifyError("❌ File not found: " + exePath);
      } else if (err.code === "EACCES") {
        notifyError(
          "❌ Permission denied. Try running the app as administrator or check file permissions."
        );
      } else {
        notifyError("❌ Failed to launch executable: " + err.message);
      }
    });
    child.unref();

    if (selectedConfig) {
      const configPath = path.join(configsDir, `${selectedConfig}.json`);
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const safeConfigName = sanitizeConfigName(selectedConfig);
        configData.__playtimeKey = safeConfigName;
        manualLaunchInProgress = true;
        detectedConfigName = configData.name;
        activePlaytimeConfigs.add(configData.name);
        //if (!global.disablePlaytime) startPlaytimeLogWatcher(configData);
        startPlaytimeLogWatcher(configData);
      } else {
        notifyError(`❌ Config file not found for: ${selectedConfig}`);
      }
    } else {
      notifyError(
        `❌ selectedConfig is null – cannot start playtime log watcher.`
      );
    }
  } catch (err) {
    notifyError("Failed to launch executable: " + err.message);
  }
});

let currentAppId = null;

ipcMain.on("toggle-overlay", (_event, selectedConfig) => {
  if (!selectedConfig) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow(selectedConfig);
  } else {
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", selectedLanguage);
  }
});

// Handle request for current config from overlay
ipcMain.on("request-current-config", (event) => {
  if (selectedConfig) {
    event.sender.send("load-overlay-data", selectedConfig);
    event.sender.send("set-language", selectedLanguage);
  }
});

ipcMain.on(
  "refresh-ui-after-language-change",
  (event, { language, configName }) => {
    selectedLanguage = language;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("refresh-achievements-table", configName);
    }

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", selectedLanguage);
    }
  }
);

function minimizeWindow() {
  if (mainWindow) mainWindow.hide();
}

function maximizeWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
}

function closeWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
}

ipcMain.on("minimize-window", minimizeWindow);
ipcMain.on("maximize-window", maximizeWindow);
ipcMain.on("close-window", closeWindow);

app.whenReady().then(async () => {
  // Load preferences
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};

    if (prefs.language) {
      selectedLanguage = prefs.language;
    }
    global.disableProgress = prefs.disableProgress === true;
    global.disablePlaytime = prefs.disablePlaytime === true;
    selectedSound = prefs.sound || "mute";
    selectedPreset = prefs.preset || "default";
    selectedPosition = prefs.position || "center-bottom";
  } catch (err) {
    notifyError("❌ Failed to load language preference: " + err.message);
  }

  copyFolderOnce(defaultSoundsFolder, userSoundsFolder);
  copyFolderOnce(defaultPresetsFolder, userPresetsFolder);

  createMainWindow();
  setInterval(autoSelectRunningGameConfig, 2000);
  createTray();
  mainWindow.hide();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

function showProgressNotification(data) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const progressWindow = new BrowserWindow({
    width: 350,
    height: 150,
    x: 20,
    y: height - 140,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  progressWindow.setAlwaysOnTop(true, "screen-saver");
  progressWindow.setVisibleOnAllWorkspaces(true);
  progressWindow.setFullScreenable(false);
  progressWindow.setFocusable(false);
  progressWindow.loadFile("progress.html");

  progressWindow.once("ready-to-show", () => {
    progressWindow.show();
    progressWindow.webContents.send("show-progress", data);
  });

  setTimeout(() => {
    if (!progressWindow.isDestroyed()) progressWindow.close();
  }, 5000);
  return progressWindow;
}
ipcMain.on("disable-progress-check", (event) => {
  event.returnValue = global.disableProgress || false;
});

ipcMain.on("set-disable-progress", (_, value) => {
  global.disableProgress = value;
});

// === Disable Playtime: check + set ===
ipcMain.on("disable-playtime-check", (event) => {
  event.returnValue = global.disablePlaytime || false;
});

ipcMain.on("set-disable-playtime", (_event, value) => {
  global.disablePlaytime = !!value;
  try {
    global.disablePlaytime = !!value;
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    cur.disablePlaytime = !!value;
    fs.writeFileSync(preferencesPath, JSON.stringify(cur, null, 2));
  } catch (err) {
    notifyError("❌ Failed to persist disablePlaytime: " + err.message);
  }
});

let playtimeWindow = null;
let playtimeAlreadyClosing = false;
let pendingPlayData = null;

let __lastPlaySig = null,
  __lastPlayAt = 0;
function isDuplicatePlay(data) {
  try {
    const sig = [
      data?.phase || "start",
      data?.displayName || data?.name || "",
      data?.description || "",
    ].join("|");
    const now = Date.now();
    if (__lastPlaySig === sig && now - __lastPlayAt < 1000) return true;
    __lastPlaySig = sig;
    __lastPlayAt = now;
  } catch {}
  return false;
}

function normalizePlayPayload(raw) {
  const p = raw || {};
  const displayName = p.displayName || p.name || "Unknown Game";
  const description =
    p.description || (p.phase === "start" ? "Start Playtime!" : "");
  return { ...p, displayName, description };
}

ipcMain.on("show-playtime", (_event, playData) => {
  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) {
      if (playtimeWindow && !playtimeWindow.isDestroyed())
        playtimeWindow.close();
      return;
    }
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }

  const normalized = normalizePlayPayload(playData);
  if (isDuplicatePlay(normalized)) return;
  createPlaytimeWindow(normalized);
});

function createPlaytimeWindow(playData = {}) {
  const phase = playData.phase || "start";

  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) return;
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }

  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    if (!playtimeAlreadyClosing) {
      playtimeAlreadyClosing = true;
      pendingPlayData = normalizePlayPayload(playData);
      try {
        playtimeWindow.webContents.send(
          "start-close-animation",
          pendingPlayData
        );
      } catch {}
      setTimeout(() => {
        try {
          if (playtimeWindow && !playtimeWindow.isDestroyed())
            playtimeWindow.close();
        } finally {
          playtimeAlreadyClosing = false;
        }
      }, 1200);
    }
    return;
  }

  const { width: sw } =
    require("electron").screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 460,
    winHeight = 340;
  const x = Math.floor((sw - winWidth) / 2),
    y = 40;

  playtimeWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    type: "notification",
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
  playtimeWindow.setAlwaysOnTop(true, "screen-saver");
  playtimeWindow.setVisibleOnAllWorkspaces(true);
  playtimeWindow.setFullScreenable(false);
  playtimeWindow.setFocusable(false);
  playtimeWindow.loadFile("playtime.html");

  playtimeWindow.webContents.once("dom-ready", () => {
    try {
      const prefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
        : {};
      const scale = prefs.notificationScale || 1;
      const source = pendingPlayData ?? playData;
      const payload = normalizePlayPayload({ ...source, phase, scale });

      pendingPlayData = null;
      playtimeAlreadyClosing = false;
      playtimeWindow.show();
      playtimeWindow.webContents.send("show-playtime", payload);
    } catch (err) {
      console.error("[playtime] send failed:", err.message);
    }
  });

  ipcMain.once("close-playtime-window", () => {
    const next = pendingPlayData;
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.close();
      playtimeAlreadyClosing = false;
    }
    if (next) {
      pendingPlayData = null;
      createPlaytimeWindow(next);
    }
  });

  playtimeWindow.on("closed", () => {
    playtimeWindow = null;
    playtimeAlreadyClosing = false;
    pendingPlayData = null;
  });
}

ipcMain.on("queue-achievement-notification", (_event, payload) => {
  try {
    queueAchievementNotification(payload);
  } catch (err) {
    notifyError(`queue-achievement-notification failed: ${err.message}`);
  }
});

ipcMain.on("queue-progress-notification", (_event, payload) => {
  try {
    queueProgressNotification(payload);
  } catch (err) {
    notifyError(`queue-progress-notification failed: ${err.message}`);
  }
});

ipcMain.on("notify-from-child", (_event, message) => {
  if (typeof message === "string" && message.trim()) {
    notifyInfo(message);
  }
});

const { pathToFileURL } = require("url");

async function importPsListWrapper() {
  const tryPaths = [
    path.join(__dirname, "utils", "pslist-wrapper.mjs"),
    path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "utils",
      "pslist-wrapper.mjs"
    ),
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
}

let detectedConfigName = null;
const activePlaytimeConfigs = new Set();

async function autoSelectRunningGameConfig() {
  try {
    const { getProcesses } = await importPsListWrapper();
    const processes = await getProcesses();
    if (process.env.ACH_LOG_PROCESSES === "1") {
      const logPath = path.join(app.getPath("userData"), "process-log.txt");
      fs.writeFileSync(
        logPath,
        processes.map((p) => p.name).join("\n"),
        "utf8"
      );
    }

    if (manualLaunchInProgress) {
      const configPath = path.join(configsDir, `${detectedConfigName}.json`);
      if (!fs.existsSync(configPath)) {
        manualLaunchInProgress = false;
        detectedConfigName = null;
      } else {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const exeName = path.basename(config.process_name || "").toLowerCase();
        const isRunning = processes.some(
          (p) => p.name.toLowerCase() === exeName
        );

        if (!isRunning) {
          notifyInfo(`${config.name} closed.`);
          manualLaunchInProgress = false;
          activePlaytimeConfigs.delete(config.name);
          detectedConfigName = null;
        }
      }
    }

    try {
      const configs = listConfigs();

      if (detectedConfigName) {
        const configPath = path.join(configsDir, `${detectedConfigName}.json`);
        if (!fs.existsSync(configPath)) {
          detectedConfigName = null;
        } else {
          const configData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const exeName = path
            .basename(configData.process_name || "")
            .toLowerCase();
          const isStillRunning = processes.some(
            (p) => p.name.toLowerCase() === exeName
          );

          if (!isStillRunning) {
            notifyInfo(`${configData.name} closed.`);
            activePlaytimeConfigs.delete(configData.name);
            if (detectedConfigName === configData.name)
              detectedConfigName = null;
          }
        }
      }

      for (const activeName of [...activePlaytimeConfigs]) {
        const cfgPath = path.join(configsDir, `${activeName}.json`);
        if (!fs.existsSync(cfgPath)) {
          activePlaytimeConfigs.delete(activeName);
          if (detectedConfigName === activeName) detectedConfigName = null;
          continue;
        }

        const cfgData = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        const exe = path.basename(cfgData.process_name || "").toLowerCase();
        const stillRunning = processes.some(
          (p) => p.name.toLowerCase() === exe
        );

        if (!stillRunning) {
          notifyInfo(`${cfgData.name} closed.`);
          activePlaytimeConfigs.delete(activeName);
          if (detectedConfigName === activeName) detectedConfigName = null;
        }
      }

      for (const configName of configs) {
        if (activePlaytimeConfigs.has(configName)) continue;
        const configPath = path.join(configsDir, `${configName}.json`);
        if (!fs.existsSync(configPath)) continue;

        const configData = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (!configData.process_name) continue;

        const exeName = path.basename(configData.process_name).toLowerCase();
        const isRunning = processes.some(
          (p) => p.name.toLowerCase() === exeName
        );

        if (isRunning) {
          detectedConfigName = configName;
          activePlaytimeConfigs.add(configName);
          notifyInfo(`${configData.name} started.`);
          configData.__playtimeKey = sanitizeConfigName(configName);

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("auto-select-config", configName);
            //if (!global.disablePlaytime) startPlaytimeLogWatcher(configData);
            startPlaytimeLogWatcher(configData);
          }
          return;
        }
      }
    } catch (err) {
      notifyError("Error in autoSelectRunningGameConfig: " + err.message);
    }
  } catch (err) {
    notifyError("Error in autoSelectRunningGameConfig: " + err.message);
  }
}

ipcMain.handle("resolve-icon-url", async (_event, configPath, rel) => {
  try {
    const p = resolveIconAbsolutePath(configPath, rel);
    if (!p) {
      return pathToFileURL(ICON_PATH).toString();
    }
    await fs.promises.access(p, fs.constants.R_OK);
    return pathToFileURL(p).toString();
  } catch {
    return pathToFileURL(ICON_PATH).toString();
  }
});

const {
  generateGameConfigs,
  generateConfigForAppId,
} = require("./utils/auto-config-generator");
const {
  loadAchievementsFromSaveFile,
  getSafeLocalizedText,
  buildCrcNameMap,
  resolveConfigSchemaPath,
} = require("./utils/achievement-data");
ipcMain.handle("parse-stats-bin", async (_event, filePath) => {
  try {
    const parseStatsBin = require("./utils/parseStatsBin");
    return parseStatsBin(filePath);
  } catch (err) {
    notifyError(`parse-stats-bin failed: ${err.message}`);
    throw err;
  }
});

ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("get-display-workarea", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      return display.workAreaSize || display.size;
    }
  } catch {}
  const primary = screen.getPrimaryDisplay();
  return primary?.workAreaSize || primary?.size || { width: 0, height: 0 };
});

ipcMain.handle("generate-auto-configs", async (event, folderPath) => {
  const outputDir = configsDir;
  global.mainWindow = BrowserWindow.fromWebContents(event.sender);
  try {
    const result = await generateGameConfigs(folderPath, outputDir, {
      onSeedCache: ({ appid, configName, snapshot }) => {
        try {
          savePreviousAchievements(configName, snapshot);
        } catch (e) {
          console.warn(
            `[seed-cache] ${configName} (${appid}) failed: ${e.message}`
          );
        }
      },
    });
    if (!result || result.processed === 0) {
      return {
        success: false,
        message: "No AppID found inside folder.",
      };
    }
    return {
      success: true,
      message: "Configs generated successfully!",
    };
  } catch (error) {
    console.error("Error generating configs:", error);
    return { success: false, message: error.message };
  }
});

const {
  hasStartupTask,
  createStartupTask,
  deleteStartupTask,
} = require("./utils/startup-task");

function quoteForCmd(arg) {
  const stringified = String(arg ?? "");
  return `"${stringified.replace(/"/g, '""')}"`;
}

function buildStartupCommandLine() {
  const exe = quoteForCmd(process.execPath);
  const argList = process.argv.slice(1).map(quoteForCmd);
  return [exe].concat(argList).join(" ").trim();
}

ipcMain.handle("startup:get-start-with-windows", async () => {
  return await hasStartupTask();
});

ipcMain.handle("startup:set-start-with-windows", async (_e, enabled) => {
  if (enabled) {
    const commandLine = buildStartupCommandLine();
    await createStartupTask(commandLine);
  } else {
    await deleteStartupTask();
  }
  return true;
});

const { fetchSteamDbLibraryCover } = require("./utils/steamdb-cover");

ipcMain.handle("covers:steamdb", async (_evt, appid) => {
  try {
    const url = await fetchSteamDbLibraryCover(String(appid));
    return { ok: true, url };
  } catch (err) {
    const notFound = err && err.tag === Symbol.for("steamdb-miss");
    return { ok: false, notFound, message: String(err?.message || err) };
  }
});

const {
  accumulatePlaytime,
  getPlaytimeTotal,
} = require("./utils/playtime-store");

ipcMain.on("playtime:session-ended", (_event, payload = {}) => {
  const totalMs = typeof payload.totalMs === "number" ? payload.totalMs : 0;

  broadcastToAll("playtime:update", {
    configName: payload.configName || "",
    totalMs,
  });
});

ipcMain.handle("playtime:get-total", async (_event, configName) => {
  const safe = sanitizeConfigName(configName);
  return { totalMs: getPlaytimeTotal(safe) };
});

const makeWatchedFolders = require("./utils/watched-folders");

makeWatchedFolders({
  app,
  ipcMain,
  BrowserWindow,
  preferencesPath,
  configsDir,
  generateGameConfigs,
  generateConfigForAppId,
  notifyWarn: (m) => console.warn(m),
  onSeedCache: ({ appid, configName, snapshot }) => {
    try {
      savePreviousAchievements(configName, snapshot);
    } catch (e) {
      console.warn(`${configName} (${appid}) failed: ${e.message}`);
    }
  },
  getCachedSnapshot: (configName) => {
    try {
      const cachePath = getCachePath(configName);
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, "utf8");
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`${configName} failed: ${err.message}`);
    }
    return null;
  },
  onEarned: (payload) => queueAchievementNotification(payload),
  onProgress: (payload) => {
    if (global.disableProgress) return;
    queueProgressNotification(payload);
  },
  isConfigActive: (name) =>
    sanitizeConfigName(name) === sanitizeConfigName(selectedConfig),
});

// === screenshots support ===
let screenshot = null;
try {
  screenshot = require("screenshot-desktop");
} catch (e) {
  console.warn(
    '⚠️ "screenshot-desktop" missing. Run: npm i screenshot-desktop'
  );
}

function readPrefsSafe() {
  try {
    return fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
  } catch {
    return {};
  }
}

app.on("before-quit", () => {
  manualLaunchInProgress = false;
  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    playtimeWindow.destroy();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
