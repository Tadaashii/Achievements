// steamdb-cover.js
const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright-core");
const CDN_BASE = "https://shared.fastly.steamstatic.com";

const NOT_FOUND_TAG = Symbol.for("steamdb-miss");

const headed = false;

function markNotFound(err, message) {
  const e = err instanceof Error ? err : new Error(message || String(err));
  e.tag = NOT_FOUND_TAG;
  return e;
}

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

function normalizeSteamDbRel(appid, relOrAbs) {
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const clean = relOrAbs
    .replace(/^\//, "")
    .replace(/^store_item_assets\/steam\/apps\/\d+\//i, "");
  return `${CDN_BASE}/store_item_assets/steam/apps/${appid}/${clean}`;
}

async function fetchSteamDbLibraryCover(appid) {
  const url = `https://steamdb.info/app/${appid}/info/`;
  const browser = await launchChromiumSafe({ headless: true });

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

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);

    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!res || !res.ok())
      throw markNotFound(null, `HTTP ${res?.status?.() ?? "??"}`);

    await page
      .waitForSelector('a.image-hover, a[href*="library_600x900.jpg"]', {
        timeout: 5000,
      })
      .catch(() => {});

    const found = await page.evaluate(() => {
      const isLib = (s) => /library_600x900\.jpg/i.test(s || "");
      const anchors = Array.from(
        document.querySelectorAll(
          'a.image-hover, a[href*="library_600x900.jpg"]'
        )
      );
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (isLib(href)) return href.split("?")[0];
        const txt = (a.textContent || "").trim();
        if (isLib(txt)) return txt.split("?")[0].replace(/^\/+/, "");
      }
      const html = document.documentElement.innerHTML;
      const abs = html.match(/https?:\/\/[^"'<\s]*library_600x900\.jpg/i);
      if (abs) return abs[0].split("?")[0];
      const rel = html.match(
        /store_item_assets\/steam\/apps\/\d+\/[^"'<\s]*\/library_600x900\.jpg/i
      );
      if (rel) return rel[0].replace(/^\/+/, "");
      return "";
    });

    if (!found) throw markNotFound(null, "cover missing");
    return normalizeSteamDbRel(appid, found);
  } catch (err) {
    throw markNotFound(err);
  } finally {
    await browser.close();
  }
}

module.exports = { fetchSteamDbLibraryCover, NOT_FOUND_TAG };
