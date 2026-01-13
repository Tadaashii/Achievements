const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  globalShortcut,
  Tray,
} = require("electron");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-hid-blocklist");
app.setName("Achievements");
const { spawn, fork, execFile, execFileSync, spawnSync } =
  require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ini = require("ini");
const chokidar = require("chokidar");
app.disableHardwareAcceleration();
const CRC32 = require("crc-32");
const { copyFolderOnce, copyFolderOverwrite } = require("./utils/fileCopy");
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
const { createLogger } = require("./utils/logger");

const appLogger = createLogger("app");
const notificationLogger = createLogger("notifications");
const windowLogger = createLogger("windows");
const ipcLogger = createLogger("ipc");
const uiLogger = createLogger("ui");
const coverUiLogger = createLogger("covers");
const prefsLogger = createLogger("preferences");
const persistenceLogger = createLogger("persistence");
const execLogger = createLogger("execution");
const schemaLogger = createLogger("achschema");

const PRESETS_MIGRATION_VERSION = "2026-01-12-duration";

function runWindowsConfirm({ title, message }) {
  const ps = process.env.SystemRoot
    ? path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      )
    : "powershell.exe";
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$title = $env:ACH_CONFIRM_TITLE;",
    "$message = $env:ACH_CONFIRM_MESSAGE;",
    "$result = [System.Windows.Forms.MessageBox]::Show($message, $title, 'OKCancel', 'Question');",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }",
  ].join(" ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const env = {
    ...process.env,
    ACH_CONFIRM_TITLE: title || app.getName() || "Confirm",
    ACH_CONFIRM_MESSAGE: message || "Are you sure?",
  };
  try {
    const res = spawnSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      { env, stdio: "ignore", windowsHide: true }
    );
    if (typeof res.status === "number") {
      return res.status === 0;
    }
    if (res.error) {
      appLogger.error("ui:confirm:powershell-failed", {
        error: res.error?.message || String(res.error),
      });
    }
    return null;
  } catch (err) {
    appLogger.error("ui:confirm:powershell-failed", {
      error: err?.message || String(err),
    });
    return null;
  }
}

function migrateDefaultPresetsIfNeeded() {
  const versionFile = path.join(userPresetsFolder, ".presets-version");
  let currentVersion = "";
  try {
    if (fs.existsSync(versionFile)) {
      currentVersion = fs.readFileSync(versionFile, "utf8").trim();
    }
  } catch (err) {
    appLogger.warn("presets:version-read-failed", { error: err.message });
  }

  if (currentVersion === PRESETS_MIGRATION_VERSION) return;

  try {
    fs.mkdirSync(userPresetsFolder, { recursive: true });
  } catch (err) {
    appLogger.warn("presets:user-dir-create-failed", { error: err.message });
  }

  try {
    if (fs.existsSync(userPresetsFolder)) {
      const entries = fs.readdirSync(userPresetsFolder);
      if (entries.length > 0) {
        const baseUserDir = path.dirname(userPresetsFolder);
        const backupDir = path.join(
          baseUserDir,
          `presets_backup_${PRESETS_MIGRATION_VERSION}`
        );
        if (!fs.existsSync(backupDir)) {
          copyFolderOnce(userPresetsFolder, backupDir);
          appLogger.info("presets:backup-created", {
            backupDir,
            version: PRESETS_MIGRATION_VERSION,
          });
        }
      }
    }
  } catch (err) {
    appLogger.warn("presets:backup-failed", { error: err.message });
  }

  try {
    copyFolderOverwrite(defaultPresetsFolder, userPresetsFolder);
    appLogger.info("presets:migrated", {
      version: PRESETS_MIGRATION_VERSION,
      source: defaultPresetsFolder,
      target: userPresetsFolder,
    });
  } catch (err) {
    appLogger.warn("presets:migration-failed", { error: err.message });
  }

  try {
    fs.writeFileSync(versionFile, PRESETS_MIGRATION_VERSION, "utf8");
  } catch (err) {
    appLogger.warn("presets:version-write-failed", { error: err.message });
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function getDefaultScreenshotFolder() {
  try {
    return path.join(app.getPath("pictures"), "Achievements Screenshots");
  } catch {
    return path.join(process.cwd(), "Achievements Screenshots");
  }
}

const DEFAULT_PREFERENCES = {
  startInTray: false,
  screenshotFolder: getDefaultScreenshotFolder(),
  overlayShortcut: "",
  sound: "mute",
  soundVolume: 100,
  preset: "default",
  notificationScale: 1,
  notificationDuration: 0,
  position: "center-bottom",
  language: "english",
  disableProgress: false,
  progressMutedConfigs: [],
  windowZoomFactor: 1,
  disableAchievementScreenshot: false,
  showDashboardOnStart: false,
  startMaximized: false,
  disablePlaytime: false,
  platinumSound: "mute",
  platinumPreset: "default",
  platinumPosition: "center-bottom",
  showBlacklistedGames: false,
  disablePlatinum: false,
  showHiddenDescription: false,
  closeToTray: false,
  blockedWatchedFolders: [],
  blacklistedAppIds: [],
  watchedFolders: [],
  steamApiKey: "",
};

function mergeWithDefaultPreferences(prefs = {}) {
  return { ...DEFAULT_PREFERENCES, ...(prefs || {}) };
}

function ensurePreferencesFile() {
  try {
    const current = readPrefsSafe();
    const merged = mergeWithDefaultPreferences(current);
    const exists = fs.existsSync(preferencesPath);
    if (!exists || !deepEqual(current, merged)) {
      fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
      fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2));
    }
    return merged;
  } catch (err) {
    prefsLogger.warn("preferences:ensure-failed", { error: err.message });
    return readPrefsSafe();
  }
}

const BLACKLIST_PREF_KEY = "blacklistedAppIds";
let watchedFoldersApi = null;
let cachedPreferences = {};
let mainWindow;
let selectedConfigPath = null;
let selectedConfig = null;
let mainWindowUserZoom = 1;
let mainWindowZoomTimer = null;
let displayMetricsListenerAdded = false;
const ZOOM_LOG_EPS = 0.001;
let lastZoomLog = null;
let selectedSound = "mute";
let selectedPreset = "default";
let selectedPosition = "center-bottom";
let selectedNotificationScale = 1;
let bootSeeding = true;
global.bootDone = false;
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  app.exit(0);
  process.exit(0);
} else {
  app.on("second-instance", () => {
    // Ignore subsequent launches; keep the first instance state (tray/hidden).
    return;
  });
}

function normalizeAppIdValue(value) {
  const trimmed = String(value || "").trim();
  return /^[0-9a-fA-F]+$/.test(trimmed) ? trimmed : "";
}

process.on("uncaughtException", (err) => {
  ipcLogger.error("process:uncaught-exception", {
    error: err?.message || String(err),
    stack: err?.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  ipcLogger.error("process:unhandled-rejection", {
    error: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

function normalizeProgressMutePath(value) {
  if (!value) return "";
  const normalized = path.normalize(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildProgressMuteKey(configPath, configName) {
  if (configPath) return `path:${normalizeProgressMutePath(configPath)}`;
  if (configName) return `name:${String(configName)}`;
  return "";
}

function isProgressMutedByPrefs(prefs, payload) {
  const list = Array.isArray(prefs?.progressMutedConfigs)
    ? prefs.progressMutedConfigs
    : [];
  if (!list.length) return false;
  const key = buildProgressMuteKey(
    payload?.config_path || payload?.configPath || "",
    payload?.configName ||
      payload?.config_name ||
      payload?.config ||
      selectedConfig
  );
  return key ? list.includes(key) : false;
}

function readBlacklistFromPrefs() {
  const prefs = readPrefsSafe();
  const arr = Array.isArray(prefs[BLACKLIST_PREF_KEY])
    ? prefs[BLACKLIST_PREF_KEY]
    : [];
  return arr.map(normalizeAppIdValue).filter(Boolean);
}

function persistBlacklist(appIds) {
  const nextList = Array.from(new Set(appIds))
    .map(normalizeAppIdValue)
    .filter(Boolean);
  try {
    const prefs = updatePreferences({ [BLACKLIST_PREF_KEY]: nextList });
    return prefs[BLACKLIST_PREF_KEY] || [];
  } catch (err) {
    prefsLogger.error("blacklist:write-failed", { error: err.message });
  }
  return readBlacklistFromPrefs();
}

function addAppIdToBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return readBlacklistFromPrefs();
  const next = new Set(readBlacklistFromPrefs());
  next.add(normalized);
  return persistBlacklist(Array.from(next));
}

function removeAppIdFromBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return readBlacklistFromPrefs();
  const next = new Set(readBlacklistFromPrefs());
  next.delete(normalized);
  return persistBlacklist(Array.from(next));
}

function resetBlacklist() {
  return persistBlacklist([]);
}

function isAppIdBlacklisted(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return false;
  const current = readBlacklistFromPrefs();
  return current.includes(normalized);
}

function refreshBlacklistEffects() {
  try {
    if (watchedFoldersApi?.refreshConfigState) {
      watchedFoldersApi.refreshConfigState();
    }
  } catch (err) {
    ipcLogger.error("blacklist:refresh-config-state-failed", {
      error: err?.message || String(err),
    });
  }
  try {
    if (watchedFoldersApi?.rebuildKnownAppIds) {
      watchedFoldersApi.rebuildKnownAppIds();
    }
  } catch (err) {
    ipcLogger.error("blacklist:rebuild-known-appids-failed", {
      error: err?.message || String(err),
    });
  }
  try {
    notifyConfigsChanged();
  } catch (err) {
    ipcLogger.error("blacklist:notify-configs-changed-failed", {
      error: err?.message || String(err),
    });
  }
}

const MY_LOGIN_FILENAME = "my_login.txt";

function getMyLoginUserDataPath() {
  try {
    return path.join(app.getPath("userData"), MY_LOGIN_FILENAME);
  } catch {
    return path.join(process.cwd(), MY_LOGIN_FILENAME);
  }
}

function getMyLoginAppPath() {
  return path.join(__dirname, MY_LOGIN_FILENAME);
}

function parseSteamApiKeyFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*(key|apikey|steam_api_key)\s*=/i.test(line)) {
      return line.split("=").slice(1).join("=").trim();
    }
  }
  return "";
}

function readSteamApiKeyFromFile() {
  const candidates = [getMyLoginUserDataPath(), getMyLoginAppPath()];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, "utf8");
      const key = parseSteamApiKeyFromText(raw);
      if (key) return key;
    } catch {}
  }
  return "";
}

function maskSteamApiKey(value) {
  const key = String(value || "");
  if (!key) return "";
  if (key.length <= 4) {
    return "•".repeat(key.length);
  }
  return `${"•".repeat(key.length - 4)}${key.slice(-4)}`;
}

function writeSteamApiKeyFile(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return;
  const target = getMyLoginUserDataPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `key=${trimmed}\n`, "utf8");
  } catch (err) {
    prefsLogger.error("steam-api-key:write-failed", { error: err.message });
  }
}

function removeSteamApiKeyFiles() {
  const targets = [getMyLoginUserDataPath()];
  const legacy = getMyLoginAppPath();
  if (legacy && !targets.includes(legacy)) targets.push(legacy);
  for (const fp of targets) {
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }
}

function ensureSteamApiKeyFileFromPrefs() {
  const key = String(cachedPreferences?.steamApiKey || "").trim();
  if (!key) return;
  writeSteamApiKeyFile(key);
}

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

