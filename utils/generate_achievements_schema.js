// generate_achievements_schema.js
process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createLogger } = require("./logger");
const fsSync = require("fs");
const DEFAULT_UPLAY_MAP_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json"
);
let uplaySteamMapPath = DEFAULT_UPLAY_MAP_PATH;
let uplaySteamMap = [];
const uplayToSteam = new Map();
let mappingRefreshed = false;
function hydrateUplayMap(rows) {
  uplayToSteam.clear();
  for (const row of rows || []) {
    if (!row || !row.uplay_id) continue;
    uplayToSteam.set(String(row.uplay_id), row);
  }
}

function loadUplayMappingFile(fp) {
  try {
    if (!fsSync.existsSync(fp)) return [];
    const raw = fsSync.readFileSync(fp, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureUserDataMappingFile(userDataDir) {
  if (!userDataDir) return null;
  try {
    const candidate = path.join(path.resolve(userDataDir), "uplay-steam.json");
    if (!fsSync.existsSync(candidate)) {
      fsSync.mkdirSync(path.dirname(candidate), { recursive: true });
      if (fsSync.existsSync(DEFAULT_UPLAY_MAP_PATH)) {
        fsSync.copyFileSync(DEFAULT_UPLAY_MAP_PATH, candidate);
      } else {
        fsSync.writeFileSync(candidate, "[]", "utf8");
      }
    }
    return candidate;
  } catch {
    return null;
  }
}

function configureUplayMapping(userDataDir) {
  const candidate = userDataDir ? ensureUserDataMappingFile(userDataDir) : null;
  if (candidate) {
    uplaySteamMapPath = candidate;
  } else {
    uplaySteamMapPath = DEFAULT_UPLAY_MAP_PATH;
  }
  uplaySteamMap = loadUplayMappingFile(uplaySteamMapPath);
  hydrateUplayMap(uplaySteamMap);
}
const schemaLogger = createLogger("achschema");

// --- bridge log/IPC (Electron main) ---
const HAS_IPC = typeof process.send === "function";
function emit(level, message, data = {}) {
  if (HAS_IPC) {
    if (message !== "achschema:start") {
      try {
        process.send({ type: "achgen:log", level, message, ...data });
      } catch {}
    }
  }
  try {
    const logMeta = Object.keys(data || {}).length ? data : undefined;
    if (level === "error") {
      schemaLogger.error(message, logMeta);
    } else if (level === "warn") {
      schemaLogger.warn(message, logMeta);
    } else {
      schemaLogger.info(message, logMeta);
    }
  } catch {}
  if (!HAS_IPC) {
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
        ? console.warn
        : console.log;
    fn(message);
  }
}
function stripAchievementPrefix(name) {
  if (typeof name !== "string") return name;
  const match = name.match(/Ach_(.+)$/i);
  if (match && match[1]) return match[1];
  return name;
}

function normalizeAchievementName(name, shouldStrip = false) {
  if (typeof name !== "string") return name;
  let result = name.trim();
  if (shouldStrip) {
    result = stripAchievementPrefix(result);
    const m = result.match(/^(.*)_(\d+)$/);
    if (m && m[1] && /[A-Za-z]/.test(m[1])) {
      result = m[2];
    }
  }
  return result;
}
const info = (m, d) => emit("info", m, d);
const warn = (m, d) => emit("warn", m, d);
const error = (m, d) => emit("error", m, d);

function reloadUplayMappingFromDisk() {
  try {
    const refreshed = loadUplayMappingFile(uplaySteamMapPath);
    if (!Array.isArray(refreshed)) {
      throw new Error("Mapping file is not an array");
    }
    uplaySteamMap = refreshed;
    hydrateUplayMap(uplaySteamMap);
    return true;
  } catch (err) {
    warn("uplay-mapping:reload-failed", {
      error: err?.message || String(err),
    });
    return false;
  }
}

function refreshMappingViaScript() {
  try {
    execFileSync(process.execPath, [
      "--run-as-node",
      path.join(__dirname, "match-uplay-steam.js"),
      `--output=${uplaySteamMapPath}`,
    ]);
    reloadUplayMappingFromDisk();
    mappingRefreshed = true;
    info("uplay-mapping:refreshed");
  } catch (err) {
    warn("uplay-mapping:script-failed", { error: err?.message || String(err) });
  }
}

/* ---------- CLI ---------- */
function getFlag(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(name + "="));
  return hit ? hit.split("=").slice(1).join("=") : def;
}
const ARGS = process.argv.slice(2);
const APPIDS = ARGS.filter((a) => /^[0-9a-fA-F]+$/.test(a));
const platformModeArg = (getFlag("--platform", "auto") || "auto").toLowerCase();
const VALID_PLATFORM_MODES = ["auto", "uplay", "steam", "epic", "gog"];
const PLATFORM_MODE = VALID_PLATFORM_MODES.includes(platformModeArg)
  ? platformModeArg
  : "auto";
const OUTPUT_PLATFORM =
  PLATFORM_MODE === "uplay"
    ? "uplay"
    : PLATFORM_MODE === "gog"
    ? "gog"
    : PLATFORM_MODE === "epic"
    ? "epic"
    : "steam";
const EFFECTIVE_PLATFORM_MODE = PLATFORM_MODE;

function resolveAppMeta(appid, mode = "auto") {
  const id = String(appid);
  if (mode === "gog") {
    return { uplayId: id, steamId: id, strip: false, platform: "gog" };
  }
  if (mode === "steam" || mode === "epic") {
    return { uplayId: id, steamId: id, strip: false, platform: mode };
  }
  const mapping = uplayToSteam.get(id);
  if (mapping?.steam_appid) {
    return {
      uplayId: id,
      steamId: String(mapping.steam_appid),
      strip: mode !== "steam",
      platform: mode === "uplay" ? "uplay" : undefined,
    };
  }
  if (mode === "uplay") {
    warn(`[${id}] No Uplay->Steam mapping found. Using provided ID only.`);
  }
  return {
    uplayId: id,
    steamId: id,
    strip: false,
    platform: mode === "uplay" ? "uplay" : undefined,
  };
}

function buildResolvedAppIds(ids, mode = "auto") {
  if (!ids.length) return [];
  if (mode === "gog") {
    return ids.map((raw) => resolveAppMeta(raw, mode));
  }
  if (mode === "steam" || mode === "epic") {
    return ids.map((raw) => resolveAppMeta(raw, mode));
  }
  const needsRefresh = ids.some((raw) => {
    const mapping = uplayToSteam.get(String(raw));
    return !mapping || !mapping.steam_appid;
  });
  const initial = ids.map((raw) => resolveAppMeta(raw, mode));
  if (!needsRefresh) return initial;
  if (!mappingRefreshed) {
    try {
      refreshMappingViaScript();
    } catch (err) {
      warn("uplay-mapping:refresh-failed", {
        error: err?.message || String(err),
      });
    } finally {
      mappingRefreshed = true;
    }
  }
  return ids.map((raw) => resolveAppMeta(raw, mode));
}

const headed = ARGS.includes("--headed");
const verbose = ARGS.includes("--verbose");
const langsArg = getFlag("--langs", null);
const appsConcurrency = parseInt(getFlag("--apps-concurrency", "1"), 10);
const inlineKey = (getFlag("--key", "") || "").trim();
const OUT_BASE = getFlag("--out", null);
const USERDATA_DIR = getFlag("--user-data-dir", "");
configureUplayMapping(USERDATA_DIR);
const GOG_AUTH_BASE = "https://auth.gog.com";
const GOG_EMBED = "https://embed.gog.com";
const GOG_GAMEPLAY = "https://gameplay.gog.com";
const GOG_CLIENT_ID = "46899977096215655";
const GOG_CLIENT_SECRET =
  "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";
const GOG_REDIRECT_URI = "https://embed.gog.com/on_login_success?origin=client";
const GOG_MODE = ARGS.includes("--gog");
const GOG_USER = getFlag("--gog-user", "jach_dum@mailinator.com");
const GOG_PASS = getFlag("--gog-pass", "JokerVerse2009!");
const gogTokensFlag = getFlag("--gog-tokens-file", "");
const DEFAULT_GOG_TOKENS_FILE = USERDATA_DIR
  ? path.join(path.resolve(USERDATA_DIR), "gog_tokens.enc")
  : path.join(process.cwd(), "gog_tokens.enc");
const GOG_TOKENS_FILE = path.resolve(gogTokensFlag || DEFAULT_GOG_TOKENS_FILE);
const GOG_TOKEN_SECRET =
  process.env.GOG_TOKEN_SECRET || "gog_default_passphrase";
const resolvedAppIds = buildResolvedAppIds(APPIDS, EFFECTIVE_PLATFORM_MODE);

if (!APPIDS.length) {
  error(
    "Usage: node generate_achievements_schema.js <APPID...> [--headed] [--verbose] [--apps-concurrency=2] [--langs=english,german,...] [--key=XXXXX] [--out=ABS_OR_REL_PATH] [--platform=steam|uplay|epic|gog] [--gog] [--gog-user=email --gog-pass=pass] [--gog-tokens-file=PATH]"
  );
  process.exit(1);
}

/* ---------- langs ---------- */
const DEFAULT_LANGS = [
  "english",
  "german",
  "french",
  "italian",
  "spanish",
  "brazilian",
  "russian",
  "polish",
  "japanese",
  "koreana",
  "tchinese",
  "schinese",
  "LATAM",
];
const EXTENDED_STEAM_LANGS = [
  ...DEFAULT_LANGS,
  "thai",
  "portuguese",
  "danish",
  "dutch",
  "swedish",
  "hungarian",
  "turkish",
  "ukrainian",
  "vietnamese",
];
const LANGS = (langsArg ? langsArg.split(",") : DEFAULT_LANGS)
  .map((s) => s.trim())
  .filter(Boolean);
const STEAM_LANGS = langsArg ? LANGS : EXTENDED_STEAM_LANGS;

info("achschema:start", {
  uplayAppIds: resolvedAppIds.map((entry) => entry.uplayId),
  steamAppIds: resolvedAppIds.map((entry) => entry.steamId),
  platform: PLATFORM_MODE,
  headed,
  verbose,
  langs: LANGS,
  output: OUT_BASE,
});

/* ---------- utils ---------- */
function log(...a) {
  if (!verbose) return;
  const message = a.map((x) => String(x)).join(" ");
  emit("info", message);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function safeText(s) {
  return (s || "").replace(/\u00A0/g, " ").trim();
}
function sanitize(name) {
  return (name || "").replace(/[^\w.-]+/g, "_").slice(0, 120) || "ach";
}
function toAbs(base, u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
}
function takeFromSrcset(srcset) {
  if (!srcset) return "";
  const parts = srcset
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const parsed = parts
    .map((p) => {
      const m = p.match(/(\S+)\s+(\d+(\.\d+)?x|\d+w)$/i);
      return m
        ? {
            url: m[1],
            dens: parseFloat((m[2] || "1").replace(/[^\d.]/g, "")) || 1,
          }
        : { url: p.split(/\s+/)[0], dens: 1 };
    })
    .sort((a, b) => b.dens - a.dens);
  return parsed[0].url;
}
function extFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? "." + m[1].toLowerCase() : ".jpg";
  } catch {
    return ".jpg";
  }
}
function normalizeSteamIconUrl(appid, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return "https:" + value;
  return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appid}/${value}`;
}

async function download(url, dest, ms = 20000) {
  if (!url) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url.replace(/^http:/, "https:"), {
      signal: ctrl.signal,
    });
    if (!r.ok) return false;
    const ab = await r.arrayBuffer();
    await fs.writeFile(dest, Buffer.from(ab));
    return true;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- GOG helpers ---------- */
function ensureGogTokenDir() {
  try {
    fsSync.mkdirSync(path.dirname(GOG_TOKENS_FILE), { recursive: true });
  } catch {}
}

function gogEncryptTokens(payload) {
  ensureGogTokenDir();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(GOG_TOKEN_SECRET, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const pt = Buffer.from(JSON.stringify(payload), "utf8");
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = {
    v: 1,
    s: salt.toString("base64"),
    i: iv.toString("base64"),
    t: tag.toString("base64"),
    c: enc.toString("base64"),
  };
  return Buffer.from(JSON.stringify(body), "utf8");
}

function gogDecryptTokens(buf) {
  if (!buf) return null;
  const raw = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  const payload = JSON.parse(raw);
  const salt = Buffer.from(payload.s, "base64");
  const iv = Buffer.from(payload.i, "base64");
  const tag = Buffer.from(payload.t, "base64");
  const ct = Buffer.from(payload.c, "base64");
  const key = crypto.scryptSync(GOG_TOKEN_SECRET, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

async function gogSaveTokensEncrypted(tok) {
  if (!tok) return;
  tok.expires_at =
    Date.now() + Math.max(0, (tok.expires_in || 3600) - 60) * 1000;
  await fs.writeFile(GOG_TOKENS_FILE, gogEncryptTokens(tok));
}

async function gogLoadTokensEncrypted() {
  try {
    if (!fsSync.existsSync(GOG_TOKENS_FILE)) return null;
    const buf = await fs.readFile(GOG_TOKENS_FILE);
    return gogDecryptTokens(buf);
  } catch {
    return null;
  }
}

async function gogTokenRequest(grant) {
  const body = new URLSearchParams({
    client_id: GOG_CLIENT_ID,
    client_secret: GOG_CLIENT_SECRET,
    redirect_uri: GOG_REDIRECT_URI,
    ...grant,
  });
  const res = await fetch(`${GOG_AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`GOG token ${res.status} ${res.statusText}`);
  }
  const tok = await res.json();
  tok.expires_at =
    Date.now() + Math.max(0, (tok.expires_in || 3600) - 60) * 1000;
  return tok;
}

