// generate_achievements_schema.js
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');


// --- bridge log/IPC (Electron main) ---
const HAS_IPC = typeof process.send === 'function';
function emit(level, message, data = {}) {
    if (HAS_IPC) {
        try { process.send({ type: 'achgen:log', level, message, ...data }); } catch { }
    }
    const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
            : console.log;
    fn(message);
}
const info = (m, d) => emit('info', m, d);
const warn = (m, d) => emit('warn', m, d);
const error = (m, d) => emit('error', m, d);


/* ---------- CLI ---------- */
function getFlag(name, def = null) {
    const hit = process.argv.find(a => a.startsWith(name + '='));
    return hit ? hit.split('=').slice(1).join('=') : def;
}
const ARGS = process.argv.slice(2);
const APPIDS = ARGS.filter(a => /^\d+$/.test(a));
const headed = ARGS.includes('--headed');
const verbose = ARGS.includes('--verbose');
const langsArg = getFlag('--langs', null);
const appsConcurrency = parseInt(getFlag('--apps-concurrency', '1'), 10);
const inlineKey = (getFlag('--key', '') || '').trim();
// <out>/<appid>
const OUT_BASE = getFlag('--out', null);
const USERDATA_DIR = getFlag('--user-data-dir', '');

if (!APPIDS.length) {
    console.error('Usage: node generate_achievements_schema.js <APPID...> [--headed] [--verbose] [--apps-concurrency=2] [--langs=english,german,...] [--key=XXXXX] [--out=ABS_OR_REL_PATH]');
    process.exit(1);
}

/* ---------- langs ---------- */
const DEFAULT_LANGS = [
    'english', 'german', 'french', 'italian', 'spanish', 'brazilian',
    'russian', 'polish', 'japanese', 'koreana', 'tchinese', 'schinese', 'LATAM'
];
const LANGS = (langsArg ? langsArg.split(',') : DEFAULT_LANGS).map(s => s.trim()).filter(Boolean);

/* ---------- utils ---------- */
function log(...a) {
    if (!verbose) return;
    const message = a.map(x => String(x)).join(' ');
    emit('info', message);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeText(s) { return (s || '').replace(/\u00A0/g, ' ').trim(); }
function sanitize(name) { return (name || '').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'ach'; }
function toAbs(base, u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    try { return new URL(u, base).toString(); } catch { return ''; }
}
function takeFromSrcset(srcset) {
    if (!srcset) return '';
    const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return '';
    const parsed = parts.map(p => {
        const m = p.match(/(\S+)\s+(\d+(\.\d+)?x|\d+w)$/i);
        return m ? { url: m[1], dens: parseFloat((m[2] || '1').replace(/[^\d.]/g, '')) || 1 } : { url: p.split(/\s+/)[0], dens: 1 };
    }).sort((a, b) => b.dens - a.dens);
    return parsed[0].url;
}
function extFromUrl(u) {
    try { const p = new URL(u).pathname; const m = p.match(/\.([a-z0-9]+)$/i); return m ? '.' + m[1].toLowerCase() : '.jpg'; }
    catch { return '.jpg'; }
}

async function download(url, dest, ms = 20000) {
    if (!url) return false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url.replace(/^http:/, 'https:'), { signal: ctrl.signal });
        if (!r.ok) return false;
        const ab = await r.arrayBuffer();
        await fs.writeFile(dest, Buffer.from(ab));
        return true;
    } finally { clearTimeout(t); }
}

function normalizeHidden(descEN) {
  if (!descEN) return { hidden: 0, clean: '' };

  let s = String(descEN).replace(/\u00A0/g, ' ').trim();
  let hidden = 0;

  // SteamDB: "Hidden achievement:"
  if (/^\s*Hidden achievement:/i.test(s)) {
    hidden = 1;
    s = s.replace(/^\s*Hidden achievement:\s*/i, '').trim();
  }

  // SteamHunters: "This achievement is hidden."
  else if (/^\s*This achievement is hidden\.\s*/i.test(s)) {
    hidden = 1;
    s = s.replace(/^\s*This achievement is hidden\.\s*/i, '').trim();
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
        Promise.resolve().then(fn)
            .then(v => { active--; resolve(v); run(); })
            .catch(e => { active--; reject(e); run(); });
    };
    return fn => new Promise((res, rej) => { q.push({ fn, resolve: res, reject: rej }); run(); });
}
const appLimit = createLimiter(appsConcurrency);

