// auto-config-generator.js
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { fork } = require("child_process");
const ini = require("ini");
const CRC32 = require("crc-32");
const { loadAchievementsFromSaveFile } = require("./achievement-data");

function readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

async function maybeSeedAchCache({
  appid,
  configName,
  save_path,
  config_path,
  onSeedCache,
}) {
  if (typeof onSeedCache !== "function" || !save_path) return;
  const id = String(appid);
  const meta = { appid: id, config_path };
  const candidates = [
    path.join(save_path, "achievements.json"),
    path.join(save_path, id, "achievements.json"),
    path.join(save_path, "steam_settings", id, "achievements.json"),
    path.join(save_path, "achievements.ini"),
    path.join(save_path, "Stats", "achievements.ini"),
    path.join(save_path, id, "achievements.ini"),
    path.join(save_path, "stats.bin"),
    path.join(save_path, id, "stats.bin"),
  ];
  let snapshot = null;
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const cur = loadAchievementsFromSaveFile(
        path.dirname(fp),
        {},
        { configMeta: meta }
      );
      if (cur && Object.keys(cur).length) {
        snapshot = { ...(snapshot || {}), ...cur };
      }
    } catch {}
  }
  if (snapshot && Object.keys(snapshot).length) {
    try {
      onSeedCache({ appid: id, configName, snapshot });
    } catch {}
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, "");
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cleanText(x) {
  return decodeHtml(String(x || "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function isBadName(name) {
  const n = (name || "").trim();
  return !n || /^steam hunters$/i.test(n);
}

function extractNameFromSteamHuntersHtml(html) {
  const H = String(html || "");

  // 1) Banner: <span.flex-link-underline> din <h1><a>…</a></h1>
  //    (not “Steam Hunters”, second)
  let m =
    /<main[\s\S]*?<div[^>]*class="[^"]*\bbanner\b[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*\bmedia-body\b[^"]*"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<a[^>]*>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>[\s\S]*?<\/span>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }

  // 2) Breadcrumb: <span class="text-ellipsis app-name after">
  m =
    /<header[\s\S]*?<span[^>]*class="[^"]*\btext-ellipsis\b[^"]*\bapp-name\b[^"]*(?:\bafter\b)?[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }

  return null;
}

async function getGameNameFromSteamHunters(appid) {
  try {
    const url = `https://steamhunters.com/apps/${appid}/achievements`;
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;

    const name = extractNameFromSteamHuntersHtml(res.data || "");
    return name || null;
  } catch (e) {
    console.warn(`[SteamHunters] ${appid}: ${e.message || e}`);
    return null;
  }
}

async function getGameName(appid, retries = 2) {
  let nameFromStore = null;

  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    const res = await axios.get(url, { timeout: 15000 });
    const entry = res.data?.[String(appid)];
    if (entry?.success && entry?.data?.name) {
      nameFromStore = entry.data.name;
    } else {
      console.warn(
        `[StoreAPI] ${appid}: success=${entry?.success} name missing -> will try fallback`
      );
    }
  } catch (err) {
    if (err.response && err.response.status === 429 && retries > 0) {
      console.warn(`⚠️ Rate limit for appid ${appid}. Retrying after delay...`);
      await new Promise((r) => setTimeout(r, 2000));
      return getGameName(appid, retries - 1);
    }
    console.error(`[StoreAPI] ${appid}: ${err.message}`);
  }

  if (nameFromStore) return nameFromStore;

  // Fallback SteamHunters
  console.warn(`[Fallback] Trying SteamHunters for ${appid}...`);
  const shName = await getGameNameFromSteamHunters(appid);
  if (shName) return shName;

  console.warn(`[Fallback] SteamHunters also failed for ${appid}`);
  return null;
}

const userDataDir = app.getPath("userData");