function findConfigDirFromSelection(selDir, appid = "", platform = "") {
  if (!isNonEmptyString(selDir)) return null;
  const normalizedAppId = String(appid || "").trim();
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const candidates = [];

  const pushCandidate = (dir) => {
    if (!dir || candidates.includes(dir)) return;
    candidates.push(dir);
  };

  pushCandidate(path.join(selDir, "steam_settings"));
  pushCandidate(selDir);
  if (normalizedAppId) {
    pushCandidate(path.join(selDir, normalizedAppId));
    if (normalizedPlatform) {
      pushCandidate(path.join(selDir, normalizedPlatform, normalizedAppId));
    }
    ["uplay", "steam", "epic", "gog"].forEach((plat) =>
      pushCandidate(path.join(selDir, plat, normalizedAppId))
    );
  }

  for (const dir of candidates) {
    if (!dir) continue;
    const file = path.join(dir, "achievements.json");
    try {
      if (fs.existsSync(file) && looksLikeSchemaArray(readJsonSafe(file))) {
        return dir;
      }
    } catch {
      /* ignore */
    }
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
    const universeIniPath = path.join(d, "UniverseLANData", "Achievements.ini");
    const tenokeIniNested = path.join(d, "SteamData", "user_stats.ini");
    const tenokeIniDirect = path.join(d, "user_stats.ini");
    const tenokeIni = fs.existsSync(tenokeIniDirect)
      ? tenokeIniDirect
      : tenokeIniNested;
    const ofx = path.join(d, "Stats", "achievements.ini");
    const bin = path.join(d, "stats.bin");
    if (fs.existsSync(tenokeIni))
      return {
        dir: d,
        ini: null,
        tenokeIni,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };
    if (fs.existsSync(ofx))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(universeIniPath))
      return {
        dir: d,
        ini: universeIniPath,
        tenokeIni: null,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(iniPath))
      return {
        dir: d,
        ini: iniPath,
        tenokeIni: null,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(bin))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx: null,
        bin,
      };
  }
  return {
    dir: path.join(saveBase, String(appid)),
    ini: null,
    tenokeIni: null,
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
  appLogger.warn(message);
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
  appLogger.error(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#f44336" });
  }
}

function notifyInfo(message) {
  originalConsole.info(message);
  appLogger.info(message);
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
    if (!rel) return ICON_PNG_PATH;
    if (path.isAbsolute(rel)) {
      try {
        if (fs.existsSync(rel)) return rel;
      } catch {}
    }
    if (!isNonEmptyString(configPath)) return ICON_PNG_PATH;
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
    candidates.push(ICON_PNG_PATH);
    candidates.push(ICON_PATH);

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  } catch {}
  return ICON_PNG_PATH;
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

function waitForFileExists(fp, tries = 50, delay = 80) {
  return new Promise((resolve) => {
    const tick = (n) => {
      try {
        if (fs.existsSync(fp)) return resolve(true);
      } catch {}
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), delay);
    };
    tick(tries);
  });
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
cachedPreferences = ensurePreferencesFile();
if (!cachedPreferences || typeof cachedPreferences !== "object") {
  cachedPreferences = {};
}
const fileSteamApiKey = readSteamApiKeyFromFile();
if (fileSteamApiKey && !cachedPreferences.steamApiKey) {
  cachedPreferences.steamApiKey = fileSteamApiKey;
}
if (typeof cachedPreferences.steamApiKey === "string") {
  cachedPreferences.steamApiKey = cachedPreferences.steamApiKey.trim();
  if (!cachedPreferences.steamApiKey) {
    delete cachedPreferences.steamApiKey;
  }
}
if (cachedPreferences && typeof cachedPreferences === "object") {
  if (typeof cachedPreferences.language === "string") {
    selectedLanguage = cachedPreferences.language;
  }
  if (cachedPreferences.preset) {
    selectedPreset = cachedPreferences.preset;
  }
  if (cachedPreferences.position) {
    selectedPosition = cachedPreferences.position;
  }
  if (cachedPreferences.sound) {
    selectedSound = cachedPreferences.sound;
  }
  if (cachedPreferences.notificationScale != null) {
    const n = Number(cachedPreferences.notificationScale);
    if (!Number.isNaN(n) && n > 0) selectedNotificationScale = n;
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
  if ("closeToTray" in cachedPreferences) {
    global.closeToTray = !!cachedPreferences.closeToTray;
  }
}
ensureSteamApiKeyFileFromPrefs();

function applyPreferenceSideEffects(
  patch = {},
  prefsSnapshot = {},
  options = {}
) {
  if ("language" in patch && typeof prefsSnapshot.language === "string") {
    selectedLanguage = prefsSnapshot.language;
  }
  if ("disableProgress" in patch) {
    global.disableProgress = prefsSnapshot.disableProgress === true;
  }
  if ("disablePlaytime" in patch) {
    global.disablePlaytime = prefsSnapshot.disablePlaytime === true;
  }
  if ("startMaximized" in patch) {
    global.startMaximized = !!prefsSnapshot.startMaximized;
  }
  if ("startInTray" in patch) {
    global.startInTray = !!prefsSnapshot.startInTray;
  }
  if ("closeToTray" in patch) {
    global.closeToTray = !!prefsSnapshot.closeToTray;
  }
  if ("preset" in patch) {
    selectedPreset = prefsSnapshot.preset || "default";
  }
  if ("position" in patch) {
    selectedPosition = prefsSnapshot.position || "center-bottom";
  }
  if ("sound" in patch) {
    selectedSound = prefsSnapshot.sound || "mute";
  }
  if ("notificationScale" in patch) {
    const n = Number(prefsSnapshot.notificationScale);
    if (!Number.isNaN(n) && n > 0) selectedNotificationScale = n;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "overlayShortcut")) {
    global.overlayShortcut = patch.overlayShortcut;
    if (typeof patch.overlayShortcut === "string" && patch.overlayShortcut) {
      registerOverlayShortcut(patch.overlayShortcut);
    }
  }
  if (options.removeSteamKey === true) {
    removeSteamApiKeyFiles();
  } else if (Object.prototype.hasOwnProperty.call(patch, "steamApiKey")) {
    const trimmed = String(prefsSnapshot.steamApiKey || "").trim();
    if (trimmed) writeSteamApiKeyFile(trimmed);
  }
}

function updatePreferences(patch = {}) {
  const incoming = { ...(patch || {}) };
  let removeSteamKey = false;

  if ("steamApiKeyMasked" in incoming) delete incoming.steamApiKeyMasked;

  if (Object.prototype.hasOwnProperty.call(incoming, "steamApiKey")) {
    const raw = incoming.steamApiKey;
    const trimmed =
      typeof raw === "string" ? raw.trim() : raw ? String(raw).trim() : "";
    if (trimmed) {
      incoming.steamApiKey = trimmed;
    } else {
      removeSteamKey = true;
      delete incoming.steamApiKey;
    }
  }

  try {
    const current = readPrefsSafe();
    const merged = mergeWithDefaultPreferences({
      ...current,
      ...incoming,
    });
    if (removeSteamKey) delete merged.steamApiKey;

    const keysSet = new Set([
      ...Object.keys(current || {}),
      ...Object.keys(merged || {}),
    ]);
    const changedKeys = [];
    for (const key of keysSet) {
      if (!deepEqual(current?.[key], merged?.[key])) {
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) {
      prefsLogger.info("preferences:update:no-change", {
        keys: Object.keys(incoming || {}),
      });
      return current;
    }

    fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2));
    cachedPreferences = { ...merged };
    const effectivePatch = {};
    for (const key of changedKeys) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        effectivePatch[key] = merged[key];
      }
    }
    if (removeSteamKey && !effectivePatch.steamApiKey) {
      effectivePatch.steamApiKey = undefined;
    }
    prefsLogger.info("preferences:update:written", {
      path: preferencesPath,
      keys: changedKeys,
    });
    applyPreferenceSideEffects(effectivePatch, cachedPreferences, {
      removeSteamKey,
    });
    return cachedPreferences;
  } catch (err) {
    notifyError("Error writing merged preferences: " + err.message);
    prefsLogger.error("preferences:update:error", { error: err.message });
    throw err;
  }
}

ipcMain.handle("preferences:update", async (_event, newPrefs) => {
  prefsLogger.info("preferences:update:requested", {
    keys: newPrefs ? Object.keys(newPrefs) : [],
  });
  return updatePreferences(newPrefs || {});
});

// Backwards compatibility
ipcMain.handle("save-preferences", async (_event, newPrefs) =>
  updatePreferences(newPrefs || {})
);

ipcMain.on("set-zoom", (_event, zoomFactor) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const safeZoom = Number(zoomFactor) || 1;
    mainWindowUserZoom = safeZoom;
    applyMainWindowZoomFactor(safeZoom);

    try {
      const updatedPrefs = updatePreferences({ windowZoomFactor: safeZoom });
      cachedPreferences = updatedPrefs;
    } catch (err) {
      notifyError("❌ Failed to save zoom preference: " + err.message);
    }
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
async function runAchievementsGenerator(
  appid,
  schemaBaseDir,
  userDataDir,
  opts = {}
) {
  if (isAppIdBlacklisted(appid)) {
    schemaLogger.warn("schema:skip-blacklisted", { appid });
    throw new Error(`AppID ${appid} is blacklisted. Remove it to continue.`);
  }
  return new Promise((resolve, reject) => {
    ensureSteamApiKeyFileFromPrefs();
    const script = path.join(
      __dirname,
      "utils",
      "generate_achievements_schema.js"
    );
    const logDir = path.join(app.getPath("userData"), "logs");
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    } catch {}
    const platform =
      typeof opts.platform === "string" && opts.platform.length
        ? opts.platform.toLowerCase()
        : null;
    const args = [
      String(appid),
      "--apps-concurrency=1",
      `--out=${schemaBaseDir}`,
      `--user-data-dir=${userDataDir}`,
    ];
    if (platform) args.push(`--platform=${platform}`);
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOGGER_DIR: logDir,
        LOGGER_SUPPRESS_CLEAR: "1",
      },
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

async function ensureSchemaForApp(appid, platform = "steam") {
  const appidStr = String(appid || "");
  if (!platform && /[a-f]/i.test(appidStr)) {
    platform = "epic";
  }
  if (!/^[0-9a-fA-F]+$/.test(String(appid || ""))) return null;

  const schemaBase = SCHEMA_ROOT_PATH; // %APPDATA%\Achievements\configs\schema
  const normalizedPlatform = normalizeStoragePlatform(platform);
  const destDir = resolveSchemaDirForPlatform(appid, normalizedPlatform);
  const achJson = path.join(destDir, "achievements.json");
  const legacyDir = path.join(schemaBase, String(appid));
  const legacyJson = path.join(legacyDir, "achievements.json");

  try {
    if (!fs.existsSync(schemaBase))
      fs.mkdirSync(schemaBase, { recursive: true });
  } catch {}
  // if achievements schema exist
  if (fs.existsSync(achJson)) {
    ipcLogger.info("schema:ensure-exists", {
      appid,
      platform: normalizedPlatform,
      dir: destDir,
    });
    return { dir: destDir, existed: true };
  }
  if (fs.existsSync(legacyJson)) {
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(legacyDir, destDir);
      if (fs.existsSync(achJson)) {
        ipcLogger.info("schema:ensure-migrated-legacy", {
          appid,
          from: legacyDir,
          to: destDir,
        });
        return { dir: destDir, existed: true };
      }
    } catch (err) {
      ipcLogger.warn("schema:legacy-move-failed", {
        appid,
        error: err?.message || String(err),
      });
      return { dir: legacyDir, existed: true };
    }
  }

  for (const altPlatform of SCHEMA_PLATFORM_DIRS) {
    if (altPlatform === normalizedPlatform) continue;
    const altDir = resolveSchemaDirForPlatform(appid, altPlatform);
    if (
      path.normalize(altDir).toLowerCase() ===
      path.normalize(destDir).toLowerCase()
    ) {
      continue;
    }
    const altJson = path.join(altDir, "achievements.json");
    if (!fs.existsSync(altJson)) continue;
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(altDir, destDir);
      if (fs.existsSync(achJson)) {
        ipcLogger.info("schema:ensure-migrated-platform", {
          appid,
          from: altDir,
          to: destDir,
        });
        return { dir: destDir, existed: true };
      }
    } catch (err) {
      ipcLogger.warn("schema:platform-move-failed", {
        appid,
        from: altPlatform,
        to: normalizedPlatform,
        error: err?.message || String(err),
      });
    }
    break;
  }

  try {
    await runAchievementsGenerator(appid, schemaBase, app.getPath("userData"), {
      platform: normalizedPlatform,
    });
    if (fs.existsSync(achJson)) {
      ipcLogger.info("schema:ensure-generated", {
        appid,
        platform: normalizedPlatform,
        dir: destDir,
      });
      return { dir: destDir, existed: false };
    }
  } catch (e) {
    warnOnce(`${appid}:fail`, `Generate schema failed: ${e.message}`);
  }
  return null;
}