async function gogRefreshIfNeeded(tok) {
  if (tok?.expires_at && Date.now() < tok.expires_at) return tok;
  if (!tok?.refresh_token) throw new Error("GOG_NO_REFRESH_TOKEN");
  const next = await gogTokenRequest({
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token,
  });
  await gogSaveTokensEncrypted(next);
  return next;
}

async function gogHeadlessLogin() {
  if (!GOG_USER || !GOG_PASS) {
    throw new Error("Provide --gog-user and --gog-pass for first login.");
  }
  const browser = await launchChromiumSafe({ headless: !headed });
  try {
    const page = await browser.newPage();
    const authUrl = `${GOG_AUTH_BASE}/auth?client_id=${GOG_CLIENT_ID}&redirect_uri=${encodeURIComponent(
      GOG_REDIRECT_URI
    )}&response_type=code&layout=client2`;
    await page.goto(authUrl, { waitUntil: "domcontentloaded" });

    const signInToggle = await page.$(
      'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Already have an account"), a:has-text("Already have an account")'
    );
    if (signInToggle) {
      await signInToggle.click().catch(() => {});
      await page.waitForTimeout(700);
    }

    const loginForm = page
      .locator("form.js-login-form, form.form--login")
      .first();
    await loginForm
      .waitFor({ state: "visible", timeout: 30000 })
      .catch(() => {});

    const userInput = loginForm
      .locator('input[name="login[username]"]')
      .first();
    const passInput = loginForm
      .locator('input[name="login[password]"]')
      .first();
    await userInput.waitFor({ state: "visible", timeout: 30000 });
    await userInput.fill(GOG_USER);
    await passInput.waitFor({ state: "visible", timeout: 30000 });
    await passInput.fill(GOG_PASS);

    const submit = loginForm
      .locator(
        '#login_login, button:has-text("Log in now"), button:has-text("Log in"), button[type="submit"]'
      )
      .first();
    if ((await submit.count()) > 0) {
      await submit
        .waitFor({ state: "visible", timeout: 30000 })
        .catch(() => {});
      await submit.scrollIntoViewIfNeeded().catch(() => {});
      await submit.click().catch(async () => {
        try {
          await submit.click({ force: true });
        } catch {}
      });
    } else {
      await page.keyboard.press("Enter");
    }

    let code = null;
    for (let i = 0; i < 150 && !code; i++) {
      const url = page.url();
      if (url.startsWith(`${GOG_EMBED}/on_login_success`)) {
        try {
          code = new URL(url).searchParams.get("code");
        } catch {}
      }
      if (!code) await page.waitForTimeout(200);
    }
    if (!code) throw new Error("GOG_LOGIN_FAILED_NO_CODE");
    const token = await gogTokenRequest({
      grant_type: "authorization_code",
      code,
    });
    await gogSaveTokensEncrypted(token);
    return token;
  } finally {
    await browser.close();
  }
}

