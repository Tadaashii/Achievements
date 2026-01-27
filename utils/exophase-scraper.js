const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function resolvePlaywrightBrowsersPath() {
  const current = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
  if (current && current !== "0") return current;
  const resourcesRoot = process.resourcesPath;
  if (resourcesRoot) {
    const candidate = path.join(resourcesRoot, "playwright-browsers");
    if (fs.existsSync(candidate)) return candidate;
  }
  return current || "0";
}

process.env.PLAYWRIGHT_BROWSERS_PATH = resolvePlaywrightBrowsersPath();
const { chromium } = require("playwright");

const DEFAULT_WAIT_MS = 30000;
const BASE_EXOPHASE_URL = "https://www.exophase.com/game/";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";

const EXOPHASE_PLATFORM_MAP = {
  xenia: "xbox-360",
  rpcs3: "ps3",
};

const EXOPHASE_LANG_MAP = {
  english: "us",
  german: "de",
  french: "fr",
  italian: "it",
  spanish: "es",
  latam: "es_MX",
  portuguese: "pt",
  brazilian: "pt_BR",
  russian: "ru",
  polish: "pl",
  japanese: "jp",
  koreana: "ko",
  tchinese: "zh_TW",
  schinese: "zh_CN",
  thai: "th",
  danish: "dk",
  dutch: "nl",
  swedish: "se",
  hungarian: "hu",
  turkish: "tr",
  ukrainian: "uk",
  vietnamese: "vi",
};

const EXOPHASE_LANG_KEYS = [
  "english",
  "german",
  "french",
  "italian",
  "spanish",
  "latam",
  "portuguese",
  "brazilian",
  "russian",
  "polish",
  "japanese",
  "koreana",
  "tchinese",
  "schinese",
  "thai",
  "danish",
  "dutch",
  "swedish",
  "hungarian",
  "turkish",
  "ukrainian",
  "vietnamese",
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function launchChromiumSafe(opts = {}) {
  const baseArgs = ["--disable-blink-features=AutomationControlled"];
  try {
    return await chromium.launch({
      headless: true,
      args: baseArgs,
      ...opts,
    });
  } catch (firstErr) {
    // Fallback: retry without extra options
    return await chromium.launch({ headless: true, args: baseArgs });
  }
}

function mapExophasePlatform(platform) {
  const key = String(platform || "").trim().toLowerCase();
  if (!key) return "";
  return EXOPHASE_PLATFORM_MAP[key] || key;
}

function buildExophaseSlug(input) {
  const raw = String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]s\b/g, " s")
    .replace(/['\u2019]/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw || "game";
}

const ROMAN_NUMERAL_MAP = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
  xi: "11",
  xii: "12",
  xiii: "13",
  xiv: "14",
  xv: "15",
  xvi: "16",
  xvii: "17",
  xviii: "18",
  xix: "19",
  xx: "20",
};

function replaceRomanNumerals(input) {
  return String(input || "").replace(/\b[ivxlcdm]+\b/g, (match) => {
    const key = match.toLowerCase();
    return ROMAN_NUMERAL_MAP[key] || match;
  });
}

function slugify(input) {
  const raw = String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw || "game";
}

