const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');


const CRC32 = require('crc-32');
const { copyFolderOnce } = require('./utils/fileCopy');
const {
defaultSoundsFolder,
defaultPresetsFolder,
userSoundsFolder,
userPresetsFolder,
preferencesPath,
configsDir,
cacheDir
} = require('./utils/paths');
const { startPlaytimeLogWatcher } = require('./playtime-log-watcher');


function notifyError(message) {
console.error(message);
if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.send('notify', { message, color: '#f44336' });
}
}
function notifyInfo(message) {
if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.send('notify', {
message,
color: '#2196f3'
});
}
}

//Achievements Image
function resolveIconAbsolutePath(configPath, rel) {
  try {
    if (!rel) return null;
    const base = path.basename(String(rel));
    const candidates = [];
	
    candidates.push(path.join(configPath, rel));

    candidates.push(path.join(configPath, 'achievement_images', base));
    candidates.push(path.join(configPath, 'steam_settings', 'achievement_images', base));
    candidates.push(path.join(configPath, 'img', base));
    candidates.push(path.join(configPath, 'images', base));

    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
  } catch {}
  return null;
}


function registerOverlayShortcut(newShortcut) {
  if (!newShortcut || typeof newShortcut !== 'string') return;

  try {
    globalShortcut.unregisterAll();

    const registered = globalShortcut.register(newShortcut, () => {
		console.log(`Overlay Shortcut Pressed : ${newShortcut}`);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        if (overlayWindow.isVisible()) {
          overlayWindow.close();
        } else {
          overlayWindow.show();
        }
		  } else {
			createOverlayWindow(selectedConfig);
		  }
		});

    if (!registered) {
      notifyError(`Could not save shortcut: ${newShortcut}`);
    } else {
      console.log(`Overlay shortcut saved: ${newShortcut}`);
    }
  } catch (err) {
    notifyError(`Failed to save shortcut: ${newShortcut} – ${err.message}`);
  }
}




const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error
};

function sendConsoleMessageToUI(message, color) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify', { message, color });
  }
}

console.log = (...args) => {
  originalConsole.log(...args);
  sendConsoleMessageToUI(args.join(' '), '#4CAF50'); 
};

console.info = (...args) => {
  originalConsole.info(...args);
  sendConsoleMessageToUI(args.join(' '), '#2196F3'); 
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  sendConsoleMessageToUI(args.join(' '), '#FFC107'); 
};

console.error = (...args) => {
  originalConsole.error(...args);
  sendConsoleMessageToUI(args.join(' '), '#f44336'); 
};


if (!fs.existsSync(configsDir)) {
fs.mkdirSync(configsDir, { recursive: true });
}
let selectedLanguage = 'english';
let manualLaunchInProgress = false;

ipcMain.handle('save-preferences', async (event, newPrefs) => {
let currentPrefs = {};

try {
if (fs.existsSync(preferencesPath)) {
currentPrefs = JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'));
}
} catch (err) {
notifyError('❌ Error reading existing preferences: ' + err.message);
}

const mergedPrefs = { ...currentPrefs, ...newPrefs };

if (mergedPrefs.language) {
selectedLanguage = mergedPrefs.language;
}
if ('disableProgress' in newPrefs) {
global.disableProgress = newPrefs.disableProgress;
}

if ('disablePlaytime' in newPrefs) {
    global.disablePlaytime = newPrefs.disablePlaytime;
  }
  
if ('startInTray' in newPrefs) {
    global.startInTray = !!newPrefs.startInTray;
  }  
try {
fs.writeFileSync(preferencesPath, JSON.stringify(mergedPrefs, null, 2));
} catch (err) {
notifyError('Error writing merged preferences: ' + err.message);
}
if ('overlayShortcut' in newPrefs) {
  global.overlayShortcut = newPrefs.overlayShortcut;
  registerOverlayShortcut(newPrefs.overlayShortcut);
}

});

ipcMain.on('set-zoom', (event, zoomFactor) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(zoomFactor);

    try {
      const currentPrefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
        : {};
      const newPrefs = { ...currentPrefs, windowZoomFactor: zoomFactor };
      fs.writeFileSync(preferencesPath, JSON.stringify(newPrefs, null, 2));
    } catch (err) {
      notifyError('❌ Failed to save zoom preference: ' + err.message);
    }
  }
});

function getScreenshotRootFolder() {
  const prefs = readPrefsSafe();
  // Default Pictures\Achievements Screenshots
  const fallback = path.join(app.getPath('pictures'), 'Achievements Screenshots');
  const root = prefs.screenshotFolder || fallback;
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.warn('Cannot create screenshot root folder:', e.message);
  }
  return root;
}

function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    console.warn('Cannot create dir:', p, e.message);
  }
}

function sanitizeFilename(name) {
  return String(name || 'achievement')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() || 'achievement';
}

/**
 * <root>/<gameName>/<displayName>.png  (timestamp if exists)
 */
async function saveFullScreenShot(gameName, achDisplayName) {
  if (!screenshot) throw new Error('screenshot-desktop is not installed');
  const root = getScreenshotRootFolder();
  const gameFolder = path.join(root, sanitizeFilename(gameName || 'Unknown Game'));
  ensureDir(gameFolder);

  let file = path.join(gameFolder, sanitizeFilename(achDisplayName) + '.png');
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    file = path.join(gameFolder, `${sanitizeFilename(achDisplayName)}_${ts}.png`);
  }

  const buf = await screenshot({ format: 'png' }); // full desktop
  fs.writeFileSync(file, buf);
  return file;
}

function waitForFile(filePath, callback, interval = 1000) {
const checkFile = () => {
if (fs.existsSync(filePath)) {
callback();
} else {
setTimeout(checkFile, interval);
}
};
checkFile();
}


ipcMain.handle('load-preferences', () => {
if (fs.existsSync(preferencesPath)) {
return JSON.parse(fs.readFileSync(preferencesPath));
} else {
return {};
}
});

ipcMain.handle('get-sound-files', () => {
if (!fs.existsSync(userSoundsFolder)) return [];
const files = fs.readdirSync(userSoundsFolder).filter(file => file.endsWith('.wav'));
return files;
});

ipcMain.handle('get-sound-path', (event, fileName) => {
const fullPath = path.join(app.getPath('userData'), 'sounds', fileName);
return `file://${fullPath.replace(/\\/g, '/')}`;
});



// List existing configs
function listConfigs() {
const files = fs.readdirSync(configsDir);
return files.filter(file => file.endsWith('.json')).map(file => file.replace('.json', ''));
}