async function gogEnsureAccessToken() {
  let tok = null;
  try {
    tok = await gogLoadTokensEncrypted();
  } catch {
    tok = null;
  }
  if (tok) {
    try {
      tok = await gogRefreshIfNeeded(tok);
      return tok;
    } catch {
      tok = null;
    }
  }
  tok = await gogHeadlessLogin();
  return tok;
}

async function gogFetchAchievements(productId) {
  const tok = await gogEnsureAccessToken();
  const url = `${GOG_GAMEPLAY}/clients/${productId}/users/${tok.user_id}/achievements`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "Accept-Language": "en-US",
    },
  });
  if (res.status === 404) return { items: [], userId: tok.user_id };
  if (!res.ok) {
    throw new Error(`GOG ${productId} achievements HTTP ${res.status}`);
  }
  const data = await res.json().catch(() => ({ items: [] }));
  return { items: data.items || [], userId: tok.user_id };
}

async function processGogApp(productId, outBaseDir) {
  const appid = String(productId);
  const base = outBaseDir
    ? path.resolve(outBaseDir)
    : path.join(process.cwd(), "_OUTPUT");
  const outDir = path.join(base, "gog", appid);
  const imgDir = path.join(outDir, "img");
  await fs.mkdir(imgDir, { recursive: true });

  const { items } = await gogFetchAchievements(appid);
  const results = [];
  const seenUrls = new Set();

  const downloadImageIfNeeded = async (url, fallbackName) => {
    if (!url || seenUrls.has(url)) return "";
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "";
    }
    const baseName =
      sanitize(
        parsed.pathname
          .split("/")
          .pop()
          .replace(/\.[^.]+$/, "")
      ) || sanitize(fallbackName || "gog_icon");
    const fileName = `${baseName}${extFromUrl(url)}`;
    await download(url, path.join(imgDir, fileName));
    seenUrls.add(url);
    return `img/${fileName}`;
  };

  for (const entry of items || []) {
    const unlocked = entry?.image_url_unlocked || "";
    const locked = entry?.image_url_locked || "";
    const fallbackBase =
      entry?.achievement_key || entry?.name || `gog_${results.length}`;
    const iconRel = await downloadImageIfNeeded(
      unlocked,
      `${fallbackBase}_icon`
    );
    const grayRel = await downloadImageIfNeeded(locked, `${fallbackBase}_gray`);
    const hidden = entry?.visible ? 1 : 0;
    results.push({
      hidden,
      displayName: { english: entry?.name || "" },
      description: { english: entry?.description || "" },
      icon: iconRel,
      icon_gray: grayRel || iconRel,
      name: entry?.achievement_key || "",
    });
  }

  await fs.writeFile(
    path.join(outDir, "achievements.json"),
    JSON.stringify(results, null, 2),
    "utf8"
  );

  if (!results.length) {
    emit("info", `⏭ [${appid}] (GOG) No Achievements found!`);
  } else {
    emit("info", `✅ [${appid}] (GOG) Achievements schema done.`);
  }
  return { outDir, count: results.length };
}

