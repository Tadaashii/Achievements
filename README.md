# 🎮 Achievements

A desktop application built with Electron that monitors running games and displays animated notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays
- 📊 Real-time achievement dashboard
- ?? Steam/Uplay/GOG/Epic schema support (auto-detected where possible)

## ✨ Features

- **Achievement Tracking**
  - Detects running games using their process names
  - Sends notifications with custom HTML/CSS animation
  - Real-time progress monitoring and updates
  - Screenshots achievements when unlocked (optional)
- **Smart Dashboard**
  - Grid view of all configured games
  - Real-time progress tracking per game
  - Multiple sorting options:
    - Alphabetical (A-Z / Z-A)
    - Progress (Low-High / High-Low)
    - Last Updated (Recent-Old / Old-Recent)
  - Quick game search and filtering
  - Click-to-load configs
  - Play game launch button (requires executable and optional arguments)
  - Automatically refreshes when config or save files change
- **Notification System**
  - Multiple notification types:
    - Achievement unlocks
    - Progress updates
    - Playtime tracking (Now Playing / Session Ended)
  - Customizable sounds and visual presets
  - Adjustable position, duration, and scaling (presets support up to 200%)
  - Non-intrusive overlay system
  - Playtime header artwork cached locally for faster repeat notifications
  - Per-game progress mute (when a config is active)
- **Playtime Tracker**
  - Detects when configured games start and stop via process monitoring
  - Stores total Playtime per config inside `%APPDATA%/Achievements/playtime-totals.json`
  - Shows Playtime totals in the Achievements panel
  - Triggers dedicated notifications rendered by `playtime.html`
- **Customization**
  - Modern settings UI with tabs
  - Multiple visual themes/presets
  - Startup options (maximized/minimized)
  - UI scaling (75% to 200%)
  - Achievement duration slider (auto or custom)
  - Achievement sound volume (0% to 200%)
  - Show hidden descriptions (when available)
  - Close-to-tray option
  - Multi-language support for achievements

## 📁 Project Structure

| File/Folder                             | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `main.js`                               | Main Electron process: window handling, core logic   |
| `playtime-log-watcher.js`               | Tracks game start/stop and calculates total playtime |
| `index.html`                            | Main UI with dashboard and config management         |
| `overlay.html`                          | Achievement notification overlay                     |
| `playtime.html`                         | Playtime notification template                       |
| `progress.html`                         | Progress notification template                       |
| `playtime-totals.json`                  | Runtime-generated playtime totals per config         |
| `utils/`                                | Helper modules and utilities:                        |
| `utils/auto-config-generator.js`        | Auto-generates game configs from save directories    |
| `utils/generate_achievements_schema.js` | Scrapes achievement data from Steam API/Web          |
| `utils/paths.js`, etc.                  | Other utility modules                                |
| `presets/`                              | Scalable and non-scalable notification themes        |
| `sounds/`                               | Notification sound assets                            |
| `style.css`                             | Global styling for all UI components                 |

## 🛠️ Installation