// Handler for config saving
ipcMain.handle('saveConfig', (event, config) => {
const configPath = path.join(configsDir, `${config.name}.json`);

if (!fs.existsSync(configsDir)) {
fs.mkdirSync(configsDir, { recursive: true });
}

try {
fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
return { success: true, message: 'Configuration saved successfully!' };
} catch (error) {
return { success: false, message: 'Error saving configuration!' };
}
});


// Handler for config load
ipcMain.handle('loadConfigs', () => {
const configFiles = fs.readdirSync(configsDir).filter(file => file.endsWith('.json'));
const configs = configFiles.map(file => path.basename(file, '.json'));
return configs;
});

// Handler for folder load
ipcMain.handle('selectFolder', async () => {
const result = await dialog.showOpenDialog({
properties: ['openDirectory']
});
if (!result.canceled) {
return result.filePaths[0];
}
return null;
});

// Handler for json load
ipcMain.handle('load-achievements', async (event, configName) => {
try {
const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
const configData = fs.readFileSync(configPath, 'utf-8');
const config = JSON.parse(configData);

const achievementsFilePath = path.join(config.config_path, 'achievements.json');

const achievementsData = fs.readFileSync(achievementsFilePath, 'utf-8');
const achievements = JSON.parse(achievementsData);

return { achievements, config_path: config.config_path };

} catch (error) {
notifyError('Error reading achievements.json file: ' + error.message);
if (error.code === 'ENOENT') {
const webContents = event.sender;
webContents.send('achievements-missing', configName);
}

return { achievements: [], config_path: '' };
}
});

ipcMain.handle('load-saved-achievements', async (event, configName) => {
try {
const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
const configData = fs.readFileSync(configPath, 'utf-8');
const config = JSON.parse(configData);

const saveDir = path.join(config.save_path, config.appid);
const achievementsJsonPath = path.join(saveDir, 'achievements.json');
const achievementsIniPath = path.join(saveDir, 'achievements.ini');
const achievementsBinPath = path.join(saveDir, 'stats.bin');
let achievements = {};

if (fs.existsSync(achievementsJsonPath)) {
const jsonData = fs.readFileSync(achievementsJsonPath, 'utf-8');
const parsed = JSON.parse(jsonData);

if (Array.isArray(parsed)) {
parsed.forEach(item => {
if (item.name) {
achievements[item.name] = {
earned: item.achieved === true,
earned_time: item.UnlockTime || 0
};
}
});
} else {
achievements = parsed;
}
} else if (fs.existsSync(achievementsIniPath)) {
const iniData = fs.readFileSync(achievementsIniPath, 'utf-8');
const parsedIni = ini.parse(iniData);

Object.keys(parsedIni).forEach(key => {
const item = parsedIni[key];
achievements[key] = {
earned: item.Achieved === "1" || item.Achieved === 1,
progress: item.CurProgress ? Number(item.CurProgress) : undefined,
max_progress: item.MaxProgress ? Number(item.MaxProgress) : undefined,
earned_time: item.UnlockTime ? Number(item.UnlockTime) : 0
};
});
} else if (fs.existsSync(achievementsBinPath)) {
try {
const parseStatsBin = require('./utils/parseStatsBin');
const raw = parseStatsBin(achievementsBinPath);
const configJsonPath = path.join(config.config_path, 'achievements.json');
let crcMap = {};

if (fs.existsSync(configJsonPath)) {
const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
crcMap = buildCrcNameMap(configJson);
}

Object.entries(raw).forEach(([crc, item]) => {
const key = crcMap[crc.toLowerCase()]?.name || crc.toLowerCase();
achievements[key] = {
earned: item.earned,
earned_time: item.earned_time
};
});
} catch (e) {
notifyError('Error reading stats.bin: ' + e.message);
}
}

return { achievements, save_path: saveDir };

} catch (error) {
return { achievements: [], save_path: '', error: error.message };
}
});


function waitForFile(filePath, timeout = 30000, interval = 1000) {
return new Promise((resolve, reject) => {
const startTime = Date.now();
const checkFile = () => {
if (fs.existsSync(filePath)) {
resolve();
} else if (Date.now() - startTime >= timeout) {
reject(new Error(`Timeout: File ${filePath} was not found in ${timeout / 1000} seconds.`));
} else {
setTimeout(checkFile, interval);
}
};
checkFile();
});
}

function buildCrcNameMap(achievements) {
const map = {};
for (const ach of achievements) {
if (ach.name) {
const crc = CRC32.str(ach.name) >>> 0;
const hexCrc = crc.toString(16).padStart(8, '0');
map[hexCrc.toLowerCase()] = ach;
}
}
return map;
}


// Handler for config deletion
ipcMain.handle('delete-config', async (event, configName) => {
try {
const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);

if (fs.existsSync(configPath)) {
fs.unlinkSync(configPath);
return { success: true };
} else {
return { success: false, error: "File not found." };
}
} catch (error) {
return { success: false, error: error.message };
}
});

ipcMain.on('set-animation-duration', (event, duration) => {
global.animationDuration = Number(duration);
});

function getPresetAnimationDuration(presetFolder) {
const presetIndexPath = path.join(presetFolder, 'index.html');
try {
const content = fs.readFileSync(presetIndexPath, 'utf-8');
const durationMatch = content.match(/<meta\s+name="duration"\s+content="(\d+)"\s*\/>/i);
if (durationMatch && !isNaN(durationMatch[1])) {
const duration = parseInt(durationMatch[1], 10);
return duration;
}
} catch (error) {
notifyError("Error reading animation duration from preset:" + error.message);
}
return 5000; // fallback default
}

function getUserPreferredSound() {
try {
const prefs = fs.existsSync(preferencesPath)
? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
: {};
return prefs.sound || null;
} catch (err) {
console.warn('Could not load sound preference:', err);
return null;
}
}


let mainWindow;
let tray = null;
const { Menu, Tray } = require('electron');
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')  // in installer: resources\icon.ico
  : path.join(__dirname, 'icon.ico');     
  
function createTray() {
  tray = new Tray(ICON_PATH);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setToolTip('Achievements App');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
        if (mainWindow) {
      mainWindow.show();
    }
  });
}

let achievementsFilePath; // achievements.json path
let currentConfigPath; 
let previousAchievements = {};

function createMainWindow() {
  let initialZoom = 1;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
      : {};
    initialZoom = Number(prefs.windowZoomFactor) || 1;
  } catch {}	
mainWindow = new BrowserWindow({
width: 900,
height: 800,
frame: false,
show: false,
titleBarStyle: 'hidden',
trafficLightPosition: { x: 10, y: 10 },
webPreferences: {
nodeIntegration: false,
contextIsolation: true,
backgroundThrottling: false,
preload: path.join(__dirname, 'preload.js'),
zoomFactor: initialZoom
}
});

