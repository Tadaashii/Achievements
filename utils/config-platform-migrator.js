const fs = require("fs");
const path = require("path");

const VALID_PLATFORMS = new Set(["steam", "uplay", "epic", "gog"]);

function normalizePlatform(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_PLATFORMS.has(raw) ? raw : "";
}

function sanitizeAppId(value) {
  const raw = String(value || "").trim();
  return /^[0-9a-fA-F]+$/.test(raw) ? raw : "";
}

function inferPlatformAndSteamId({ config, mapping }) {
  const currentPlatform = normalizePlatform(config.platform);
  const appid =
    sanitizeAppId(config.appid) ||
    sanitizeAppId(config.appId) ||
    sanitizeAppId(config.steamAppId);
  let steamAppId = sanitizeAppId(config.steamAppId);
  let platform = currentPlatform;

  const mappedSteamId =
    mapping && mapping.steam_appid ? sanitizeAppId(mapping.steam_appid) : "";

  if (!platform) {
    if (steamAppId && appid && steamAppId !== appid) {
      platform = "uplay";
    } else if (mappedSteamId && appid && mappedSteamId !== appid) {
      platform = "uplay";
      steamAppId = mappedSteamId;
    } else {
      platform = "steam";
      if (steamAppId === appid) steamAppId = "";
    }
  } else if (platform === "uplay") {
    if (!steamAppId && mappedSteamId && mappedSteamId !== appid) {
      steamAppId = mappedSteamId;
    }
  } else if (platform === "steam") {
    if (steamAppId && (!appid || steamAppId === appid)) {
      steamAppId = "";
    }
  } else if (platform === "epic" || platform === "gog") {
    steamAppId = "";
  }

  return {
    platform,
    steamAppId,
    appid,
  };
}

function migrateConfigPlatforms({
  configsDir,
  mappingByUplayId,
  logger = console,
}) {
  let updated = 0;
  const platformIndex = new Map(); // appid -> Set(platform)

  let files = [];
  try {
    files = fs
      .readdirSync(configsDir)
      .filter((name) => name.toLowerCase().endsWith(".json"));
  } catch (err) {
    logger?.warn?.("platform-migrate:list-failed", { error: err.message });
    return { updated: 0, platformIndex };
  }

  for (const file of files) {
    const full = path.join(configsDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      logger?.warn?.("platform-migrate:parse-failed", {
        file: full,
        error: err.message,
      });
      continue;
    }

    const appid =
      sanitizeAppId(data.appid) ||
      sanitizeAppId(data.appId) ||
      sanitizeAppId(data.steamAppId);
    const mapping = appid ? mappingByUplayId.get(appid) : null;
    const { platform, steamAppId } = inferPlatformAndSteamId({
      config: data,
      mapping,
    });

    const nextSteamAppId = steamAppId || undefined;
    const nextPlatform = platform || undefined;
    const prevSteamAppId =
      data.steamAppId !== undefined ? String(data.steamAppId) : undefined;
    const prevPlatform = data.platform;

    const needsUpdate =
      nextPlatform !== prevPlatform ||
      nextSteamAppId !== prevSteamAppId ||
      !VALID_PLATFORMS.has(normalizePlatform(prevPlatform));

    if (needsUpdate) {
      if (nextPlatform) data.platform = nextPlatform;
      else delete data.platform;

      if (nextSteamAppId) data.steamAppId = nextSteamAppId;
      else delete data.steamAppId;

      try {
        fs.writeFileSync(full, JSON.stringify(data, null, 2));
        updated++;
      } catch (err) {
        logger?.warn?.("platform-migrate:write-failed", {
          file: full,
          error: err.message,
        });
      }
    }

    const finalPlatform = normalizePlatform(data.platform) || "steam";
    if (appid) {
      if (!platformIndex.has(appid)) platformIndex.set(appid, new Set());
      platformIndex.get(appid).add(finalPlatform);
    }
  }

  return { updated, platformIndex };
}

function migrateSchemaStorage({ configsDir, platformIndex, logger = console }) {
  const schemaRoot = path.join(configsDir, "schema");
  let moved = 0;
  let updatedConfigs = 0;
  try {
    if (!fs.existsSync(schemaRoot)) {
      return { moved, updatedConfigs };
    }
  } catch {
    return { moved, updatedConfigs };
  }

  const legacyDirs = [];
  try {
    const entries = fs.readdirSync(schemaRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const normalized = name.trim().toLowerCase();
      if (VALID_PLATFORMS.has(normalized)) continue;
      if (!/^\d+$/.test(name)) continue;
      legacyDirs.push(name);
    }
  } catch (err) {
    logger?.warn?.("platform-migrate:schema-enumerate-failed", {
      error: err?.message || String(err),
    });
  }

  for (const dir of legacyDirs) {
    const appid = dir;
    const currentDir = path.join(schemaRoot, dir);
    const platforms = platformIndex?.get(appid);
    const prefersUplay = platforms?.has("uplay") && !platforms?.has("steam");
    const prefersGog =
      platforms?.has("gog") &&
      !platforms?.has("steam") &&
      !platforms?.has("uplay");
    const targetPlatform = prefersUplay
      ? "uplay"
      : prefersGog
      ? "gog"
      : "steam";
    const targetDir = path.join(schemaRoot, targetPlatform, appid);
    try {
      if (fs.existsSync(targetDir)) {
        // Already migrated or conflicting folder; skip to avoid data loss.
        continue;
      }
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(currentDir, targetDir);
      moved++;
    } catch (err) {
      logger?.warn?.("platform-migrate:schema-move-failed", {
        appid,
        targetPlatform,
        source: currentDir,
        target: targetDir,
        error: err?.message || String(err),
      });
    }
  }

  try {
    const files = fs
      .readdirSync(configsDir)
      .filter((name) => name.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const full = path.join(configsDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      const appid =
        sanitizeAppId(data?.appid) ||
        sanitizeAppId(data?.appId) ||
        sanitizeAppId(data?.steamAppId);
      if (!appid) continue;
      const platform = normalizePlatform(data?.platform) || "steam";
      const storagePlatform =
        platform === "uplay" ? "uplay" : platform === "gog" ? "gog" : "steam";
      const legacyDir = path.join(schemaRoot, appid);
      const nextDir = path.join(schemaRoot, storagePlatform, appid);
      const currentPath =
        typeof data?.config_path === "string" ? data.config_path : "";
      if (
        currentPath &&
        path.normalize(currentPath).toLowerCase() ===
          path.normalize(legacyDir).toLowerCase()
      ) {
        try {
          fs.mkdirSync(nextDir, { recursive: true });
        } catch {}
        data.config_path = nextDir;
        try {
          fs.writeFileSync(full, JSON.stringify(data, null, 2));
          updatedConfigs++;
        } catch (err) {
          logger?.warn?.("platform-migrate:schema-config-update-failed", {
            file: full,
            error: err?.message || String(err),
          });
        }
      }
    }
  } catch (err) {
    logger?.warn?.("platform-migrate:schema-config-scan-failed", {
      error: err?.message || String(err),
    });
  }

  return { moved, updatedConfigs };
}

module.exports = {
  migrateConfigPlatforms,
  normalizePlatform,
  sanitizeAppId,
  inferPlatformAndSteamId,
  migrateSchemaStorage,
};
