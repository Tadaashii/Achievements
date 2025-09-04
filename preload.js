const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('customApi', {
minimizeWindow: () => ipcRenderer.send('minimize-window'),
maximizeWindow: () => ipcRenderer.send('maximize-window'),
closeWindow: () => ipcRenderer.send('close-window')
});

contextBridge.exposeInMainWorld('api', {
// Config management
saveConfig: (config) => ipcRenderer.invoke('saveConfig', config),
loadConfigs: () => ipcRenderer.invoke('loadConfigs'),
selectFolder: () => ipcRenderer.invoke('selectFolder'),
deleteConfig: (configName) => ipcRenderer.invoke('delete-config', configName),

// Achievements loading
loadAchievementData: (configName) => ipcRenderer.invoke('load-achievements', configName),
loadSavedAchievements: (configName) => ipcRenderer.invoke('load-saved-achievements', configName),

// Presets
loadPresets: () => ipcRenderer.invoke('load-presets'),

// Notification
showNotification: (data) => ipcRenderer.send('show-notification', data),
showTestNotification: (options) => ipcRenderer.send('show-test-notification', options),
onNotification: (callback) => ipcRenderer.on('show-notification', (event, data) => callback(data)),
onNotify: (callback) => ipcRenderer.on('notify', (_, data) => callback(data)),
notifyMain: (msg) => ipcRenderer.send('notify-from-child', msg),
once: (channel, callback) => { ipcRenderer.once(channel, (_, data) => callback(data));},
disableProgress: (value) => ipcRenderer.send('set-disable-progress', value),
setDisablePlaytime: (value) => ipcRenderer.send('set-disable-playtime', value),
getDisablePlaytimeSync: () => ipcRenderer.sendSync('disable-playtime-check'),
resolveIconUrl: (configPath, rel) => ipcRenderer.invoke('resolve-icon-url', configPath, rel),

// Event for receiving a new monitored achievement
onNewAchievement: (callback) => ipcRenderer.on('new-achievement', (event, data) => callback(data)),
onRefreshAchievementsTable: (callback) => ipcRenderer.on('refresh-achievements-table', (event, data) => callback(data)),

// Update the configuration (now uses the 'update-config' event)
updateConfig: (configData) => ipcRenderer.send('update-config', configData),
toggleOverlay: (selectedConfig) => ipcRenderer.send('toggle-overlay', selectedConfig),
onLoadOverlayData: (callback) => ipcRenderer.on('load-overlay-data', (event, config) => callback(config)),
onToggleOverlayShortcut: (callback) => ipcRenderer.on('toggle-overlay-shortcut', () => callback()),
onSetLanguage: (callback) => ipcRenderer.on('set-language', (event, lang) => callback(lang)),

// Other functionalities
savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),
loadPreferences: () => ipcRenderer.invoke('load-preferences'),
getSounds: () => ipcRenderer.invoke('get-sound-files'),
getSoundFullPath: (fileName) => ipcRenderer.invoke('get-sound-path', fileName),
onPlaySound: (callback) => ipcRenderer.on('play-sound', (event, sound) => callback(sound)),
onProgressUpdate: (callback) => ipcRenderer.on('show-progress', (event, data) => callback(data)),
closeNotificationWindow: () => ipcRenderer.send('close-notification-window'),
parseStatsBin: (filePath) => ipcRenderer.invoke('parse-stats-bin', filePath),
selectFile: () => ipcRenderer.invoke('select-file'),
getConfigByName: (name) => ipcRenderer.invoke('get-config-by-name', name),
renameAndSaveConfig: (oldName, config) => ipcRenderer.invoke('renameAndSaveConfig', oldName, config),
selectExecutable: () => ipcRenderer.invoke('selectExecutable'),
launchExecutable: (exe, args) => ipcRenderer.invoke('launchExecutable', exe, args),
onAchievementsMissing: (callback) => ipcRenderer.on('achievements-missing', (e, configName) => callback(configName)),
checkLocalGameImage: (appid) => ipcRenderer.invoke('checkLocalGameImage', appid),
saveGameImage: (appid, buffer) => ipcRenderer.invoke('saveGameImage', appid, buffer),
onImageUpdate: (callback) => ipcRenderer.on('update-image', (_, url) => callback(url)),
on: (channel, callback) => ipcRenderer.on(channel, (_, data) => callback(data)),
setZoom: (zoomFactor) => ipcRenderer.send('set-zoom', zoomFactor),
updateOverlayShortcut: (combo) => ipcRenderer.send('update-overlay-shortcut', combo),
requestCurrentConfig: () => ipcRenderer.send('request-current-config'),
// language
refreshUILanguage: (language) => ipcRenderer.send('refresh-ui-after-language-change', language),
setLanguage: (lang) => {
  window.currentLang = lang;
},
setLanguageAndReload: async (language) => {
  await ipcRenderer.invoke('save-preferences', { language });
  ipcRenderer.send('refresh-ui-after-language-change', language);
}
});


contextBridge.exposeInMainWorld('electron', {
ipcRenderer: {
on: (channel, func) => {
  const validChannels = ['window-state-change', 'notify', 'achievements-missing', 'update-image', 'show-playtime', 'start-close-animation'];
  if (validChannels.includes(channel)) {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  }
},
send: (channel, data) => {
  const validChannels = ['refresh-ui-after-language-change', 'update-overlay-shortcut', 'close-playtime-window'];
  if (validChannels.includes(channel)) {
    ipcRenderer.send(channel, data);
  }
}
}
});

contextBridge.exposeInMainWorld('autoConfigApi', {
  generateConfigs: (folderPath) => ipcRenderer.invoke('generate-auto-configs', folderPath),
});

// --- Compat: preseturi vechi care folosesc window.electronAPI.onNotification
(function () {
  const normalizeFileUrl = (raw) => {
    if (!raw) return '';
    const s = String(raw);
    return s.startsWith('file://') ? s : `file:///${s.replace(/\\/g, '/')}`;
  };

  contextBridge.exposeInMainWorld('electronAPI', {
    onNotification: (cb) => {
      ipcRenderer.on('show-notification', (_e, data) => {
        // preferă iconPath calculat de main; dacă nu, cade pe icon
        const raw = data?.iconPath || data?.icon || '';
        const normalized = raw ? normalizeFileUrl(raw) : '';
        cb({
          ...data,
          icon: normalized,      // preset-urile vechi citesc .icon
          iconPath: normalized,  // preset-urile noi citesc .iconPath
        });
      });
    }
  });
})();
