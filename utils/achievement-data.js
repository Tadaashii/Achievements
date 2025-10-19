const fs = require("fs");
const path = require("path");
const ini = require("ini");
const CRC32 = require("crc-32");
const parseStatsBin = require("./parseStatsBin");

function hexLE32FromAny(raw) {
  const hex = String(raw ?? "").replace(/[^0-9a-f]/gi, "");
  if (hex.length < 8) return undefined;
  try {
    const buf = Buffer.from(hex.slice(0, 8), "hex");
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return view.getUint32(0, true);
  } catch {
    return undefined;
  }
}

function normalizeEpoch(t) {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t < 10_000_000_000 ? t * 1000 : t;
}

function parseType2Section(sec) {
  const get = (...keys) => {
    for (const k of keys) if (k in (sec || {})) return sec[k];
    return undefined;
  };

  const achRaw = get("Achieved", "achieved", "ACHIEVED", "Earned", "earned");
  const achieved =
    typeof achRaw === "boolean"
      ? achRaw
      : typeof achRaw === "number"
      ? achRaw === 1
      : typeof achRaw === "string"
      ? ["1", "true", "yes"].includes(achRaw.trim().toLowerCase())
      : false;

  const curRaw = get("CurProgress", "curProgress", "progress", "Progress");
  const maxRaw = get(
    "MaxProgress",
    "maxProgress",
    "max_progress",
    "Max",
    "max"
  );

  const cur =
    typeof curRaw === "string" && /^[0-9]$/.test(curRaw)
      ? Number(curRaw)
      : Number.isFinite(Number(curRaw))
      ? Number(curRaw)
      : undefined;
  const max =
    typeof maxRaw === "string" && /^[0-9]$/.test(maxRaw)
      ? Number(maxRaw)
      : Number.isFinite(Number(maxRaw))
      ? Number(maxRaw)
      : undefined;

  const tRaw = get(
    "UnlockTime",
    "unlockTime",
    "timestamp",
    "earned_time",
    "earnedTime",
    "Time",
    "time"
  );
  const tNum = Number(tRaw);
  const time = Number.isFinite(tNum) ? tNum : 0;

  return {
    earned: achieved,
    earned_time: normalizeEpoch(time),
    ...(cur !== undefined ? { progress: cur } : {}),
    ...(max !== undefined ? { max_progress: max } : {}),
  };
}

function parseType1Section(sec) {
  const curRaw =
    sec.CurProgress ?? sec.curProgress ?? sec.progress ?? sec.Progress;
  const maxRaw =
    sec.MaxProgress ??
    sec.maxProgress ??
    sec.max_progress ??
    sec.Max ??
    sec.max;
  const timeRaw =
    sec.Time ?? sec.UnlockTime ?? sec.unlockTime ?? sec.timestamp ?? sec.time;

  const stateHex = hexLE32FromAny(sec.State);
  const curHex = hexLE32FromAny(curRaw);
  const maxHex = hexLE32FromAny(maxRaw);
  const timeHex = hexLE32FromAny(timeRaw);

  const toNumber = (raw) =>
    raw !== undefined && raw !== null && raw !== "" ? Number(raw) : undefined;

  const curVal = curHex !== undefined ? curHex : toNumber(curRaw);
  const maxVal = maxHex !== undefined ? maxHex : toNumber(maxRaw);
  const timeVal = timeHex !== undefined ? timeHex : toNumber(timeRaw);

  const earned =
    String(sec.achieved ?? sec.Achieved ?? "").trim() === "1" ||
    (typeof stateHex === "number" && stateHex > 0) ||
    (typeof curVal === "number" &&
      typeof maxVal === "number" &&
      maxVal > 0 &&
      curVal >= maxVal);

  return {
    earned,
    earned_time: normalizeEpoch(timeVal || 0),
    ...(curVal !== undefined ? { progress: curVal } : {}),
    ...(maxVal !== undefined ? { max_progress: maxVal } : {}),
  };
}

function parseAchievementIniSection(sec) {
  const hasType2 =
    "Achieved" in sec ||
    "achieved" in sec ||
    "UnlockTime" in sec ||
    "unlocktime" in sec;
  const hasType1 =
    "State" in sec ||
    "Time" in sec ||
    "CurProgress" in sec ||
    "MaxProgress" in sec ||
    "curProgress" in sec ||
    "maxProgress" in sec ||
    "Progress" in sec ||
    "Max" in sec ||
    "max" in sec;

  if (hasType2 && !hasType1) return parseType2Section(sec);
  if (hasType2 && hasType1) return parseType2Section(sec);
  return parseType1Section(sec);
}

