# 🎮 Achievements

A desktop application built with Electron that monitors running games and displays beautiful animated notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays
- 📊 Real-time achievement dashboard

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
    - Alphabetical (A→Z / Z→A)
    - Progress (Low→High / High→Low)
    - Last Updated (Recent→Old / Old→Recent)
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
  - Adjustable position and scaling (All presets now supports maximum 200% scale)
  - Non-intrusive overlay system
  - Playtime header artwork cached locally for faster repeat notifications

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

1. Click "Generate Auto-Configs" and select your game saves directory
2. The app will:
   - Scan for game folders with numeric names (Steam AppIDs)
   - Fetch game info from Steam Store or Steam Hunters
   - Download achievement data and images using Steam API
   - Create pre-configured entries for each detected game
   - Add configs to your dashboard automatically

**Note**: Auto-configuration requires a Steam API key (optional) in `my_login.txt` with format: `key=YOUR_API_KEY`. Without a key, only English achievements will be fetched from SteamDB/Steam Hunters.

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
- Configure overlay shortcut or disable the overlay entirely
- Enable/disable features:
  - Achievement screenshots
  - Progress Notification
  - Playtime Notification
  - Startup behavior
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

https://youtu.be/4w8ENj3rlSY

## 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!
