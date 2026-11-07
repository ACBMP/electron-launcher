const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('api', {
	login: (u, p) => ipcRenderer.invoke('login', u, p),
	discordLogin: () => ipcRenderer.invoke('discord-login'),
	// Consent now happens in the system browser, where a closed tab is
	// invisible to us — the user needs a way to say they gave up.
	cancelDiscordLogin: () => ipcRenderer.invoke('cancel-discord-login'),
	validateSession: () => ipcRenderer.invoke('session-validate'),
	logout: () => ipcRenderer.invoke('logout'),

	// Registration. The signed ticket proving Discord ownership stays in the
	// main process between these two calls; the renderer never handles it.
	registerStart: () => ipcRenderer.invoke('register-start'),
	registerSubmit: profile => ipcRenderer.invoke('register-submit', profile),
	registerOptions: () => ipcRenderer.invoke('register-options'),
	checkName: name => ipcRenderer.invoke('check-name', name),
	openRegisterPage: () => ipcRenderer.invoke('open-register-page'),
	pendingRegistration: () => ipcRenderer.invoke('pending-registration'),
	openLoginPage: () => ipcRenderer.invoke('open-login-page'),

	// Launcher updates.
	getAppVersion: () => ipcRenderer.invoke('get-app-version'),
	checkLauncherUpdate: () => ipcRenderer.invoke('check-launcher-update'),
	checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
	installUpdate: () => ipcRenderer.invoke('install-update'),
	onUpdateStatus: callback =>
		ipcRenderer.on('update-status', (event, data) => callback(data)),

    openExternal: (url) => ipcRenderer.invoke("open-external", url),
	// The Play button only starts the game itself on Windows; elsewhere the
	// player launches it through Wine/Proton.
	platform: process.platform,
	patchCheck: (game, options) => ipcRenderer.invoke('patch-check', game, options),

	// Options read from the game's own .ini files, each with its current value.
	getGameSettings: (game) => ipcRenderer.invoke('get-game-settings', game),
	setGameSettings: (game, values) => ipcRenderer.invoke('set-game-settings', game, values),
	detectGamePath: () => ipcRenderer.invoke('detect-game-path'),
	launchGame: (config, username) => ipcRenderer.invoke('launch-game', config, username),
	getConfig: () => ipcRenderer.invoke('get-config'),
	setConfig: cfg => ipcRenderer.invoke('set-config', cfg),
	pickInstallDir: () => ipcRenderer.invoke('pick-install-dir'),
	openPlayPage: () => ipcRenderer.invoke('open-play-page'),
	openSettingsPage: () => ipcRenderer.invoke('open-settings-page'),
	openStatsPage: () => ipcRenderer.invoke('open-stats-page'),
	openNewsPage: () => ipcRenderer.invoke('open-news-page'),
	getStats: (username) => ipcRenderer.invoke('get-stats', username),
	getBoard: (mode) => ipcRenderer.invoke('get-board', mode),
	getMedalHTML,
	getBadgeText,
    getBoards: () => ipcRenderer.invoke("get-boards"),
    installGame: (config, game) => ipcRenderer.invoke("install-game", config, game),
    onInstallProgress: (callback) => ipcRenderer.on("install-progress", (event, data) => callback(data)),
    onInstallLog: (callback) => ipcRenderer.on("install-log", (event, data) => callback(data)),
});

function getMedalHTML(badge) {
    const rank = badge.rank;

    switch (rank) {
        case "1st": return "&#129351;";
        case "2nd": return "&#129352;";
        case "3rd": return "&#129353;";
        case "Trophy": return "&#127942;";
        case "Rookie": return "&#128304;";
        case "Special": return "&#127941;";
        case "All-Star": return "&#11088;";
        case "Custom":
            return badge.medal?.HTML || "🏅";
        default:
            return "🏅";
    }
}

function getBadgeText(badge) {
    if (["Trophy", "All-Star", "Custom", "Special"].includes(badge.rank)) {
        return badge.name || "Unnamed Badge";
    }

    if (badge.rank === "Rookie") {
        return `Season ${badge.season} Rookie of the Season`;
    }

    return `Season ${badge.season} ${badge.mode} ${badge.rank} Place`;
}
