const fs = require('fs');
const path = require('path');
const https = require('https');
const { preferencesPath } = require('./utils/paths');

let playtimeStart = null;
let currentGame = null;

function notifyError(message) {
  console.error("❌", message);
  const { webContents } = require('electron');
  const allWindows = webContents.getAllWebContents();

  allWindows.forEach((wc) => {
    try {
      wc.send('notify', { message, color: '#f44336' });
    } catch (err) {
      console.error("💥 Failed to send notify to renderer:", err.message);
    }
  });
}

function sendPlaytimeNotification(playData) {
  const { ipcMain } = require('electron');
  ipcMain.emit('show-playtime', null, playData);
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      } else {
        fs.unlink(dest, () => {});
        const msg = `Failed to download image: ${response.statusCode}`;
        notifyError(msg);
        reject(new Error(msg));
      }
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      notifyError(`🛑 Download error: ${err.message}`);
      reject(err);
    });
  });
}

function cacheHeaderImage(appid, headerUrl) {
  try {
    const imageDir = path.join(process.env.APPDATA, 'Achievements', 'images', appid);
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });

    const headerPath = path.join(imageDir, 'header.jpg');
    const downloads = [];

    if (!fs.existsSync(headerPath)) {
      downloads.push(downloadImage(headerUrl, headerPath).catch(err => notifyError(err.message)));
    }

    return Promise.all(downloads).then(() => ({
      headerUrl: `file://${headerPath.replace(/\\/g, '/')}`
    }));
  } catch (err) {
    notifyError(`💥 Error caching header image: ${err.message}`);
    return Promise.resolve({ headerUrl });
  }
}

const { pathToFileURL } = require('url');

async function getProcessesSafe() {
  const tryPaths = [
    // 1) Build: UNPACKED
    path.join(process.resourcesPath, 'app.asar.unpacked', 'utils', 'pslist-wrapper.mjs'),
    // 2) Dev: from source
    path.join(__dirname, 'utils', 'pslist-wrapper.mjs'),
    // 3) (optional)
    path.join(process.resourcesPath, 'utils', 'pslist-wrapper.mjs'),
  ];

  let found = null;
  for (const p of tryPaths) {
    try {
      await fs.promises.access(p, fs.constants.R_OK);
      found = p;
      break;
    } catch { /* continue */ }
  }

  if (!found) {
    throw new Error(`pslist-wrapper.mjs not found in: \n${tryPaths.join('\n')}`);
  }
  const wrapperUrl = pathToFileURL(found).href;
  const { getProcesses } = await import(wrapperUrl);
  return await getProcesses();
}


function readPrefsSafe() {
  try {
    if (fs.existsSync(preferencesPath)) {
      return JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    }
  } catch {}
  return {};
}
function isPlaytimeDisabled() {
  const prefs = readPrefsSafe();
  return !!prefs.disablePlaytime;
}


function startPlaytimeLogWatcher(configData) {
	if (isPlaytimeDisabled()) {
    return;
}
  let isRunning = true;
  const { process_name: processName, appid, name } = configData;

  if (!appid) {
    notifyError('🚨 Missing appid in configData!');
    return;
  }

  playtimeStart = Date.now();
  currentGame = configData;

  const headerUrl = `https://cdn.steamstatic.com/steam/apps/${appid}/header.jpg`;

  cacheHeaderImage(`${appid}`, headerUrl)
    .then(({ headerUrl }) => {
	  if (isPlaytimeDisabled()) return;
      sendPlaytimeNotification({
        displayName: name,
        description: 'Tracking Playtime!',
        headerUrl
      });
    })
    .catch(err => notifyError(`❌ Failed to cache image for ${appid}: ${err.message}`));

  const interval = setInterval(async () => {
    try {
      if (!processName) {
        notifyError(`⚠️ Missing executable for app ${appid}`);
        clearInterval(interval);
        return;
      }

      const processes = await getProcessesSafe();
      const exeName = path.basename(processName).toLowerCase();
      const stillRunning = processes.some(p => p.name.toLowerCase() === exeName);

      if (!stillRunning && isRunning) {
        isRunning = false;
        clearInterval(interval);

        const minutesPlayed = Math.round((Date.now() - playtimeStart) / 60000);
        const displayTime = minutesPlayed <= 0
          ? 'Played for a few seconds'
          : `Played for ${minutesPlayed} minute${minutesPlayed > 1 ? 's' : ''}`;

        const headerPath = path.join(process.env.APPDATA, 'Achievements', 'images', String(appid), 'header.jpg');
		if (!isPlaytimeDisabled()) { 
        sendPlaytimeNotification({
          displayName: name,
          description: displayTime,
          headerUrl: `file://${headerPath.replace(/\\/g, '/')}`
        });
		}
        currentGame = null;
      }
    } catch (err) {
      notifyError(`⛔ Interval error: ${err.message}`);
    }
  }, 2000);

  return () => {
    clearInterval(interval);
    currentGame = null;
  };
}

module.exports = { startPlaytimeLogWatcher };