/* <root>/<gameName>/<displayName>.png (timestamp if exists) */
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
  prefsLogger.info("load-preferences:requested");
  cachedPreferences = readPrefsSafe();
  const fileKey = readSteamApiKeyFromFile();
  if (fileKey && !cachedPreferences.steamApiKey) {
    cachedPreferences.steamApiKey = fileKey;
  }
  if (
    typeof cachedPreferences.steamApiKey === "string" &&
    !cachedPreferences.steamApiKey.trim()
  ) {
    delete cachedPreferences.steamApiKey;
  }
  prefsLogger.info("load-preferences:loaded", {
    keys: cachedPreferences ? Object.keys(cachedPreferences) : [],
  });
  const safePrefs = { ...cachedPreferences };
  if (safePrefs.steamApiKey) {
    safePrefs.steamApiKeyMasked = maskSteamApiKey(safePrefs.steamApiKey);
    delete safePrefs.steamApiKey;
  } else {
    safePrefs.steamApiKeyMasked = "";
  }
  return safePrefs;
});

ipcMain.handle("blacklist:check", async (_event, appid) => {
  const normalized = normalizeAppIdValue(appid);
  const blacklisted = normalized ? isAppIdBlacklisted(normalized) : false;
  return { appid: normalized, blacklisted };
});

ipcMain.handle("config:get-by-appid", async (_event, appid) => {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return null;
  try {
    const files = fs.readdirSync(configsDir);
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".json")) continue;
      const cfgPath = path.join(configsDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const cfgAppId = normalizeAppIdValue(
          data?.appid || data?.appId || data?.steamAppId
        );
        if (cfgAppId === normalized) {
          return {
            name: data?.name || path.basename(f, ".json"),
            displayName: data?.displayName || null,
            appid: cfgAppId,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
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
  appLogger.info("ui:confirm:request", {
    title: title || "",
    message: message || "",
    hasDetail: !!detail,
  });
  ipcLogger.info("ui:confirm:request", {
    title: title || "",
    message: message || "",
    hasDetail: !!detail,
  });
  if (app.isPackaged && process.platform === "win32") {
    const result = runWindowsConfirm({ title, message });
    if (result !== null) {
      appLogger.info("ui:confirm:powershell-result", { ok: result });
      ipcLogger.info("ui:confirm:powershell-result", { ok: result });
      return result;
    }
    appLogger.warn("ui:confirm:powershell-fallback");
    ipcLogger.warn("ui:confirm:powershell-fallback");
    throw new Error("native-confirm-failed");
  }
  const win = BrowserWindow.fromWebContents(e.sender);
  const baseOptions = {
    type: "question",
    buttons: ["Cancel", "OK"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: title || app.getName() || "Confirm",
    message: message || "Are you sure?",
    detail: detail || "",
  };
  try {
    const canParent =
      win &&
      !win.isDestroyed() &&
      win.isVisible() &&
      !app.isPackaged &&
      !win.isMinimized();
    const options = canParent
      ? { ...baseOptions, modal: false }
      : baseOptions;
    const res = canParent
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    try {
      if (win && !win.isDestroyed()) {
        win.setIgnoreMouseEvents(false);
        if (!win.isVisible()) win.show();
        win.focus();
      }
    } catch {}
    appLogger.info("ui:confirm:dispatch", {
      parent: canParent,
      packaged: app.isPackaged,
    });
    appLogger.info("ui:confirm:response", { ok: res.response === 1 });
    ipcLogger.info("ui:confirm:response", { ok: res.response === 1 });
    return res.response === 1;
  } catch (err) {
    ipcLogger.warn("ui:confirm:failed", {
      error: err?.message || String(err),
    });
    appLogger.error("ui:confirm:failed", {
      error: err?.message || String(err),
    });
    return false;
  }
});

ipcMain.handle("ui:refocus", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, "screen-saver");
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(false);
        win.focus();
      }
    }, 0);
  } catch {}
});

// dashboard visibility & refresh
let dashboardOpen = false;
let pendingDashboardRefresh = false;
let dashboardRefreshTimer = null;

// Platinum tracking for pending delivery and dedupe
const pendingPlatinumByConfig = new Map();

function requestDashboardRefresh() {
  if (!dashboardOpen) {
    pendingDashboardRefresh = true;
    return;
  }
  pendingDashboardRefresh = false;
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    try {
      broadcastToAll("dashboard:refresh");
    } catch {}
  }, 350);
}

ipcMain.handle("dashboard:set-open", (_e, state) => {
  dashboardOpen = !!state;
  if (dashboardOpen && pendingDashboardRefresh) {
    requestDashboardRefresh();
  }
  return dashboardOpen;
});

ipcMain.handle("dashboard:is-open", () => {
  return dashboardOpen;
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
  ipcLogger.info("saveConfig:request", {
    name: config?.name || null,
    appid: config?.appid || null,
  });
  try {
    const safeName = sanitizeConfigName(config.name);
    if (!fs.existsSync(configsDir))
      fs.mkdirSync(configsDir, { recursive: true });
    const filePath = path.join(configsDir, `${safeName}.json`);
    let prevConfig = null;
    if (fs.existsSync(filePath)) {
      try {
        prevConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {}
    }

    const exePath = isNonEmptyString(config.executable)
      ? config.executable
      : null;

    const payload = {
      ...prevConfig, // preserve custom fields like platinum
      ...config,
      name: safeName,
      displayName: config.displayName || config.name,
      config_path: isNonEmptyString(config.config_path)
        ? config.config_path
        : null,
      save_path: isNonEmptyString(config.save_path) ? config.save_path : null,
      executable: exePath,
      arguments: isNonEmptyString(config.arguments) ? config.arguments : "",
      process_name: isNonEmptyString(config.process_name)
        ? config.process_name
        : exePath
        ? path.basename(exePath)
        : "",
    };

    const sanitizedAppId = sanitizeAppId(payload.appid);
    if (!sanitizedAppId) {
      return { success: false, message: "AppID is required." };
    }
    if (isAppIdBlacklisted(sanitizedAppId)) {
      const message = `AppID ${sanitizedAppId} is blacklisted. Remove it to continue.`;
      ipcLogger.info("saveConfig:blocked-blacklist", {
        appid: sanitizedAppId,
        name: payload?.name || null,
      });
      return { success: false, message, blacklisted: true };
    }
    payload.appid = sanitizedAppId;
    applyConfigPlatformDefaults(payload);
    const prevPlatform = normalizePlatform(prevConfig?.platform) || null;
    let nextPlatform = normalizePlatform(payload.platform) || null;
    if (!nextPlatform && /[a-f]/i.test(String(payload.appid || ""))) {
      nextPlatform = "epic";
    }
    nextPlatform = nextPlatform || "steam";

    const wc = event.sender;

    // 1) Manually selected config_path
    let finalSchemaDir = null;
    if (isNonEmptyString(payload.config_path)) {
      if (isManagedSchemaPath(payload.config_path)) {
        const bySel = findConfigDirFromSelection(
          payload.config_path,
          payload.appid,
          payload.platform
        );
        if (bySel) {
          finalSchemaDir = bySel;
        }
      } else {
        finalSchemaDir = payload.config_path;
      }
    }

    // 2) Search schema locally
    let needBackground = false;
    if (!finalSchemaDir) {
      const preferredDir = resolveSchemaDirForPlatform(
        payload.appid,
        payload.platform
      );
      const achPath = path.join(preferredDir, "achievements.json");
      if (
        fs.existsSync(achPath) &&
        looksLikeSchemaArray(readJsonSafe(achPath))
      ) {
        finalSchemaDir = preferredDir;
      } else {
        const legacyDir = path.join(SCHEMA_ROOT_PATH, String(payload.appid));
        const legacyJson = path.join(legacyDir, "achievements.json");
        if (
          fs.existsSync(legacyJson) &&
          looksLikeSchemaArray(readJsonSafe(legacyJson))
        ) {
          try {
            if (legacyDir !== preferredDir) {
              fs.mkdirSync(preferredDir, { recursive: true });
              fs.renameSync(legacyDir, preferredDir);
              finalSchemaDir = preferredDir;
            } else {
              finalSchemaDir = legacyDir;
            }
          } catch {
            finalSchemaDir = legacyDir;
          }
        } else {
          needBackground = true;
        }
      }
    }

    const managesSchemaPath =
      isManagedSchemaPath(payload.config_path) ||
      (!isNonEmptyString(payload.config_path) &&
        isManagedSchemaPath(prevConfig?.config_path));
    if (prevPlatform && prevPlatform !== nextPlatform && managesSchemaPath) {
      ipcLogger.info("config:platform-change", {
        name: payload.name,
        appid: payload.appid,
        from: prevPlatform,
        to: nextPlatform,
      });
      finalSchemaDir = null;
      payload.config_path = null;
      needBackground = true;
    } else if (
      finalSchemaDir &&
      managesSchemaPath &&
      !schemaPathMatchesPlatform(payload.appid, nextPlatform, finalSchemaDir)
    ) {
      finalSchemaDir = null;
      payload.config_path = null;
      needBackground = true;
    }

    if (finalSchemaDir && !needBackground) payload.config_path = finalSchemaDir;

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
    ipcLogger.info("saveConfig:written", {
      name: payload.name,
      appid: payload.appid,
      filePath,
      savePath: payload.save_path || null,
      schemaDir: finalSchemaDir || null,
      needBackground,
    });
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

      ipcLogger.info("saveConfig:success", {
        name: payload.name,
        appid: payload.appid,
        schemaReady: true,
        config_path: finalSchemaDir,
        save_path: payload.save_path || null,
      });
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
          const res = await ensureSchemaForApp(payload.appid, payload.platform);
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
          ipcLogger.error("saveConfig:schema-generation-failed", {
            appid: payload.appid,
            error: e.message,
          });
        }
      })();
      setTimeout(() => {
        console.log(`${startTxt}`);
      }, 15);
      ipcLogger.info("saveConfig:success", {
        name: payload.name,
        appid: payload.appid,
        schemaReady: false,
        config_path: null,
        save_path: payload.save_path || null,
      });
      return reply;
    }
  } catch (error) {
    ipcLogger.error("saveConfig:error", {
      error: error?.message || String(error),
      name: config?.name || null,
      appid: config?.appid || null,
    });
    return { success: false, message: "Error saving configuration!" };
  }
});

// Handler for config load
ipcMain.handle("loadConfigs", () => {
  ipcLogger.info("loadConfigs:request");
  const blacklist = new Set(readBlacklistFromPrefs());
  const lang = cachedPreferences?.language || "english";
  const configFiles = fs
    .readdirSync(configsDir)
    .filter((file) => file.endsWith(".json"));
  const configs = configFiles.map((file) => {
    const baseName = path.basename(file, ".json");
    const meta = {
      name: baseName,
      displayName: baseName,
      appid: null,
      blacklisted: false,
    };
    const fullPath = path.join(configsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (raw?.displayName) {
        meta.displayName =
          getSafeLocalizedText(raw.displayName, lang) || raw.name || baseName;
      } else if (raw?.name) {
        meta.displayName = raw.name;
      }
      if (raw?.appid) {
        meta.appid = String(raw.appid);
        meta.blacklisted = blacklist.has(meta.appid);
      }
    } catch (err) {
      ipcLogger.warn("loadConfigs:parse-failed", {
        file: fullPath,
        error: err?.message || String(err),
      });
    }
    return meta;
  });
  ipcLogger.info("loadConfigs:success", { count: configs.length });
  return configs;
});

// Handler for folder load
ipcMain.handle("selectFolder", async () => {
  ipcLogger.info("selectFolder:request");
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (!result.canceled) {
    const folder = result.filePaths[0];
    ipcLogger.info("selectFolder:success", { folder });
    return folder;
  }
  ipcLogger.info("selectFolder:cancelled");
  return null;
});

// Handler for json load
ipcMain.handle("load-achievements", async (event, configName) => {
  ipcLogger.info("load-achievements:request", { configName });
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
      ipcLogger.warn("load-achievements:missing", {
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
      ipcLogger.warn("load-achievements:missing", {
        configName,
        reason: "no-file",
        config_path: cfgDir,
      });
      return { achievements: null, config_path: cfgDir };
    }

    const achievements = JSON.parse(fs.readFileSync(foundPath, "utf-8"));
    ipcLogger.info("load-achievements:success", {
      configName,
      source: foundPath,
      count: Array.isArray(achievements)
        ? achievements.length
        : achievements && typeof achievements === "object"
        ? Object.keys(achievements).length
        : 0,
    });
    return { achievements, config_path: path.dirname(foundPath) };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      notifyError("Error reading achievements.json file: " + error.message);
      ipcLogger.error("load-achievements:error", {
        configName,
        error: error.message,
      });
    }
    return { achievements: null, config_path: "" };
  }
});