/* ---------- Epic helpers ---------- */
const EPIC_LOCALE_MAP = {
  english: "en",
  german: "de",
  french: "fr",
  italian: "it",
  spanish: "es-ES",
  latam: "es-MX",
  brazilian: "pt-BR",
  russian: "ru",
  polish: "pl",
  japanese: "ja",
  koreana: "ko",
  tchinese: "zh-TW",
  schinese: "zh-CN",
};

function epicLocaleForLang(lang) {
  const key = String(lang || "")
    .trim()
    .toLowerCase();
  return EPIC_LOCALE_MAP[key] || EPIC_LOCALE_MAP.english;
}

async function fetchEpicAchievements(appid, locale) {
  const url = `https://api.epicgames.dev/epic/achievements/v1/public/achievements/product/${appid}/locale/${locale}?includeAchievements=true`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    throw new Error(`Epic ${r.status} ${r.statusText}`);
  }
  const data = await r.json();
  return Array.isArray(data?.achievements) ? data.achievements : [];
}

function parseEpicAchievement(entry) {
  const ach = entry?.achievement || entry || {};
  const apiName = String(
    ach.name || ach.id || ach.apiName || ach.achievementName || ""
  ).trim();
  if (!apiName) return null;
  const displayName =
    ach.unlockedDisplayName ||
    ach.lockedDisplayName ||
    ach.displayName ||
    apiName;
  const description =
    ach.unlockedDescription || ach.lockedDescription || ach.description || "";
  const hidden = ach.hidden === true;
  const icon =
    ach.unlockedIconLink || ach.unlockedIcon || ach.unlockedIconUrl || "";
  const iconGray =
    ach.lockedIconLink || ach.lockedIcon || ach.lockedIconUrl || "";
  return {
    apiName,
    displayName,
    description,
    hidden,
    icon,
    icon_gray: iconGray,
  };
}

function normalizeHidden(descEN) {
  if (!descEN) return { hidden: 0, clean: "" };

  let s = String(descEN)
    .replace(/\u00A0/g, " ")
    .trim();
  let hidden = 0;

  // SteamDB: "Hidden achievement:"
  if (/^\s*Hidden achievement:/i.test(s)) {
    hidden = 1;
    s = s.replace(/^\s*Hidden achievement:\s*/i, "").trim();
  }

  // SteamHunters: "This achievement is hidden."
  else if (/^\s*This achievement is hidden\.\s*/i.test(s)) {
    hidden = 1;
    s = s.replace(/^\s*This achievement is hidden\.\s*/i, "").trim();
  }

  return { hidden, clean: s };
}

function createLimiter(concurrency = 1) {
  let active = 0;
  const q = [];
  const run = () => {
    if (active >= concurrency || !q.length) return;
    const { fn, resolve, reject } = q.shift();
    active++;
    Promise.resolve()
      .then(fn)
      .then((v) => {
        active--;
        resolve(v);
        run();
      })
      .catch((e) => {
        active--;
        reject(e);
        run();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      q.push({ fn, resolve: res, reject: rej });
      run();
    });
}
const appLimit = createLimiter(appsConcurrency);

async function launchChromiumSafe(opts = {}) {
  const baseArgs = ["--disable-blink-features=AutomationControlled"];
  try {
    return await chromium.launch({
      headless: !headed,
      args: baseArgs,
      ...opts,
    });
  } catch (firstErr) {
    const unAsar = (p) =>
      p.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");

    const roots = [];

    for (const pkg of ["playwright-core", "playwright"]) {
      try {
        const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
        const rootA = path.join(pkgDir, ".local-browsers");
        const rootB = unAsar(rootA);
        roots.push(rootA, rootB);
      } catch {}
    }

    if (process.resourcesPath) {
      roots.push(
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright-core",
          ".local-browsers"
        ),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "node_modules",
          "playwright",
          ".local-browsers"
        ),
        path.join(process.resourcesPath, "playwright-browsers")
      );
    }

    const exeCandidates = [];
    for (const root of roots) {
      const dirs = await fs.readdir(root).catch(() => []);
      for (const d of dirs) {
        if (/^chromium_headless_shell-/i.test(d)) {
          exeCandidates.push(
            path.join(root, d, "chrome-win", "headless_shell.exe")
          );
        }
        if (/^chromium-/i.test(d)) {
          exeCandidates.push(path.join(root, d, "chrome-win", "chrome.exe"));
        }
      }
    }

    for (const exe of exeCandidates) {
      try {
        await fs.access(exe);
        // if (verbose) emit('info', `[achgen] Using Chromium: ${exe}`);
        return await chromium.launch({
          executablePath: exe,
          headless: !headed,
          args: baseArgs,
          ...opts,
        });
      } catch {}
    }

    throw firstErr;
  }
}

