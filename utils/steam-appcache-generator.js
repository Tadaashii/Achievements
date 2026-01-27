const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { createLogger } = require("./logger");
const {
  parseKVBinary,
  extractSchemaAchievements,
  extractUserStats,
  buildSnapshotFromAppcache,
  normalizeSteamIconUrl,
  pickLatestUserBin,
} = require("./steam-appcache");
const autoConfigLogger = createLogger("autoconfig");
const schemaLogger = createLogger("achschema");

function sanitizeFileName(name) {
  return String(name || "").replace(/[<>:"/\\|?*]+/g, "_");
}

const steamStoreCache = new Map();

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
    if (!name) {
      autoConfigLogger.warn("steam-hunters:name-missing", { appid });
    }
    return name || null;
  } catch (e) {
    autoConfigLogger.warn("steam-hunters:request-failed", {
      appid,
      error: e?.message || String(e),
    });
    return null;
  }
}

async function fetchSteamStoreName(appid, fetchImpl = global.fetch) {
  if (!appid) return null;
  if (typeof fetchImpl !== "function") return null;
  const key = String(appid);
  if (steamStoreCache.has(key)) return steamStoreCache.get(key);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const entry = data?.[String(appid)];
    const name = entry?.success ? entry?.data?.name : null;
    const resolved = name && typeof name === "string" ? name : null;
    if (resolved) {
      steamStoreCache.set(key, resolved);
      return resolved;
    }
  } catch {
    // fallthrough to SteamHunters
  } finally {
    clearTimeout(t);
  }
  const fallback = await getGameNameFromSteamHunters(appid);
  if (fallback) {
    steamStoreCache.set(key, fallback);
    return fallback;
  }
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function download(url, dest, fetchImpl = global.fetch) {
  if (!url) return false;
  if (typeof fetchImpl !== "function") return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetchImpl(url.replace(/^http:/, "https:"), {
      signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const ab = await r.arrayBuffer();
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, Buffer.from(ab));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function writeSchemaFromEntries(appid, entries, schemaDir) {
  ensureDir(schemaDir);
  const imgDir = path.join(schemaDir, "img");
  ensureDir(imgDir);

  const rewritten = [];
  for (const e of entries) {
    const baseName = e.icon
      ? path.basename(String(e.icon)).replace(/\.[^.]+$/, "")
      : String(e.api);
    let iconRel = "";
    let grayRel = "";
    const iconUrl = normalizeSteamIconUrl(appid, e.icon || "");
    const grayUrl = normalizeSteamIconUrl(appid, e.icon_gray || e.icon || "");
    if (iconUrl) {
      const ext = path.extname(new URL(iconUrl).pathname) || ".jpg";
      const file = `${baseName}${ext}`;
      iconRel = `img/${file}`;
      download(iconUrl, path.join(imgDir, file)).catch(() => {});
    }
    if (grayUrl) {
      const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
      const file = `${baseName}_gray${ext}`;
      grayRel = `img/${file}`;
      download(grayUrl, path.join(imgDir, file)).catch(() => {});
    }
    if (!grayRel) grayRel = iconRel;
    rewritten.push({
      name: e.api,
      hidden: e.hidden ? 1 : 0,
      displayName: e.displayName || { english: "" },
      description: e.description || { english: "" },
      icon: iconRel,
      icon_gray: grayRel,
      statId: e.statId,
      bit: e.bit,
    });
  }

  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(rewritten, null, 2),
    "utf8",
  );
  schemaLogger.info("steam-appcache:schema:written", {
    appid: String(appid),
    dir: schemaDir,
    achievements: rewritten.length,
  });
  return rewritten;
}

function updateSchemaFromAppcache(appid, entries, schemaDir) {
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(schemaPath))
    return { updated: false, added: 0, changed: 0, entries: [] };
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return { updated: false, added: 0, changed: 0, entries: [] };
  }
  if (!Array.isArray(cur))
    return { updated: false, added: 0, changed: 0, entries: [] };

  const byName = new Map();
  for (const c of cur) byName.set(c.name, c);
  let updated = false;
  let added = 0;
  let changed = 0;

  for (const e of entries) {
    const existing = byName.get(e.api);
    if (!existing) {
      added++;
      updated = true;
      const baseName = e.icon
        ? path.basename(String(e.icon)).replace(/\.[^.]+$/, "")
        : String(e.api);
      let iconRel = "";
      let grayRel = "";
      const iconUrl = normalizeSteamIconUrl(appid, e.icon || "");
      const grayUrl = normalizeSteamIconUrl(appid, e.icon_gray || e.icon || "");
      if (iconUrl) {
        const ext = path.extname(new URL(iconUrl).pathname) || ".jpg";
        const file = `${baseName}${ext}`;
        iconRel = `img/${file}`;
        download(iconUrl, path.join(schemaDir, iconRel)).catch(() => {});
      }
      if (grayUrl) {
        const ext = path.extname(new URL(grayUrl).pathname) || ".jpg";
        const file = `${baseName}_gray${ext}`;
        grayRel = `img/${file}`;
        download(grayUrl, path.join(schemaDir, grayRel)).catch(() => {});
      }
      if (!grayRel) grayRel = iconRel;
      cur.push({
        name: e.api,
        hidden: e.hidden ? 1 : 0,
        displayName: e.displayName || { english: "" },
        description: e.description || { english: "" },
        icon: iconRel,
        icon_gray: grayRel,
        statId: e.statId,
        bit: e.bit,
      });
      continue;
    }
  }
  if (updated) {
    fs.writeFileSync(schemaPath, JSON.stringify(cur, null, 2), "utf8");
  }
  schemaLogger.info("steam-appcache:schema:updated", {
    appid: String(appid),
    dir: schemaDir,
    updated,
    added,
    changed,
    total: cur.length,
    incoming: entries.length,
  });
  return { updated, added, changed, entries: cur };
}

