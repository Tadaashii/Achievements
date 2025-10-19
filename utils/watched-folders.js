// utils/watched-folders.js
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const chokidar = require("chokidar");
function isAppIdName(name) {
  return /^\d+$/.test(String(name || ""));
}
const {
  loadAchievementsFromSaveFile,
  getSafeLocalizedText,
} = require("./achievement-data");

function coercePath(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (input.path && typeof input.path === "string") return input.path;
  if (input.filePath && typeof input.filePath === "string")
    return input.filePath;
  if (Array.isArray(input.filePaths) && input.filePaths[0])
    return input.filePaths[0];
  try {
    return String(input);
  } catch {
    return "";
  }
}

function waitForFileExists(fp, tries = 50, delay = 60) {
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

const DEFAULT_WATCH_ROOTS = (() => {
  const spec = [
    ["PUBLIC", ["Documents", "Steam", "CODEX"]],
    ["PUBLIC", ["Documents", "Steam", "RUNE"]],
    ["PUBLIC", ["Documents", "OnlineFix"]],
    ["PUBLIC", ["Documents", "EMPRESS"]],
    ["APPDATA", ["Goldberg SteamEmu Saves"]],
    ["APPDATA", ["GSE Saves"]],
    ["APPDATA", ["EMPRESS"]],
    ["LOCALAPPDATA", ["anadius", "LSX emu", "achievement_watcher"]],
    ["APPDATA", ["Steam", "CODEX"]],
    ["APPDATA", ["SmartSteamEmu"]],
    ["LOCALAPPDATA", ["SKIDROW"]],
  ];

  return spec
    .map(([envKey, segments]) => {
      const base = process.env[envKey];
      if (!base) return null;
      try {
        return path.join(base, ...segments);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
})();

module.exports = function makeWatchedFolders({
  app,
  ipcMain,
  BrowserWindow,
  preferencesPath,
  configsDir,
  generateGameConfigs,
  generateConfigForAppId = null,
  notifyWarn = (m) => console.warn(m),
  onEarned = null,
  onProgress = null,
  onSeedCache = null, // ( { appid, configName, snapshot } ) => void
  onAutoSelect = null, // (configName) => void
  isConfigActive = null,
  getCachedSnapshot = null,
}) {
  // --- state ---
  const folderWatchers = new Map();
  const knownAppIds = new Set();
  const existingConfigIds = new Set();
  const activeRoots = new Set();
  const configIndex = new Map();
  const appidSaveWatchers = new Map();
  const rescanInProgress = { value: false };
  const normalize = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };

  const BOOT_GEN_CONCURRENCY = 3;
  const BOOT_GEN_SLICE_MS = 0;
  let bootMode = true;

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function generateIdsThrottled(ids, discoveredMap) {
    let running = 0;
    let idx = 0;

    return new Promise((resolve) => {
      const next = async () => {
        while (running < BOOT_GEN_CONCURRENCY && idx < ids.length) {
          const id = ids[idx++];
          running++;
          (async () => {
            const appDir = discoveredMap.get(id) || null;
            try {
              await generateOneAppId(id, appDir);
            } catch {
            } finally {
              running--;
              setTimeout(next, BOOT_GEN_SLICE_MS);
            }
          })();
        }
        if (running === 0 && idx >= ids.length) resolve();
      };
      next();
    });
  }

  // --- prefs helpers ---
  function readPrefsSafe() {
    try {
      return fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
        : {};
    } catch {
      return {};
    }
  }
  function getWatchedFolders() {
    const prefs = readPrefsSafe();
    const userFolders = Array.isArray(prefs.watchedFolders)
      ? prefs.watchedFolders
      : [];

    const merged = new Set(
      [...DEFAULT_WATCH_ROOTS, ...userFolders].filter(Boolean).map((dir) => {
        try {
          return fs.realpathSync(dir);
        } catch {
          return dir;
        }
      })
    );

    return Array.from(merged).filter((dir) => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    });
  }
  function saveWatchedFolders(list) {
    try {
      const cur = readPrefsSafe();
      // normalize and realpath to collapse case/links
      const norm = (p) => {
        try {
          p = fs.realpathSync(p);
        } catch {}
        return p;
      };
      const uniq = Array.from(new Set((list || []).filter(Boolean).map(norm)));
      fs.writeFileSync(
        preferencesPath,
        JSON.stringify({ ...cur, watchedFolders: uniq }, null, 2)
      );
      return uniq;
    } catch (e) {
      console.error("[folders] persist failed:", e.message);
      return list || [];
    }
  }

  // --- helpers ---
  function broadcastAll(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      } catch {}
    }
  }

  function indexExistingConfigsSync() {
    existingConfigIds.clear();
    configIndex.clear();
    try {
      const files = fs.readdirSync(configsDir);
      for (const f of files.slice(0, 5000)) {
        if (!f.toLowerCase().endsWith(".json")) continue;
        try {
          const p = path.join(configsDir, f);
          const raw = fs.readFileSync(p, "utf8");
          const data = JSON.parse(raw);

          const appid = String(
            data?.appid || data?.appId || data?.steamAppId || ""
          ).trim();

          if (appid && /^\d+$/.test(appid)) {
            existingConfigIds.add(appid);
            configIndex.set(appid, {
              name: data?.name || path.basename(f, ".json"),
              appid,
              save_path: data?.save_path || null,
              config_path: data?.config_path || null,
            });
          }
        } catch {
          /* ignore */
        }
      }
    } catch {}
  }

  const lastSnapshot = new Map(); // appid -> { [achName]: { earned, progress, max_progress, earned_time } }

  function readJsonSafe(fp) {
    try {
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      return null;
    }
  }

  function resolveAchievementsSchemaPath(meta) {
    if (!meta?.config_path) return null;
    const p1 = path.join(meta.config_path, "achievements.json");
    if (fs.existsSync(p1)) return p1;
    if (meta?.appid != null) {
      const p2 = path.join(
        meta.config_path,
        String(meta.appid),
        "achievements.json"
      );
      if (fs.existsSync(p2)) return p2;
    }
    return null;
  }

  function getConfigEntry(meta, key) {
    const schemaPath = resolveAchievementsSchemaPath(meta);
    if (!schemaPath) return null;
    const arr = readJsonSafe(schemaPath);
    if (!Array.isArray(arr)) return null;
    return arr.find((item) => item?.name === key) || null;
  }

  function getSaveWatchTargets(meta) {
    const out = new Set();
    if (!meta?.save_path) return [];

    out.add(meta.save_path);

    // JSON
    out.add(path.join(meta.save_path, "achievements.json"));
    out.add(path.join(meta.save_path, String(meta.appid), "achievements.json"));
    out.add(
      path.join(
        meta.save_path,
        "steam_settings",
        String(meta.appid),
        "achievements.json"
      )
    );
    out.add(
      path.join(
        meta.save_path,
        "remote",
        String(meta.appid),
        "achievements.json"
      )
    );
    // INI
    out.add(path.join(meta.save_path, "achievements.ini"));
    out.add(path.join(meta.save_path, "Stats", "achievements.ini"));
    out.add(path.join(meta.save_path, String(meta.appid), "achievements.ini"));
    // BIN
    out.add(path.join(meta.save_path, "stats.bin"));
    out.add(path.join(meta.save_path, String(meta.appid), "stats.bin"));

    return Array.from(out);
  }

  const evalDebounce = new Map(); // appid -> timeout
  const fileHitCooldown = new Map();
  const bootDashDebounce = { t: null, pending: false };

  async function evaluateFile(appid, meta, filePath, opts = {}) {
    const { initial = false, retry = false } = opts || {};
    if (!filePath) return;
    const base = path.basename(filePath).toLowerCase();
    if (!["achievements.json", "achievements.ini", "stats.bin"].includes(base))
      return;

    const now = Date.now();
    const last = fileHitCooldown.get(filePath) || 0;
    if (now - last < 200) return;
    fileHitCooldown.set(filePath, now);

    const key = String(appid);
    clearTimeout(evalDebounce.get(key));
    await new Promise((r) => {
      const t = setTimeout(r, 120);
      evalDebounce.set(key, t);
    });

    const cfgPath = path.join(configsDir, `${meta.name}.json`);
    await waitForFileExists(cfgPath);

    const shouldSeed = initial === true && typeof onSeedCache === "function";

    const prev = lastSnapshot.get(appid) || {};
    const cur = loadAchievementsFromSaveFile(path.dirname(filePath), prev, {
      configMeta: meta,
      fullSchemaPath: resolveAchievementsSchemaPath(meta),
    });
    if (!cur) return false;
    if (cur === prev) return retry ? false : "__retry__";
    lastSnapshot.set(appid, cur);
    if (pendingAutoSelect.has(meta.name)) {
      if (isConfigActive?.(meta.name)) {
        pendingAutoSelect.delete(meta.name);
      }
      return false;
    }
    if (isConfigActive?.(meta.name)) {
      return false;
    }
    if (shouldSeed) {
      try {
        onSeedCache({
          appid: String(appid),
          configName: meta.name,
          snapshot: cur,
        });
      } catch {}
      bootDashDebounce.pending = true;
      clearTimeout(bootDashDebounce.t);
      bootDashDebounce.t = setTimeout(() => {
        if (bootDashDebounce.pending) {
          bootDashDebounce.pending = false;
          try {
            broadcastAll("dashboard:refresh");
          } catch {}
        }
      }, 150);
      return false;
    }

    const lang = readPrefsSafe().language || "english";
    let touched = false;
    for (const [achKey, nowVal] of Object.entries(cur)) {
      const oldVal = prev[achKey];
      const becameEarned = nowVal.earned && (!oldVal || !oldVal.earned);
      const progressChanged =
        !nowVal.earned &&
        (!oldVal ||
          nowVal.progress !== oldVal.progress ||
          nowVal.max_progress !== oldVal.max_progress);
      if (!becameEarned && !progressChanged) continue;
      if (isConfigActive?.(meta.name)) continue;
      touched = true;
      const cfgEntry = getConfigEntry(meta, achKey);
      if (isConfigActive?.(meta.name)) {
        continue;
      }
      if (becameEarned && onEarned) {
        onEarned({
          displayName: cfgEntry
            ? getSafeLocalizedText(cfgEntry.displayName, lang)
            : achKey,
          description: cfgEntry
            ? getSafeLocalizedText(cfgEntry.description, lang)
            : "",
          icon: cfgEntry?.icon || "",
          icon_gray: cfgEntry?.icon_gray || cfgEntry?.icongray || "",
          config_path: meta.config_path || null,
          preset: null,
          position: null,
          sound: null,
          skipScreenshot: false,
          isTest: false,
        });
      }

      if (progressChanged && onProgress) {
        onProgress({
          displayName: cfgEntry
            ? getSafeLocalizedText(cfgEntry.displayName, lang)
            : achKey,
          icon: cfgEntry?.icon || "",
          progress: nowVal.progress || 0,
          max_progress: nowVal.max_progress || 0,
          config_path: meta.config_path || null,
        });
      }
    }
    if (touched && typeof onSeedCache === "function") {
      try {
        onSeedCache({
          appid: String(appid),
          configName: meta.name,
          snapshot: cur,
        });
      } catch {}
    }
    return touched;
  }

  function attachSaveWatcherForAppId(appid) {
    appid = String(appid);
    if (appidSaveWatchers.has(appid)) return;

    const meta = configIndex.get(appid);
    if (!meta || !meta.save_path) return;

    const targets = getSaveWatchTargets(meta);
    const watcher = chokidar.watch(targets, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: 6,
      ignorePermissionErrors: true,
    });

    const onHit = async (ev, filePath, retryFlag = false) => {
      if (!filePath) return;
      const normalised = String(appid);
      const parts = filePath.split(path.sep).map((p) => p.toLowerCase());
      const detected = [...parts].reverse().find((p) => /^\d+$/.test(p));
      if (detected && detected !== normalised) return;
      const initial = ev === "add" && bootMode;
      let result = false;
      try {
        result = await evaluateFile(appid, meta, filePath, {
          initial,
          retry: retryFlag,
        });
      } catch {}

      if (result === "__retry__") {
        setTimeout(() => {
          onHit(ev, filePath, true);
        }, 220);
        return;
      }

      try {
        broadcastAll("refresh-achievements-table");
        if (result) {
          broadcastAll("achievements:file-updated", {
            appid: String(appid),
            configName: meta?.name || null,
          });
        }
      } catch {}
    };

    watcher
      .on("add", (fp) => onHit("add", fp))
      .on("change", (fp) => onHit("change", fp))
      .on("error", (err) =>
        notifyWarn(`save watcher [${appid}] error: ${err.message}`)
      );

    appidSaveWatchers.set(appid, watcher);

    const id = String(appid);
    const candidates = [
      path.join(meta.save_path || "", "achievements.json"),
      path.join(meta.save_path || "", id, "achievements.json"),
      path.join(
        meta.save_path || "",
        "steam_settings",
        id,
        "achievements.json"
      ),
      path.join(meta.save_path || "", "achievements.ini"),
      path.join(meta.save_path || "", "Stats", "achievements.ini"),
      path.join(meta.save_path || "", "stats.bin"),
      path.join(path.dirname(meta.save_path || ""), id, "achievements.json"),
      path.join(path.dirname(meta.save_path || ""), id, "achievements.ini"),
      path.join(
        path.dirname(meta.save_path || ""),
        id,
        "Stats",
        "achievements.ini"
      ),
      path.join(path.dirname(meta.save_path || ""), id, "stats.bin"),
    ].filter(Boolean);

    seedInitialSnapshot(id, meta, candidates, true);
  }

  function rebuildSaveWatchers() {
    const roots = getWatchedFolders().map(normalize);
    const allowed = new Set();

    for (const [appid, meta] of configIndex.entries()) {
      const savePath = meta?.save_path ? normalize(meta.save_path) : null;
      if (!savePath) continue;

      const inside = roots.some((root) => {
        const rel = path.relative(root, savePath);
        if (!rel) return true; // same directory
        return !rel.startsWith("..") && !path.isAbsolute(rel); // inside subdir
      });

      if (inside) allowed.add(appid);
    }

    for (const [appid, watcher] of appidSaveWatchers.entries()) {
      if (!allowed.has(appid)) {
        try {
          watcher.close();
        } catch {}
        appidSaveWatchers.delete(appid);
      }
    }

    for (const appid of allowed) {
      if (!appidSaveWatchers.has(appid)) {
        attachSaveWatcherForAppId(appid);
      }
    }
  }

  async function discoverAppIdsUnder(root, maxDepth = 3) {
    const out = new Map(); // appid -> abs path
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const next = path.join(dir, ent.name);
        if (/^\d+$/.test(ent.name)) out.set(ent.name, next);
        await walk(next, depth + 1);
      }
    }
    await walk(root, 0);
    return out;
  }

  function normalizeRoot(inputRoot) {
    let root = inputRoot;
    try {
      root = fs.realpathSync(inputRoot);
    } catch {
      /* keep original */
    }
    if (isAppIdName(path.basename(root))) root = path.dirname(root);
    return root;
  }

  function rebuildKnownAppIds() {
    knownAppIds.clear();
    indexExistingConfigsSync();
    try {
      const roots = getWatchedFolders().map(normalizeRoot);
      for (const r of roots) {
        try {
          const entries = fs.readdirSync(r, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory() && /^\d+$/.test(ent.name)) {
              knownAppIds.add(ent.name);
            }
          }
        } catch {
          /* ignore root */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const inflightAppIds = new Set();
  async function generateOneAppId(appid, appDir) {
    appid = String(appid);
    if (existingConfigIds.has(appid) || inflightAppIds.has(appid)) return false;
    inflightAppIds.add(appid);
    try {
      if (typeof generateConfigForAppId === "function") {
        await generateConfigForAppId(appid, configsDir, {
          appDir,
          onSeedCache,
        });
        existingConfigIds.add(appid);
        knownAppIds.add(appid);
        return true;
      }
      return false;
    } finally {
      inflightAppIds.delete(appid);
    }
  }

  function seedInitialSnapshot(appid, meta, candidates, initialFlag = true) {
    appid = String(appid);
    let seeded = false;

    for (const fp of candidates) {
      if (!fp || !fs.existsSync(fp)) continue;
      try {
        const snapshot = loadAchievementsFromSaveFile(
          path.dirname(fp),
          lastSnapshot.get(appid) || {},
          {
            configMeta: meta,
            fullSchemaPath: resolveAchievementsSchemaPath(meta),
          }
        );
        if (!snapshot) continue;

        lastSnapshot.set(appid, snapshot);
        seeded = true;

        if (initialFlag && typeof onSeedCache === "function") {
          try {
            onSeedCache({
              appid,
              configName: meta?.name || appid,
              snapshot,
            });
          } catch {}
        }
        break;
      } catch {}
    }

    if (!seeded && typeof getCachedSnapshot === "function") {
      const cached = getCachedSnapshot(meta?.name || appid);
      if (cached && typeof cached === "object") {
        lastSnapshot.set(appid, cached);
      }
    }
  }

  async function scanRootOnce(rootPath) {
    try {
      if (!rootPath || !fs.existsSync(rootPath)) return;
      const base = path.basename(rootPath);
      const scanBase = isAppIdName(base) ? path.dirname(rootPath) : rootPath;

      const discoveredMap = await discoverAppIdsUnder(scanBase, 6); // Map
      const discovered = Array.from(discoveredMap.keys());

      const newIds = discovered.filter((id) => !existingConfigIds.has(id));
      if (newIds.length === 0) {
        for (const id of discovered) knownAppIds.add(id);
        return;
      }

      if (typeof generateConfigForAppId === "function") {
        let createdAny = false;

        if (bootMode) {
          await generateIdsThrottled(newIds, discoveredMap);
          indexExistingConfigsSync();
          createdAny = newIds.some((id) => existingConfigIds.has(id));
        } else {
          for (const id of newIds) {
            const appDir = discoveredMap.get(id) || null;
            const created = await generateOneAppId(id, appDir);
            if (created) createdAny = true;
          }
        }

        if (createdAny) {
          broadcastAll("configs:changed");
          broadcastAll("refresh-achievements-table");

          for (const id of newIds) {
            attachSaveWatcherForAppId(id);
            const m = configIndex.get(String(id));
            if (m) {
              const rootDir = discoveredMap.get(id);
              const maybe = [
                path.join(rootDir || "", "achievements.json"),
                path.join(m.save_path || "", "achievements.json"),
                path.join(m.save_path || "", String(id), "achievements.json"),
                path.join(
                  m.save_path || "",
                  "steam_settings",
                  String(id),
                  "achievements.json"
                ),
                path.join(
                  m.save_path || "",
                  "remote",
                  String(id),
                  "achievements.json"
                ),
                rootDir ? path.join(rootDir, "achievements.ini") : null,
                rootDir
                  ? path.join(rootDir, "Stats", "achievements.ini")
                  : null,
                rootDir ? path.join(rootDir, "stats.bin") : null,
                m.save_path ? path.join(m.save_path, "achievements.ini") : null,
                m.save_path
                  ? path.join(m.save_path, "Stats", "achievements.ini")
                  : null,
                m.save_path ? path.join(m.save_path, "stats.bin") : null,
              ].filter(Boolean);
              seedInitialSnapshot(id, m, maybe, bootMode);
            }
          }
        }
      } else {
        if (bootMode) {
          notifyWarn(
            "generateConfigForAppId missing – skip heavy generateGameConfigs() at boot"
          );
        } else {
          await generateGameConfigs(scanBase, configsDir, { onSeedCache });
          indexExistingConfigsSync();
          rebuildSaveWatchers();
          for (const id of discovered) knownAppIds.add(id);
          broadcastAll("configs:changed");
          broadcastAll("refresh-achievements-table");
        }
      }
    } catch (e) {
      notifyWarn(`Scan failed for "${rootPath}": ${e.message}`);
    }
  }

  // ——— WATCHER ———
  const pendingAutoSelect = new Set();
  function startFolderWatcher(inputRoot, opts = {}) {
    const { initialScan = true } = opts;
    const root = normalizeRoot(coercePath(inputRoot));
    if (folderWatchers.has(root)) return;
    if (!fs.existsSync(root)) return;

    const watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: 6,
      ignorePermissionErrors: true,
    });
    const state = { watcher, debounce: null };
    folderWatchers.set(root, state);

    const schedule = () => {
      clearTimeout(state.debounce);
      state.debounce = setTimeout(async () => {
        if (activeRoots.has(root)) return;
        activeRoots.add(root);
        try {
          await scanRootOnce(root);
        } catch (e) {
          notifyWarn(`Watch rescan failed for "${root}": ${e.message}`);
        } finally {
          activeRoots.delete(root);
        }
      }, 300);
    };

    if (initialScan && !rescanInProgress.value) {
      // optional: schedule();
    }

    watcher
      .on("ready", () => {
        if (
          !rescanInProgress.value &&
          initialScan &&
          typeof generateConfigForAppId !== "function"
        ) {
          schedule();
        }
      })

      .on("add", (filePath) => {
        if (rescanInProgress.value) return;
        const base = path.basename(filePath).toLowerCase();
        if (
          !["achievements.json", "achievements.ini", "stats.bin"].includes(base)
        )
          return;

        const parts = filePath.split(path.sep);
        let appid = null;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (/^\d+$/.test(parts[i])) {
            appid = parts[i];
            break;
          }
        }
        if (!appid) return;

        let meta = configIndex.get(String(appid));
        if (!meta) {
          indexExistingConfigsSync();
          meta = configIndex.get(String(appid));
        }
        if (!meta) return;

        try {
          pendingAutoSelect.add(meta.name);
          broadcastAll("auto-select-config", meta.name);
        } catch {}
        try {
          if (typeof onAutoSelect === "function") onAutoSelect(meta.name);
        } catch {}

        const appKey = String(appid);
        const runEval = async (retryFlag = false) => {
          let result = false;
          try {
            result = await evaluateFile(appKey, meta, filePath, {
              initial: false,
              retry: retryFlag,
            });
          } catch {}
          if (result === "__retry__") {
            setTimeout(() => runEval(true), 220);
            return;
          }
          if (result) {
            try {
              broadcastAll("achievements:file-updated", {
                appid: appKey,
                configName: meta?.name || null,
              });
            } catch {}
          }
        };
        runEval();

        try {
          broadcastAll("configs:changed");
          broadcastAll("refresh-achievements-table");
          broadcastAll("dashboard:refresh");
        } catch {}
      })

      .on("change", (filePath) => {
        if (rescanInProgress.value) return;
        const base = path.basename(filePath).toLowerCase();
        if (
          !["achievements.json", "achievements.ini", "stats.bin"].includes(base)
        )
          return;

        const parts = filePath.split(path.sep);
        let appid = null;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (/^\d+$/.test(parts[i])) {
            appid = parts[i];
            break;
          }
        }
        if (!appid) return;

        let meta = configIndex.get(String(appid));
        if (!meta) {
          indexExistingConfigsSync();
          meta = configIndex.get(String(appid));
        }
        if (!meta) return;

        try {
          pendingAutoSelect.add(meta.name);
          broadcastAll("auto-select-config", meta.name);
        } catch {}
        try {
          if (typeof onAutoSelect === "function") onAutoSelect(meta.name);
        } catch {}

        const appKey = String(appid);
        const runEval = async (retryFlag = false) => {
          let result = false;
          try {
            result = await evaluateFile(appKey, meta, filePath, {
              initial: false,
              retry: retryFlag,
            });
          } catch {}
          if (result === "__retry__") {
            setTimeout(() => runEval(true), 220);
            return;
          }
          if (result) {
            try {
              broadcastAll("achievements:file-updated", {
                appid: appKey,
                configName: meta?.name || null,
              });
            } catch {}
          }
        };
        runEval();

        try {
          broadcastAll("refresh-achievements-table");
          broadcastAll("dashboard:refresh");
        } catch {}
      })

      .on("addDir", async (dir) => {
        if (rescanInProgress.value) return;

        const base = path.basename(dir);
        if (!isAppIdName(base)) return;

        if (typeof generateConfigForAppId === "function") {
          try {
            const created = await generateOneAppId(base, dir);
            if (created) {
              indexExistingConfigsSync();
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
              broadcastAll("dashboard:refresh");

              const meta = configIndex.get(String(base));
              if (meta) {
                const candidates = [
                  path.join(dir, "achievements.json"),
                  path.join(
                    path.dirname(dir),
                    "steam_settings",
                    String(base),
                    "achievements.json"
                  ),
                  path.join(dir, "achievements.ini"),
                  path.join(dir, "Stats", "achievements.ini"),
                  path.join(dir, "stats.bin"),
                ];
                attachSaveWatcherForAppId(String(base));
                seedInitialSnapshot(base, meta, candidates, bootMode);
              }
              return;
            }
          } catch (e) {
            notifyWarn(`Generate failed for "${base}": ${e.message}`);
          }
        }
        schedule(); // fallback
      })
      .on("unlinkDir", () => {
        if (!rescanInProgress.value) schedule();
      })
      .on("error", (err) =>
        notifyWarn(`Watcher error "${root}": ${err.message}`)
      );
  }

  function stopFolderWatcher(inputRoot) {
    const root = normalizeRoot(inputRoot);
    const entry = folderWatchers.get(root) || folderWatchers.get(inputRoot);
    if (!entry) return;
    clearTimeout(entry.debounce);
    entry.watcher.close().catch(() => {});
    folderWatchers.delete(root);
  }

  // ——— IPC ———
  ipcMain.handle("folders:list", async () => {
    return getWatchedFolders();
  });

  async function restartWatchersAndRescan() {
    rescanInProgress.value = true;
    activeRoots.clear();

    const entries = Array.from(folderWatchers.values());
    folderWatchers.clear();
    await Promise.allSettled(
      entries.map((e) => {
        try {
          clearTimeout(e.debounce);
        } catch {}
        try {
          return e.watcher.close();
        } catch {
          return Promise.resolve();
        }
      })
    );

    indexExistingConfigsSync();
    rebuildKnownAppIds();

    const folders = getWatchedFolders();
    for (const f of folders) {
      try {
        startFolderWatcher(f, { initialScan: false });
      } catch (e) {
        notifyWarn(`Failed to start watcher for "${f}": ${e.message}`);
      }
    }

    const before = existingConfigIds.size;
    for (const f of folders) {
      try {
        await scanRootOnce(f);
      } catch (e) {
        notifyWarn(`Rescan failed for "${f}": ${e.message}`);
      }
    }
    const generatedSomething = existingConfigIds.size > before;

    // rebuild watchers
    rebuildSaveWatchers();
    broadcastAll("configs:changed");
    broadcastAll("refresh-achievements-table");

    rescanInProgress.value = false;
    return {
      ok: true,
      restarted: folders.length,
      generated: generatedSomething,
    };
  }

  // add
  ipcMain.handle("folders:add", async (_e, dirPath) => {
    try {
      let p = coercePath(dirPath);
      try {
        p = fs.realpathSync(p);
      } catch {}
      if (!p || !fs.existsSync(p)) {
        return { ok: false, error: "Folder not found" };
      }
      const cur = getWatchedFolders();
      if (!cur.includes(p)) saveWatchedFolders([...cur, p]);
      startFolderWatcher(p);
      await scanRootOnce(p);
      return { ok: true, folders: getWatchedFolders() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // remove
  ipcMain.handle("folders:remove", async (_e, dirPath) => {
    try {
      let p = coercePath(dirPath);
      try {
        p = fs.realpathSync(p);
      } catch {}
      stopFolderWatcher(p);
      const saved = saveWatchedFolders(
        getWatchedFolders().filter((x) => x !== p)
      );
      return { ok: true, folders: saved };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // rescan
  ipcMain.handle("folders:rescan", async () => {
    try {
      if (rescanInProgress.value)
        return { ok: false, error: "Rescan already running", busy: true };
      return await restartWatchersAndRescan();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ——— boot ———
  app.whenReady().then(async () => {
    rebuildKnownAppIds();
    const folders = getWatchedFolders();
    for (const f of folders) startFolderWatcher(f, { initialScan: false });
    for (const f of folders) {
      try {
        await scanRootOnce(f);
      } catch {}
    }
    rebuildSaveWatchers();
    try {
      broadcastAll("dashboard:refresh");
    } catch {}
    bootMode = false;
  });

  if (app && typeof app.on === "function") {
    app.on("before-quit", async () => {
      for (const entry of folderWatchers.values()) {
        try {
          await entry.watcher.close();
        } catch {}
      }
      for (const w of appidSaveWatchers.values()) {
        try {
          await w.close();
        } catch {}
      }
    });
  }
  return { rebuildKnownAppIds };
};