async function launchChromiumSafe(opts = {}) {
    const baseArgs = ['--disable-blink-features=AutomationControlled'];
    try {
        return await chromium.launch({ headless: !headed, args: baseArgs, ...opts });
    } catch (firstErr) {
        const unAsar = p => p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');

        const roots = [];

        for (const pkg of ['playwright-core', 'playwright']) {
            try {
                const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
                const rootA = path.join(pkgDir, '.local-browsers');
                const rootB = unAsar(rootA);
                roots.push(rootA, rootB);
            } catch { }
        }

        if (process.resourcesPath) {
            roots.push(
                path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright-core', '.local-browsers'),
                path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright', '.local-browsers'),
                path.join(process.resourcesPath, 'playwright-browsers')
            );
        }

        const exeCandidates = [];
        for (const root of roots) {
            const dirs = await fs.readdir(root).catch(() => []);
            for (const d of dirs) {
                if (/^chromium_headless_shell-/i.test(d)) {
                    exeCandidates.push(path.join(root, d, 'chrome-win', 'headless_shell.exe'));
                }
                if (/^chromium-/i.test(d)) {
                    exeCandidates.push(path.join(root, d, 'chrome-win', 'chrome.exe'));
                }
            }
        }

        for (const exe of exeCandidates) {
            try {
                await fs.access(exe);
                // if (verbose) emit('info', `[achgen] Using Chromium: ${exe}`);
                return await chromium.launch({ executablePath: exe, headless: !headed, args: baseArgs, ...opts });
            } catch { }
        }

        throw firstErr;
    }
}