function buildExophaseSlugVariants(input) {
  const base = String(input || "").trim();
  if (!base) return ["game"];
  const normalized = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const lower = normalized.toLowerCase();

  const variants = new Set();
  variants.add(buildExophaseSlug(base));

  const apostropheVariant = slugify(lower.replace(/['\u2019]s\b/g, " s"));
  variants.add(apostropheVariant);

  const romanVariant = slugify(replaceRomanNumerals(lower));
  variants.add(romanVariant);

  const comboVariant = slugify(
    replaceRomanNumerals(lower.replace(/['\u2019]s\b/g, " s")),
  );
  variants.add(comboVariant);

  const noApos = lower.replace(/['\u2019]/g, "");
  variants.add(slugify(noApos));
  variants.add(slugify(replaceRomanNumerals(noApos)));

  return Array.from(variants).filter(Boolean);
}

function ensureLangUrl(baseUrl, code) {
  let u = baseUrl;
  if (!u.endsWith("/")) u += "/";
  u = u.replace(/\/achievements\/[^/]+\/$/i, "/achievements/");
  u = u.replace(/\/trophies\/[^/]+\/$/i, "/trophies/");
  return u + encodeURIComponent(code) + "/";
}

function isAdHost(host) {
  const h = (host || "").toLowerCase();
  return (
    h.includes("doubleclick") ||
    h.includes("googlesyndication") ||
    h.includes("googleadservices") ||
    h.includes("adservice") ||
    h.includes("adsystem") ||
    h.includes("adnxs") ||
    h.includes("taboola") ||
    h.includes("outbrain") ||
    h.includes("criteo") ||
    h.includes("pubmatic") ||
    h.includes("rubiconproject") ||
    h.includes("openx") ||
    h.includes("mgid") ||
    h.includes("zedo") ||
    h.includes("scorecardresearch") ||
    h.includes("quantserve")
  );
}

async function installAdBlockRouting(context) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();

    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}

    if (type === "document") return route.continue();
    if (host && isAdHost(host)) return route.abort();
    if (type === "frame" && host && !host.endsWith("exophase.com"))
      return route.abort();
    if (type === "media" || type === "font") return route.abort();
    if (type === "image" && host && !host.endsWith("exophase.com"))
      return route.abort();

    return route.continue();
  });
}

async function nukeOverlays(page) {
  await page.evaluate(() => {
    const killSelectors = [
      "iframe",
      ".adsbygoogle",
      "[id*='ad' i]",
      "[class*='ad' i]",
      "[id*='ads' i]",
      "[class*='ads' i]",
      "[class*='overlay' i]",
      "[id*='overlay' i]",
      "[class*='modal' i]",
      "[id*='modal' i]",
    ];

    for (const sel of killSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const st = window.getComputedStyle(el);
        const zi = parseInt(st.zIndex || "0", 10);
        const pos = st.position;
        if (pos === "fixed" || pos === "sticky" || zi >= 1000) el.remove();
      });
    }

    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
  });
}

async function looksBlocked(page) {
  try {
    const html = (await page.content()).toLowerCase();
    if (
      html.includes("error 403") ||
      html.includes("access denied") ||
      html.includes("request blocked")
    )
      return true;
    if (html.includes("attention required") && html.includes("cloudflare"))
      return true;
  } catch {}
  return false;
}

async function loadAwardsPage(page, url) {
  const resp = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: DEFAULT_WAIT_MS,
  });
  await page.waitForTimeout(800);
  await nukeOverlays(page);

  const status = resp ? resp.status() : 0;
  if (status === 403 || (await looksBlocked(page))) {
    throw new Error(`Blocked (status=${status || "unknown"})`);
  }

  await page.waitForSelector("[class*=award-detail]", {
    timeout: 15000,
  });
}