function findExistingSteamOfficialConfig(configsDir, appid) {
  try {
    const entries = fs.readdirSync(configsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.toLowerCase().endsWith(".json")) continue;
      const full = path.join(configsDir, ent.name);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (String(data?.appid || "") !== String(appid)) continue;
        if (String(data?.platform || "").toLowerCase() !== "steam-official")
          continue;
        return {
          path: full,
          data,
        };
      } catch {}
    }
  } catch {}
  return null;
}

async function generateConfigFromAppcacheBin(statsDir, schemaBinPath, configsDir) {
  const appidMatch = path.basename(schemaBinPath).match(/UserGameStatsSchema_(\d+)\.bin/i);
  if (!appidMatch) return null;
  const appid = appidMatch[1];
  const userBin = pickLatestUserBin(statsDir, appid);
  if (!userBin) return null;

  const schemaKV = parseKVBinary(fs.readFileSync(schemaBinPath));
  const entries = extractSchemaAchievements(schemaKV.data);
  if (!entries.length) return null;

  const schemaRoot = path.join(
    configsDir,
    "schema",
    "steam-official",
    String(appid),
  );
  ensureDir(schemaRoot);
  let schemaEntries = [];
  let schemaUpdated = false;
  const schemaPath = path.join(schemaRoot, "achievements.json");
  if (fs.existsSync(schemaPath)) {
    // do not rewrite existing schema; just reuse
    try {
      schemaEntries = JSON.parse(fs.readFileSync(schemaPath, "utf8")) || [];
    } catch {
      schemaEntries = [];
    }
  }
  if (!schemaEntries.length) {
    schemaEntries = writeSchemaFromEntries(appid, entries, schemaRoot);
    schemaUpdated = true;
  }

  const userKV = parseKVBinary(fs.readFileSync(userBin));
  const userStats = extractUserStats(userKV.data);
  const snapshot = buildSnapshotFromAppcache(
    (schemaEntries || []).map((e) => ({
      api: e.name || e.api,
      statId: e.statId,
      bit: e.bit,
    })),
    userStats,
  );

  const storeName = await fetchSteamStoreName(appid);
  const resolvedBase = storeName || String(appid || "");
  const defaultCfgName = `${resolvedBase} (Steam)`;
  const existing = findExistingSteamOfficialConfig(configsDir, appid);
  const cfgPath = existing?.path
    ? existing.path
    : path.join(configsDir, `${sanitizeFileName(defaultCfgName)}.json`);
  const cfgName = existing?.data?.name || path.basename(cfgPath, ".json");
  const payload = {
    name: defaultCfgName,
    displayName: defaultCfgName,
    appid: String(appid),
    platform: "steam-official",
    config_path: schemaRoot,
    save_path: statsDir,
  };
  let created = true;
  if (existing || fs.existsSync(cfgPath)) {
    created = false;
    try {
      const existingData =
        existing?.data || JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const existingDisplay =
        existingData?.displayName || existingData?.name || "";
      if (storeName && typeof storeName === "string") {
        const desiredDisplay = `${storeName} (Steam)`;
        if (desiredDisplay && desiredDisplay !== existingDisplay) {
          existingData.displayName = desiredDisplay;
          fs.writeFileSync(cfgPath, JSON.stringify(existingData, null, 2));
          autoConfigLogger.info("steam-appcache:config:display-updated", {
            appid,
            name: existingData?.name || cfgName,
            displayName: desiredDisplay,
            filePath: cfgPath,
          });
        }
      }
    } catch {}
  } else {
    fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2));
    autoConfigLogger.info("steam-appcache:config:created", {
      appid,
      name: defaultCfgName,
      filePath: cfgPath,
    });
  }

  return {
    appid,
    name: cfgName,
    configPath: cfgPath,
    config_path: schemaRoot,
    save_path: statsDir,
    created,
    schemaUpdated,
    snapshot: created || schemaUpdated ? snapshot : null,
  };
}

module.exports = {
  generateConfigFromAppcacheBin,
  writeSchemaFromEntries,
  updateSchemaFromAppcache,
};