function flattenIniSections(obj) {
  const out = {};
  const isLeaf = (o) =>
    o &&
    typeof o === "object" &&
    ("State" in o ||
      "Time" in o ||
      "CurProgress" in o ||
      "MaxProgress" in o ||
      "Achieved" in o ||
      "achieved" in o ||
      "UnlockTime" in o ||
      "timestamp" in o);

  const walk = (node, parts) => {
    if (!node || typeof node !== "object") return;
    if (isLeaf(node)) {
      out[parts.join(".")] = node;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "Steam") continue;
      walk(v, parts.concat(k));
    }
  };

  for (const [k, v] of Object.entries(obj || {})) {
    if (k === "Steam") continue;
    walk(v, [k]);
  }

  return out;
}

function normSectionTitle(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\u2026/g, "...")
    .replace(/\s/g, " ")
    .trim()
    .toLowerCase();
}

function buildNameOnlyIndex(configArray) {
  const byName = new Map();
  for (const a of configArray || []) {
    if (!a || !a.name) continue;
    byName.set(normSectionTitle(a.name), a.name);
  }
  return byName;
}

function buildDisplayToNameIndex(configArray) {
  const byDisp = new Map();
  for (const a of configArray || []) {
    if (!a || !a.name) continue;
    const dn = a.displayName;
    if (typeof dn === "string") {
      byDisp.set(normSectionTitle(dn), a.name);
    } else if (dn && typeof dn === "object") {
      for (const v of Object.values(dn)) {
        if (typeof v === "string" && v.trim()) {
          byDisp.set(normSectionTitle(v), a.name);
        }
      }
    }
  }
  return byDisp;
}

function getNameIndexFromConfigPath(
  configPath,
  schemaOverride = null,
  appid = null
) {
  try {
    const candidates = [];
    if (schemaOverride) candidates.push(schemaOverride);
    if (configPath) {
      candidates.push(path.join(configPath, "achievements.json"));
      if (appid) {
        candidates.push(
          path.join(configPath, String(appid), "achievements.json")
        );
      }
    }
    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const arr = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return {
        byName: buildNameOnlyIndex(arr),
        byDisp: buildDisplayToNameIndex(arr),
      };
    }
  } catch {}
  return { byName: new Map(), byDisp: new Map() };
}

function canonNameFromIniSection(sectionTitle, nameIndex) {
  const key = normSectionTitle(sectionTitle);
  return (
    nameIndex?.byDisp.get(key) || nameIndex?.byName.get(key) || sectionTitle
  );
}

function resolveConfigSchemaPath(meta, fallbackConfigPath = null) {
  if (meta?.config_path) {
    const p1 = path.join(meta.config_path, "achievements.json");
    if (fs.existsSync(p1)) return p1;
    if (meta?.appid != null) {
      const nested = path.join(
        meta.config_path,
        String(meta.appid),
        "achievements.json"
      );
      if (fs.existsSync(nested)) return nested;
    }
  }
  if (fallbackConfigPath) {
    const guess = path.join(fallbackConfigPath, "achievements.json");
    if (fs.existsSync(guess)) return guess;
  }
  return null;
}

function buildCrcNameMap(achievements) {
  const map = {};
  for (const ach of achievements || []) {
    if (!ach?.name) continue;
    const crc = CRC32.str(ach.name) >>> 0;
    const hex = crc.toString(16).padStart(8, "0").toLowerCase();
    map[hex] = ach;
  }
  return map;
}

function getSafeLocalizedText(input, lang = "english") {
  if (input === null || input === undefined) return "Hidden";
  if (typeof input === "string") {
    return input.trim() !== "" ? input.trim() : "Hidden";
  }
  if (typeof input === "object") {
    return (
      input[lang] ||
      input.english ||
      Object.values(input).find(
        (v) => typeof v === "string" && v.trim() !== ""
      ) ||
      "Hidden"
    );
  }
  return "Hidden";
}