ipcMain.handle("load-saved-achievements", async (_event, configName) => {
  ipcLogger.info("load-saved-achievements:request", { configName });
  try {
    const rawName = String(configName || "").trim();
    if (!rawName) {
      ipcLogger.warn("load-saved-achievements:missing-name", { configName });
      return { achievements: {}, save_path: "", error: "configName required" };
    }
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    if (!fs.existsSync(configPath)) {
      const ready = await waitForFileExists(configPath, 50, 100);
      if (!ready || !fs.existsSync(configPath)) {
        ipcLogger.warn("load-saved-achievements:not-found", {
          configName: safeName,
          configPath,
        });
        return { achievements: {}, save_path: "", error: "config not ready" };
      }
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const saveBase = config.save_path;
    const appid = String(config.appid || "");
    const saveJsonPath = resolveSaveFilePath(saveBase, appid);
    const {
      tenokeIni: tenokeIniPath,
      ini: achievementsIniPath,
      ofx: achievementsIniOnlineFixPath,
      bin: achievementsBinPath,
    } = resolveSaveSidecarPaths(saveBase, appid);

    let effectiveSavePath = "";
    if (fs.existsSync(saveJsonPath))
      effectiveSavePath = path.dirname(saveJsonPath);
    else if (fs.existsSync(tenokeIniPath))
      effectiveSavePath = path.dirname(tenokeIniPath);
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
    ipcLogger.error("load-saved-achievements:error", {
      configName,
      error: error.message,
    });
    return { achievements: {}, save_path: "", error: error.message };
  }
});

// Handler for config deletion
ipcMain.handle("delete-config", async (_event, configName) => {
  ipcLogger.info("delete-config:request", { configName });
  try {
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${safe}.json`);
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      watchedFoldersApi?.refreshConfigState?.();
      ipcLogger.info("delete-config:success", { configName, configPath });
      return { success: true };
    }
    ipcLogger.warn("delete-config:not-found", { configName, configPath });
    return { success: false, error: "File not found." };
  } catch (error) {
    ipcLogger.error("delete-config:error", {
      configName,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
});

ipcMain.handle("config:blacklist", async (_event, payload = {}) => {
  const rawName = payload.configName || "";
  const safeName = rawName ? sanitizeConfigName(rawName) : null;
  let resolvedAppId = payload.appid ? String(payload.appid) : null;
  const configPath = safeName
    ? path.join(configsDir, `${safeName}.json`)
    : null;
  const removeFlag = payload?.remove === true || payload?.action === "remove";

  ipcLogger.info("config:blacklist:request", {
    configName: safeName || null,
    appid: resolvedAppId || null,
    remove: removeFlag,
  });

  try {
    if (!resolvedAppId && configPath && fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed?.appid) resolvedAppId = String(parsed.appid);
    }
    if (!resolvedAppId) throw new Error("AppID missing");

    const updatedList = removeFlag
      ? removeAppIdFromBlacklist(resolvedAppId)
      : addAppIdToBlacklist(resolvedAppId);

    if (removeFlag) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, resolvedAppId);
      } catch {}
    }

    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", { appids: updatedList });
    } catch {}

    ipcLogger.info("config:blacklist:success", {
      configName: safeName || null,
      appid: resolvedAppId,
      remove: removeFlag,
    });
    return {
      success: true,
      appid: resolvedAppId,
      blacklisted: !removeFlag,
      blacklist: updatedList,
    };
  } catch (err) {
    ipcLogger.error("config:blacklist:error", {
      configName: safeName || null,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Blacklist failed" };
  }
});

ipcMain.handle("blacklist:list", async () => {
  return { appids: readBlacklistFromPrefs() };
});

ipcMain.handle("blacklist:reset", async () => {
  ipcLogger.info("blacklist:reset:request");
  try {
    const before = readBlacklistFromPrefs();
    resetBlacklist();
    if (Array.isArray(before) && before.length) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, before);
      } catch {}
    }
    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", { appids: readBlacklistFromPrefs() });
    } catch {}
    ipcLogger.info("blacklist:reset:success", { count: before?.length || 0 });
    return { success: true, appids: [] };
  } catch (err) {
    ipcLogger.error("blacklist:reset:error", {
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Reset failed" };
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

let tray = null;
let trayMenuWindow = null;
let isQuitting = false;
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico") // in installer: resources\icon.ico
  : path.join(__dirname, "icon.ico");
const ICON_PNG_PATH = app.isPackaged
  ? path.join(app.getAppPath(), "assets", "icon.png") // in installer: resources\app.asar\assets\icon.png
  : path.join(__dirname, "assets", "icon.png");
const TRAY_MENU_WIDTH = 180;
const TRAY_MENU_HEIGHT = 170;

function getTrayScaleFactor() {
  try {
    if (tray) {
      const bounds = tray.getBounds();
      return screen.getDisplayNearestPoint(bounds)?.scaleFactor || 1;
    }
  } catch {}
  return screen.getPrimaryDisplay()?.scaleFactor || 1;
}

function applyTrayMenuScale() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  const scale = getTrayScaleFactor();
  const width = Math.max(120, Math.round(TRAY_MENU_WIDTH));
  const height = Math.max(120, Math.round(TRAY_MENU_HEIGHT));
  trayMenuWindow.setBounds({ width, height }, false);
  if (!trayMenuWindow.webContents.isDestroyed()) {
    trayMenuWindow.webContents.setZoomFactor(1);
  }
  windowLogger.info("tray:scale", {
    scale,
    width,
    height,
    mode: "linear",
  });
}
function showMainWindowRespectingPrefs() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ forceShow: true });
    return;
  }
  const prefs = readPrefsSafe();
  if (prefs.startMaximized) {
    mainWindow.maximize();
  }
  mainWindow.show();
}

// Zoom model:
// - userZoom: preference from UI dropdown (1.0, 1.25, 1.5, etc).
// - effectiveZoom: value applied to webContents (userZoom / display scale).
// This keeps the main window visually at userZoom while tray/notifications use DPI.
function getDisplayScaleForBounds(bounds) {
  try {
    if (bounds) {
      return screen.getDisplayMatching(bounds)?.scaleFactor || 1;
    }
  } catch {}
  return screen.getPrimaryDisplay()?.scaleFactor || 1;
}

function getMainWindowScaleFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  return getDisplayScaleForBounds(mainWindow.getBounds());
}

function shouldLogZoomChange(prev, next) {
  if (!prev) return true;
  return (
    Math.abs(prev.userZoom - next.userZoom) > ZOOM_LOG_EPS ||
    Math.abs(prev.scaleFactor - next.scaleFactor) > ZOOM_LOG_EPS ||
    Math.abs(prev.effectiveZoom - next.effectiveZoom) > ZOOM_LOG_EPS
  );
}

function logMainZoomState(userZoom, scaleFactor, effectiveZoom) {
  const next = { userZoom, scaleFactor, effectiveZoom };
  if (!shouldLogZoomChange(lastZoomLog, next)) return;
  lastZoomLog = next;
  windowLogger.info("zoom:apply", next);
}

function applyMainWindowZoomFactor(userZoom = mainWindowUserZoom) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = getMainWindowScaleFactor() || 1;
  const safeZoom = Number(userZoom) || 1;
  mainWindowUserZoom = safeZoom;
  const effectiveZoom = safeZoom / scale;
  mainWindow.webContents.setZoomFactor(effectiveZoom);
  logMainZoomState(safeZoom, scale, effectiveZoom);
  mainWindow.webContents.send("zoom-factor-changed", {
    userZoom: safeZoom,
    effectiveZoom,
  });
}

function scheduleMainWindowZoomUpdate() {
  if (mainWindowZoomTimer) clearTimeout(mainWindowZoomTimer);
  mainWindowZoomTimer = setTimeout(() => {
    mainWindowZoomTimer = null;
    applyMainWindowZoomFactor();
  }, 120);
}

function ensureDisplayMetricsListener() {
  if (displayMetricsListenerAdded) return;
  displayMetricsListenerAdded = true;
  screen.on("display-metrics-changed", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
  screen.on("display-added", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
  screen.on("display-removed", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
}

function createTrayMenuWindow() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    return trayMenuWindow;
  }
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: TRAY_MENU_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: "#282a36",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  trayMenuWindow.setAlwaysOnTop(true, "pop-up-menu");
  trayMenuWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  trayMenuWindow.loadFile("tray-menu.html");
  trayMenuWindow.webContents.once("did-finish-load", () => {
    applyTrayMenuScale();
  });
  trayMenuWindow.on("blur", () => {
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.hide();
    }
  });
  trayMenuWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      trayMenuWindow.hide();
    }
  });
  return trayMenuWindow;
}

function hideTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.hide();
  }
}

function positionTrayMenu() {
  if (!tray || !trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  applyTrayMenuScale();
  const trayBounds = tray.getBounds();
  const winBounds = trayMenuWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const workArea = display.workArea;
  const x = Math.round(
    trayBounds.x + trayBounds.width / 2 - winBounds.width / 2
  );
  const shouldPlaceBelow = trayBounds.y < workArea.y + workArea.height / 2;
  const y = shouldPlaceBelow
    ? Math.round(trayBounds.y + trayBounds.height)
    : Math.round(trayBounds.y - winBounds.height);
  const clampedX = Math.min(
    Math.max(x, workArea.x),
    workArea.x + workArea.width - winBounds.width
  );
  const clampedY = Math.min(
    Math.max(y, workArea.y),
    workArea.y + workArea.height - winBounds.height
  );
  trayMenuWindow.setPosition(clampedX, clampedY, false);
}

function toggleTrayMenu() {
  if (!tray) return;
  const win = createTrayMenuWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  positionTrayMenu();
  win.show();
  win.focus();
}

function openSettingsFromTray() {
  showMainWindowRespectingPrefs();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.send("tray:open-settings");
    });
  } else {
    mainWindow.webContents.send("tray:open-settings");
  }
}

function createTray() {
  tray = new Tray(ICON_PATH);
  tray.setToolTip("Achievements App");
  createTrayMenuWindow();

  tray.on("click", () => {
    toggleTrayMenu();
  });
  tray.on("right-click", () => {
    toggleTrayMenu();
  });
  tray.on("double-click", () => {
    hideTrayMenu();
    showMainWindowRespectingPrefs();
  });
}

let achievementsFilePath; // achievements.json path
let currentConfigPath;
let previousAchievements = {};

function createMainWindow(options = {}) {
  windowLogger.info("create-main-window:start", {
    existing: Boolean(mainWindow && !mainWindow.isDestroyed?.()),
  });
  const forceShowOnLoad = !!options.forceShow;
  let initialZoom = 1;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};
    initialZoom = Number(prefs.windowZoomFactor) || 1;
  } catch {}
  mainWindowUserZoom = initialZoom;
  const initialScale = getDisplayScaleForBounds();
  const initialZoomFactor = initialZoom / (initialScale || 1);
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
      zoomFactor: initialZoomFactor,
    },
  });
  windowLogger.info("create-main-window:browserwindow-created", {
    width: 1000,
    height: 1000,
    zoom: initialZoom,
  });

  const ICON_URL = pathToFileURL(ICON_PNG_PATH).toString();
  mainWindow.loadFile("index.html", { query: { icon: ICON_URL } });
  windowLogger.info("create-main-window:load-file", { icon: ICON_URL });

  mainWindow.webContents.on("did-finish-load", () => {
    windowLogger.info("create-main-window:did-finish-load");
    try {
      const prefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
        : {};
      const shouldStartInTray = !!prefs.startInTray;
      const shouldStartMaximized = !!prefs.startMaximized;
      const zoom = Number(prefs.windowZoomFactor) || 1;
      applyMainWindowZoomFactor(zoom);
      if (forceShowOnLoad || !shouldStartInTray) {
        if (shouldStartMaximized) {
          mainWindow.maximize();
        }
        mainWindow.show();
      }
    } catch (e) {
      applyMainWindowZoomFactor(1);
      mainWindow.show();
    }
    windowLogger.info("create-main-window:visible", {
      maximized: mainWindow.isMaximized(),
    });
    mainWindow.webContents.send(
      "window-state-change",
      mainWindow.isMaximized()
    );
  });
  global.mainWindow = mainWindow;

  // Track window state changes
  mainWindow.on("maximize", () => {
    windowLogger.info("create-main-window:maximize");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", true);
    }
  });

  mainWindow.on("unmaximize", () => {
    windowLogger.info("create-main-window:unmaximize");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", false);
    }
  });

  mainWindow.on("enter-full-screen", () => {
    windowLogger.info("create-main-window:enter-full-screen");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-fullscreen-change", true);
    }
  });

  mainWindow.on("leave-full-screen", () => {
    windowLogger.info("create-main-window:leave-full-screen");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-fullscreen-change", false);
    }
  });

  mainWindow.on("move", () => scheduleMainWindowZoomUpdate());
  mainWindow.on("resize", () => scheduleMainWindowZoomUpdate());
  ensureDisplayMetricsListener();

  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    const shouldCloseToTray =
      cachedPreferences?.closeToTray === true || global.closeToTray === true;
    if (shouldCloseToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    windowLogger.info("create-main-window:closed");
    if (mainWindowZoomTimer) {
      clearTimeout(mainWindowZoomTimer);
      mainWindowZoomTimer = null;
    }
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.destroy();
    }
    trayMenuWindow = null;
    mainWindow = null;
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

function normalizeNotificationScale(rawScale) {
  const scale = Number(rawScale);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const displayScale = screen.getPrimaryDisplay()?.scaleFactor || 1;
  const effectiveScale = safeScale * displayScale;
  return { scale: safeScale, displayScale, effectiveScale };
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
  const scaleInfo = normalizeNotificationScale(message.scale);
  const scale = scaleInfo.scale;
  windowLogger.info("create-notification-window:start", {
    preset,
    position,
    scale,
  });

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
    show: false,
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
  notificationWindow.setIgnoreMouseEvents(true, { forward: true });
  notificationWindow.loadFile(presetHtml);
  notificationWindow.showInactive();
  windowLogger.info("create-notification-window:load-file", {
    presetHtml,
  });

  notificationWindow.webContents.on("did-finish-load", async () => {
    const iconPathToSend =
      message.iconPath ||
      (message.icon ? path.join(message.config_path, message.icon) : "");
    const durationMs = Number(message?.durationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      try {
        await notificationWindow.webContents.executeJavaScript(
          `(function(){const meta=document.querySelector('meta[name="duration"]');if(meta){meta.content='${Math.round(
            durationMs
          )}';}})();`,
          true
        );
      } catch (err) {
        windowLogger.warn(
          "create-notification-window:duration-override-failed",
          {
            error: err?.message || String(err),
          }
        );
      }
    }
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
  const configName =
    achievement?.configName ||
    achievement?.config_name ||
    selectedConfig ||
    null;
  const achKey =
    achievement?.name ||
    (typeof achievement?.displayName === "string"
      ? achievement.displayName
      : null);
  if (configName && achKey) {
    const prev = loadPreviousAchievements(configName) || {};
    const prevEntry = prev[achKey];
    const incomingProg = Number(achievement.progress);
    const prevProg = Number(prevEntry?.progress);
    const prevMax = Number(prevEntry?.max_progress);
    const maxProg = Number(achievement.max_progress);
    if (prevEntry?.earned === true) return;
    if (
      Number.isFinite(incomingProg) &&
      Number.isFinite(prevProg) &&
      incomingProg <= prevProg &&
      (Number.isNaN(maxProg) || maxProg === prevMax)
    ) {
      return;
    }
  }

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
ipcMain.handle("checkLocalGameImage", async (_event, appid, platformArg) => {
  const platform = normalizePlatform(platformArg) || getPlatformForAppId(appid);
  ipcLogger.info("checkLocalGameImage:request", { appid, platform });
  const baseDir = path.join(app.getPath("userData"), "images");
  const newPath = path.join(
    baseDir,
    platform || "steam",
    `${appid}`,
    `${appid}.jpg`
  );
  const legacyPath = path.join(baseDir, `${appid}.jpg`);
  try {
    await fs.promises.access(newPath, fs.constants.F_OK);
    ipcLogger.info("checkLocalGameImage:hit", {
      appid,
      platform,
      imagePath: newPath,
    });
    return newPath;
  } catch {}
  try {
    await fs.promises.access(legacyPath, fs.constants.F_OK);
    ipcLogger.info("checkLocalGameImage:legacy-hit", {
      appid,
      platform,
      imagePath: legacyPath,
    });
    return legacyPath;
  } catch {}
  ipcLogger.info("checkLocalGameImage:miss", { appid, platform });
  return null;
});

// Save image locally from renderer
ipcMain.handle("saveGameImage", async (_event, appid, buffer, platformArg) => {
  const platform = normalizePlatform(platformArg) || getPlatformForAppId(appid);
  ipcLogger.info("saveGameImage:request", { appid, platform });
  try {
    const imageDir = path.join(
      app.getPath("userData"),
      "images",
      platform || "steam",
      String(appid)
    );
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    const fullPath = path.join(imageDir, `${appid}.jpg`);
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    broadcastToAll("update-image", { appid: String(appid), platform });
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
    icon: ICON_PNG_PATH, // Use app icon
    icon_gray: ICON_PNG_PATH, // Use app icon
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

// Add new IPC handler for Platinum Achievement
const platinumDedup = new Set();

function markConfigPlatinumFlag(configName) {
  const safe = configName ? sanitizeConfigName(configName) : "";
  if (!safe) return false;
  const cfgPath = path.join(configsDir, `${safe}.json`);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (data.platinum === true) return false; // already flagged
    data.platinum = true;
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function handlePlatinumComplete({
  configName,
  appid,
  savePath,
  configPath,
  isActive = false,
}) {
  const dedupKey =
    (configName ? sanitizeConfigName(configName) : "") ||
    (appid ? String(appid) : "") ||
    (configPath ? path.basename(configPath) : "");
  if (dedupKey) {
    if (platinumDedup.has(dedupKey)) return;
    platinumDedup.add(dedupKey);
  }

  const prefs = cachedPreferences || {};
  if (prefs.disablePlatinum) return;

  const preset = prefs.platinumPreset || "default";
  const position = prefs.platinumPosition || "center-bottom";
  const sound = prefs.platinumSound || "mute";
  const scale = Number(prefs.notificationScale) || 1;
  const safeName = configName ? sanitizeConfigName(configName) : "";

  const message = {
    displayName: "100% Completed",
    description: "You've unlocked all achievements!",
    preset,
    position,
    sound,
    scale,
    config_path: configPath || null,
    save_path: savePath || null,
    configName: configName || null,
    appid: appid ? String(appid) : null,
    __isPlatinum: true,
  };

  if (isActive) {
    // Mark flag but defer popup until queue is idle
    markConfigPlatinumFlag(configName);
    const key =
      safeName ||
      (appid ? String(appid) : "") ||
      (configPath ? path.basename(configPath) : "");
    if (key) {
      pendingPlatinumByConfig.set(key, message);
    }
    flushPendingPlatinum();
    return;
  }

  queuePlatinumAfterCurrent(message);
}

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
const progressNotificationQueue = [];
let isProgressShowing = false;
let pendingPlatinumNotification = null;
let platinumAwaitingNormal = false;
let platinumFallbackTimer = null;

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

  const resolvedPreset =
    achievement.preset || selectedPreset || prefs.preset || "default";
  const resolvedPosition =
    achievement.position ||
    selectedPosition ||
    prefs.position ||
    "center-bottom";
  const resolvedSound =
    achievement.sound || selectedSound || prefs.sound || "mute";
  const resolvedSkipScreenshot =
    achievement.skipScreenshot === true
      ? true
      : prefs.disableAchievementScreenshot === true;

  const notificationData = {
    displayName: displayName || "",
    description: description || "",
    icon: achievement.icon,
    icon_gray: achievement.icon_gray || achievement.icongray,
    config_path: achievement.config_path,
    preset: resolvedPreset,
    position: resolvedPosition,
    sound: resolvedSound,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: resolvedSkipScreenshot,
    isTest: !!achievement.isTest,
  };

  notificationLogger.info("queue-achievement", {
    displayName: notificationData.displayName,
    preset: notificationData.preset || "default",
    position: notificationData.position || "center-bottom",
    config: notificationData.config_path || null,
    test: notificationData.isTest || false,
  });
  const isPlatinum = achievement.__isPlatinum === true;
  if (!isPlatinum && pendingPlatinumNotification) {
    platinumAwaitingNormal = false;
  }
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
  notificationLogger.info("show-notification", {
    displayName: notificationData.displayName,
    preset: notificationData.preset || "default",
    position: notificationData.position || "center-bottom",
    config: notificationData.config_path || null,
    iconResolved: iconPathFinal,
  });

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

  const overrideDurationSec = Number(cachedPreferences?.notificationDuration);
  const overrideDurationMs =
    Number.isFinite(overrideDurationSec) && overrideDurationSec > 0
      ? Math.round(overrideDurationSec * 1000)
      : 0;
  const duration =
    overrideDurationMs || getPresetAnimationDuration(presetFolder);
  notificationData.durationMs = duration;
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
    windowLogger.info("create-notification-window:closed", {
      preset: notificationData.preset || "default",
      position: notificationData.position || "center-bottom",
    });
    isNotificationShowing = false;
    processNextNotification();
    flushPendingPlatinum();
  });

  setTimeout(() => {
    if (!notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  }, duration);
}

function flushPendingPlatinum() {
  if (
    pendingPlatinumNotification &&
    !platinumAwaitingNormal &&
    !isNotificationShowing &&
    earnedNotificationQueue.length === 0
  ) {
    queueAchievementNotification(pendingPlatinumNotification);
    pendingPlatinumNotification = null;
    if (platinumFallbackTimer) {
      clearTimeout(platinumFallbackTimer);
      platinumFallbackTimer = null;
    }
  } else if (
    !pendingPlatinumNotification &&
    !isNotificationShowing &&
    earnedNotificationQueue.length === 0 &&
    pendingPlatinumByConfig.size > 0
  ) {
    const [key, payload] = pendingPlatinumByConfig.entries().next().value || [];
    if (key) pendingPlatinumByConfig.delete(key);
    if (payload) {
      queuePlatinumAfterCurrent(payload);
    }
  }
}

function queuePlatinumAfterCurrent(notificationData) {
  pendingPlatinumNotification = notificationData;
  platinumAwaitingNormal = true;
  if (platinumFallbackTimer) clearTimeout(platinumFallbackTimer);
  platinumFallbackTimer = setTimeout(() => {
    platinumAwaitingNormal = false;
    flushPendingPlatinum();
  }, 300);
  flushPendingPlatinum();
}

function queueProgressNotification(data) {
  if (global.disableProgress) return;
  if (isProgressMutedByPrefs(cachedPreferences, data)) {
    notificationLogger.info("queue-progress:muted", {
      displayName: data?.displayName || "",
      config: data?.config_path || null,
    });
    return;
  }
  notificationLogger.info("queue-progress", {
    displayName: data?.displayName || "",
    progress: data?.progress ?? null,
    max: data?.max_progress ?? null,
    config: data?.config_path || null,
  });
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

const bootSeededCacheKeys = new Set();
let bootManualSeedScheduled = false;
let bootManualSeedRunning = false;

function normalizeCacheSeedPath(input) {
  if (!input) return "";
  let resolved = "";
  try {
    resolved = fs.realpathSync(input);
  } catch {
    try {
      resolved = path.resolve(String(input));
    } catch {
      resolved = String(input);
    }
  }
  if (!resolved) return "";
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function buildCacheSeedKey(config) {
  if (!config || typeof config !== "object") return "";
  const cfgPath = normalizeCacheSeedPath(config.config_path);
  if (cfgPath) return `cfg:${cfgPath}`;
  const savePath = normalizeCacheSeedPath(config.save_path);
  if (savePath) return `save:${savePath}`;
  const name = sanitizeConfigName(config.name || config.displayName || "");
  return name ? `name:${name}` : "";
}

function markCacheSeedKeyFromConfig(config) {
  const key = buildCacheSeedKey(config);
  if (key) bootSeededCacheKeys.add(key);
  return key;
}

function markCacheSeedKeyFromName(configName) {
  const safeName = sanitizeConfigName(configName);
  if (!safeName) return "";
  const cfgPath = path.join(configsDir, `${safeName}.json`);
  if (fs.existsSync(cfgPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      return markCacheSeedKeyFromConfig(data);
    } catch {}
  }
  const fallback = `name:${safeName}`;
  bootSeededCacheKeys.add(fallback);
  return fallback;
}

function loadPreviousAchievements(configName) {
  const cachePath = getCachePath(configName);
  if (fs.existsSync(cachePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      persistenceLogger.info("load-achievement-cache:hit", {
        config: configName,
        path: cachePath,
        count: data ? Object.keys(data).length : 0,
      });
      return data;
    } catch (e) {
      notifyError("Error reading achievement cache: " + e.message);
      persistenceLogger.error("load-achievement-cache:error", {
        config: configName,
        error: e.message,
      });
    }
  }
  persistenceLogger.info("load-achievement-cache:miss", {
    config: configName,
    path: cachePath,
  });
  return {};
}

function savePreviousAchievements(configName, data) {
  const cachePath = getCachePath(configName);
  try {
    const ordered = {};
    const keys = Object.keys(data || {});
    const known = new Set([
      "earned",
      "earned_time",
      "max_progress",
      "progress",
    ]);
    for (const key of keys) {
      const entry = data?.[key];
      if (!entry || typeof entry !== "object") {
        ordered[key] = entry;
        continue;
      }
      const normalized = {};
      if (Object.prototype.hasOwnProperty.call(entry, "earned")) {
        normalized.earned = entry.earned;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "earned_time")) {
        normalized.earned_time = entry.earned_time;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "max_progress")) {
        normalized.max_progress = entry.max_progress;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "progress")) {
        normalized.progress = entry.progress;
      }
      for (const [k, v] of Object.entries(entry)) {
        if (known.has(k)) continue;
        normalized[k] = v;
      }
      ordered[key] = normalized;
    }
    fs.writeFileSync(cachePath, JSON.stringify(ordered, null, 2));
    persistenceLogger.info("save-achievement-cache", {
      config: configName,
      path: cachePath,
      count: data ? Object.keys(data).length : 0,
    });
  } catch (e) {
    notifyError("Error reading achievement cache: " + e.message);
    persistenceLogger.error("save-achievement-cache:error", {
      config: configName,
      error: e.message,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedCacheFromSnapshot(configName, snapshot) {
  if (!configName || !snapshot) return;
  savePreviousAchievements(configName, snapshot);
  markCacheSeedKeyFromName(configName);
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

function findAchievementFileDeep(baseDir, maxDepth = 2) {
  if (!isNonEmptyString(baseDir)) return null;
  const targets = [
    "achievements.json",
    "achievements.ini",
    "stats.bin",
    "user_stats.ini",
  ];
  const targetLc = targets.map((t) => t.toLowerCase());
  const stack = [{ dir: baseDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && targetLc.includes(ent.name.toLowerCase())) {
          return path.join(dir, ent.name);
        }
      }
      if (depth < maxDepth) {
        for (const ent of entries) {
          if (ent.isDirectory()) {
            stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findAchievementFileDeepForAppId(saveBase, appid, maxDepth = 2) {
  if (!isNonEmptyString(saveBase) || !isNonEmptyString(appid)) return null;
  const appidStr = String(appid);
  const candidates = [];
  if (path.basename(saveBase) === appidStr) {
    candidates.push(saveBase);
  }
  candidates.push(
    path.join(saveBase, "steam_settings", appidStr),
    path.join(saveBase, appidStr),
    path.join(saveBase, "remote", appidStr)
  );
  for (const root of candidates) {
    if (!root || !fs.existsSync(root)) continue;
    const found = findAchievementFileDeep(root, maxDepth);
    if (found) return found;
  }
  return null;
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
      const bootNotDoneYet = bootSeeding && global.bootDone !== true;
      if (bootNotDoneYet) {
        previousAchievements = { ...currentAchievements };
        savePreviousAchievements(configName, previousAchievements);
        isFirstLoad = false;
        bootSeeding = false;
        return;
      }
      bootSeeding = false;
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
              configName,
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
              configName,
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
      const tenokePath = path.join(baseDir, "SteamData", "user_stats.ini");
      const iniPath = path.join(baseDir, "achievements.ini");
      const universeIniPath = path.join(
        baseDir,
        "UniverseLANData",
        "Achievements.ini"
      );
      const onlineFixIniPath = path.join(baseDir, "Stats", "achievements.ini");
      const binPath = path.join(baseDir, "stats.bin");

      if (fs.existsSync(tenokePath)) {
        monitorAchievementsFile(tenokePath);
        return;
      }

      if (fs.existsSync(iniPath)) {
        monitorAchievementsFile(iniPath);
        return;
      }

      if (fs.existsSync(universeIniPath)) {
        monitorAchievementsFile(universeIniPath);
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

      // Retry discovery later in case the save file appears after config load
      setTimeout(checkFileLoop, 1000);
    }
  };

  checkFileLoop();
}

let fullAchievementsConfigPath;
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

  const appIdString = config?.appid != null ? String(config.appid).trim() : "";

  if (appIdString && isAppIdBlacklisted(appIdString)) {
    ipcLogger.info("update-config:ignored-blacklisted", {
      configName: configName || null,
      appid: appIdString,
    });
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
    tenokeIni: tenokeIniPath,
    ini: iniPath,
    ofx: onlineFixIniPath,
    bin: binPath,
  } = resolveSaveSidecarPaths(saveBase, appid);

  if (fs.existsSync(saveJsonPath)) achievementsFilePath = saveJsonPath;
  else if (tenokeIniPath) achievementsFilePath = tenokeIniPath;
  else if (onlineFixIniPath) achievementsFilePath = onlineFixIniPath;
  else if (iniPath) achievementsFilePath = iniPath;
  else if (binPath) achievementsFilePath = binPath;
  else achievementsFilePath = saveJsonPath; // fallback

  if (
    (!achievementsFilePath || !fs.existsSync(achievementsFilePath)) &&
    isNonEmptyString(saveBase)
  ) {
    const deep = findAchievementFileDeepForAppId(saveBase, appid, 2);
    if (deep) {
      achievementsFilePath = deep;
      try {
        const cfgFile = path.join(configsDir, `${safeName}.json`);
        if (fs.existsSync(cfgFile)) {
          const raw = fs.readFileSync(cfgFile, "utf8");
          const data = JSON.parse(raw);
          data.save_path = path.dirname(deep);
          fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2));
          selectedConfigPath = isNonEmptyString(data.config_path)
            ? data.config_path
            : null;
        }
      } catch {}
    }
  }

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
            if (
              /^[0-9a-fA-F]+$/.test(target) &&
              /^[0-9a-fA-F]+$/.test(String(val || ""))
            ) {
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
    const hasAppId = /^[0-9a-fA-F]+$/.test(appid);
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
      const schemaBase = path.join(configsDir, "schema");
      const platformDir = resolveSchemaDirForPlatform(appid, data?.platform);
      const platformJson = path.join(platformDir, "achievements.json");
      const legacyDir = path.join(schemaBase, appid);
      const legacyJson = path.join(legacyDir, "achievements.json");
      const candidates = [
        { dir: platformDir, file: platformJson },
        { dir: legacyDir, file: legacyJson, legacy: true },
      ];
      for (const candidate of candidates) {
        if (candidate.legacy && candidate.dir !== platformDir) {
          try {
            fs.mkdirSync(platformDir, { recursive: true });
            fs.renameSync(candidate.dir, platformDir);
            candidate.dir = platformDir;
            candidate.file = path.join(platformDir, "achievements.json");
          } catch {}
        }
        if (!fs.existsSync(candidate.file)) {
          await waitForPathExists(candidate.file, 40, 60);
        }
        if (
          fs.existsSync(candidate.file) &&
          looksLikeSchemaArray(readJsonSafe(candidate.file))
        ) {
          data.config_path = candidate.dir;
          try {
            const now = readJsonWithRetries(configPath, 3, 40);
            if (now.config_path !== candidate.dir) {
              now.config_path = candidate.dir;
              fs.writeFileSync(configPath, JSON.stringify(now, null, 2));
              data = now;
            }
          } catch {}
          foundSchemaPath = candidate.file;
          break;
        }
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
    let prevConfig = null;
    if (fs.existsSync(oldConfigPath)) {
      try {
        prevConfig = JSON.parse(fs.readFileSync(oldConfigPath, "utf8"));
      } catch {}
    }

    if (safeOld !== safeNew && fs.existsSync(oldConfigPath)) {
      fs.renameSync(oldConfigPath, newConfigPath);
    }

    const exePath = isNonEmptyString(newConfig.executable)
      ? newConfig.executable
      : null;

    const payload = {
      ...prevConfig, // preserve custom fields like platinum
      ...newConfig,
      name: safeNew,
      displayName: newConfig.displayName || newConfig.name,
      config_path: isNonEmptyString(newConfig.config_path)
        ? newConfig.config_path
        : null,
      save_path: isNonEmptyString(newConfig.save_path)
        ? newConfig.save_path
        : null,
      executable: exePath,
      arguments: isNonEmptyString(newConfig.arguments)
        ? newConfig.arguments
        : "",
      process_name: isNonEmptyString(newConfig.process_name)
        ? newConfig.process_name
        : exePath
        ? path.basename(exePath)
        : "",
    };

    const sanitizedAppId = sanitizeAppId(payload.appid);
    if (!sanitizedAppId) {
      return { success: false, message: "AppID is required." };
    }
    if (isAppIdBlacklisted(sanitizedAppId)) {
      const message = `AppID ${sanitizedAppId} is blacklisted. Remove it to continue.`;
      ipcLogger.info("renameConfig:blocked-blacklist", {
        appid: sanitizedAppId,
        oldName: safeOld,
        newName: safeNew,
      });
      return { success: false, message, blacklisted: true };
    }
    payload.appid = sanitizedAppId;

    applyConfigPlatformDefaults(payload);
    const prevPlatform = normalizePlatform(prevConfig?.platform) || null;
    let nextPlatform = normalizePlatform(payload.platform) || null;
    if (!nextPlatform && /[a-f]/i.test(String(payload.appid || ""))) {
      nextPlatform = "epic";
    }
    nextPlatform = nextPlatform || "steam";
    payload.platform = nextPlatform;

    // missing config_path, generate and set path
    if (
      !payload.config_path &&
      /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
    ) {
      try {
        global.mainWindow = BrowserWindow.fromWebContents(event.sender);
      } catch {}
      const res = await ensureSchemaForApp(payload.appid, payload.platform);
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
        /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
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

    const managesSchemaPath = isManagedSchemaPath(prevConfig?.config_path);
    if (
      prevPlatform &&
      prevPlatform !== nextPlatform &&
      managesSchemaPath &&
      /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
    ) {
      ipcLogger.info("config:platform-change", {
        name: safeNew,
        appid: payload.appid,
        from: prevPlatform,
        to: nextPlatform,
      });
      try {
        const res = await ensureSchemaForApp(payload.appid, nextPlatform);
        if (res?.dir) {
          const current = JSON.parse(fs.readFileSync(newConfigPath, "utf8"));
          if (current.config_path !== res.dir) {
            current.config_path = res.dir;
            fs.writeFileSync(newConfigPath, JSON.stringify(current, null, 2));
          }
        }
      } catch (err) {
        ipcLogger.warn("renameConfig:schema-sync-failed", {
          appid: payload.appid,
          error: err?.message || String(err),
        });
      }
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
  windowLogger.info("create-overlay:start", {
    selectedConfig: selectedConfig || null,
  });
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
  windowLogger.info("create-overlay:browserwindow-created", {
    width: 450,
    height: 950,
    position: { x: width - 470, y: 20 },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setFocusable(false);
  overlayWindow.blur();
  const iconUrl = pathToFileURL(ICON_PNG_PATH).toString();
  overlayWindow.loadFile("overlay.html", { query: { icon: iconUrl } });
  windowLogger.info("create-overlay:load-file", { icon: iconUrl });

  overlayWindow.webContents.on("did-finish-load", () => {
    windowLogger.info("create-overlay:did-finish-load", {
      selectedConfig: selectedConfig || null,
    });
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", selectedLanguage);
  });

  overlayWindow.on("closed", () => {
    windowLogger.info("create-overlay:closed");
    overlayWindow = null;
  });
}

ipcMain.handle("selectExecutable", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("launchExecutable", async (_event, exePath, argsString) => {
  try {
    if (!exePath) {
      notifyError("? No executable path provided.");
      return;
    }
    const argStr = String(argsString || "").trim();
    const args = argStr ? argStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [] : [];

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    const shouldCloseToTray =
      cachedPreferences?.closeToTray === true || global.closeToTray === true;
    if (shouldCloseToTray && !isQuitting) {
      mainWindow.hide();
      return;
    }
  }
  isQuitting = true;
  app.quit();
}

ipcMain.on("minimize-window", minimizeWindow);
ipcMain.on("maximize-window", maximizeWindow);
ipcMain.on("close-window", closeWindow);
ipcMain.on("tray:action", (_event, action) => {
  const cmd = String(action || "").toLowerCase();
  if (cmd === "show") {
    hideTrayMenu();
    showMainWindowRespectingPrefs();
    return;
  }
  if (cmd === "settings") {
    hideTrayMenu();
    openSettingsFromTray();
    return;
  }
  if (cmd === "hide") {
    hideTrayMenu();
    return;
  }
  if (cmd === "quit") {
    isQuitting = true;
    app.quit();
  }
});

app.whenReady().then(async () => {
  appLogger.info("app:ready", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    platform: process.platform,
    arch: process.arch,
  });
  // Load preferences
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};

    selectedLanguage = prefs.language || selectedLanguage;
    const overlayShortcut = prefs.overlayShortcut || null;
    global.overlayShortcut = overlayShortcut;
    if (overlayShortcut) {
      registerOverlayShortcut(overlayShortcut);
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
  migrateDefaultPresetsIfNeeded();
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
  windowLogger.info("create-progress-window:start", {
    displayName: data?.displayName || "",
    config: data?.config_path || null,
  });
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
  windowLogger.info("create-progress-window:browserwindow-created", {
    size: { width: 350, height: 150 },
    position: { x: 20, y: height - 140 },
  });

  progressWindow.once("ready-to-show", () => {
    notificationLogger.info("show-progress", {
      displayName: data?.displayName || "",
      progress: data?.progress ?? null,
      max: data?.max_progress ?? null,
      config: data?.config_path || null,
    });
    windowLogger.info("create-progress-window:ready-to-show");
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
    updatePreferences({ disablePlaytime: !!value });
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
  return { ...p, displayName, description, scale: 1 };
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
  windowLogger.info("create-playtime-window:start", {
    displayName: playData?.displayName || playData?.name || null,
    phase: playData?.phase || "start",
  });
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
      windowLogger.info("create-playtime-window:reuse", {
        reason: "closing-existing",
      });
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

  const {
    x: ax,
    y: ay,
    width: aw,
  } = require("electron").screen.getPrimaryDisplay().workArea;
  const winWidth = 460;
  const winHeight = 340;
  const x = Math.floor(ax + (aw - winWidth) / 2),
    y = Math.floor(ay + 40);

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
  windowLogger.info("create-playtime-window:browserwindow-created", {
    size: { width: winWidth, height: winHeight },
    position: { x, y },
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
      const scale = normalizeNotificationScale(prefs.notificationScale).scale;
      const source = pendingPlayData ?? playData;
      const payload = normalizePlayPayload({ ...source, phase, scale });

      pendingPlayData = null;
      playtimeAlreadyClosing = false;
      playtimeWindow.show();
      windowLogger.info("create-playtime-window:dom-ready", {
        displayName: payload.displayName,
        phase: payload.phase,
        scale,
      });
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
    windowLogger.info("create-playtime-window:closed");
    playtimeWindow = null;
    playtimeAlreadyClosing = false;
    pendingPlayData = null;
  });
}

ipcMain.on("queue-achievement-notification", (_event, payload) => {
  try {
    const configName =
      payload?.configName || payload?.config_name || selectedConfig || null;
    const achKey =
      payload?.name ||
      (typeof payload?.displayName === "string" ? payload.displayName : null);
    if (configName && achKey) {
      const prev = loadPreviousAchievements(configName) || {};
      const prevEntry = prev[achKey];
      const incomingProg = Number(payload.progress);
      const prevProg = Number(prevEntry?.progress);
      const prevMax = Number(prevEntry?.max_progress);
      const maxProg = Number(payload.max_progress);
      if (prevEntry?.earned === true) return;
      if (
        Number.isFinite(incomingProg) &&
        Number.isFinite(prevProg) &&
        incomingProg <= prevProg &&
        (Number.isNaN(maxProg) || maxProg === prevMax)
      ) {
        return;
      }
    }

    queueAchievementNotification(payload);
  } catch (err) {
    notifyError(`queue-achievement-notification failed: ${err.message}`);
  }
});

ipcMain.on("queue-progress-notification", (_event, payload) => {
  try {
    const configName =
      payload?.configName || payload?.config_name || selectedConfig || null;
    const achKey =
      payload?.name ||
      (typeof payload?.displayName === "string" ? payload.displayName : null);
    if (configName && achKey) {
      const prev = loadPreviousAchievements(configName) || {};
      const prevEntry = prev[achKey];
      const incomingProg = Number(payload.progress);
      const prevProg = Number(prevEntry?.progress);
      const prevMax = Number(prevEntry?.max_progress);
      const maxProg = Number(payload.max_progress);
      if (prevEntry?.earned === true) return;
      if (
        Number.isFinite(incomingProg) &&
        Number.isFinite(prevProg) &&
        incomingProg <= prevProg &&
        (Number.isNaN(maxProg) || maxProg === prevMax)
      ) {
        return;
      }
    }

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

async function seedManualConfigsAtBoot() {
  if (bootManualSeedRunning) return;
  bootManualSeedRunning = true;
  let files = [];
  try {
    if (!fs.existsSync(configsDir)) {
      bootManualSeedRunning = false;
      return;
    }
    files = fs
      .readdirSync(configsDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    bootManualSeedRunning = false;
    return;
  }

  persistenceLogger.info("boot-cache:manual-start", { total: files.length });
  for (const file of files) {
    const full = path.join(configsDir, file);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    const configName = config?.name || path.basename(file, ".json");
    const savePathRaw = config?.save_path;
    if (!savePathRaw) continue;

    const seedKey = buildCacheSeedKey(config);
    if (seedKey && bootSeededCacheKeys.has(seedKey)) continue;

    const cachePath = getCachePath(configName);
    if (fs.existsSync(cachePath)) {
      if (seedKey) bootSeededCacheKeys.add(seedKey);
      continue;
    }

    let saveRoot = savePathRaw;
    let candidatePath = null;
    try {
      const stat = fs.statSync(savePathRaw);
      if (stat.isFile()) {
        candidatePath = savePathRaw;
        saveRoot = path.dirname(savePathRaw);
      }
    } catch {}
    if (!candidatePath) {
      if (!fs.existsSync(saveRoot)) continue;
      const appid = String(config?.appid || "").trim();
      const saveJsonPath = resolveSaveFilePath(saveRoot, appid);
      const {
        tenokeIni: tenokeIniPath,
        ini: iniPath,
        ofx: onlineFixIniPath,
        bin: binPath,
      } = resolveSaveSidecarPaths(saveRoot, appid);
      if (fs.existsSync(saveJsonPath)) candidatePath = saveJsonPath;
      else if (tenokeIniPath) candidatePath = tenokeIniPath;
      else if (onlineFixIniPath) candidatePath = onlineFixIniPath;
      else if (iniPath) candidatePath = iniPath;
      else if (binPath) candidatePath = binPath;
      else if (appid) {
        candidatePath = findAchievementFileDeepForAppId(saveRoot, appid, 2);
      } else {
        candidatePath = findAchievementFileDeep(saveRoot, 2);
      }
    }
    if (!candidatePath) continue;

    let schemaPath = null;
    try {
      schemaPath = resolveConfigSchemaPath(
        config,
        config?.config_path || null
      );
    } catch {}
    const snapshot = loadAchievementsFromSaveFile(
      path.dirname(candidatePath),
      {},
      {
        configMeta: config,
        selectedConfigPath: config?.config_path || null,
        fullSchemaPath: schemaPath,
      }
    );
    if (snapshot && Object.keys(snapshot).length) {
      seedCacheFromSnapshot(configName, snapshot);
      if (seedKey) bootSeededCacheKeys.add(seedKey);
      persistenceLogger.info("boot-cache:manual-seeded", {
        config: configName,
        entries: Object.keys(snapshot).length,
      });
    }
    await sleep(40);
  }
  persistenceLogger.info("boot-cache:manual-complete", { total: files.length });
  bootManualSeedRunning = false;
}

function scheduleManualCacheSeedAfterBoot() {
  if (bootManualSeedScheduled) return;
  bootManualSeedScheduled = true;
  const tick = async () => {
    if (global.bootDone === true) {
      await seedManualConfigsAtBoot();
      return;
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}
const {
  migrateConfigPlatforms,
  normalizePlatform,
  sanitizeAppId,
  inferPlatformAndSteamId,
  migrateSchemaStorage,
} = require("./utils/config-platform-migrator");
ipcMain.handle("parse-stats-bin", async (_event, filePath) => {
  try {
    const parseStatsBin = require("./utils/parseStatsBin");
    return parseStatsBin(filePath);
  } catch (err) {
    notifyError(`parse-stats-bin failed: ${err.message}`);
    throw err;
  }
});

const defaultUplaySteamMapPath = path.join(
  __dirname,
  "assets",
  "uplay-steam.json"
);
const runtimeUplaySteamMapPath = path.join(
  app.getPath("userData"),
  "uplay-steam.json"
);
function ensureRuntimeUplayMap() {
  try {
    if (fs.existsSync(runtimeUplaySteamMapPath)) return;
    fs.mkdirSync(path.dirname(runtimeUplaySteamMapPath), { recursive: true });
    if (fs.existsSync(defaultUplaySteamMapPath)) {
      fs.copyFileSync(defaultUplaySteamMapPath, runtimeUplaySteamMapPath);
    } else {
      fs.writeFileSync(runtimeUplaySteamMapPath, "[]", "utf8");
    }
  } catch (err) {
    ipcLogger.warn("uplay-mapping:init-failed", {
      error: err?.message || String(err),
    });
  }
}
function loadRuntimeUplayMap() {
  try {
    const raw = fs.readFileSync(runtimeUplaySteamMapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    ipcLogger.warn("uplay-mapping:load-failed", {
      error: err?.message || String(err),
    });
    return [];
  }
}
function refreshRuntimeUplayMapping() {
  try {
    const script = path.join(__dirname, "utils", "match-uplay-steam.js");
    execFileSync(
      process.execPath,
      ["--run-as-node", script, `--output=${runtimeUplaySteamMapPath}`],
      {
        windowsHide: true,
        stdio: "ignore",
      }
    );
    ipcLogger.info("uplay-mapping:refresh-success");
  } catch (err) {
    ipcLogger.warn("uplay-mapping:refresh-failed", {
      error: err?.message || String(err),
    });
  }
}
function hydrateRuntimeMapping(rows) {
  uplaySteamMap = Array.isArray(rows) ? rows : [];
  uplayToSteam.clear();
  for (const row of uplaySteamMap) {
    if (row && row.uplay_id) {
      uplayToSteam.set(String(row.uplay_id), row);
    }
  }
}

function refreshRuntimeUplayMappingAsync() {
  if (refreshRuntimeUplayMappingAsync.inflight) return;
  const script = path.join(__dirname, "utils", "match-uplay-steam.js");
  refreshRuntimeUplayMappingAsync.inflight = true;
  execFile(
    process.execPath,
    ["--run-as-node", script, `--output=${runtimeUplaySteamMapPath}`],
    { windowsHide: true },
    (err) => {
      if (err) {
        ipcLogger.warn("uplay-mapping:refresh-failed", {
          error: err?.message || String(err),
        });
      } else {
        try {
          const rows = loadRuntimeUplayMap();
          hydrateRuntimeMapping(rows);
          ipcLogger.info("uplay-mapping:refresh-success", {
            entries: uplaySteamMap.length,
          });
        } catch (reloadErr) {
          ipcLogger.warn("uplay-mapping:refresh-reload-failed", {
            error: reloadErr?.message || String(reloadErr),
          });
        }
      }
      refreshRuntimeUplayMappingAsync.inflight = false;
    }
  );
}
refreshRuntimeUplayMappingAsync.inflight = false;

ensureRuntimeUplayMap();
let uplaySteamMap = loadRuntimeUplayMap();
const uplayToSteam = new Map();
hydrateRuntimeMapping(uplaySteamMap);
refreshRuntimeUplayMappingAsync();

function applyConfigPlatformDefaults(payload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const sanitizedAppId =
    sanitizeAppId(payload.appid) ||
    sanitizeAppId(payload.appId) ||
    sanitizeAppId(payload.steamAppId);
  if (sanitizedAppId) {
    payload.appid = sanitizedAppId;
  }
  const mapping = sanitizedAppId ? uplayToSteam.get(sanitizedAppId) : null;
  const { platform, steamAppId } = inferPlatformAndSteamId({
    config: payload,
    mapping,
  });
  if (platform) payload.platform = platform;
  else delete payload.platform;
  if (steamAppId) payload.steamAppId = steamAppId;
  else delete payload.steamAppId;
  return payload;
}

const SCHEMA_ROOT_PATH = path.join(configsDir, "schema");
const SCHEMA_PLATFORM_DIRS = ["steam", "uplay", "gog", "epic"];

function normalizeStoragePlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === "uplay") return "uplay";
  if (normalized === "gog") return "gog";
  if (normalized === "epic") return "epic";
  return "steam";
}

function resolveSchemaDirForPlatform(appid, platform) {
  const storagePlatform = normalizeStoragePlatform(platform);
  return path.join(SCHEMA_ROOT_PATH, storagePlatform, String(appid));
}

function isManagedSchemaPath(p) {
  if (!isNonEmptyString(p)) return true;
  const normalized = path.normalize(p).toLowerCase();
  return normalized.startsWith(path.normalize(SCHEMA_ROOT_PATH).toLowerCase());
}

function schemaPathMatchesPlatform(appid, platform, schemaPath) {
  if (!isManagedSchemaPath(schemaPath)) return false;
  const expected = resolveSchemaDirForPlatform(appid, platform);
  return (
    path.normalize(schemaPath || "").toLowerCase() ===
    path.normalize(expected).toLowerCase()
  );
}
const { updated: platformMetaUpdated, platformIndex: configPlatformIndex } =
  migrateConfigPlatforms({
    configsDir,
    mappingByUplayId: uplayToSteam,
    logger: persistenceLogger,
  });
if (platformMetaUpdated) {
  persistenceLogger.info("platform-migrate:configs-updated", {
    updated: platformMetaUpdated,
  });
}
global.configPlatformIndex = configPlatformIndex;
const { moved: schemaDirsMoved, updatedConfigs: schemaConfigsUpdated } =
  migrateSchemaStorage({
    configsDir,
    platformIndex: configPlatformIndex,
    logger: persistenceLogger,
  });
if (schemaDirsMoved || schemaConfigsUpdated) {
  persistenceLogger.info("platform-migrate:schema-updated", {
    moved: schemaDirsMoved,
    configsUpdated: schemaConfigsUpdated,
  });
}

function getPlatformForAppId(appid) {
  const key = String(appid || "").trim();
  if (!key) return "steam";
  try {
    const idx = global.configPlatformIndex;
    const set = idx && typeof idx.get === "function" ? idx.get(key) : null;
    if (!set || set.size === 0) return "steam";
    const order = ["steam", "uplay", "gog", "epic"];
    for (const p of order) {
      if (set.has(p)) return p;
    }
    const first = set.values().next();
    return first && typeof first.value === "string" ? first.value : "steam";
  } catch {
    return "steam";
  }
}

function pickFresherPath(src, dest) {
  try {
    if (!fs.existsSync(dest)) return src;
    const sStat = fs.statSync(src);
    const dStat = fs.statSync(dest);
    return sStat.mtimeMs >= dStat.mtimeMs ? src : dest;
  } catch {
    return src;
  }
}

function migrateImagesToPlatformStorage() {
  let imagesRoot;
  try {
    imagesRoot = path.join(app.getPath("userData"), "images");
  } catch {
    return;
  }
  if (!imagesRoot || !fs.existsSync(imagesRoot)) return;

  const isNumeric = (name) => /^[0-9a-fA-F]+$/.test(String(name || ""));
  const entries = fs.readdirSync(imagesRoot, { withFileTypes: true });

  // Covers: images/<appid>.jpg -> images/<platform>/<appid>/<appid>.jpg
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^(\d+)\.jpg$/i);
    if (!m) continue;
    const appid = m[1];
    const platform = getPlatformForAppId(appid);
    const src = path.join(imagesRoot, entry.name);
    const destDir = path.join(imagesRoot, platform, appid);
    const dest = path.join(destDir, `${appid}.jpg`);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const preferred = pickFresherPath(src, dest);
      if (preferred === src) {
        fs.renameSync(src, dest);
      } else {
        fs.unlinkSync(src);
      }
    } catch (err) {
      ipcLogger?.warn?.("images:migrate-cover-failed", {
        appid,
        platform,
        error: err?.message || String(err),
      });
    }
  }

  // Headers/other per-app folders: images/<appid>/header.jpg -> images/<platform>/<appid>/header.jpg
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appid = entry.name;
    if (!isNumeric(appid)) continue;
    const srcDir = path.join(imagesRoot, appid);
    const platform = getPlatformForAppId(appid);
    const destDir = path.join(imagesRoot, platform, appid);
    try {
      const files = fs.readdirSync(srcDir);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of files || []) {
        const src = path.join(srcDir, file);
        const dest = path.join(destDir, file);
        try {
          const preferred = pickFresherPath(src, dest);
          if (preferred === src) {
            fs.renameSync(src, dest);
          } else {
            fs.unlinkSync(src);
          }
        } catch (moveErr) {
          ipcLogger?.warn?.("images:migrate-header-failed", {
            appid,
            file,
            platform,
            error: moveErr?.message || String(moveErr),
          });
        }
      }
      try {
        fs.rmdirSync(srcDir);
      } catch {}
    } catch (err) {
      ipcLogger?.warn?.("images:migrate-dir-failed", {
        appid,
        platform,
        error: err?.message || String(err),
      });
    }
  }
}

migrateImagesToPlatformStorage();

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
    ensureSteamApiKeyFileFromPrefs();
    const result = await generateGameConfigs(folderPath, outputDir, {
      onSeedCache: ({ appid, configName, snapshot }) => {
        try {
          seedCacheFromSnapshot(configName, snapshot);
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

const {
  fetchSteamDbLibraryCover,
  fetchSteamGridDbImage,
} = require("./utils/game-cover");

ipcMain.handle("covers:steamdb", async (_evt, appid) => {
  try {
    const mapping = uplayToSteam.get(String(appid));
    const steamAppId = mapping?.steam_appid
      ? String(mapping.steam_appid)
      : String(appid);
    const url = await fetchSteamDbLibraryCover(String(steamAppId));
    return { ok: true, url };
  } catch (err) {
    const notFound = err && err.tag === Symbol.for("steamdb-miss");
    return { ok: false, notFound, message: String(err?.message || err) };
  }
});

ipcMain.handle("covers:steamgriddb", async (_evt, payload = {}) => {
  try {
    const term = String(payload?.term || "").trim();
    if (!term) throw new Error("term-required");
    const size = payload?.size || "600x900";
    const url = await fetchSteamGridDbImage(term, { size });
    return { ok: true, url };
  } catch (err) {
    const notFound = err && err.tag === Symbol.for("steamgriddb-miss");
    return { ok: false, notFound, message: String(err?.message || err) };
  }
});

ipcMain.handle("uplay:steam-appid", async (_evt, appid) => {
  const mapping = uplayToSteam.get(String(appid));
  return mapping?.steam_appid ? String(mapping.steam_appid) : null;
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

ipcMain.handle("covers:ui-log", async (_event, payload = {}) => {
  const level = ["info", "warn", "error"].includes(
    String(payload.level || "").toLowerCase()
  )
    ? String(payload.level || "").toLowerCase()
    : "info";
  const message = String(payload.message || "").trim();
  const meta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  try {
    coverUiLogger[level](
      message || "covers:ui-log",
      Object.keys(meta).length ? meta : undefined
    );
  } catch {}
  return true;
});

ipcMain.handle("ui:log", async (_event, payload = {}) => {
  const level = ["debug", "info", "warn", "error"].includes(
    String(payload.level || "").toLowerCase()
  )
    ? String(payload.level || "").toLowerCase()
    : "info";
  const message = String(payload.message || "").trim();
  const meta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  try {
    uiLogger[level](
      message || "ui:log",
      Object.keys(meta).length ? meta : undefined
    );
  } catch {}
  return true;
});

const makeWatchedFolders = require("./utils/watched-folders");

watchedFoldersApi = makeWatchedFolders({
  app,
  ipcMain,
  BrowserWindow,
  preferencesPath,
  updatePreferences,
  configsDir,
  generateGameConfigs,
  generateConfigForAppId,
  notifyWarn: (m) => console.warn(m),
  requestDashboardRefresh,
  onSeedCache: ({ appid, configName, snapshot }) => {
    try {
      seedCacheFromSnapshot(configName, snapshot);
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
  onPlatinumComplete: handlePlatinumComplete,
});

scheduleManualCacheSeedAfterBoot();

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
  } catch (err) {
    prefsLogger.error("read-preferences:error", { error: err.message });
    return {};
  }
}
ipcMain.handle("platinum:manual", async (_event, payload = {}) => {
  const {
    configName = "",
    appid = null,
    savePath = null,
    configPath = null,
    suppressNotify = false,
  } = payload || {};
  const flagged = markConfigPlatinumFlag(configName);
  const alreadyFlagged = flagged === false;
  if (
    !suppressNotify &&
    !cachedPreferences.disablePlatinum &&
    !alreadyFlagged
  ) {
    handlePlatinumComplete({
      configName,
      appid,
      savePath,
      configPath,
      isActive: false,
    });
  }
  return { flagged: flagged || alreadyFlagged };
});
// Flag already-complete configs at boot to avoid retroactive platinum popups
async function flagPlatinumFromCacheOnBoot() {
  try {
    const files = fs
      .readdirSync(configsDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const name = path.basename(file, ".json");
      const configPath = path.join(configsDir, file);
      let config = null;
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(raw);
      } catch {
        continue;
      }
      const schemaPath = resolveConfigSchemaPath(config);
      if (!schemaPath || !fs.existsSync(schemaPath)) continue;
      let schema = null;
      try {
        schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      } catch {
        continue;
      }
      const schemaNames = Array.isArray(schema)
        ? schema
            .map((a) => (a && a.name ? String(a.name) : null))
            .filter(Boolean)
        : [];
      if (!schemaNames.length) continue;

      const snapshot = loadPreviousAchievements(name) || {};
      const isEarnedByName = (achName) => {
        const main = snapshot?.[achName];
        if (main?.earned) return true;
        if (/^ach_/i.test(achName)) {
          const alt = achName.replace(/^ach_/i, "");
          return !!snapshot?.[alt]?.earned;
        }
        const withPrefix = `ach_${achName}`;
        return !!snapshot?.[withPrefix]?.earned;
      };

      const total = schemaNames.length;
      const earned = schemaNames.filter(isEarnedByName).length;
      if (total > 0 && earned === total) {
        markConfigPlatinumFlag(name);
      }
    }
  } catch {}
}

app.on("before-quit", () => {
  appLogger.info("app:before-quit", {
    isQuitting,
    hasMainWindow: !!mainWindow && !mainWindow.isDestroyed(),
  });
  isQuitting = true;
  manualLaunchInProgress = false;
  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    playtimeWindow.destroy();
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.destroy();
  }
});

flagPlatinumFromCacheOnBoot();
app.on("window-all-closed", () => {
  appLogger.info("app:window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("render-process-gone", (_event, webContents, details) => {
  appLogger.error("process:render-gone", {
    reason: details?.reason,
    exitCode: details?.exitCode,
    type: details?.type,
    id: webContents?.id,
    url: webContents?.getURL?.() || null,
  });
  ipcLogger.error("process:render-gone", {
    reason: details?.reason,
    exitCode: details?.exitCode,
    type: details?.type,
    id: webContents?.id,
    url: webContents?.getURL?.() || null,
  });
});

app.on("child-process-gone", (_event, details) => {
  appLogger.error("process:child-gone", {
    type: details?.type,
    reason: details?.reason,
    exitCode: details?.exitCode,
    name: details?.name,
  });
  ipcLogger.error("process:child-gone", {
    type: details?.type,
    reason: details?.reason,
    exitCode: details?.exitCode,
    name: details?.name,
  });
});