// run generate_achievements_schema.js
function runAchievementsGenerator(appid, schemaBaseDir, userDataDir) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "generate_achievements_schema.js");

    const isElectron = !!process.versions.electron;
    const nodeBin = isElectron
      ? process.platform === "win32"
        ? "node.exe"
        : "node"
      : process.execPath;

    const args = [
      String(appid),
      "--apps-concurrency=1",
      `--out=${schemaBaseDir}`,
      `--user-data-dir=${userDataDir}`,
    ];

    console.log(`↪ Generate achievements schema for ${appid}…`);
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
      windowsHide: true,
    });

    // IPC messages
    cp.on("message", (msg) => {
      if (msg && msg.type === "achgen:log") {
        if (global.mainWindow) {
          global.mainWindow.webContents.send("achgen:log", msg);
        }
        const tag =
          msg.level === "error"
            ? "error"
            : msg.level === "warn"
            ? "warn"
            : "log";
        console[tag](`${msg.message}`);
      }
    });

    cp.stdout.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stdout", line);
      process.stdout.write(line);
    });

    cp.stderr.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stderr", line);
      process.stderr.write(line);
    });
    cp.on("error", reject);
    cp.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Code: ${code}`))
    );
  });
}

async function generateGameConfigs(folderPath, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error("Folder is not valid.");
  }

  const dirents = fs.readdirSync(folderPath, { withFileTypes: true });
  const folders = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  const appidFolders = folders.filter((f) => /^\d+$/.test(f));

  // nothing found
  if (appidFolders.length === 0) {
    console.warn(`No AppIDs found in: ${folderPath}`);
    return {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      outputDir,
    };
  }

  // <outputDir>/schema/<appid>
  const schemaBase = path.join(outputDir, "schema");
  if (!fs.existsSync(schemaBase)) fs.mkdirSync(schemaBase, { recursive: true });

  let processed = 0,
    created = 0,
    updated = 0,
    skipped = 0,
    failed = 0;
  for (const appid of appidFolders) {
    processed++;

    console.log(`Processing AppID: ${appid}...`);
    const name = await getGameName(appid);
    if (!name) {
      console.warn(`${appid}: not exist!`);
      skipped++;
      continue;
    }

    const safeName = sanitizeFilename(name);
    const fileName = `${safeName}.json`;
    const filePath = path.join(outputDir, fileName);

    //const gameSaveDir = path.join(folderPath);   // <folderPath>/
    let gameSaveDir = path.join(folderPath);
    const maybeRemote = path.join(folderPath, "remote", appid);
    if (
      folderPath.toLowerCase().includes("empress") &&
      fs.existsSync(maybeRemote)
    ) {
      gameSaveDir = maybeRemote;
    }
    const destSchemaDir = path.join(schemaBase, String(appid));
    const destAchievementsJson = path.join(destSchemaDir, "achievements.json");

    if (!fs.existsSync(destSchemaDir))
      fs.mkdirSync(destSchemaDir, { recursive: true });

    const ensureSchema = async () => {
      try {
        if (!fs.existsSync(destAchievementsJson)) {
          const userDataDir = app.getPath("userData");
          await runAchievementsGenerator(appid, schemaBase, userDataDir);
        } else {
          const txt = `⏭ [${appid}] Achievements schema exists. Skip generating!`;
          if (global.mainWindow) {
            global.mainWindow.webContents.send("achgen:log", {
              type: "achgen:log",
              level: "info",
              message: txt,
            });
            global.mainWindow.webContents.send(
              "achgen:stdout",
              `[achgen] ${txt}\n`
            );
          }
          console.log(`${txt}`);
        }
      } catch (e) {
        console.warn(`Generate schema failed for ${appid}: ${e.message}`);
        failed++;
        // continue
      }
    };

    if (fs.existsSync(filePath)) {
      // if config exist, complete only
      await ensureSchema();
      try {
        const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
        let changed = false;

        if (!curr.config_path) {
          curr.config_path = destSchemaDir;
          changed = true;
        }
        if (!curr.save_path) {
          curr.save_path = gameSaveDir;
          changed = true;
        }

        if (changed) {
          fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
          console.log(`Updated: ${filePath}`);
          updated++;
        } else {
          console.log(`Config for "${safeName}" exists (no changes).`);
          skipped++;
        }
        await maybeSeedAchCache({
          appid,
          configName: safeName,
          save_path: curr.save_path || gameSaveDir,
          config_path: curr.config_path || destSchemaDir,
          onSeedCache,
        });
      } catch (e) {
        console.warn(
          `Failed to update existing config for ${appid}: ${e.message}`
        );
        failed++;
      }
      continue;
    }

    // generate schema if missing
    await ensureSchema();

    const gameData = {
      name: safeName,
      appid,
      // IMPORTANT: set path, if achievements.json missing
      config_path: destSchemaDir,
      save_path: gameSaveDir,
      executable: "",
      arguments: "",
      process_name: "",
    };

    fs.writeFileSync(filePath, JSON.stringify(gameData, null, 2));
    console.log(`Saved: ${filePath}`);
    created++;
    await maybeSeedAchCache({
      appid,
      configName: safeName,
      save_path: gameSaveDir,
      config_path: destSchemaDir,
      onSeedCache,
    });
  }

  if (processed > 0) {
    console.log(`Done! JSON files saved to ${outputDir}`);
  } else {
    console.warn(`No configs generated.`);
  }
  return { processed, created, updated, skipped, failed, outputDir };
}

async function generateConfigForAppId(appid, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  appid = String(appid);
  if (!/^\d+$/.test(appid)) throw new Error(`Invalid appid: ${appid}`);

  const appDir = opts?.appDir || null;
  const tmpRoot = path.join(
    os.tmpdir(),
    `ach_single_root_${appid}_${Date.now()}`
  );
  const tmpAppDir = path.join(tmpRoot, appid);

  fs.mkdirSync(tmpAppDir, { recursive: true });

  await generateGameConfigs(tmpRoot, outputDir, { onSeedCache });

  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  let targetFile = null;
  for (const f of files) {
    try {
      const full = path.join(outputDir, f);
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const id = String(
        data?.appid || data?.appId || data?.steamAppId || ""
      ).trim();
      if (id === appid) {
        targetFile = full;
        break;
      }
    } catch {}
  }

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}

  if (!targetFile) return;

  if (appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      const fixPath = (p) => {
        if (!p || typeof p !== "string") return p;
        if (p.startsWith(tmpRoot)) {
          const rel = path.relative(tmpRoot, p);
          return path.join(appDir, rel.replace(/^(\d+[\\/])?/, ""));
        }
        return p;
      };
      if (cfg.config_path) cfg.config_path = fixPath(cfg.config_path);
      if (cfg.save_path) cfg.save_path = fixPath(cfg.save_path);
      if (cfg.executable) cfg.executable = fixPath(cfg.executable);

      fs.writeFileSync(targetFile, JSON.stringify(cfg, null, 2));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        onSeedCache,
      });
    } catch {}
  }
  if (!appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        onSeedCache,
      });
    } catch {}
  }
}

module.exports = { generateGameConfigs, generateConfigForAppId };