/* ---------- Steam Web API ---------- */
async function readApiKey() {
  if (inlineKey) return inlineKey;
  const candidates = [
    path.join(__dirname, "my_login.txt"),
    ...(USERDATA_DIR ? [path.join(USERDATA_DIR, "my_login.txt")] : []),
  ];
  //emit('info', 'Look for my_login.txt');

  for (const fp of candidates) {
    try {
      const txt = await fs.readFile(fp, "utf8");
      const line = txt
        .split(/\r?\n/)
        .find((l) => /^\s*(key|apikey|steam_api_key)\s*=/i.test(l)); // <— /i
      if (line) {
        const val = line.split("=").slice(1).join("=").trim();
        if (val) {
          //emit('info', `Steam API key loaded`);
          return val;
        }
      }
    } catch {}
  }
  //emit('warn', 'Steam API key not found. Running in SteamDB/SteamHunters mode. (English only)');
  return "";
}

const STEAM_API_TIMEOUT_MS = 15000;
const STEAM_API_GAP_MS = 250;

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return { response: r, json: await r.json().catch(() => ({})) };
  } finally {
    clearTimeout(t);
  }
}
async function fetchSchemaLang(appid, key, lang) {
  const base = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(
    key
  )}&appid=${encodeURIComponent(appid)}`;
  const urls = [
    `${base}&language=${encodeURIComponent(lang)}`,
    `${base}&l=${encodeURIComponent(lang)}`,
  ];
  let lastErr = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const mode = i === 0 ? "language" : "l";
    try {
      emit("info", "steam-schema:request", { appid, lang, mode });
      const { response: r, json: j } = await fetchJsonWithTimeout(
        url,
        STEAM_API_TIMEOUT_MS
      );
      if (!r.ok) throw new Error(`Steam API ${appid} ${lang} HTTP ${r.status}`);
      const list = j?.game?.availableGameStats?.achievements || [];
      if (!list.length) {
        emit("warn", "steam-schema:empty", { appid, lang, mode });
        continue;
      }
      const map = new Map();
      for (const a of list) {
        if (!a || !a.name) continue;
        map.set(a.name, {
          displayName: a.displayName || "",
          description: a.description || "",
          hidden: Number(a.hidden) ? 1 : 0,
          icon: a.icon || "",
          icongray: a.icongray || "",
        });
      }
      emit("info", "steam-schema:success", {
        appid,
        lang,
        mode,
        count: map.size,
      });
      return map;
    } catch (err) {
      lastErr = err;
      emit("warn", "steam-schema:failed", {
        appid,
        lang,
        mode,
        error: err?.message || String(err),
      });
    }
    if (i < urls.length - 1 && STEAM_API_GAP_MS > 0) {
      await sleep(STEAM_API_GAP_MS);
    }
  }

  if (lastErr) throw lastErr;
  return new Map();
}
async function fetchAchievementsLang(appid, key, lang) {
  const base = `https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/?key=${encodeURIComponent(
    key
  )}&appid=${encodeURIComponent(appid)}`;
  const urls = [
    `${base}&language=${encodeURIComponent(lang)}`,
    `${base}&l=${encodeURIComponent(lang)}`,
  ];
  let lastErr = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const mode = i === 0 ? "language" : "l";
    try {
      emit("info", "steam-achievements:request", { appid, lang, mode });
      const { response: r, json: j } = await fetchJsonWithTimeout(
        url,
        STEAM_API_TIMEOUT_MS
      );
      if (!r.ok)
        throw new Error(
          `Steam Achievements API ${appid} ${lang} HTTP ${r.status}`
        );
      const list = j?.response?.achievements || [];
      if (!list.length) {
        emit("warn", "steam-achievements:empty", { appid, lang, mode });
        continue;
      }

      const map = new Map();
      for (const a of list) {
        const apiName = a?.internal_name || a?.name || "";
        if (!apiName) continue;
        map.set(apiName, {
          displayName: a?.localized_name || "",
          description: a?.localized_desc || "",
          hidden: a?.hidden ? 1 : 0,
          icon: normalizeSteamIconUrl(appid, a?.icon || ""),
          icongray: normalizeSteamIconUrl(
            appid,
            a?.icon_gray || a?.icongray || ""
          ),
        });
      }
      emit("info", "steam-achievements:success", {
        appid,
        lang,
        mode,
        count: map.size,
      });
      return map;
    } catch (err) {
      lastErr = err;
      emit("warn", "steam-achievements:failed", {
        appid,
        lang,
        mode,
        error: err?.message || String(err),
      });
    }
    if (i < urls.length - 1 && STEAM_API_GAP_MS > 0) {
      await sleep(STEAM_API_GAP_MS);
    }
  }

  if (lastErr) throw lastErr;
  return new Map();
}

/* ---------- Scraping SteamDB ---------- */
async function scrapeSteamDB(appid) {
  const url = `https://steamdb.info/app/${appid}/stats/`;
  log(`[${appid}] open`, url);

  const browser = await launchChromiumSafe({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });

  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
    route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const list = page.locator('[id^="achievement-"]');
  await list
    .first()
    .waitFor({ state: "visible" })
    .catch(() => {});
  const count = await list.count();
  if (!count) {
    await browser.close();
    throw new Error("No achievements found");
  }
  log(`[${appid}] achievements: ${count}`);

  for (let i = 0; i < count; i++) {
    await list
      .nth(i)
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await sleep(12);
  }

  async function extractImgUrl(el, sel, baseUrl) {
    const img = el.locator(sel).first();
    if ((await img.count()) === 0) return "";
    let url = await img.getAttribute("src").catch(() => null);
    if (!url) {
      const [ds, dor, ss, dss] = await Promise.all([
        img.getAttribute("data-src").catch(() => null),
        img.getAttribute("data-original").catch(() => null),
        img.getAttribute("srcset").catch(() => null),
        img.getAttribute("data-srcset").catch(() => null),
      ]);
      url = ds || dor || takeFromSrcset(ss) || takeFromSrcset(dss) || "";
    }
    if (!url) {
      const source = el
        .locator(`${sel} ~ source, picture ${sel} source`)
        .first();
      if (await source.count()) {
        const s1 = await source.getAttribute("srcset").catch(() => null);
        const s2 = await source.getAttribute("data-srcset").catch(() => null);
        url = takeFromSrcset(s1) || takeFromSrcset(s2) || "";
      }
    }
    return toAbs(baseUrl, url);
  }
  async function extractGrayUrl(el, baseUrl) {
    await el.hover().catch(() => {});
    const img = el.locator("div.achievement_checkmark > img").first();
    await img.waitFor({ state: "attached" }).catch(() => {});
    let url = await img.getAttribute("src").catch(() => null);
    if (!url) {
      const [ds, dor, ss, dss] = await Promise.all([
        img.getAttribute("data-src").catch(() => null),
        img.getAttribute("data-original").catch(() => null),
        img.getAttribute("srcset").catch(() => null),
        img.getAttribute("data-srcset").catch(() => null),
      ]);
      url = ds || dor || takeFromSrcset(ss) || takeFromSrcset(dss) || "";
    }
    if (!url) {
      const dataName = await img.getAttribute("data-name").catch(() => null);
      if (dataName)
        url = `https://cdn.fastly.steamstatic.com/steamcommunity/public/images/apps/${appid}/${dataName}`;
    }
    if (!url)
      url = await img
        .evaluate((n) => (n && (n.currentSrc || n.src)) || "")
        .catch(() => "");
    return toAbs(baseUrl, url || "");
  }

  const rows = [];
  for (let i = 0; i < count; i++) {
    const el = list.nth(i);
    const id = await el.getAttribute("id").catch(() => null);
    if (!id || !id.startsWith("achievement-")) continue;

    const apiName =
      safeText(
        await el
          .locator(
            "div.achievement_inner > div > div.achievement_right > div.achievement_api"
          )
          .textContent()
          .catch(() => "")
      ) || id.replace(/^achievement-/, "");
    const nameEN =
      safeText(
        await el
          .locator(
            "div.achievement_inner > div > div:nth-child(1) > div.achievement_name"
          )
          .textContent()
          .catch(() => "")
      ) || "";
    const descEN0 =
      safeText(
        await el
          .locator(
            "div.achievement_inner > div > div:nth-child(1) > div.achievement_desc"
          )
          .textContent()
          .catch(() => "")
      ) || "";
    const { hidden, clean: descEN } = normalizeHidden(descEN0);

    let iconUrl = await extractImgUrl(el, "div.achievement_inner > img", url);
    if (!iconUrl)
      iconUrl = await extractImgUrl(el, ".achievement_inner picture img", url);
    let iconGrayUrl = await extractGrayUrl(el, url);

    rows.push({ apiName, nameEN, descEN, hidden, iconUrl, iconGrayUrl });
    if (verbose && i % 10 === 0) log(`[${appid}] scraped ${i + 1}/${count}`);
  }

  await browser.close();
  return rows;
}