const ICON_URL = pathToFileURL(ICON_PATH).toString();
mainWindow.loadFile('index.html', { query: { icon: ICON_URL } });

mainWindow.webContents.on('did-finish-load', () => {
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
      : {};
    const shouldStartInTray = !!prefs.startInTray;
	const zoom = Number(prefs.windowZoomFactor) || 1;
    mainWindow.webContents.setZoomFactor(zoom);
    if (!shouldStartInTray) mainWindow.show();
  } catch (e) {
    mainWindow.webContents.setZoomFactor(1);
    mainWindow.show();
  }
});

// Track window state changes
mainWindow.on('maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-state-change', true);
  }
});

mainWindow.on('unmaximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-state-change', false);
  }
});
}

function getPresetDimensions(presetFolder) {
const presetIndexPath = path.join(presetFolder, 'index.html');
try {
const content = fs.readFileSync(presetIndexPath, 'utf-8');
const metaRegex = /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i;
const match = content.match(metaRegex);
if (match) {
return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}
} catch (error) {
notifyError("Error reading preset: " + error.message);
}
// Default values if not defined
return { width: 400, height: 200 };
}

function createNotificationWindow(message) {
const display = screen.getPrimaryDisplay();
const { width, height } = display.workAreaSize;

const preset = message.preset || 'default';
// Check in both scalable and non-scalable folders
const scalableFolder = path.join(userPresetsFolder, 'Scalable', preset);
const nonScalableFolder = path.join(userPresetsFolder, 'Non-scalable', preset);
const oldStyleFolder = path.join(userPresetsFolder, preset);

// Determine which folder contains the preset
let presetFolder;
if (fs.existsSync(scalableFolder)) {
  presetFolder = scalableFolder;
} else if (fs.existsSync(nonScalableFolder)) {
  presetFolder = nonScalableFolder;
} else {
  presetFolder = oldStyleFolder; // Fallback to the old structure
}

const presetHtml = path.join(presetFolder, 'index.html');
const position = message.position || 'center-bottom';
const scale = parseFloat(message.scale || 1);

const { width: windowWidth, height: windowHeight } = getPresetDimensions(presetFolder);

// Apply scaling to window dimensions to prevent content overflow
// at higher scale factors by increasing the window size proportionally
const scaledWidth = Math.ceil(windowWidth * (scale > 1 ? scale : 1));
const scaledHeight = Math.ceil(windowHeight * (scale > 1 ? scale : 1));

let x = 0, y = 0;

switch (position) {
case 'center-top':
x = Math.floor((width - scaledWidth) / 2);
y = 5;
break;
case 'top-right':
x = width - scaledWidth - Math.round(20 * scale)
y = 5;
break;
case 'bottom-right':
x = width - scaledWidth - Math.round(20 * scale)
y = height - Math.floor(scaledHeight) - 40;
break;
case 'top-left':
x = Math.round(20 * scale)
y = 5;
break;
case 'bottom-left':
x = Math.round(20 * scale)
y = height - Math.floor(scaledHeight) - 40;
break;
case 'center-bottom':
default:
x = Math.floor((width - scaledWidth) / 2);
y = height - Math.floor(scaledHeight) - 40;
break;
}

const notificationWindow = new BrowserWindow({
width: scaledWidth,
height: scaledHeight,
x,
y,
transparent: true,
frame: false,
alwaysOnTop: true,
focusable: false,
resizable: false,
fullscreenable: false,
skipTaskbar: true,
hasShadow: false,
type: "notification",
webPreferences: {
preload: path.join(__dirname, 'preload.js'),
contextIsolation: true,
nodeIntegration: false,
backgroundThrottling: false
}
});

notificationWindow.setAlwaysOnTop(true, 'screen-saver');
notificationWindow.setVisibleOnAllWorkspaces(true);
notificationWindow.setFullScreenable(false);
notificationWindow.setFocusable(false);

notificationWindow.loadFile(presetHtml);

notificationWindow.webContents.on('did-finish-load', () => {
const iconPathToSend = message.iconPath || (message.icon ? path.join(message.config_path, message.icon) : '');	
notificationWindow.webContents.send('show-notification', {
displayName: message.displayName,
description: message.description,
iconPath: iconPathToSend,
scale
});
});

return notificationWindow;
}

function getSafeLocalizedText(input, lang = 'english') {
if (input === null || input === undefined) return 'Hidden';

if (typeof input === 'string') {
return input.trim() !== '' ? input.trim() : 'Hidden';
}

if (typeof input === 'object') {
return input[lang] || input.english || 
Object.values(input).find(v => typeof v === 'string' && v.trim() !== '') || 
'Hidden';
}

return 'Hidden';
}


ipcMain.on('show-notification', (event, achievement) => {
const displayName = getSafeLocalizedText(achievement.displayName, selectedLanguage);
const descriptionText = getSafeLocalizedText(achievement.description, selectedLanguage);

if (displayName && descriptionText) {
const notificationData = {
displayName,
description: descriptionText,
icon: achievement.icon,
icon_gray: achievement.icon_gray || achievement.icongray,
config_path: achievement.config_path,
preset: achievement.preset,
position: achievement.position,
sound: achievement.sound
};

queueAchievementNotification(notificationData);

const achName = achievement.name;
if (achName) {
if (!previousAchievements) previousAchievements = {};
previousAchievements[achName] = {
earned: true,
progress: achievement.progress || undefined,
max_progress: achievement.max_progress || undefined,
earned_time: Date.now()
};
if (selectedConfig) {
savePreviousAchievements(selectedConfig, previousAchievements);
}
}

if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.send('refresh-achievements-table', selectedConfig);
}
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}
} else {
notifyError("Achievement syntax not correct:", achievement);
}
});

// New Image Windows
// Return path to image if exists locally
ipcMain.handle('checkLocalGameImage', async (event, appid) => {
const imagePath = path.join(app.getPath('userData'), 'images', `${appid}.jpg`);
try {
await fs.promises.access(imagePath, fs.constants.F_OK);
return imagePath; 
} catch {
return null; 
}
});



// Save image locally from renderer
ipcMain.handle('saveGameImage', async (event, appid, buffer) => {
try {
const imageDir = path.join(app.getPath('userData'), 'images');
if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
const fullPath = path.join(imageDir, `${appid}.jpg`);
fs.writeFileSync(fullPath, Buffer.from(buffer));
return { success: true, path: fullPath };
} catch (err) {
notifyError('❌ Error saving image: ' + err.message);
return { success: false, error: err.message };
}
});