/* ---------- Steam Web API ---------- */
async function readApiKey() {
    if (inlineKey) return inlineKey;
    const candidates = [
        path.join(__dirname, 'my_login.txt'),
        ...(USERDATA_DIR ? [path.join(USERDATA_DIR, 'my_login.txt')] : []),
    ];
    //emit('info', 'Look for my_login.txt');

    for (const fp of candidates) {
        try {
            const txt = await fs.readFile(fp, 'utf8');
            const line = txt.split(/\r?\n/).find(l => /^\s*(key|apikey|steam_api_key)\s*=/i.test(l)); // <— /i
            if (line) {
                const val = line.split('=').slice(1).join('=').trim();
                if (val) {
                    //emit('info', `Steam API key loaded`);
                    return val;
                }
            }
        } catch { }
    }
    //emit('warn', 'Steam API key not found. Running in SteamDB/SteamHunters mode. (English only)');
    return '';
}
async function fetchSchemaLang(appid, key, lang) {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appid)}&l=${encodeURIComponent(lang)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Steam API ${appid} ${lang} HTTP ${r.status}`);
    const j = await r.json().catch(() => ({}));
    const list = j?.game?.availableGameStats?.achievements || [];
    const map = new Map();
    for (const a of list) {
        if (!a || !a.name) continue;
        map.set(a.name, {
            displayName: a.displayName || '',
            description: a.description || '',
            hidden: Number(a.hidden) ? 1 : 0,
            icon: a.icon || '',
            icongray: a.icongray || ''
        });
    }
    return map;
}


/* ---------- Scraping SteamDB ---------- */
async function scrapeSteamDB(appid) {
    const url = `https://steamdb.info/app/${appid}/stats/`;
    log(`[${appid}] open`, url);

    const browser = await launchChromiumSafe({ headless: !headed, args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
        viewport: { width: 1400, height: 1000 }
    });

    await ctx.route('**/*', route => {
        const u = route.request().url();
        if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
        route.continue();
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const list = page.locator('[id^="achievement-"]');
    await list.first().waitFor({ state: 'visible' }).catch(() => { });
    const count = await list.count();
    if (!count) { await browser.close(); throw new Error('No achievements found'); }
    log(`[${appid}] achievements: ${count}`);

    for (let i = 0; i < count; i++) {
        await list.nth(i).scrollIntoViewIfNeeded().catch(() => { });
        await sleep(12);
    }

    async function extractImgUrl(el, sel, baseUrl) {
        const img = el.locator(sel).first();
        if (await img.count() === 0) return '';
        let url = await img.getAttribute('src').catch(() => null);
        if (!url) {
            const [ds, dor, ss, dss] = await Promise.all([
                img.getAttribute('data-src').catch(() => null),
                img.getAttribute('data-original').catch(() => null),
                img.getAttribute('srcset').catch(() => null),
                img.getAttribute('data-srcset').catch(() => null)
            ]);
            url = ds || dor || takeFromSrcset(ss) || takeFromSrcset(dss) || '';
        }
        if (!url) {
            const source = el.locator(`${sel} ~ source, picture ${sel} source`).first();
            if (await source.count()) {
                const s1 = await source.getAttribute('srcset').catch(() => null);
                const s2 = await source.getAttribute('data-srcset').catch(() => null);
                url = takeFromSrcset(s1) || takeFromSrcset(s2) || '';
            }
        }
        return toAbs(baseUrl, url);
    }
    async function extractGrayUrl(el, baseUrl) {
        await el.hover().catch(() => { });
        const img = el.locator('div.achievement_checkmark > img').first();
        await img.waitFor({ state: 'attached' }).catch(() => { });
        let url = await img.getAttribute('src').catch(() => null);
        if (!url) {
            const [ds, dor, ss, dss] = await Promise.all([
                img.getAttribute('data-src').catch(() => null),
                img.getAttribute('data-original').catch(() => null),
                img.getAttribute('srcset').catch(() => null),
                img.getAttribute('data-srcset').catch(() => null)
            ]);
            url = ds || dor || takeFromSrcset(ss) || takeFromSrcset(dss) || '';
        }
        if (!url) {
            const dataName = await img.getAttribute('data-name').catch(() => null);
            if (dataName) url = `https://cdn.fastly.steamstatic.com/steamcommunity/public/images/apps/${appid}/${dataName}`;
        }
        if (!url) url = await img.evaluate(n => (n && (n.currentSrc || n.src)) || '').catch(() => '');
        return toAbs(baseUrl, url || '');
    }

    const rows = [];
    for (let i = 0; i < count; i++) {
        const el = list.nth(i);
        const id = await el.getAttribute('id').catch(() => null);
        if (!id || !id.startsWith('achievement-')) continue;

        const apiName = safeText(await el.locator('div.achievement_inner > div > div.achievement_right > div.achievement_api').textContent().catch(() => '')) || id.replace(/^achievement-/, '');
        const nameEN = safeText(await el.locator('div.achievement_inner > div > div:nth-child(1) > div.achievement_name').textContent().catch(() => '')) || '';
        const descEN0 = safeText(await el.locator('div.achievement_inner > div > div:nth-child(1) > div.achievement_desc').textContent().catch(() => '')) || '';
        const { hidden, clean: descEN } = normalizeHidden(descEN0);

        let iconUrl = await extractImgUrl(el, 'div.achievement_inner > img', url);
        if (!iconUrl) iconUrl = await extractImgUrl(el, '.achievement_inner picture img', url);
        let iconGrayUrl = await extractGrayUrl(el, url);

        rows.push({ apiName, nameEN, descEN, hidden, iconUrl, iconGrayUrl });
        if (verbose && (i % 10 === 0)) console.log(`[${appid}] scraped ${i + 1}/${count}`);
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
        args: ['--disable-blink-features=AutomationControlled']
    });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
        viewport: { width: 1400, height: 1000 }
    });

    await ctx.route('**/*', route => {
        const u = route.request().url();
        if (/\.(mp4|webm|gif|woff2?|ttf|otf)$/i.test(u)) return route.abort();
        route.continue();
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // a<href="/apps/<appid>/achievements/...">
    await page.waitForSelector('a[href*="/achievements/"][href*="/apps/"]', { timeout: 10000 }).catch(() => { });

    const rows = await page.$$eval('a[href*="/achievements/"][href*="/apps/"]', (links) => {
        const safeText = s => (s || '').replace(/\u00A0/g, ' ').trim();
        const takeFromSrcset = ss => {
            if (!ss) return '';
            const p = ss.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+/)[0]);
            return p[0] || '';
        };
        const abs = u => {
            if (!u) return '';
            if (/^https?:\/\//i.test(u)) return u;
            if (u.startsWith('//')) return 'https:' + u;
            try { return new URL(u, location.origin).toString(); } catch { return u; }
        };

        const out = [];
        for (const a of links) {
            const displayName = safeText(a.textContent);
            const row = a.closest('tr') || a.closest('li') || a.closest('div');

            const descEl = row && row.querySelector('p.small');
            const descEN = safeText(descEl ? descEl.textContent : '');

            // icon (<span class="image ..."><img ...>)
            const img = row && (row.querySelector('span.image img') || row.querySelector('img'));
            let iconUrl = '';
            if (img) {
                iconUrl = img.getAttribute('src')
                    || img.getAttribute('data-src')
                    || takeFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
                iconUrl = abs(iconUrl);
            }

            // API Name  title/data-original-title
            const span = row && row.querySelector('span.image');
            const title = (span && (span.getAttribute('title') || span.getAttribute('data-original-title'))) || '';
            let apiName = '';
            const m = /API Name:\s*([^\s<>"']+)/i.exec(title);
            if (m) apiName = m[1];

            out.push({
                apiName,
                nameEN: displayName,
                descEN,
                hidden: /^Hidden achievement:/i.test(descEN) ? 1 : 0,
                iconUrl,
                iconGrayUrl: '' // if not exists use icon
            });
        }

        // apiName (fallback on name)
        const seen = new Set(), uniq = [];
        for (const r of out) {
            const key = r.apiName || r.nameEN;
            if (seen.has(key)) continue;
            seen.add(key); uniq.push(r);
        }
        return uniq;
    });

    await browser.close();

    if (!rows.length) throw new Error('No achievements found (SteamHunters)');
    return rows;
}


function uniqueLangsWithEnglish(langs) {
    const s = new Set(langs || []);
    s.add('english');
    return Array.from(s);
}

/* ---------- Process ---------- */
async function processOneApp(appid, apiKey, outBaseDir) {
    // results
    const base = outBaseDir ? path.resolve(outBaseDir) : path.join(process.cwd(), '_OUTPUT');
    const outDir = path.join(base, String(appid));
    const imgDir = path.join(outDir, 'img');
    await fs.mkdir(imgDir, { recursive: true });

    const achievements = [];

    if (apiKey) {
        // ===== API-ONLY =====
        // 1) langs
        const langsToFetch = uniqueLangsWithEnglish(LANGS);

        // 2) fetch schema
        const perLangByApi = {};
        await Promise.all(langsToFetch.map(async (lang) => {
            try {
                perLangByApi[lang] = await fetchSchemaLang(appid, apiKey, lang);
            } catch (e) {
                emit('warn', `[${appid}] Steam API failed for ${lang}`, { appid, lang, error: String(e?.message || e) });
                perLangByApi[lang] = new Map();
            }
        }));

        // 3) take EN
        let enMap = perLangByApi['english'];
        if (!enMap || enMap.size === 0) {
            // fallback: all langs
            const keys = new Set();
            for (const m of Object.values(perLangByApi)) for (const k of m.keys()) keys.add(k);
            enMap = new Map(Array.from(keys).map(k => [k, {}]));
        }

        for (const [apiName, enEntry] of enMap.entries()) {
            // --- API ---
            const displayName = {};
            const description = {};
            let hidden = 0;

            displayName.english = enEntry?.displayName || '';
            description.english = enEntry?.description || '';
            if (enEntry?.hidden) hidden = 1;

            for (const lang of langsToFetch) {
                if (lang === 'english') continue;
                const entry = perLangByApi[lang]?.get(apiName);
                if (entry?.displayName) displayName[lang] = entry.displayName;
                if (entry?.description) description[lang] = entry.description;
                if (entry?.hidden) hidden = 1;
            }

            // --- API Images ---
            let iconUrl = enEntry?.icon || '';
            let iconGrayUrl = enEntry?.icongray || '';
            if (!iconUrl || !iconGrayUrl) {
                for (const lang of langsToFetch) {
                    const entry = perLangByApi[lang]?.get(apiName);
                    if (!iconUrl && entry?.icon) iconUrl = entry.icon;
                    if (!iconGrayUrl && entry?.icongray) iconGrayUrl = entry.icongray;
                    if (iconUrl && iconGrayUrl) break;
                }
            }

            // --- download images ---
            let iconRel = '', iconGrayRel = '';
            if (iconUrl) {
                const baseName = sanitize(path.basename(new URL(iconUrl).pathname).replace(/\.[^.]+$/, '')) || sanitize(apiName + '_icon');
                const file = `${baseName}${extFromUrl(iconUrl)}`;
                await download(iconUrl, path.join(imgDir, file));
                iconRel = `img/${file}`;
            }
            if (iconGrayUrl) {
                const baseName = sanitize(path.basename(new URL(iconGrayUrl).pathname).replace(/\.[^.]+$/, '')) || sanitize(apiName + '_gray');
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
                name: apiName
            });
        }

    } else {

        // ===== STEAMDB-ONLY =====
        // 1) scrape SteamDB => fallback SteamHunters
        let scraped = [];
        try {
            scraped = await scrapeSteamDB(appid);
        } catch (e) {
            warn(`[${appid}] SteamDB failed: ${String(e?.message || e)} -> trying SteamHunters`);
            try {
                scraped = await scrapeSteamHunters(appid);
            } catch (e2) {
                warn(`[${appid}] SteamHunters failed: ${String(e2?.message || e2)} -> continue`);
                scraped = [];
            }
        }

        // 2) Only English
        for (const a of scraped) {
            const enNorm = normalizeHidden(a.descEN || '');
            const hidden = enNorm.hidden ? 1 : (a.hidden ? 1 : 0);

            // take img from SteamDB/SteamHunters
            let iconRel = '', iconGrayRel = '';
            if (a.iconUrl) {
                const baseName = sanitize(path.basename(new URL(a.iconUrl).pathname).replace(/\.[^.]+$/, '')) || sanitize(a.apiName + '_icon');
                const file = `${baseName}${extFromUrl(a.iconUrl)}`;
                await download(a.iconUrl, path.join(imgDir, file));
                iconRel = `img/${file}`;
            }
            if (a.iconGrayUrl) {
                const baseName = sanitize(path.basename(new URL(a.iconGrayUrl).pathname).replace(/\.[^.]+$/, '')) || sanitize(a.apiName + '_gray');
                const file = `${baseName}${extFromUrl(a.iconGrayUrl)}`;
                await download(a.iconGrayUrl, path.join(imgDir, file));
                iconGrayRel = `img/${file}`;
            } else {
                // fallback: icon_gary is missing use icon
                iconGrayRel = iconRel;
            }

            achievements.push({
                hidden,
                displayName: { english: a.nameEN || '' },
                description: { english: enNorm.clean },
                icon: iconRel,
                icon_gray: iconGrayRel,
                name: a.apiName
            });
        }
    }

    // 3) write JSON file
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'achievements.json'), JSON.stringify(achievements, null, 2), 'utf8');

    const count = achievements.length;

    if (count === 0) {
        emit('info', `⏭ [${appid}] Achievements schema skipped. No Achievements found!`);
    } else {
        emit('info', `✅ [${appid}] Achievements schema done.`);
    }

    //console.log(`✔ [${appid}] ${count} achievements -> ${path.join(outDir, 'achievements.json')}`);
    return { outDir, count };
}


/* ---------- MAIN (multi-APPID) ---------- */
(async () => {
    try {
        const apiKey = await readApiKey();
        emit('info',
            apiKey
                ? 'ℹ Steam API key loaded'
                : 'ℹ Steam API key not found. Running in SteamDB/SteamHunters mode. (English only)'
        );

        await Promise.all(
            APPIDS.map(id => appLimit(() => processOneApp(id, apiKey, OUT_BASE)))
        );
    } catch (e) {
        emit('error', String(e?.message || e));
        process.exit(1);
    }
})();

