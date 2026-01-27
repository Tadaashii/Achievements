const fs = require("fs");
const path = require("path");

function readFile(p) {
  return fs.readFileSync(p);
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function decodeXml(s) {
  return (s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTag(xmlFragment, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xmlFragment.match(re);
  return m ? decodeXml(m[1].trim()) : "";
}

function parseTropconfSfm(xmlText) {
  const getTag = (tag) => {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = xmlText.match(re);
    return m ? decodeXml(m[1].trim()) : "";
  };

  const trophies = [];
  const trophyRe = /<trophy\b([^>]*)>([\s\S]*?)<\/trophy>/gi;
  let m;
  while ((m = trophyRe.exec(xmlText)) !== null) {
    const attrs = m[1] || "";
    const body = m[2] || "";

    const idMatch = attrs.match(/\bid\s*=\s*"(\d+)"/i);
    if (!idMatch) continue;

    const id = parseInt(idMatch[1], 10);
    const ttypeMatch = attrs.match(/\bttype\s*=\s*"([^"]+)"/i);
    const hiddenMatch = attrs.match(/\bhidden\s*=\s*"([^"]+)"/i);

    trophies.push({
      id,
      ttype: (ttypeMatch ? ttypeMatch[1] : "").trim(),
      hidden: (hiddenMatch ? hiddenMatch[1] : "").trim(),
      name: extractTag(body, "name"),
      detail: extractTag(body, "detail"),
    });
  }

  trophies.sort((a, b) => a.id - b.id);

  return {
    titleName: getTag("title-name"),
    titleDetail: getTag("title-detail"),
    npcommid: getTag("npcommid"),
    trophies,
  };
}

function ttypeToLabel(ttype) {
  const t = (ttype || "").toUpperCase();
  if (t === "P") return "platinum";
  if (t === "G") return "gold";
  if (t === "S") return "silver";
  if (t === "B") return "bronze";
  return t || "unknown";
}

function parseHiddenFlag(v) {
  const s = String(v || "").toLowerCase().trim();
  return s === "yes" || s === "true" || s === "1";
}

function parseTropusrDatAuto(buf, trophyCountFromConf) {
  const L = buf.length;
  const u32 = (off) => (off + 4 <= L ? buf.readUInt32BE(off) : null);

  const headerBytes = Math.min(0x600, L);
  const vals = [];
  for (let off = 0; off < headerBytes; off += 4) vals.push(u32(off));

  const candidates = [];
  for (let i = 0; i + 5 < vals.length; i++) {
    const type = vals[i];
    if (type !== 6) continue;

    const entrySize = vals[i + 1];
    const count = vals[i + 3];
    const baseOffset = vals[i + 5];

    if (!entrySize || entrySize < 0x10 || entrySize > 0x400) continue;
    if (!count || count < 1 || count > 5000) continue;
    if (!baseOffset || baseOffset >= L) continue;

    const stride = entrySize + 0x10;
    candidates.push({ entrySize, count, baseOffset, stride, descriptorIndex: i });
  }

  if (!candidates.length) {
    throw new Error(
      "No valid type=6 descriptor found in TROPUSR.DAT header. Layout may differ or file may be truncated."
    );
  }

  const idOffsetsToTry = [0x10, 0x00, 0x08, 0x14, 0x0c];
  const wantCount = trophyCountFromConf ?? null;

  function scoreCandidate(c) {
    let best = { score: -1, idOff: null, binLike: 0, idMatch: 0 };
    const n = wantCount ? Math.min(wantCount, c.count) : Math.min(96, c.count);

    for (const idOff of idOffsetsToTry) {
      let idMatch = 0;
      let binLike = 0;
      let checked = 0;

      for (let tid = 0; tid < n; tid++) {
        const entry = c.baseOffset + tid * c.stride;
        const idPos = entry + idOff;
        const flagPos = idPos + 4;

        if (flagPos + 4 > L) break;

        const trophyId = u32(idPos);
        const flag = u32(flagPos);

        if (trophyId === tid) idMatch++;
        if (flag === 0 || flag === 1) binLike++;
        checked++;
      }

      const score = idMatch * 10 + binLike;

      if (score > best.score) best = { score, idOff, binLike, idMatch, checked };
    }

    return best;
  }

  let chosen = null;
  let chosenIdOff = null;
  let chosenScore = -1;
  let chosenMeta = null;

  for (const c of candidates) {
    const s = scoreCandidate(c);
    if (s.score > chosenScore) {
      chosen = c;
      chosenIdOff = s.idOff;
      chosenScore = s.score;
      chosenMeta = s;
    }
  }

  if (!chosen || chosenIdOff == null) {
    throw new Error("Could not validate any candidate layout for trophyId/flag positions.");
  }

  if (chosenMeta && chosenMeta.idMatch === 0) {
    console.warn(
      "[WARN] Could not validate trophyId==index. Proceeding with detected offsets, but results may be unreliable for this set."
    );
  }

  const count = wantCount ? Math.min(wantCount, chosen.count) : chosen.count;
  const unlockMap = new Map();

  for (let tid = 0; tid < count; tid++) {
    const entry = chosen.baseOffset + tid * chosen.stride;
    const idPos = entry + chosenIdOff;
    const flagPos = idPos + 4;

    if (flagPos + 4 > L) break;

    const trophyId = u32(idPos);
    const flag = u32(flagPos);

    unlockMap.set(trophyId, { unlocked: flag === 1 });
  }

  return {
    layout: {
      entrySize: chosen.entrySize,
      stride: chosen.stride,
      baseOffset: chosen.baseOffset,
      countInUsr: chosen.count,
      idOffset: chosenIdOff,
      flagOffset: chosenIdOff + 4,
      descriptorIndex: chosen.descriptorIndex,
    },
    unlockMap,
  };
}

function buildIconIndex(dir) {
  const iconFiles = new Map();
  let fallbackIconName = "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name;
      const lower = name.toLowerCase();
      if (lower === "icon0.png") {
        fallbackIconName = name;
        continue;
      }
      const m = lower.match(/^trop(\d{3})\.png$/);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      if (Number.isFinite(id)) iconFiles.set(id, name);
    }
  } catch {}
  return { iconFiles, fallbackIconName };
}