// Add new IPC handler for test achievements that doesn't require a config
ipcMain.on('show-test-notification', (event, options) => {
  const prefs = fs.existsSync(preferencesPath)
    ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
    : {};

const baseDir = app.isPackaged ? process.resourcesPath : __dirname;

  const notificationData = {
    displayName: "This is a testing achievement notification",
    description: "This is a testing achievement notification for this app",
    icon: "icon.ico", // Use app icon
    icon_gray: "icon.ico", // Use app icon
    config_path: baseDir, // Use app's directory
    preset: options.preset || 'default',
    position: options.position || 'center-bottom',
    sound: options.sound || 'mute',
    scale: parseFloat(prefs.notificationScale || options.scale || 1),
	skipScreenshot: true,
	isTest: true
  };

  queueAchievementNotification(notificationData);
});


ipcMain.handle('load-presets', async () => {
if (!fs.existsSync(userPresetsFolder)) return [];

try {
  // Check for the new structure with separate folders
  const scalableFolder = path.join(userPresetsFolder, 'Scalable');
  const nonScalableFolder = path.join(userPresetsFolder, 'Non-scalable');
  
  // Result object with category information
  let result = {
    scalable: [],
    nonScalable: [],
    isStructured: true  // Flag to indicate we're using the new folder structure
  };
  
  // If both category folders exist, use the new structure
  if (fs.existsSync(scalableFolder) && fs.existsSync(nonScalableFolder)) {
    // Get scalable presets
    const scalableDirs = fs.readdirSync(scalableFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    // Get non-scalable presets
    const nonScalableDirs = fs.readdirSync(nonScalableFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    result.scalable = scalableDirs;
    result.nonScalable = nonScalableDirs;
    
    return result;
  } else {
    // Fall back to flat structure if category folders don't exist
    const dirs = fs.readdirSync(userPresetsFolder, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    // Filter out the category folders themselves if they exist
    const flatDirs = dirs.filter(dir => dir !== 'Scalable' && dir !== 'Non-scalable');
    
    // For backwards compatibility, return just the array
    return flatDirs;
  }
} catch (error) {
  notifyError('Error reading presets: ' + error.message);
  return [];
}
});

const earnedNotificationQueue = [];
let isNotificationShowing = false;
let selectedNotificationScale = 1;
const progressNotificationQueue = [];
let isProgressShowing = false;

function queueAchievementNotification(achievement) {
const prefs = fs.existsSync(preferencesPath)
? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
: {};

achievement.scale = prefs.notificationScale || 1;
const lang = selectedLanguage || 'english';

const displayName = getSafeLocalizedText(achievement.displayName, lang);
const description = getSafeLocalizedText(achievement.description, lang);

const notificationData = {
displayName: displayName || '',
description: description || '',
icon: achievement.icon,
icon_gray: achievement.icon_gray || achievement.icongray,
config_path: achievement.config_path,
preset: achievement.preset,
position: achievement.position,
sound: achievement.sound,
scale: parseFloat(achievement.scale || 1),
skipScreenshot: !!achievement.skipScreenshot, 
isTest: !!achievement.isTest                  
};

earnedNotificationQueue.push(notificationData);
processNextNotification();
}

function processNextNotification() {
if (isNotificationShowing || earnedNotificationQueue.length === 0) return;

const achievement = earnedNotificationQueue.shift();
isNotificationShowing = true;

const lang = selectedLanguage || 'english';

const notificationData = {
displayName: achievement.displayName,
description: achievement.description,
icon: achievement.icon,
icon_gray: achievement.icon_gray,
config_path: achievement.config_path,
preset: achievement.preset,
position: achievement.position,
sound: achievement.sound,
scale: parseFloat(achievement.scale || 1),
skipScreenshot: !!achievement.skipScreenshot,
isTest: !!achievement.isTest
};

  const iconCandidate = notificationData.icon || notificationData.icon_gray;
  let iconPathFinal = resolveIconAbsolutePath(notificationData.config_path, iconCandidate);

  if (!iconPathFinal) {
    iconPathFinal = ICON_PATH;
  }
  notificationData.iconPath = iconPathFinal;

const preset = achievement.preset || 'default';
// Check in both scalable and non-scalable folders
const scalableFolder = path.join(userPresetsFolder, 'Scalable', preset);
const nonScalableFolder = path.join(userPresetsFolder, 'Non-scalable', preset);
const oldStyleFolder = path.join(userPresetsFolder, preset);

// Determine which folder contains the preset
let presetFolder;
if (fs.existsSync(scalableFolder)) {
  presetFolder = scalableFolder;
} else if (fs.existsSync(nonScalableFolder)) {
  presetFolder = nonScalableFolder;
} else {
  presetFolder = oldStyleFolder; // Fallback to the old structure
}

const duration = getPresetAnimationDuration(presetFolder);
const notificationWindow = createNotificationWindow(notificationData);

if (mainWindow && !mainWindow.isDestroyed() && achievement.sound && achievement.sound !== 'mute') {
mainWindow.webContents.send('play-sound', achievement.sound);
}

  // Screenshot
  let disableByPrefs = false;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
      : {};
    disableByPrefs = !!prefs.disableAchievementScreenshot;
  } catch {}

  const shouldScreenshot =
    !notificationData.isTest &&
    !notificationData.skipScreenshot &&
    !disableByPrefs;

  const doShot = async () => {
    try {
      if (!screenshot) {
        console.warn('[shot] screenshot-desktop not installed');
        return;
      }
      const gameName = selectedConfig || 'Unknown Game';
      const achName  = notificationData.displayName || 'Achievement';
      const saved = await saveFullScreenShot(gameName, achName);
      console.log('📸 Screenshot saved:', saved);
    } catch (err) {
      console.warn('Screenshot failed:', err.message);
    }
  };

  if (shouldScreenshot) {
    if (notificationWindow.webContents.isLoading()) {
      notificationWindow.webContents.once('did-finish-load', () => {
        setTimeout(doShot, 250);
      });
    } else {
      setTimeout(doShot, 250);
    }
  }


notificationWindow.on('closed', () => {
isNotificationShowing = false;
processNextNotification();
});

setTimeout(() => {
if (!notificationWindow.isDestroyed()) {
notificationWindow.close();
}
}, duration);
}

function queueProgressNotification(data) {
  progressNotificationQueue.push(data);
  processNextProgressNotification();
}

function processNextProgressNotification() {
  if (isProgressShowing || progressNotificationQueue.length === 0) return;

  const data = progressNotificationQueue.shift();
  isProgressShowing = true;

  const progressWindow = showProgressNotification(data);

  if (progressWindow) {
    progressWindow.on('closed', () => {
      isProgressShowing = false;
      processNextProgressNotification();
    });
  } else {
    isProgressShowing = false;
    processNextProgressNotification();
  }
}

let currentAchievementsFilePath = null;
let achievementsWatcher = null;

if (!fs.existsSync(cacheDir)) {
fs.mkdirSync(cacheDir, { recursive: true });
}

function getCachePath(configName) {
return path.join(cacheDir, `${configName}_achievements_cache.json`);
}

function loadPreviousAchievements(configName) {
  const cachePath = getCachePath(configName);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
      notifyError('Error reading achievement cache: ' + e.message);
    }
  }
  return {};
}