function loadAchievementsFromSaveFile(saveDir, fallback = {}, options = {}) {
  const {
    configMeta = null,
    selectedConfigPath = null,
    fullSchemaPath = null,
  } = options || {};

  const appid = configMeta?.appid != null ? String(configMeta.appid) : null;
  const configPathOverride =
    (configMeta && configMeta.config_path) || selectedConfigPath || null;

  const nameIndex = getNameIndexFromConfigPath(
    configPathOverride,
    fullSchemaPath,
    appid
  );

  const saveJsonPath = path.join(saveDir, "achievements.json");
  const iniPath = path.join(saveDir, "achievements.ini");
  const isStatsDir = path.basename(saveDir).toLowerCase() === "stats";
  const onlineFixIniPath = isStatsDir
    ? iniPath
    : path.join(saveDir, "Stats", "achievements.ini");
  const binPath = path.join(saveDir, "stats.bin");
  const fromIniSection = (sec) => parseAchievementIniSection(sec);

  if (fs.existsSync(saveJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(saveJsonPath, "utf-8"));
      const out = {};
      const put = (name, item) => {
        if (!name) return;
        const achRaw =
          item?.achieved ?? item?.Achieved ?? item?.ACHIEVED ?? item?.earned;
        const earned =
          typeof achRaw === "boolean"
            ? achRaw
            : typeof achRaw === "number"
            ? achRaw === 1
            : typeof achRaw === "string"
            ? ["1", "true", "yes"].includes(achRaw.trim().toLowerCase())
            : false;
        const prog =
          item?.CurProgress ??
          item?.curProgress ??
          item?.progress ??
          item?.Progress;
        const maxp =
          item?.MaxProgress ??
          item?.maxProgress ??
          item?.max_progress ??
          item?.Max ??
          item?.max;
        const tsRaw =
          item?.UnlockTime ??
          item?.unlockTime ??
          item?.timestamp ??
          item?.earned_time ??
          item?.earnedTime;
        const ts = Number(tsRaw) || 0;

        out[name] = {
          earned,
          earned_time: ts,
          ...(prog !== undefined ? { progress: Number(prog) } : {}),
          ...(maxp !== undefined ? { max_progress: Number(maxp) } : {}),
        };
      };

      if (Array.isArray(parsed)) {
        parsed.forEach((item) =>
          put(item?.name || item?.Name || item?.id, item)
        );
      } else if (parsed && typeof parsed === "object") {
        for (const [name, item] of Object.entries(parsed)) put(name, item);
      }

      return out;
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(onlineFixIniPath)) {
    try {
      const parsed = ini.parse(fs.readFileSync(onlineFixIniPath, "utf8"));
      const flat = flattenIniSections(parsed);
      const converted = {};
      for (const [secTitle, secObj] of Object.entries(flat)) {
        const key = canonNameFromIniSection(secTitle, nameIndex);
        if (!key) continue;
        converted[key] = fromIniSection(secObj || {});
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(iniPath)) {
    try {
      const parsed = ini.parse(fs.readFileSync(iniPath, "utf8"));
      const flat = flattenIniSections(parsed);
      const converted = {};
      for (const [secTitle, secObj] of Object.entries(flat)) {
        const key = canonNameFromIniSection(secTitle, nameIndex);
        if (!key) continue;
        converted[key] = fromIniSection(secObj || {});
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  if (fs.existsSync(binPath)) {
    try {
      const schemaPath =
        resolveConfigSchemaPath(configMeta, configPathOverride) ||
        fullSchemaPath ||
        (configPathOverride
          ? path.join(configPathOverride, "achievements.json")
          : null);

      let crcMap = {};
      if (schemaPath && fs.existsSync(schemaPath)) {
        const configJson = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        crcMap = buildCrcNameMap(configJson);
      }

      const raw = parseStatsBin(binPath);
      const converted = {};
      for (const [crc, item] of Object.entries(raw)) {
        const key = crcMap[crc.toLowerCase()]?.name || crc.toLowerCase();
        converted[key] = {
          earned: item.earned,
          earned_time: item.earned_time,
        };
      }
      return converted;
    } catch {
      return fallback || {};
    }
  }

  return fallback || {};
}

module.exports = {
  loadAchievementsFromSaveFile,
  parseAchievementIniSection,
  flattenIniSections,
  canonNameFromIniSection,
  getNameIndexFromConfigPath,
  normalizeEpoch,
  hexLE32FromAny,
  getSafeLocalizedText,
  buildCrcNameMap,
  resolveConfigSchemaPath,
};