function parseTrophySetDir(trophyDir) {
  const confPath = path.join(trophyDir, "TROPCONF.SFM");
  const usrPath = path.join(trophyDir, "TROPUSR.DAT");
  if (!fs.existsSync(confPath)) {
    throw new Error(`Missing TROPCONF.SFM: ${confPath}`);
  }
  if (!fs.existsSync(usrPath)) {
    throw new Error(`Missing TROPUSR.DAT: ${usrPath}`);
  }

  const conf = parseTropconfSfm(readText(confPath));
  const usrBuf = readFile(usrPath);
  const { layout, unlockMap } = parseTropusrDatAuto(usrBuf, conf.trophies.length);
  const { iconFiles, fallbackIconName } = buildIconIndex(trophyDir);
  const appid = path.basename(trophyDir);
  const title = conf.titleName || appid;

  return {
    appid,
    title,
    titleDetail: conf.titleDetail,
    npcommid: conf.npcommid,
    trophies: conf.trophies,
    unlockMap,
    layout,
    iconFiles,
    fallbackIconName,
    trophyDir,
  };
}

function buildSnapshotFromTrophy(parsed) {
  const out = {};
  const list = Array.isArray(parsed?.trophies) ? parsed.trophies : [];
  for (const t of list) {
    const key = String(t.id);
    const state = parsed?.unlockMap?.get(t.id) || { unlocked: false };
    out[key] = {
      earned: !!state.unlocked,
      earned_time: 0,
    };
  }
  return out;
}

function buildSchemaFromTrophy(parsed) {
  const entries = [];
  const list = Array.isArray(parsed?.trophies) ? parsed.trophies : [];

  for (const t of list) {
    const name = String(t.id);
    const displayName = t.name || name;
    const description = t.detail || "";
    const hidden = parseHiddenFlag(t.hidden) ? 1 : 0;
    const trophyType = ttypeToLabel(t.ttype);

    entries.push({
      name,
      displayName: { english: displayName },
      description: { english: description },
      icon: "",
      icon_gray: "",
      hidden,
      trophyType,
      imageId: t.id,
    });
  }

  return entries;
}

module.exports = {
  parseTropconfSfm,
  parseTropusrDatAuto,
  parseTrophySetDir,
  buildSnapshotFromTrophy,
  buildSchemaFromTrophy,
  ttypeToLabel,
  parseHiddenFlag,
};