function savePreviousAchievements(configName, data) {
  const cachePath = getCachePath(configName);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  } catch (e) {
    notifyError('Error reading achievement cache: ' + e.message);
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia  = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function readJsonWithRetries(filePath, maxTries = 6, baseDelayMs = 35) {
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      if (
        msg.includes('Unexpected end of JSON input') ||
        msg.includes('Unexpected token') ||
        e.code === 'EBUSY'
      ) {
        sleepSync(baseDelayMs + i * 25);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}


function loadAchievementsFromSaveFile(saveDir, fallback) {
  const jsonPath = path.join(saveDir, 'achievements.json');
  const iniPath  = path.join(saveDir, 'achievements.ini');
  const binPath  = path.join(saveDir, 'stats.bin');

  if (fs.existsSync(jsonPath)) {
    try {
      const data = readJsonWithRetries(jsonPath, 6, 35);

      if (!Array.isArray(data)) {
        return data;
      }

      const converted = {};
      for (const item of data) {
        if (item?.name) {
          converted[item.name] = {
            earned: item.achieved === true,
            earned_time: item.UnlockTime || 0
          };
        }
      }
      return converted;

    } catch (e) {
      console.warn('⚠ achievements.json still writing' + e.message);
      return fallback || {};
    }
  } else if (fs.existsSync(iniPath)) {
    try {
      const iniData = fs.readFileSync(iniPath, 'utf8');
      const parsed  = ini.parse(iniData);
      const converted = {};
      for (const key in parsed) {
        const ach = parsed[key];
        converted[key] = {
          earned: ach.Achieved === "1" || ach.Achieved === 1,
          progress: ach.CurProgress ? Number(ach.CurProgress) : undefined,
          max_progress: ach.MaxProgress ? Number(ach.MaxProgress) : undefined,
          earned_time: ach.UnlockTime ? Number(ach.UnlockTime) : 0
        };
      }
      return converted;
    } catch (e) {
      notifyError('❌ Error INI: ' + e.message);
      return fallback || {};
    }
  } else if (fs.existsSync(binPath)) {
    try {
      const parseStatsBin = require('./utils/parseStatsBin');
      const raw = parseStatsBin(binPath);
      const converted = {};
      const configJsonPath = fullAchievementsConfigPath;
      let crcMap = {};
      if (fs.existsSync(configJsonPath)) {
        const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
        crcMap = buildCrcNameMap(configJson);
      }
      for (const [crc, item] of Object.entries(raw)) {
        const configEntry = crcMap[crc.toLowerCase()];
        const key = configEntry?.name || crc.toLowerCase();
        converted[key] = {
          earned: item.earned,
          earned_time: item.earned_time
        };
      }
      return converted;
    } catch (e) {
      notifyError('❌ Error parsing stats.bin: ' + e.message);
      return fallback || {};
    }
  }

  return fallback || {};
}

function monitorAchievementsFile(filePath) {
if (!filePath) {
if (achievementsWatcher && currentAchievementsFilePath) {
fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
achievementsWatcher = null;
}
currentAchievementsFilePath = null;
return;
}

if (currentAchievementsFilePath === filePath && achievementsWatcher) {
return;
}

if (achievementsWatcher && currentAchievementsFilePath) {
fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
achievementsWatcher = null;
}

currentAchievementsFilePath = filePath;

const configName = selectedConfig;
let previousAchievements = loadPreviousAchievements(configName);
let isFirstLoad = true;
let fullConfig = [];
let crcMap = {};
try {
fullConfig = JSON.parse(fs.readFileSync(fullAchievementsConfigPath, 'utf8'));
crcMap = buildCrcNameMap(fullConfig);

} catch (e) {
notifyError('❌ Error reading achievements: ' + e.message);
}

achievementsWatcher = (curr, prev) => {
let currentAchievements = loadAchievementsFromSaveFile(path.dirname(filePath), previousAchievements);

Object.keys(currentAchievements).forEach(key => {
const current = currentAchievements[key];
const previous = previousAchievements[key];
const lang = selectedLanguage || 'english';
const newlyEarned = (
Boolean(current.earned) && (!previous || !Boolean(previous.earned))		
);


if (newlyEarned) {
const isBin = path.basename(filePath).endsWith('.bin');
const achievementConfig = fullConfig.find(a => a.name === key);

if (!achievementConfig) {
console.warn(`Achievement config not found for key: ${key}`);
return;
}
if (achievementConfig) {
const notificationData = {
  displayName: typeof achievementConfig.displayName === 'object'
	? achievementConfig.displayName[lang] || achievementConfig.displayName.english || Object.values(achievementConfig.displayName)[0]
	: achievementConfig.displayName,

  description: typeof achievementConfig.description === 'object'
	? achievementConfig.description[lang] || achievementConfig.description.english || Object.values(achievementConfig.description)[0]
	: achievementConfig.description,
icon: achievementConfig.icon,
icon_gray: achievementConfig.icon_gray || achievementConfig.icongray,
config_path: selectedConfigPath,
preset: selectedPreset,
position: selectedPosition,
sound: getUserPreferredSound() || 'mute'

};

queueAchievementNotification(notificationData);

mainWindow.webContents.send('refresh-achievements-table');
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}
}
}
const progressChanged = (
(current.earned === false || current.earned === 0) &&
current.progress !== undefined &&
(
!previous ||
current.progress !== previous.progress ||
current.max_progress !== previous.max_progress
)
);

if (progressChanged) {
const isBin = path.basename(filePath).endsWith('.bin');
const achievementConfig = isBin
? crcMap[key.toLowerCase()]
: fullConfig.find(a => a.name == key || a.name == current?.name);

if (achievementConfig) {
if (!global.disableProgress) {	
queueProgressNotification({
displayName: getSafeLocalizedText(achievementConfig.displayName, selectedLanguage),
icon: achievementConfig.icon,
progress: current.progress,
max_progress: current.max_progress,
config_path: selectedConfigPath
});
}

mainWindow.webContents.send('refresh-achievements-table');
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}
}
}
});


previousAchievements = currentAchievements;
savePreviousAchievements(configName, previousAchievements);
};

const checkFileLoop = () => {
if (fs.existsSync(filePath)) {
let currentAchievements = loadAchievementsFromSaveFile(path.dirname(filePath), previousAchievements);

const isFirstTime = Object.keys(previousAchievements).length === 0;

if (isFirstLoad && isFirstTime) {
const earnedKeys = Object.keys(currentAchievements).filter(key =>
currentAchievements[key].earned === true || currentAchievements[key].earned === 1
);

if (earnedKeys.length > 0) {
earnedKeys.forEach(key => {
const current = currentAchievements[key];
const isBin = path.basename(filePath).endsWith('.bin');
const achievementConfig = fullConfig.find(a => a.name === key);


const lang = selectedLanguage || 'english';
const selectedSound = getUserPreferredSound();
const displayName = getSafeLocalizedText(achievementConfig?.displayName, lang);
const description = getSafeLocalizedText(achievementConfig?.description, lang);


if (achievementConfig) {							
queueAchievementNotification({
displayName,
description,
  icon: achievementConfig.icon,
  icon_gray: achievementConfig.icon_gray,
  config_path: selectedConfigPath,
  preset: selectedPreset,
  position: selectedPosition,
  sound: selectedSound || 'mute',
  soundPath: selectedSound ? path.join(app.getAppPath(), 'sounds', selectedSound) : null
});
previousAchievements[key] = {
earned: true,
earned_time: current.earned_time || Date.now(),
progress: current.progress,
max_progress: current.max_progress
};
}
});
}
}

previousAchievements = currentAchievements;
savePreviousAchievements(configName, previousAchievements);
isFirstLoad = false;

mainWindow.webContents.send('refresh-achievements-table');
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}

fs.watchFile(filePath, { interval: 1000 }, achievementsWatcher);
} else {
const baseDir = path.dirname(filePath);
const iniPath = path.join(baseDir, 'achievements.ini');
const binPath = path.join(baseDir, 'stats.bin');

if (fs.existsSync(iniPath)) {
monitorAchievementsFile(iniPath);
return;
}

if (fs.existsSync(binPath)) {
monitorAchievementsFile(binPath);
return;
}

setTimeout(checkFileLoop, 1000);
}
};