1. Install [Node.js](https://nodejs.org) and [Git](https://git-scm.com).
2. Clone this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/achievements.git
   cd achievements
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## 🚀 Running the App

```bash
npm start

```

## 🧱 Building a Windows Executable

```bash
npm run dist

```

Creates a standalone `.exe` installer in the `dist/` folder.

## 📦 Dependencies

### Core

- [Electron](https://electronjs.org) - Cross-platform desktop application framework
- [ps-list](https://www.npmjs.com/package/ps-list) - Process monitoring
- [crc-32](https://www.npmjs.com/package/crc-32) - Checksum calculation

### Achievement Processing

- [Playwright](https://playwright.dev) - Browser automation for achievement scraping
- [axios](https://www.npmjs.com/package/axios) - HTTP client for Steam API
- [cheerio](https://www.npmjs.com/package/cheerio) - HTML parsing
- [jsdom](https://www.npmjs.com/package/jsdom) - DOM environment

### Features

- [screenshot-desktop](https://www.npmjs.com/package/screenshot-desktop) - Achievement screenshot capture (optional install)
- [ws](https://www.npmjs.com/package/ws) - WebSocket support
- [ini](https://www.npmjs.com/package/ini) - Config file parsing

### Background Services

- `chokidar` keeps config/save directories under watch to trigger UI refreshes
- `ps-list` (via `utils/pslist-wrapper.mjs`) provides process snapshots for auto-selection and playtime tracking
- Interval timers (~2s) keep dashboard cards and playtime state up to date

## 🎮 Setup & Configuration

### Quick Start (Tutorial)

1. Open **Settings** and set Preset, and Scale.
2. Add your **Watched Folders** (recommended) so the app can detect saves/emulators.
3. Start a game once so its save folder appears; the watcher will auto-create a config when possible.
4. Let the game identify and auto-select the config, or Select the config manually, set your Language to view achievements, progress, and playtime.
5. Optional: mute progress notifications for that config using the checkbox under the config dropdown.

### Basic Setup

#### Manual Configuration

1. Create a new config with:
   - **Name**: Your preferred identifier
   - **AppID**: Steam AppID or folder name for achievements
   - **Config Path**: Location of achievements.json and images / Leave empty to generate
   - **Save Path**: Where achievement progress is stored
   - **Executable** (optional): Direct path to game executable
   - **Arguments** (optional): Launch parameters
   - **Process Name** (optional): Specific .exe name to monitor
   - _Note_: Names are sanitized (illegal filename characters removed, condensed spacing) before saving; the sanitized name is used on disk and for playtime totals.

#### Auto Configuration

1. Use **Watched Folders** (recommended) to scan your emulator/save directories.
2. The app will:
   - detect AppIDs and platform,
   - fetch game name + schema,
   - download achievement data and images when available,
   - generate configs automatically.
3. Default watched folders include:
   - %PUBLIC%\Documents\Steam\CODEX
   - %PUBLIC%\Documents\Steam\RUNE
   - %PUBLIC%\Documents\OnlineFix
   - %PUBLIC%\Documents\EMPRESS
   - %APPDATA%\Goldberg SteamEmu Saves
   - %APPDATA%\GSE Saves
   - %APPDATA%\EMPRESS
   - %LOCALAPPDATA%\anadius\LSX emu\achievement_watcher
   - %APPDATA%\Steam\CODEX
   - %APPDATA%\SmartSteamEmu
   - %LOCALAPPDATA%\SKIDROW

**Note**: Auto-configuration uses the Steam Web API when a key is provided in Settings. Without a key, it falls back to SteamDB/SteamHunters (English only).

### Dashboard

- Press the "Show Dashboard" button to access the game grid
- Use search to filter games quickly
- Sort by name, progress, or last update time
- Click any game to load its config
- Use the play button for games with configured executables (dashboard closes and returns focus to the main UI)
- Automatic background polling selects the active game when its process starts
- `Esc` or the close button restores the dashboard overlay and re-enables input for the rest of the window

### Customization

- Choose notification preset and screen position
- Select notification sounds and language
- Adjust UI scale (75% to 200%)
- Adjust achievement duration (auto or custom)
- Adjust achievement sound volume (0% to 200%)
- Toggle Show Hidden Description for hidden achievements
- Enable Close to Tray (X button hides to tray)
- Configure overlay shortcut or disable the overlay entirely
- Enable/disable features:
  - Achievement screenshots
  - Progress Notification
  - Playtime Notification
  - Startup behavior
- Per-game progress notifications can be muted when a config is active
- Toggle "Start with Windows" to create/remove a Task Scheduler entry using the current executable path
- All preferences persist to `%APPDATA%/Achievements/preferences.json` and are restored on startup

### Keyboard & Controller Navigation

- **Keyboard shortcuts**
  - `Esc` / `Backspace` backs out of the current overlay or clears the selected config.
  - `F1` / `Ctrl+O` opens Settings; `F2` / `Ctrl+D` toggles the Dashboard; `F3` Show/Hide the Options panel.
  - `Ctrl+F` focuses dashboard search, `P` or `Ctrl/Shift + Enter` launch the currently selected game.
  - Arrow keys, `Home`, `End`, and `Enter` drive focus inside lists, dashboard cards, and settings panels.
  - `PageUp` / `PageDown` perform full-page scrolling; `Alt+1/2/3` change dashboard sorting while it is open.
- **Controller support**
  - D-pad or left stick moves focus; `A` confirms, `B` backs out, `Y` opens the Dashboard, `X` Show/Hide Options/search on Dashboard.
  - `Select/Back` toggles Settings, `Start/Options` launches the active game.
  - `LB`/`RB` cycle settings tabs, `LB`/`RB`/`R3` cycle dashboard sort modes when the dashboard overlay is active.
  - Right stick provides smooth scrolling; triggers respect repeat delays so hold-to-scroll feels natural.

### Game Compatibility

- Works best with games in Borderless window mode
- Limited support for Fullscreen mode
- Automatically detects and imports existing achievements
- Supports multiple achievement languages if available in Config

### Videos

https://youtu.be/fsqoKiMGLkw
https://youtu.be/nOoiU5lPopM

## 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!