/* ---------- Scraping SteamHunters ---------- */
async function scrapeSteamHunters(appid) {
  const url = `https://steamhunters.com/apps/${appid}/achievements`;
  log(`[${appid}] fallback open`, url);

  const browser = await launchChromiumSafe({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
  });

  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
    route.continue();
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // a<href="/apps/<appid>/achievements/...">
  await page
    .waitForSelector('a[href*="/achievements/"][href*="/apps/"]', {
      timeout: 10000,
    })
    .catch(() => {});

  const rows = await page.$$eval(
    'a[href*="/achievements/"][href*="/apps/"]',
    (links) => {
      const safeText = (s) => (s || "").replace(/\u00A0/g, " ").trim();
      const takeFromSrcset = (ss) => {
        if (!ss) return "";
        const p = ss
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.split(/\s+/)[0]);
        return p[0] || "";
      };
      const abs = (u) => {
        if (!u) return "";
        if (/^https?:\/\//i.test(u)) return u;
        if (u.startsWith("//")) return "https:" + u;
        try {
          return new URL(u, location.origin).toString();
        } catch {
          return u;
        }
      };

      const out = [];
      for (const a of links) {
        const displayName = safeText(a.textContent);
        const row = a.closest("tr") || a.closest("li") || a.closest("div");

        const descEl = row && row.querySelector("p.small");
        const descEN = safeText(descEl ? descEl.textContent : "");

        // icon (<span class="image ..."><img ...>)
        const img =
          row &&
          (row.querySelector("span.image img") || row.querySelector("img"));
        let iconUrl = "";
        if (img) {
          iconUrl =
            img.getAttribute("src") ||
            img.getAttribute("data-src") ||
            takeFromSrcset(
              img.getAttribute("srcset") || img.getAttribute("data-srcset")
            );
          iconUrl = abs(iconUrl);
        }

        // API Name  title/data-original-title
        const span = row && row.querySelector("span.image");
        const title =
          (span &&
            (span.getAttribute("title") ||
              span.getAttribute("data-original-title"))) ||
          "";
        let apiName = "";
        const m = /API Name:\s*([^\s<>"']+)/i.exec(title);
        if (m) apiName = m[1];

        out.push({
          apiName,
          nameEN: displayName,
          descEN,
          hidden: /^Hidden achievement:/i.test(descEN) ? 1 : 0,
          iconUrl,
          iconGrayUrl: "", // if not exists use icon
        });
      }

      // apiName (fallback on name)
      const seen = new Set(),
        uniq = [];
      for (const r of out) {
        const key = r.apiName || r.nameEN;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(r);
      }
      return uniq;
    }
  );

  await browser.close();

  if (!rows.length) throw new Error("No achievements found (SteamHunters)");
  return rows;
}

function uniqueLangsWithEnglish(langs) {
  const s = new Set(langs || []);
  s.add("english");
  return Array.from(s);
}
async function buildAchievementsFromScrape(appid, imgDir) {
  let scraped = [];
  try {
    scraped = await scrapeSteamDB(appid);
  } catch (e) {
    warn(
      `[${appid}] SteamDB failed: ${String(
        e?.message || e
      )} -> trying SteamHunters`
    );
    try {
      scraped = await scrapeSteamHunters(appid);
    } catch (e2) {
      warn(
        `[${appid}] SteamHunters failed: ${String(
          e2?.message || e2
        )} -> continue`
      );
      scraped = [];
    }
  }

  const results = [];
  for (const a of scraped) {
    const enNorm = normalizeHidden(a.descEN || "");
    const hidden = enNorm.hidden ? 1 : a.hidden ? 1 : 0;

    let iconRel = "";
    let iconGrayRel = "";
    if (a.iconUrl) {
      const baseName =
        sanitize(
          path.basename(new URL(a.iconUrl).pathname).replace(/\.[^.]+$/, "")
        ) || sanitize(a.apiName + "_icon");
      const file = `${baseName}${extFromUrl(a.iconUrl)}`;
      await download(a.iconUrl, path.join(imgDir, file));
      iconRel = `img/${file}`;
    }
    if (a.iconGrayUrl) {
      const baseName =
        sanitize(
          path
            .basename(new URL(a.iconGrayUrl).pathname)
            .replace(/\.[^.]+$/, "")
        ) || sanitize(a.apiName + "_gray");
      const file = `${baseName}${extFromUrl(a.iconGrayUrl)}`;
      await download(a.iconGrayUrl, path.join(imgDir, file));
      iconGrayRel = `img/${file}`;
    } else {
      iconGrayRel = iconRel;
    }

    results.push({
      hidden,
      displayName: { english: a.nameEN || "" },
      description: { english: enNorm.clean },
      icon: iconRel,
      icon_gray: iconGrayRel,
      name: a.apiName,
    });
  }

  return results;
}

/* ---------- Process ---------- */
async function processOneApp(appMeta, apiKey, outBaseDir) {
  // results
  const meta =
    typeof appMeta === "object" && appMeta !== null
      ? appMeta
      : { uplayId: String(appMeta), steamId: String(appMeta), strip: false };
  const { uplayId, steamId, strip } = meta;
  const wantsGog =
    (meta && meta.platform === "gog") || PLATFORM_MODE === "gog" || GOG_MODE;
  const wantsEpic = meta && meta.platform === "epic";
  const folderId = String(uplayId);
  const appid = String(steamId);
  const base = outBaseDir
    ? path.resolve(outBaseDir)
    : path.join(process.cwd(), "_OUTPUT");
  const targetPlatform = wantsGog
    ? "gog"
    : wantsEpic
    ? "epic"
    : OUTPUT_PLATFORM;
  const outDir = path.join(base, targetPlatform, folderId);
  const imgDir = path.join(outDir, "img");
  await fs.mkdir(imgDir, { recursive: true });

  const achievements = [];

  if (wantsGog) {
    return processGogApp(folderId, outBaseDir);
  }
  if (wantsEpic) {
    const langsToFetch = uniqueLangsWithEnglish(STEAM_LANGS);
    const perLangByApi = {};

    await Promise.all(
      langsToFetch.map(async (lang) => {
        const locale = epicLocaleForLang(lang);
        try {
          const items = await fetchEpicAchievements(appid, locale);
          const map = new Map();
          for (const item of items) {
            const parsed = parseEpicAchievement(item);
            if (!parsed || !parsed.apiName) continue;
            map.set(parsed.apiName, parsed);
          }
          perLangByApi[lang] = map;
        } catch (e) {
          emit("warn", `[${appid}] Epic API failed for ${lang}`, {
            appid,
            lang: locale,
            error: String(e?.message || e),
          });
          perLangByApi[lang] = new Map();
        }
      })
    );

    let enMap = perLangByApi["english"];
    if (!enMap || enMap.size === 0) {
      enMap =
        Object.values(perLangByApi).find((m) => m && m.size > 0) || new Map();
    }

    for (const [apiName, enEntry = {}] of enMap.entries()) {
      const displayName = {};
      const description = {};
      let hidden = enEntry.hidden ? 1 : 0;

      displayName.english = enEntry.displayName || "";
      description.english = enEntry.description || "";

      for (const lang of langsToFetch) {
        if (lang === "english") continue;
        const entry = perLangByApi[lang]?.get(apiName);
        if (entry?.displayName) displayName[lang] = entry.displayName;
        if (entry?.description) description[lang] = entry.description;
        if (entry?.hidden) hidden = 1;
      }

      let iconUrl = enEntry.icon || "";
      let iconGrayUrl = enEntry.icon_gray || "";
      if (!iconUrl || !iconGrayUrl) {
        for (const lang of langsToFetch) {
          const entry = perLangByApi[lang]?.get(apiName);
          if (!iconUrl && entry?.icon) iconUrl = entry.icon;
          if (!iconGrayUrl && entry?.icon_gray) iconGrayUrl = entry.icon_gray;
        }
      }

      let iconRel = "";
      let iconGrayRel = "";
      if (iconUrl) {
        const baseName =
          sanitize(
            path.basename(new URL(iconUrl).pathname).replace(/\.[^.]+$/, "")
          ) || sanitize(apiName);
        const file = `${baseName}${extFromUrl(iconUrl)}`;
        await download(iconUrl, path.join(imgDir, file));
        iconRel = `img/${file}`;
      }
      if (iconGrayUrl) {
        const baseName =
          sanitize(
            path.basename(new URL(iconGrayUrl).pathname).replace(/\.[^.]+$/, "")
          ) || sanitize(apiName + "_gray");
        const file = `${baseName}${extFromUrl(iconGrayUrl)}`;
        await download(iconGrayUrl, path.join(imgDir, file));
        iconGrayRel = `img/${file}`;
      } else {
        iconGrayRel = iconRel;
      }

      achievements.push({
        hidden,
        displayName,
        description,
        icon: iconRel,
        icon_gray: iconGrayRel,
        name: apiName,
      });
    }
  } else if (apiKey) {
    // ===== API-ONLY =====
    // 1) langs
    const langsToFetch = uniqueLangsWithEnglish(STEAM_LANGS);

    // 2) fetch achievements -> fallback schema
    const perLangByApi = {};
    for (const lang of langsToFetch) {
      let map = null;
      try {
        map = await fetchAchievementsLang(appid, apiKey, lang);
      } catch {
        map = null;
      }
      if (map && map.size) {
        perLangByApi[lang] = map;
      } else {
        emit("info", "steam-achievements:fallback-schema", { appid, lang });
        try {
          map = await fetchSchemaLang(appid, apiKey, lang);
        } catch {
          map = null;
        }
        perLangByApi[lang] = map || new Map();
      }
      if (STEAM_API_GAP_MS > 0) {
        await sleep(STEAM_API_GAP_MS);
      }
    }

    // 3) take EN
    let enMap = perLangByApi["english"];
    if (!enMap || enMap.size === 0) {
      // fallback: all langs
      const keys = new Set();
      for (const m of Object.values(perLangByApi))
        for (const k of m.keys()) keys.add(k);
      enMap = new Map(Array.from(keys).map((k) => [k, {}]));
    }

    for (const [apiName, enEntry] of enMap.entries()) {
      // --- API ---
      const displayName = {};
      const description = {};
      let hidden = 0;

      displayName.english = enEntry?.displayName || "";
      description.english = enEntry?.description || "";
      if (enEntry?.hidden) hidden = 1;

      for (const lang of langsToFetch) {
        if (lang === "english") continue;
        const entry = perLangByApi[lang]?.get(apiName);
        if (entry?.displayName) displayName[lang] = entry.displayName;
        if (entry?.description) description[lang] = entry.description;
        if (entry?.hidden) hidden = 1;
      }

      // --- API Images ---
      let iconUrl = enEntry?.icon || "";
      let iconGrayUrl = enEntry?.icongray || "";
      if (!iconUrl || !iconGrayUrl) {
        for (const lang of langsToFetch) {
          const entry = perLangByApi[lang]?.get(apiName);
          if (!iconUrl && entry?.icon) iconUrl = entry.icon;
          if (!iconGrayUrl && entry?.icongray) iconGrayUrl = entry.icongray;
          if (iconUrl && iconGrayUrl) break;
        }
      }

      // --- download images ---
      let iconRel = "",
        iconGrayRel = "";
      if (iconUrl) {
        const baseName =
          sanitize(
            path.basename(new URL(iconUrl).pathname).replace(/\.[^.]+$/, "")
          ) || sanitize(apiName + "_icon");
        const file = `${baseName}${extFromUrl(iconUrl)}`;
        await download(iconUrl, path.join(imgDir, file));
        iconRel = `img/${file}`;
      }
      if (iconGrayUrl) {
        const baseName =
          sanitize(
            path.basename(new URL(iconGrayUrl).pathname).replace(/\.[^.]+$/, "")
          ) || sanitize(apiName + "_gray");
        const file = `${baseName}${extFromUrl(iconGrayUrl)}`;
        await download(iconGrayUrl, path.join(imgDir, file));
        iconGrayRel = `img/${file}`;
      }

      achievements.push({
        hidden,
        displayName,
        description,
        icon: iconRel,
        icon_gray: iconGrayRel,
        name: apiName,
      });
    }
    if (achievements.length === 0) {
      achievements.push(...(await buildAchievementsFromScrape(appid, imgDir)));
    }
  } else {
    // ===== STEAMDB-ONLY =====
    achievements.push(...(await buildAchievementsFromScrape(appid, imgDir)));
  }

  const gogCredentialsReady =
    fsSync.existsSync(GOG_TOKENS_FILE) || (GOG_USER && GOG_PASS);
  if (achievements.length === 0 && gogCredentialsReady) {
    try {
      return await processGogApp(folderId, outBaseDir);
    } catch (err) {
      warn(`[${folderId}] GOG fallback failed`, {
        appid: folderId,
        error: err?.message || String(err),
      });
    }
  }

  // 3) write JSON file
  await fs.mkdir(outDir, { recursive: true });
  const finalAchievements = achievements.map((ach) => ({
    ...ach,
    name: normalizeAchievementName(ach.name, strip),
  }));
  await fs.writeFile(
    path.join(outDir, "achievements.json"),
    JSON.stringify(finalAchievements, null, 2),
    "utf8"
  );

  const count = finalAchievements.length;

  if (count === 0) {
    emit(
      "info",
      `⏭ [${folderId}] Achievements schema skipped. No Achievements found!`
    );
  } else {
    emit("info", `✅ [${folderId}] Achievements schema done.`);
  }

  //console.log(`✔ [${appid}] ${count} achievements -> ${path.join(outDir, 'achievements.json')}`);
  return { outDir, count };
}

/* ---------- MAIN (multi-APPID) ---------- */
(async () => {
  try {
    const apiKey = await readApiKey();
    emit(
      "info",
      apiKey
        ? "ℹ Steam API key loaded"
        : "ℹ Steam API key not found. Running in SteamDB/SteamHunters mode. (English only)"
    );

    await Promise.all(
      resolvedAppIds.map((meta) =>
        appLimit(() => processOneApp(meta, apiKey, OUT_BASE))
      )
    );
  } catch (e) {
    emit("error", String(e?.message || e));
    process.exit(1);
  }
})();