checkFileLoop();
}

let fullAchievementsConfigPath;
let selectedConfig = null;
let selectedSound = 'mute';
ipcMain.on('update-config', (event, { configName, preset, position }) => {
if (!configName) {
if (achievementsWatcher && achievementsFilePath) {
fs.unwatchFile(achievementsFilePath, achievementsWatcher);
achievementsWatcher = null;
}

achievementsFilePath = null;
selectedConfig = null;

if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}

return;
}

const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
let config;
try {
config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
notifyError('Error reading configPath: ' + err.message);
return;
}

const saveDir = path.join(config.save_path, config.appid);
const jsonPath = path.join(saveDir, 'achievements.json');
const iniPath = path.join(saveDir, 'achievements.ini');
const binPath = path.join(saveDir, 'stats.bin');

if (fs.existsSync(jsonPath)) {
achievementsFilePath = jsonPath;
} else if (fs.existsSync(iniPath)) {
achievementsFilePath = iniPath;
} else if (fs.existsSync(binPath)) {
achievementsFilePath = binPath;
} else {
achievementsFilePath = jsonPath; // default fallback
}

fullAchievementsConfigPath = path.join(config.config_path, 'achievements.json');
selectedPreset = preset || 'default';
selectedPosition = position || 'center-bottom';
selectedConfigPath = config.config_path;
selectedConfig = configName;

monitorAchievementsFile(achievementsFilePath);
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}

});

ipcMain.handle('get-config-by-name', async (event, name) => {
try {
const configPath = path.join(configsDir, `${name}.json`);

if (!fs.existsSync(configPath)) {
console.warn(`❌ Config not found: ${configPath}`);
throw new Error('Config not found');
}

const data = fs.readFileSync(configPath, 'utf8');
return JSON.parse(data);
} catch (err) {
throw err;
}
});

ipcMain.handle('renameAndSaveConfig', async (event, oldName, newConfig) => {
const oldConfigPath = path.join(configsDir, `${oldName}.json`);
const newConfigPath = path.join(configsDir, `${newConfig.name}.json`);

const oldCachePath = getCachePath(oldName);
const newCachePath = getCachePath(newConfig.name);

try {
if (oldName !== newConfig.name && fs.existsSync(oldConfigPath)) {
fs.renameSync(oldConfigPath, newConfigPath);
}
fs.writeFileSync(newConfigPath, JSON.stringify(newConfig, null, 2));

if (fs.existsSync(oldCachePath)) {
fs.renameSync(oldCachePath, newCachePath);
} else {
}

return { success: true, message: `Config "${oldName}" has been renamed and saved.` };
} catch (error) {
return { success: false, message: "Failed to rename and save config." };
}
});


ipcMain.on('close-notification-window', (event) => {
const win = BrowserWindow.fromWebContents(event.sender);

setTimeout(() => {
if (win && !win.isDestroyed()) {
win.close();
}
}, global.animationDuration);
});


let overlayWindow = null;

function createOverlayWindow(selectedConfig) {
const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

overlayWindow = new BrowserWindow({
width: 450,
height: 800,
x: width - 470,
y: 20,  
frame: false,
transparent: true,
alwaysOnTop: true,
skipTaskbar: true,
resizable: false,
focusable: false,
hasShadow: false,
fullscreenable: false,
webPreferences: {
preload: path.join(__dirname, 'preload.js'),
contextIsolation: true,
nodeIntegration: false,
backgroundThrottling: false
}
});

overlayWindow.setAlwaysOnTop(true, 'screen-saver');
overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
overlayWindow.setFullScreenable(false);
overlayWindow.setFocusable(false);
overlayWindow.blur();

overlayWindow.loadFile('overlay.html');

overlayWindow.webContents.on('did-finish-load', () => {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
});


overlayWindow.on('closed', () => {
overlayWindow = null;
});
}

const { globalShortcut } = require('electron');