async function extractAchievements(page, baseUrl) {
  return await page.evaluate((baseUrlInner) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const abs = (u) => {
      try {
        return new URL(u, baseUrlInner).toString();
      } catch {
        return u;
      }
    };

    // New selectors match Exophase layout:
    //   title: [class*=award-detail] > [class*=award-title]
    //   description: [class*=award-detail] > [class*=award-description]
    //   image: [class*=award-image]
    const details = Array.from(
      document.querySelectorAll("[class*=award-detail]")
    );
    const items = [];

    details.forEach((detail, idx) => {
      const titleEl = detail.querySelector("[class*=award-title]");
      const descEl = detail.querySelector("[class*=award-description]");
      const card =
        detail.closest("li") ||
        detail.closest("[class*=award]") ||
        detail.parentElement;
      const imgEl = card
        ? card.querySelector("[class*=award-image] img, [class*=award-image]")
        : null;

      const title = clean(titleEl?.textContent || "");
      if (!title) return;

      const description = clean(descEl?.textContent || "");

      let iconUrl = "";
      if (imgEl) {
        if (imgEl.getAttribute("src")) {
          iconUrl = abs(imgEl.getAttribute("src"));
        } else {
          const st = window.getComputedStyle(imgEl);
          const bg = st.backgroundImage || "";
          const m = bg.match(/url\(["']?(.*?)["']?\)/i);
          if (m && m[1]) iconUrl = abs(m[1]);
        }
      }

      items.push({
        index: idx + 1,
        title,
        description,
        icon_url: iconUrl,
      });
    });

    return items;
  }, baseUrl);
}

async function downloadExophaseIcon(iconUrl, outPath) {
  if (!iconUrl || !outPath) return false;
  try {
    const resp = await fetch(iconUrl);
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, buf);
    return true;
  } catch {
    return false;
  }
}

async function fetchExophaseAchievementsMultiLang(options = {}) {
  const platform = mapExophasePlatform(options.platform || "");
  if (!platform) {
    throw new Error("Missing platform for Exophase");
  }
  const slugCandidates =
    options.slugCandidates ||
    [options.slug || buildExophaseSlug(options.title || "")];

  const langMap = options.langMap || EXOPHASE_LANG_MAP;
  const langKeysRaw = options.langKeys || EXOPHASE_LANG_KEYS;
  const langKeys = langKeysRaw.filter((k) => langMap[k]);
  if (!langKeys.includes("english")) langKeys.unshift("english");

  const baseUrlTemplate = `${BASE_EXOPHASE_URL}__SLUG__/__PATH__/`;
  const headed = options.headed === true;
  const logger = options.logger || null;
  const storageState = options.storageState;

  const browser = await launchChromiumSafe({ headless: !headed });
  const ctxOpts = {
    userAgent: options.userAgent || DEFAULT_UA,
    locale: "en-US",
    viewport: { width: 1400, height: 1000 },
  };
  if (storageState && fs.existsSync(storageState)) {
    ctxOpts.storageState = storageState;
  }
  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    } catch {}
  });
  await installAdBlockRouting(context);
  const page = await context.newPage();

  try {
    let baseUrl = null;
    let firstErr = null;
    for (const slug of slugCandidates) {
      const candidateBase =
        platform === "ps3"
          ? `${BASE_EXOPHASE_URL}${slug}/trophies/`
          : `${BASE_EXOPHASE_URL}${slug}-${platform}/achievements/`;
      const testUrl = ensureLangUrl(candidateBase, langMap.english);
      try {
        await loadAwardsPage(page, testUrl);
        baseUrl = candidateBase;
        break;
      } catch (err) {
        firstErr = firstErr || err;
        continue;
      }
    }
    if (!baseUrl) {
      throw firstErr || new Error("No working Exophase URL");
    }

    const englishUrl = ensureLangUrl(baseUrl, langMap.english);
    await loadAwardsPage(page, englishUrl);

    const gameTitle =
      (await page
        .locator("h1, h2")
        .first()
        .textContent()
        .catch(() => "")) || "";
    const baseItems = await extractAchievements(page, englishUrl);
    if (!baseItems.length) {
      throw new Error("No achievements extracted for english baseline.");
    }

    const achievements = baseItems.map((it) => ({
      index: it.index,
      titles: { english: it.title },
      descriptions: { english: it.description },
      icon_url: it.icon_url || "",
    }));

    for (const langKey of langKeys) {
      if (langKey === "english") continue;
      const exoCode = langMap[langKey];
      if (!exoCode) continue;
      const langUrl = ensureLangUrl(baseUrl, exoCode);
      if (logger) {
        logger.info("exophase:lang:load", { lang: langKey, url: langUrl });
      }
      await loadAwardsPage(page, langUrl);
      const items = await extractAchievements(page, langUrl);
      if (!items.length) {
        if (logger) {
          logger.warn("exophase:lang:empty", { lang: langKey, url: langUrl });
        }
        continue;
      }
      if (items.length !== achievements.length && logger) {
        logger.warn("exophase:lang:mismatch", {
          lang: langKey,
          got: items.length,
          expected: achievements.length,
        });
      }
      const min = Math.min(items.length, achievements.length);
      for (let i = 0; i < min; i += 1) {
        achievements[i].titles[langKey] = items[i].title;
        achievements[i].descriptions[langKey] = items[i].description;
      }
    }

    return {
      baseUrl,
      gameTitle: String(gameTitle || "").trim(),
      items: achievements,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  EXOPHASE_LANG_KEYS,
  EXOPHASE_LANG_MAP,
  mapExophasePlatform,
  buildExophaseSlug,
  buildExophaseSlugVariants,
  fetchExophaseAchievementsMultiLang,
  downloadExophaseIcon,
};