app.whenReady().then(async () => {
try {
const prefs = fs.existsSync(preferencesPath)
? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
: {};

if (prefs.language) {
selectedLanguage = prefs.language;
}

} catch (err) {
notifyError('❌ Failed to load language preference: ' + err.message);
}

let overlayShortcut = null;

try {
  const prefs = fs.existsSync(preferencesPath)
    ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
    : {};

  overlayShortcut = prefs.overlayShortcut || null;

  selectedLanguage = prefs.language || 'english';

  if (overlayShortcut) {
    registerOverlayShortcut(overlayShortcut);
  }

} catch (err) {
  notifyError('❌ Failed to load preferences: ' + err.message);
}


let registeredShortcut = null;

app.on('activate', () => {
if (BrowserWindow.getAllWindows().length === 0) {
createMainWindow();
}
});

});

ipcMain.handle('selectExecutable', async () => {
const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
return canceled ? null : filePaths[0];
});

ipcMain.handle('launchExecutable', async (event, exePath, argsString) => {
try {
const args = argsString.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];

const child = spawn(exePath, args, {
cwd: path.dirname(exePath),
detached: true,
stdio: 'ignore'
});
child.on('error', (err) => {
if (err.code === 'ENOENT') {
notifyError("❌ File not found: " + exePath);
} else if (err.code === 'EACCES') {
notifyError("❌ Permission denied. Try running the app as administrator or check file permissions.");
} else {
notifyError("❌ Failed to launch executable: " + err.message);
}
});
child.unref();

if (selectedConfig) {
const configPath = path.join(configsDir, `${selectedConfig}.json`);
if (fs.existsSync(configPath)) {
const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
manualLaunchInProgress = true;
detectedConfigName = configData.name;
if (!global.disablePlaytime) startPlaytimeLogWatcher(configData);
} else {
notifyError(`❌ Config file not found for: ${selectedConfig}`);
}
} else {
notifyError(`❌ selectedConfig is null – cannot start playtime log watcher.`);
}



} catch (err) {
notifyError("Failed to launch executable: " + err.message);
}
});


let currentAppId = null;

ipcMain.on('toggle-overlay', (event, selectedConfig) => {
	if (!selectedConfig) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow(selectedConfig);
  } else {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  }
});

// Handle request for current config from overlay
ipcMain.on('request-current-config', (event) => {
  if (selectedConfig) {
    event.sender.send('load-overlay-data', selectedConfig);
    event.sender.send('set-language', selectedLanguage);
  }
});

ipcMain.on('refresh-ui-after-language-change', (event, { language, configName }) => {
selectedLanguage = language;

if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.webContents.send('refresh-achievements-table', configName);
}

if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.webContents.send('load-overlay-data', selectedConfig);
overlayWindow.webContents.send('set-language', selectedLanguage);
}
});


function minimizeWindow() {
if (mainWindow) mainWindow.hide();
}


function maximizeWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
if (mainWindow.isMaximized()) {
mainWindow.unmaximize();
} else {
mainWindow.maximize();
}
}
}

function closeWindow() {
if (overlayWindow && !overlayWindow.isDestroyed()) {
overlayWindow.close();
}

if (playtimeWindow && !playtimeWindow.isDestroyed()) {
playtimeWindow.webContents.send('start-close-animation');
}

if (mainWindow && !mainWindow.isDestroyed()) {
mainWindow.close();
}
}


ipcMain.on('minimize-window', minimizeWindow);
ipcMain.on('maximize-window', maximizeWindow);
ipcMain.on('close-window', closeWindow);

app.whenReady().then(async () => {
// Load preferences
try {
const prefs = fs.existsSync(preferencesPath)
? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'))
: {};

if (prefs.language) {
selectedLanguage = prefs.language;
}
global.disableProgress = prefs.disableProgress === true;
global.disablePlaytime = prefs.disablePlaytime === true;
    selectedSound    = prefs.sound    || 'mute';
    selectedPreset   = prefs.preset   || 'default';
    selectedPosition = prefs.position || 'center-bottom';
} catch (err) {
notifyError('❌ Failed to load language preference: ' + err.message);
}

copyFolderOnce(defaultSoundsFolder, userSoundsFolder);
copyFolderOnce(defaultPresetsFolder, userPresetsFolder);  

createMainWindow();
setInterval(autoSelectRunningGameConfig, 2000);
  createTray(); 
  mainWindow.hide();
app.on('activate', () => {
if (BrowserWindow.getAllWindows().length === 0) {
createMainWindow();
}
});
});


function showProgressNotification(data) {
const { width, height } = screen.getPrimaryDisplay().workAreaSize;
const progressWindow = new BrowserWindow({
width: 350,
height: 150,
x: 20,
y: height - 140,
transparent: true,
frame: false,
alwaysOnTop: true,
focusable: false,
resizable: false,
fullscreenable: false,
skipTaskbar: true,
hasShadow: false,
show: false,
webPreferences: {
preload: path.join(__dirname, 'preload.js'),
contextIsolation: true,
nodeIntegration: false,
backgroundThrottling: false
}
});

progressWindow.setAlwaysOnTop(true, 'screen-saver');
progressWindow.setVisibleOnAllWorkspaces(true);
progressWindow.setFullScreenable(false);
progressWindow.setFocusable(false);
progressWindow.loadFile('progress.html');

progressWindow.once('ready-to-show', () => {
progressWindow.show();
progressWindow.webContents.send('show-progress', data);
});



setTimeout(() => {
if (!progressWindow.isDestroyed()) progressWindow.close();
}, 5000);
return progressWindow;
}
ipcMain.on('disable-progress-check', (event) => {
event.returnValue = global.disableProgress || false;
});

ipcMain.on('set-disable-progress', (_, value) => {
global.disableProgress = value;
});

// === Disable Playtime: check + set ===
ipcMain.on('disable-playtime-check', (event) => {
  event.returnValue = global.disablePlaytime || false;
});

ipcMain.on('set-disable-playtime', (_event, value) => {
  global.disablePlaytime = !!value;
  try {
    global.disablePlaytime = !!value;
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
      : {};
    cur.disablePlaytime = !!value;
    fs.writeFileSync(preferencesPath, JSON.stringify(cur, null, 2));
  } catch (err) {
    notifyError('❌ Failed to persist disablePlaytime: ' + err.message);
  }
});

let playtimeWindow = null;
let playtimeAlreadyClosing = false;

function createPlaytimeWindow(playData) {
  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) {
      console.log('[playtime] blocked at createPlaytimeWindow() entry');
      return;
    }
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }
  
if (playtimeWindow && !playtimeWindow.isDestroyed()) {
if (!playtimeAlreadyClosing) {
playtimeWindow.webContents.send('start-close-animation');
playtimeAlreadyClosing = true;
}
return;
}

const { width: screenWidth } = require('electron').screen.getPrimaryDisplay().workAreaSize;
const winWidth = 460;
const winHeight = 340;
const x = Math.floor((screenWidth - winWidth) / 2);
const y = 40;

playtimeWindow = new BrowserWindow({
width: winWidth,
height: winHeight,
x,
y,
frame: false,
type: 'notification',
alwaysOnTop: true,
transparent: true,
resizable: false,
show: false,
skipTaskbar: true,
focusable: false,
fullscreenable: false,
webPreferences: {
preload: path.join(__dirname, 'preload.js'),
contextIsolation: true,
nodeIntegration: false,
backgroundThrottling: false
}
});
playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
playtimeWindow.setAlwaysOnTop(true, 'screen-saver');
playtimeWindow.setVisibleOnAllWorkspaces(true);
playtimeWindow.setFullScreenable(false);
playtimeWindow.setFocusable(false);
playtimeWindow.loadFile('playtime.html');

playtimeWindow.once('ready-to-show', () => {

    try {
      const cur = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
        : {};
      if (cur.disablePlaytime === true || global.disablePlaytime === true) {
        console.log('[playtime] blocked at ready-to-show()');
        if (!playtimeWindow.isDestroyed()) playtimeWindow.close();
        return;
      }
    } catch (e) {
      if (global.disablePlaytime === true) {
        if (!playtimeWindow.isDestroyed()) playtimeWindow.close();
        return;
      }
    }
	
if (playtimeWindow && !playtimeWindow.isDestroyed()) {
playtimeWindow.show();

const prefs = fs.existsSync(preferencesPath)
? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
: {};
const scale = prefs.notificationScale || 1;

playtimeWindow.webContents.send('show-playtime', {
...playData,
scale
});
}
});


ipcMain.once('close-playtime-window', () => {
if (playtimeWindow && !playtimeWindow.isDestroyed()) {
playtimeWindow.close();
playtimeAlreadyClosing = false;
}
});


playtimeWindow.on('closed', () => {
playtimeWindow = null;
playtimeAlreadyClosing = false;
});
}


let detectedConfigName = null;
const { pathToFileURL } = require('url');

async function importPsListWrapper() {
  const tryPaths = [
    path.join(__dirname, 'utils', 'pslist-wrapper.mjs'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'utils', 'pslist-wrapper.mjs'),
  ];

  for (const p of tryPaths) {
    try { await fs.promises.access(p, fs.constants.R_OK); 
      return await import(pathToFileURL(p).href);
    } catch { /* continue */ }
  }
  throw new Error(`pslist-wrapper.mjs not found in:\n${tryPaths.join('\n')}`);
}


async function autoSelectRunningGameConfig() {
  try {
    const { getProcesses } = await importPsListWrapper();
    const processes = await getProcesses();
	const logPath = path.join(app.getPath('userData'), 'process-log.txt');
	fs.writeFileSync(logPath, processes.map(p => p.name).join('\n'), 'utf8');

if (manualLaunchInProgress) {
const configPath = path.join(configsDir, `${detectedConfigName}.json`);
if (!fs.existsSync(configPath)) {
manualLaunchInProgress = false;
detectedConfigName = null;
return;
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const exeName = path.basename(config.process_name || '').toLowerCase();
const isRunning = processes.some(p => p.name.toLowerCase() === exeName);

if (!isRunning) {
notifyInfo(`${config.name} closed.`);
manualLaunchInProgress = false;
detectedConfigName = null;

if (playtimeWindow && !playtimeWindow.isDestroyed()) {
playtimeWindow.webContents.send('start-close-animation');
}
}
return;
}

try {
const configs = listConfigs();

if (detectedConfigName) {
const configPath = path.join(configsDir, `${detectedConfigName}.json`);
if (!fs.existsSync(configPath)) {
detectedConfigName = null;
return;
}

const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const exeName = path.basename(configData.process_name || '').toLowerCase();
const isStillRunning = processes.some(p => p.name.toLowerCase() === exeName);

if (!isStillRunning) {
notifyInfo(`${configData.name} closed.`);
detectedConfigName = null;
return;
}

return;
}


for (const configName of configs) {
const configPath = path.join(configsDir, `${configName}.json`);
if (!fs.existsSync(configPath)) continue;

const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
if (!configData.process_name) continue;

const exeName = path.basename(configData.process_name).toLowerCase();
const isRunning = processes.some(p => p.name.toLowerCase() === exeName);

if (isRunning) {
detectedConfigName = configName;
notifyInfo(`${configData.name} started.`);

if (mainWindow && !mainWindow.isDestroyed()) {
  mainWindow.webContents.send('auto-select-config', configName);
  if (!global.disablePlaytime) startPlaytimeLogWatcher(configData);
}
return;
}
}
} catch (err) {
notifyError('Error in autoSelectRunningGameConfig: ' + err.message);
    }
  } catch (err) {
    notifyError('Error in autoSelectRunningGameConfig: ' + err.message);
  }
}


ipcMain.on('show-playtime', (event, playData) => {
  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) {
      console.log('[playtime] dropped by prefs/global');
      return;
    }
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }
  createPlaytimeWindow(playData);
});

ipcMain.handle('resolve-icon-url', async (_event, configPath, rel) => {
  try {
    const p = resolveIconAbsolutePath(configPath, rel);
    if (!p) {
      return pathToFileURL(ICON_PATH).toString();
    }
    await fs.promises.access(p, fs.constants.R_OK);
    return pathToFileURL(p).toString();
  } catch {
    return pathToFileURL(ICON_PATH).toString();
  }
});

const { generateGameConfigs } = require('./utils/auto-config-generator');

ipcMain.handle('generate-auto-configs', async (event, folderPath) => {
  const outputDir = path.join(process.env.APPDATA, "Achievements", "configs");

  try {
    await generateGameConfigs(folderPath, outputDir);
    return { success: true, message: 'Configs generated successfully!' };
  } catch (error) {
    console.error('Error generating configs:', error);
    return { success: false, message: error.message };
  }
});


// === screenshots support ===
let screenshot = null;
try {
  screenshot = require('screenshot-desktop');
} catch (e) {
  console.warn('⚠️ Optional dependency "screenshot-desktop" missing. Run: npm i screenshot-desktop');
}

function readPrefsSafe() {
  try {
    return fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8'))
      : {};
  } catch {
    return {};
  }
}

app.on('before-quit', () => {
manualLaunchInProgress = false;
if (playtimeWindow && !playtimeWindow.isDestroyed()) {
playtimeWindow.destroy();
}
});


app.on('window-all-closed', () => {
if (process.platform !== 'darwin') {
app.quit();
}
});

