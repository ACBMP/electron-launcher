let mainWindow;
const {app, dialog, BrowserWindow, ipcMain, shell} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

const API_BASE = 'https://api.assassins.network';

function readConfig() {
	return fs.existsSync(CONFIG_PATH)
		? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
		: {};
}

function writeConfig(config) {
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Read config
ipcMain.handle('get-config', async () => readConfig());

// Save config
ipcMain.handle('set-config', async (event, newConfig) => {
	const merged = {...readConfig(), ...newConfig};
	writeConfig(merged);
	return merged;
});

// Folder picker
ipcMain.handle('pick-install-dir', async () => {
	const result = await dialog.showOpenDialog({
		properties: ['openDirectory', 'createDirectory'],
	});
	if (result.canceled || result.filePaths.length === 0) {
		return null;
	}

	return result.filePaths[0];
});

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 800,
		height: 600,
		// assets/ is bundled into the app; build/ (buildResources) is not, so the
		// runtime window icon must come from assets/.
		icon: path.join(__dirname, 'assets', 'icon.png'),
		webPreferences: {
			preload: __dirname + '/preload.js',
			// Security: these belong inside webPreferences — set outside it they
			// were silently ignored. Keep the renderer isolated from Node.
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Absolute, like every other loadFile here: a relative path resolves
	// against the working directory, which isn't the app directory when the
	// launcher is started from anywhere but its own folder.
	mainWindow.loadFile(path.join(__dirname, 'login.html'));
}

// Auto-update via electron-updater + GitHub Releases. Only runs in a packaged
// build — dev (`npm start`) has no update feed and shouldn't check. The feed is
// configured by electron-builder from package.json `build.publish`.
//
// The API's /launcher/latest is the *policy* layer on top of this (see
// 'check-launcher-update'): electron-updater moves the bits, while the API says
// what's current and what's too old to keep playing.
let autoUpdater = null;

function loadAutoUpdater() {
	if (autoUpdater || !app.isPackaged) {
		return autoUpdater;
	}

	try {
		({autoUpdater} = require('electron-updater'));
	} catch {
		return null; // dependency not present; skip silently
	}

	return autoUpdater;
}

// Relay updater progress to whichever page is open so the UI can show it,
// instead of the download happening invisibly.
function sendToRenderer(channel, payload) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(channel, payload);
	}
}

function initAutoUpdater() {
	const updater = loadAutoUpdater();
	if (!updater) {
		return;
	}

	updater.autoDownload = true;
	updater.on('error', err => {
		console.error('Auto-update error:', err ? (err.stack || err).toString() : 'unknown');
		sendToRenderer('update-status', {state: 'error', error: String(err?.message || err)});
	});
	updater.on('update-available', info => {
		sendToRenderer('update-status', {state: 'available', version: info?.version});
	});
	updater.on('update-not-available', () => {
		sendToRenderer('update-status', {state: 'current'});
	});
	updater.on('download-progress', p => {
		sendToRenderer('update-status', {state: 'downloading', percent: Math.round(p?.percent || 0)});
	});
	updater.on('update-downloaded', info => {
		sendToRenderer('update-status', {state: 'ready', version: info?.version});
	});

	updater.checkForUpdates().catch(err => {
		console.error('Auto-update check failed:', err);
	});
}

ipcMain.handle('get-app-version', () => app.getVersion());

// Ask the API what the current/minimum launcher versions are. `updateRequired`
// means this build is older than the minimum the server still supports and must
// not be allowed to play.
ipcMain.handle('check-launcher-update', async () => {
	const version = app.getVersion();

	try {
		const res = await fetch(
			`${API_BASE}/launcher/latest?version=${encodeURIComponent(version)}`,
		);

		if (!res.ok) {
			return {currentVersion: version, unavailable: true};
		}

		const data = await res.json();
		return {...data, currentVersion: version};
	} catch {
		// Never block play because the version check itself failed.
		return {currentVersion: version, unavailable: true};
	}
});

ipcMain.handle('check-for-updates', async () => {
	const updater = loadAutoUpdater();

	if (!updater) {
		return {success: false, error: 'Updates are only available in an installed build'};
	}

	try {
		await updater.checkForUpdates();
		return {success: true};
	} catch (error) {
		return {success: false, error: error.message};
	}
});

ipcMain.handle('install-update', () => {
	const updater = loadAutoUpdater();

	if (!updater) {
		return {success: false};
	}

	// Restarts into the installer; nothing after this runs.
	setImmediate(() => updater.quitAndInstall());
	return {success: true};
});

app.whenReady().then(() => {
	createWindow();
	initAutoUpdater();
});

ipcMain.handle('ping', async () => 'pong');

// Username + password login. Kept as an alternative to Discord OAuth; note that
// no players currently have passwords set (see docs/AUTH_API.md).
ipcMain.handle('login', async (_, username, password) => {
	try {
		const res = await fetch(`${API_BASE}/auth/login`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({username, password}),
		});

		const data = await res.json().catch(() => ({}));

		if (!res.ok || !data.token) {
			return {success: false, error: data.error || 'Invalid credentials'};
		}

		const config = readConfig();
		config.username = data.username ?? username;
		config.token = data.token;
		writeConfig(config);

		return {success: true, username: config.username};
	} catch {
		return {success: false, error: 'Could not reach the auth server'};
	}
});

// Discord OAuth2 (Authorization Code) flow.
//
// The Discord client secret must never live in the launcher, so the actual
// token exchange happens server-side. The launcher only:
//   1. asks the API for an authorize URL (+ the redirect URI to watch for),
//   2. sends the user to Discord's consent screen,
//   3. captures the returned `code` from the redirect, and
//   4. hands the code to the API, which exchanges it.
//
// Step 2 uses the *system browser*, not an Electron window. An Electron window
// has its own cookie jar, so it never sees that the user is already signed in
// to Discord and makes them retype their password and 2FA on every login. The
// redirect is caught on a loopback listener, which is the pattern RFC 8252
// recommends for native apps (and avoids registering a custom URL scheme).
//
// Discord matches redirect URIs exactly, so LOOPBACK_PORT has to be registered
// on the Discord application as well. If the port can't be bound, or the API
// doesn't accept a loopback redirect, we fall back to the old in-app window
// rather than leaving the user unable to log in at all.
//
// Shared by sign-in and sign-up: both need to prove control of a Discord
// account, and only the API call afterwards differs.
const LOOPBACK_PORT = 8975;
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;

// Long enough to find the browser window, log in and clear 2FA; short enough
// that an abandoned attempt doesn't pin the port forever.
const OAUTH_TIMEOUT = 5 * 60 * 1000;

const LOOPBACK_PAGE =
	'<!doctype html><title>Assassins\' Network</title>' +
	"<body style='font-family:sans-serif;background:#131313;color:#e5e2e1;" +
	"display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
	'<p>Sign-in complete. You can close this tab and return to the launcher.</p>' +
	'</body>';

// Lets the renderer abandon a login the user walked away from, since a browser
// tab closing is invisible to us.
let cancelOAuth = null;

// Serves exactly one redirect on the loopback interface. Resolves with null if
// the port is unavailable, so the caller can fall back.
function listenForRedirect() {
	return new Promise(resolve => {
		let deliver = null;
		const received = new Promise(inner => {
			deliver = inner;
		});

		const server = http.createServer((req, res) => {
			const target = new URL(req.url, LOOPBACK_REDIRECT);

			// Only the redirect itself counts. Without this a stray request —
			// the browser asking for /favicon.ico after rendering our page, say
			// — would resolve the login with no code at all.
			if (target.pathname !== '/callback') {
				res.writeHead(404);
				res.end();
				return;
			}

			res.writeHead(200, {'Content-Type': 'text/html'});
			res.end(LOOPBACK_PAGE);

			deliver({
				code: target.searchParams.get('code'),
				state: target.searchParams.get('state'),
				error: target.searchParams.get('error'),
			});
		});

		server.once('error', () => resolve(null));

		server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
			resolve({
				received,
				close: () => server.close(),
			});
		});
	});
}

// The original flow: Discord's consent screen inside a modal window. Kept as a
// fallback for when the loopback listener can't be set up.
function consentWindow(url, redirectUri) {
	return new Promise(resolve => {
		const authWindow = new BrowserWindow({
			width: 500,
			height: 800,
			parent: mainWindow,
			modal: true,
			autoHideMenuBar: true,
			title: 'Sign in with Discord',
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
			},
		});
		authWindow.setMenu(null);

		let settled = false;
		const finish = value => {
			if (settled) {
				return;
			}

			settled = true;
			resolve(value);
			if (!authWindow.isDestroyed()) {
				authWindow.close();
			}
		};

		const onNavigate = (event, targetUrl) => {
			if (!targetUrl.startsWith(redirectUri)) {
				return;
			}

			// Don't actually load the redirect target; we only want its query.
			event.preventDefault();

			const params = new URL(targetUrl).searchParams;
			const error = params.get('error');
			if (error) {
				finish({error});
				return;
			}

			finish({code: params.get('code'), state: params.get('state')});
		};

		authWindow.webContents.on('will-redirect', onNavigate);
		authWindow.webContents.on('will-navigate', onNavigate);
		authWindow.on('closed', () => finish({error: 'cancelled'}));

		authWindow.loadURL(url);
	});
}

async function requestAuthorizeUrl(redirectUri) {
	const query = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : '';

	const res = await fetch(`${API_BASE}/auth/discord/authorize${query}`);
	return res.json();
}

async function runDiscordOAuth() {
	const listener = await listenForRedirect();

	let authorize;
	try {
		authorize = await requestAuthorizeUrl(listener ? LOOPBACK_REDIRECT : null);
	} catch {
		listener?.close();
		return {error: 'Could not reach the auth server'};
	}

	const {url, redirectUri} = authorize;
	if (!url || !redirectUri) {
		listener?.close();
		return {error: authorize.error || 'Malformed authorize response'};
	}

	// The API refused the loopback URI (older deployment, or it isn't in its
	// allowlist) and handed back the hosted one instead. Nothing would ever
	// arrive on our listener, so use the in-app window for this attempt.
	if (!listener || redirectUri !== LOOPBACK_REDIRECT) {
		listener?.close();
		return consentWindow(url, redirectUri);
	}

	const timeout = new Promise(resolve => {
		const timer = setTimeout(
			() => resolve({error: 'Timed out waiting for Discord'}),
			OAUTH_TIMEOUT,
		);

		// Don't hold the process open just to wait for a login nobody is doing.
		timer.unref?.();
	});

	const cancelled = new Promise(resolve => {
		cancelOAuth = () => resolve({error: 'cancelled'});
	});

	try {
		// Inside the try: if the browser can't be opened at all, the finally
		// still releases the port instead of holding it until the app quits.
		await shell.openExternal(url);

		const result = await Promise.race([listener.received, timeout, cancelled]);

		// Bring the launcher back in front of the browser the user was just in.
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.show();
			mainWindow.focus();
		}

		return result;
	} catch {
		// Every caller expects {error}; a rejection here would surface to the
		// renderer as a broken IPC call with nothing to show the user.
		return {error: 'Could not open your browser'};
	} finally {
		cancelOAuth = null;
		listener.close();
	}
}

ipcMain.handle('cancel-discord-login', () => {
	cancelOAuth?.();
	return {success: true};
});

function isOk(status) {
	return status >= 200 && status < 300;
}

// Hand the OAuth code to our API (which holds the client secret) and let it
// resolve the Discord identity to a player. Returns the parsed body plus the
// HTTP status so callers can tell "no account yet" from a real failure.
async function exchangeDiscordCode({code, state}) {
	const res = await fetch(`${API_BASE}/auth/discord/callback`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({code, state}),
	});

	return {status: res.status, data: await res.json().catch(() => ({}))};
}

// A signed ticket from the API proving we just verified a Discord identity that
// has no player yet. Held in the main process — never handed to the renderer —
// and spent by 'register-submit'.
let pendingRegistration = null;

function persistSession(data) {
	const config = readConfig();
	config.username = data.username;
	config.token = data.token;
	config.discordId = data.discordId;
	writeConfig(config);
}

ipcMain.handle('discord-login', async () => {
	const result = await runDiscordOAuth();

	if (result.error) {
		return {success: false, error: result.error};
	}

	if (!result.code) {
		return {success: false, error: 'No authorization code returned'};
	}

	try {
		const {status, data} = await exchangeDiscordCode(result);

		// The Discord account is valid but has no player. Stash the ticket and
		// tell the renderer to send the user into sign-up rather than showing
		// an error they can't act on.
		if (status === 404 && data.needsRegistration) {
			pendingRegistration = {
				ticket: data.registration?.ticket,
				suggestedName: data.registration?.suggestedName,
			};

			return {
				success: false,
				needsRegistration: true,
				suggestedName: pendingRegistration.suggestedName,
			};
		}

		if (!isOk(status) || !data.token) {
			return {success: false, error: data.error || 'Authentication failed'};
		}

		persistSession(data);

		return {success: true, username: data.username};
	} catch {
		return {success: false, error: 'Could not complete Discord sign-in'};
	}
});

// Step 1 of sign-up: verify a Discord identity and confirm it has no account.
ipcMain.handle('register-start', async () => {
	const result = await runDiscordOAuth();

	if (result.error) {
		return {success: false, error: result.error};
	}

	if (!result.code) {
		return {success: false, error: 'No authorization code returned'};
	}

	try {
		const {status, data} = await exchangeDiscordCode(result);

		if (status === 404 && data.needsRegistration) {
			pendingRegistration = {
				ticket: data.registration?.ticket,
				suggestedName: data.registration?.suggestedName,
			};

			return {success: true, suggestedName: pendingRegistration.suggestedName};
		}

		// Already has an account — sign them in instead of making them register.
		if (isOk(status) && data.token) {
			persistSession(data);
			return {success: false, alreadyRegistered: true, username: data.username};
		}

		return {success: false, error: data.error || 'Could not verify your Discord account'};
	} catch {
		return {success: false, error: 'Could not reach the auth server'};
	}
});

// Step 2 of sign-up: trade the stashed ticket + invite code + profile for an
// account and a session.
ipcMain.handle('register-submit', async (_, profile) => {
	if (!pendingRegistration?.ticket) {
		return {success: false, error: 'Link your Discord account first'};
	}

	try {
		const res = await fetch(`${API_BASE}/auth/register`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({...profile, ticket: pendingRegistration.ticket}),
		});

		const data = await res.json().catch(() => ({}));

		if (!res.ok || !data.token) {
			return {success: false, error: data.error || 'Registration failed'};
		}

		persistSession(data);
		pendingRegistration = null;

		return {success: true, username: data.username};
	} catch {
		return {success: false, error: 'Could not reach the auth server'};
	}
});

// Field constraints (platform list, name rules) come from the server so the
// form doesn't hardcode rules that can change.
ipcMain.handle('register-options', async () => {
	try {
		const res = await fetch(`${API_BASE}/auth/register/options`);
		return await res.json();
	} catch {
		return {platforms: ['PC', 'PS3', 'PS4', 'Xbox'], maxIgns: 5};
	}
});

ipcMain.handle('check-name', async (_, name) => {
	try {
		const res = await fetch(
			`${API_BASE}/auth/register/availability?name=${encodeURIComponent(name)}`,
		);
		return await res.json();
	} catch {
		return {available: null};
	}
});

// Validate a stored session token (used for silent auto-login on launch).
ipcMain.handle('session-validate', async () => {
	const config = readConfig();
	if (!config.token) {
		return {success: false};
	}

	try {
		const res = await fetch(`${API_BASE}/auth/session`, {
			headers: {Authorization: `Bearer ${config.token}`},
		});
		return {success: res.ok};
	} catch {
		return {success: false};
	}
});

// Clear the local session and (best-effort) revoke it server-side.
ipcMain.handle('logout', async () => {
	const config = readConfig();

	if (config.token) {
		try {
			await fetch(`${API_BASE}/auth/logout`, {
				method: 'POST',
				headers: {Authorization: `Bearer ${config.token}`},
			});
		} catch {
			// Ignore network errors; we still clear the local session below.
		}
	}

	delete config.token;
	delete config.rememberMe;
	writeConfig(config);
	return {success: true};
});

ipcMain.handle('open-register-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'register.html'));
});

// Lets the register page skip the Discord step when OAuth already happened —
// e.g. a sign-in attempt that found no account. Asked over IPC rather than
// passed as a query param so the ticket's existence stays the single source of
// truth: a renderer can't claim to be linked, and a stale link can't outlive
// the ticket. Only the display name crosses the bridge.
ipcMain.handle('pending-registration', () => ({
	linked: Boolean(pendingRegistration?.ticket),
	suggestedName: pendingRegistration?.suggestedName || '',
}));

ipcMain.handle('open-login-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'login.html'));
});

// Each game gets its own folder under the install path. install-game creates
// it and the patch manifest's file_location paths are relative to it, so every
// other place that touches game files has to agree on this.
//
// Players who already had the game often pick the game folder itself (the one
// with ACBMP.exe in it) instead of a parent folder. Use that folder as-is
// rather than creating a second copy inside it.
function gameDir(installPath, game) {
	const nested = path.join(installPath, game);
	if (!fs.existsSync(nested) && fs.existsSync(path.join(installPath, 'ACBMP.exe'))) {
		return installPath;
	}
	return nested;
}

// The patch manifest changes only when a patch is released, but every page
// navigation is a full document load that re-runs the status checks. Cache the
// network round-trip briefly so moving between Play and Settings doesn't
// re-fetch something that can't have changed in the meantime.
const MANIFEST_TTL = 60_000;
const manifestCache = new Map();

async function patchManifest(game, {force = false} = {}) {
	const cached = manifestCache.get(game);

	if (!force && cached && Date.now() - cached.at < MANIFEST_TTL) {
		return cached.data;
	}

	const data = await fetch(`${API_BASE}/patch/${game}/latest`).then(r => r.json());
	manifestCache.set(game, {at: Date.now(), data});
	return data;
}

ipcMain.handle('patch-check', async (_, game, options) => {
	const config = readConfig();

	config.games ||= {};

	if (!config.games[game]) {
		config.games[game] = {installedVersion: null};
		writeConfig(config);
	}

	const gameData = config.games[game];

	const patchData = await patchManifest(game, options);

	if (!config.installPath) {
		return {installed: false, upToDate: false, version: patchData.version};
	}

	// Not cached: a cheap stat, and it's the half that changes when the user
	// installs or deletes files behind our back.
	const installed = fs.existsSync(path.join(gameDir(config.installPath, game), 'ACBMP.exe'));

	return {
		installed,
		upToDate: installed && gameData.installedVersion === patchData.version,
        version: patchData.version,
	};
});

// --- INI files -------------------------------------------------------------
//
// The game's .ini files are hand-editable and hold sections and keys the
// launcher knows nothing about, so we rewrite individual entries in place
// rather than parsing to an object and serialising it back out. Comments,
// ordering, spacing and unknown keys all survive untouched.
//
// A leading ';' or '#' can't match ENTRY_RE, so commented-out entries are left
// alone instead of being silently uncommented.
const INI_SECTION = /^\s*\[([^\]]+)]\s*$/;
const INI_ENTRY = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/;

// Every entry in file order, with the comment lines directly above it joined
// into one string — the settings page shows that as the option's help.
function readIniEntries(text) {
	const entries = [];
	let section = '';
	let comments = [];

	for (const line of text.split(/\r?\n/)) {
		const heading = line.match(INI_SECTION);

		if (heading) {
			section = heading[1];
			comments = [];
			continue;
		}

		const comment = line.match(/^\s*[;#]\s?(.*)$/);

		if (comment) {
			// A commented-out entry (";Foo=1") is a disabled option, not a
			// description of the next one. Prose like "false = off" has
			// spaces, which a bare entry doesn't.
			if (!/^[A-Za-z0-9_.-]+=\S*$/.test(comment[1])) {
				comments.push(comment[1].trim());
			}

			continue;
		}

		const entry = line.match(INI_ENTRY);

		if (entry) {
			entries.push({section, name: entry[2], raw: entry[4].trim(), comment: comments.join(' ')});
		}

		comments = [];
	}

	return entries;
}

// `updates` is keyed "Section.Key" with the casing to use if the key has to be
// created. Returns the new file text.
function writeIni(text, updates) {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);

	const pending = new Map();
	for (const [key, value] of Object.entries(updates)) {
		const dot = key.lastIndexOf('.');
		pending.set(key.toLowerCase(), {
			section: key.slice(0, dot),
			name: key.slice(dot + 1),
			value: String(value),
		});
	}

	// Pass 1: rewrite entries that already exist, keeping their spelling and
	// alignment.
	let section = '';
	const rewritten = lines.map(line => {
		const heading = line.match(INI_SECTION);

		if (heading) {
			section = heading[1];
			return line;
		}

		const entry = line.match(INI_ENTRY);

		if (!entry) {
			return line;
		}

		const key = `${section}.${entry[2]}`.toLowerCase();
		const update = pending.get(key);

		if (!update) {
			return line;
		}

		pending.delete(key);
		return `${entry[1]}${entry[2]}${entry[3]}${update.value}`;
	});

	if (pending.size === 0) {
		return rewritten.join(eol);
	}

	// Pass 2: anything left didn't exist yet. Insert it at the end of its
	// section rather than appending a second [Section] header at the bottom —
	// both parse, but only one still looks like the file the game ships.
	const sectionEnd = new Map();
	section = '';
	rewritten.forEach((line, index) => {
		const heading = line.match(INI_SECTION);

		if (heading) {
			section = heading[1].toLowerCase();
			sectionEnd.set(section, index + 1);
			return;
		}

		if (line.trim()) {
			sectionEnd.set(section, index + 1);
		}
	});

	const missing = new Map();
	for (const {section: name, name: key, value} of pending.values()) {
		const list = missing.get(name) || [];
		list.push(`${key}=${value}`);
		missing.set(name, list);
	}

	const inserts = [];
	for (const [name, entries] of missing) {
		const at = sectionEnd.get(name.toLowerCase());

		if (at === undefined) {
			// Blank line before the new heading, unless the file already ends
			// in one.
			const spacer = rewritten.at(-1)?.trim() ? [''] : [];
			inserts.push({at: rewritten.length, lines: [...spacer, `[${name}]`, ...entries]});
		} else {
			inserts.push({at, lines: entries});
		}
	}

	// Descending, so an earlier insertion can't shift a later index.
	inserts.sort((a, b) => b.at - a.at);
	for (const {at, lines: added} of inserts) {
		rewritten.splice(at, 0, ...added);
	}

	return rewritten.join(eol);
}

// --- Game settings ---------------------------------------------------------
//
// The settings page offers whatever options the game's own .ini files contain,
// so a patch that adds, renames or drops a key changes the page without a
// launcher release. Each option's type is inferred from its current value, and
// a `;` comment directly above a key becomes its help text.
//
// Every file lives in the game folder and is the patch's to deliver; we only
// ever edit what's already there and never author one.
//
// `hide` drops sections that aren't player-facing choices; `only` limits a file
// to the listed Section.Key entries.
const SETTING_FILES = [
	{file: 'patch.ini', hide: ['Logging', 'Diagnostics', 'SpawnPositionOverride']},
	{file: 'ac_relay.ini'},
	// claudia.ini also carries the credentials and redirect host the launcher
	// manages itself, so only this one fix is offered.
	{file: 'claudia.ini', only: ['Fixes.FixXInputDetection']},
];

// Optional hand-written copy, for keys whose file has no comments to draw on.
// Purely cosmetic: an option appears whether or not it's listed here, and an
// entry for a key the file no longer has is simply never used. `min`/`max`
// turn a number field into a slider.
const SETTING_COPY = {
	'patch.ini:Graphics.Enabled': {label: 'Graphics tweaks', help: 'Master switch for the patch’s rendering changes.'},
	'patch.ini:Graphics.UnlockFPS': {label: 'Unlock frame rate', help: 'Removes the default 60 FPS cap.'},
	'patch.ini:Graphics.ForceBestLod': {label: 'Full render distance', help: 'Forces the highest level of detail at any distance.'},
	'patch.ini:Input.AC4Controls': {label: 'AC4-style controls', help: 'Uses the Black Flag control scheme.'},
	'patch.ini:Input.FixCameraDamping': {label: 'Fix camera damping', help: 'Enables the damping values below.'},
	'patch.ini:Input.CameraDampingGamepad': {label: 'Camera damping (gamepad)', min: 0, max: 100, step: 0.5},
	'patch.ini:Input.CameraDampingKbm': {label: 'Camera damping (mouse)', min: 0, max: 100, step: 0.5},
	'claudia.ini:Fixes.FixXInputDetection': {group: 'Input', label: 'XInput controller fix', help: 'Lets the game see modern XInput controllers.'},
};

// "UnlockFPS" -> "Unlock FPS", "AimLockPriority" -> "Aim Lock Priority", while
// "IPv6" stays whole.
function humanize(name) {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2');
}

function inferType(raw) {
	if (/^(true|false)$/i.test(raw)) {
		return 'bool';
	}

	return /^-?\d+(\.\d+)?$/.test(raw) ? 'number' : 'text';
}

function coerceSetting(type, raw) {
	if (type === 'bool') {
		return raw.toLowerCase() === 'true';
	}

	return type === 'number' ? Number.parseFloat(raw) : raw;
}

// Written back in the same shape the file used, so an edited file still looks
// like the one the patch shipped: 25.000000 stays six decimals, 80 stays an
// integer.
function formatSetting(option, value) {
	if (option.type === 'bool') {
		return value ? 'true' : 'false';
	}

	if (option.type === 'number') {
		const decimals = option.raw.split('.')[1]?.length ?? 0;
		return Number(value).toFixed(decimals);
	}

	return String(value);
}

// The options one file offers, as the settings page should present them.
function fileOptions(spec, text) {
	const options = [];

	for (const entry of readIniEntries(text)) {
		const id = `${entry.section}.${entry.name}`;

		if (spec.hide?.includes(entry.section) || (spec.only && !spec.only.includes(id))) {
			continue;
		}

		const key = `${spec.file}:${id}`;
		const copy = SETTING_COPY[key] || {};
		const type = inferType(entry.raw);

		options.push({
			key,
			file: spec.file,
			id,
			raw: entry.raw,
			type,
			group: copy.group || humanize(entry.section),
			label: copy.label || humanize(entry.name),
			help: copy.help || entry.comment,
			min: copy.min,
			max: copy.max,
			step: copy.step ?? (entry.raw.includes('.') ? 'any' : 1),
			secret: /password|secret|token/i.test(entry.name),
		});
	}

	return options;
}

// The installed copy of a settings file, or — before the game is installed —
// the pristine one from the patch's file server, so the page can show the
// defaults up front. Null when neither exists.
async function readSettingFile(installPath, game, file) {
	if (installPath) {
		try {
			return await fs.promises.readFile(path.join(gameDir(installPath, game), file), 'utf8');
		} catch {
			// Not installed yet; try the file server below.
		}
	}

	try {
		const manifest = await patchManifest(game);

		if (!manifest.files?.some(entry => entry.file_location === file)) {
			return null;
		}

		const res = await fetch(`${manifest.file_server}/${file}`, {signal: AbortSignal.timeout(10_000)});
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}

// Every option on offer, each carrying its current value: the player's stored
// choice if they made one, otherwise what the file says.
//
// The stored choice wins over the file because the files belong to the patch:
// install-game hash-checks them and re-downloads any that differ, so a
// preference that lived only on disk would silently revert on the next update.
async function gameOptions(config, game) {
	const stored = config.gameSettings || {};
	const options = [];

	for (const spec of SETTING_FILES) {
		const text = await readSettingFile(config.installPath, game, spec.file);

		if (text === null) {
			continue;
		}

		for (const option of fileOptions(spec, text)) {
			options.push({...option, value: stored[option.key] ?? coerceSetting(option.type, option.raw)});
		}
	}

	return options;
}

// Push the stored choices into the game's .ini files. Called both when the
// user changes something and again at launch and after installs, so a patch
// that replaced a file can't leave the game running with settings the UI says
// are on.
//
// Only keys the file still has are written: a choice for an option the patch
// has since dropped stays in config.json but isn't resurrected in the file.
function applyGameSettings(installPath, game) {
	if (!installPath) {
		return;
	}

	const stored = readConfig().gameSettings || {};

	for (const spec of SETTING_FILES) {
		const target = path.join(gameDir(installPath, game), spec.file);
		let text;

		try {
			text = fs.readFileSync(target, 'utf8');
		} catch {
			// Not installed, or this patch version doesn't ship the file. The
			// choices stay in config.json and get applied once it turns up.
			continue;
		}

		const updates = {};

		for (const option of fileOptions(spec, text)) {
			if (stored[option.key] !== undefined) {
				updates[option.id] = formatSetting(option, stored[option.key]);
			}
		}

		if (Object.keys(updates).length > 0) {
			fs.writeFileSync(target, writeIni(text, updates));
		}
	}
}

ipcMain.handle('get-game-settings', (_, game) => gameOptions(readConfig(), game));

ipcMain.handle('set-game-settings', (_, game, values) => {
	const config = readConfig();
	config.gameSettings = {...config.gameSettings, ...values};
	writeConfig(config);

	try {
		applyGameSettings(config.installPath, game);
		return {success: true};
	} catch (error) {
		// The choice is saved either way; only writing it out failed.
		return {success: false, error: error.message};
	}
});

// Writes the launching player's credentials into the game's claudia.ini. The
// game authenticates to the server with these, so the password field carries
// the player's session token (their api_key), not a literal password.
async function updateCredentials(installPath, username, token, game) {
	const fPath = path.join(gameDir(installPath, game), 'claudia.ini');
	const iniText = await fs.promises.readFile(fPath, 'utf8');

	await fs.promises.writeFile(
		fPath,
		writeIni(iniText, {
			'Credentials.Username': username,
			'Credentials.Password': token,
			'Network.RedirectHost': 'acb.assassins.network',
		}),
	);
}

ipcMain.handle('launch-game', async (_, config, username) => {
	if (!config.token) {
		return {success: false, error: 'Not signed in'};
	}

	const game = 'acb';

	try {
		applyGameSettings(config.installPath, game);
		await updateCredentials(config.installPath, username, config.token, game);
	} catch (error) {
		return {success: false, error: `Could not write the game config: ${error.message}`};
	}

	// On Linux the game runs under Wine/Proton, which the player sets up and
	// starts themselves — we can't know which runner or prefix they use. The
	// .ini files above are all the game needs from us, so stop here.
	if (process.platform !== 'win32') {
		return {success: true, manual: true};
	}

	const exe = path.join(gameDir(config.installPath, game), 'ACBMP.exe');

	// spawn() reports a missing or unrunnable binary as an 'error' event, not a
	// throw. Unhandled, that event takes down the whole main process.
	return new Promise(resolve => {
		const child = spawn(exe, [], {
			cwd: path.dirname(exe),
			detached: true,
			stdio: 'ignore',
		});

		child.once('error', error => {
			resolve({success: false, error: `Could not start the game: ${error.message}`});
		});

		child.once('spawn', () => {
			child.unref();
			resolve({success: true});
		});
	});
});

ipcMain.handle('open-play-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'play.html'));
});

ipcMain.handle('open-settings-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'settings.html'));
});

ipcMain.handle('open-stats-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'stats.html'));
});

ipcMain.handle('open-news-page', () => {
	mainWindow.loadFile(path.join(__dirname, 'news.html'));
});

ipcMain.handle('get-stats', async (_, username) => {
	try {
		const res = await fetch(`https://api.assassins.network/players/player/${username}`);
		return await res.json();
	} catch {
		return {success: false};
	}
});

ipcMain.handle('get-board', async (_, mode) => {
	try {
		const res = await fetch(`https://api.assassins.network/boards/ranking/${mode}`);
		return await res.json();
	} catch {
		return {success: false};
	}
});

ipcMain.handle('get-boards', async () => {
	const res = await fetch('https://api.assassins.network/boards/');
	return await res.json();
});

// Helper: compute hash
function computeFileHash(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}


function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });

        const fileStream = fs.createWriteStream(dest);

        let downloadedBytes = 0;
        let lastBytes = 0;
        let lastTime = Date.now();
        let speed = 0;

        const request = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed: ${res.statusCode} (${url})`));
            }

            const totalBytes = parseInt(res.headers['content-length'] || '0');

            res.on('data', (chunk) => {
                const delta = chunk?.length ?? 0;
                downloadedBytes += delta;

                const now = Date.now();
                const deltaTime = (now - lastTime) / 1000;

                // Update speed every ~1s
                if (deltaTime >= 1) {
                    speed = (downloadedBytes - lastBytes) / deltaTime;
                    lastBytes = downloadedBytes;
                    lastTime = now;
                }

                const percent = totalBytes
                    ? Math.round((downloadedBytes / totalBytes) * 100)
                    : 0;

                if (onProgress) {
                    onProgress({
                        delta,                 // 🔥 bytes since last chunk
                        downloadedBytes,       // per-file total
                        totalBytes,            // per-file total size
                        percent,               // per-file %
                        speed                  // bytes/sec
                    });
                }
            });

            res.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close(resolve);
            });
        });

        request.on('error', (err) => {
            fs.unlink(dest, () => {}); // cleanup partial file
            reject(err);
        });

        fileStream.on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

ipcMain.handle('install-game', async (event, config, game) => {
	const sendProgress = (message, type = 'secondary') => {
		event.sender.send('install-log', message, type);
	};

	const installPath = config.installPath;

    const progress = (percent, status, downloadedBytes, totalBytes, speed) => {
        event.sender.send('install-progress', {
            percent,
            status,
            downloadedBytes,
            totalBytes,
            speed // bytes per second
        });
    };

    let totalBytes = 0;
    let downloadedBytes = 0;
    let speed = 0;
    const percent = 0;

	try {
		sendProgress('Initializing system check...', 'primary-container');
		progress(0, 'Fetching patch information...', 0, 0, 0);
		// Force a refresh: a cached manifest is fine for a status badge, but an
		// install has to download what's current right now.
		const patchData = await patchManifest(game, {force: true});
		const baseUrl = patchData.file_server;

		sendProgress('Update metadata confirmed. Downloading...', 'primary');
		const {files} = patchData;

        totalBytes = files.reduce((sum, f) => sum + f.size, 0);

        const gameFolder = gameDir(installPath, game);
        fs.mkdirSync(gameFolder, { recursive: true });

		const totalFiles = files.length;
		let completedFiles = 0;

		for (const file of files) {
			const destPath = path.join(gameFolder, file.file_location);
			sendProgress(`Checking ${file.name}...`, 'secondary');
			const needsDownload = !fs.existsSync(destPath) || await computeFileHash(destPath) != file.hash;

			if (!needsDownload) {
				completedFiles++;
                totalBytes -= file.size;
				progress(percent, `Skipping ${file.file_location}`, downloadedBytes, totalBytes, speed);
    			sendProgress(`Already downloaded ${file.name}. Skipping.`, 'secondary');
				continue;
			}

			sendProgress(`Downloading ${file.name}...`, 'secondary');

			progress(percent, `Downloading ${file.file_location}...`, downloadedBytes, totalBytes, speed);
			fs.mkdirSync(path.dirname(destPath), {recursive: true});
			const url = `${baseUrl}/${file.file_location}`;

			let attempts = 0;
			let valid = false;

			while (attempts < 3 && !valid) {
                await downloadFile(url, destPath, (p) => {
                    downloadedBytes += p.delta;

                    const percent = Math.round((downloadedBytes / totalBytes) * 100);

                    event.sender.send('install-progress', {
                        percent,
                        downloadedBytes: downloadedBytes,
                        totalBytes: totalBytes,
                        speed: p.speed,
                        status: `Downloading ${file.name}...`
                    });
                });

				const hash = await computeFileHash(destPath);
				valid = hash === file.hash;

				attempts++;

				if (!valid) {
					sendProgress(`Hash mismatch, retrying (${attempts}/3)...`, 'error');
				}
			}

			if (!valid) {
				throw new Error(`Failed to verify ${file.file_location}`);
			}

			completedFiles++;
			sendProgress(`${file.name} completed.`, 'primary');
		}

		const savedConfig = readConfig();
		savedConfig.games ||= {};
		savedConfig.games[game] ||= {};
		savedConfig.games[game].installedVersion = patchData.version;
		writeConfig(savedConfig);

		// The download just replaced any settings file that differed from
		// the manifest with its pristine copy. Write the player's choices
		// back over them before telling them it's ready.
		applyGameSettings(installPath, game);

		progress(100, 'Installation complete!', downloadedBytes, totalBytes, speed);
		sendProgress('Success. You can now launch the game.', 'primary font-bold');

		return true;
	} catch (error) {
		console.error('Installation failed:', error);
		progress(0, 'Installation failed: ' + error.message, downloadedBytes, totalBytes, speed);
		throw error;
	}
});

ipcMain.handle('detect-game-path', async () => {
	const possiblePaths = [
		'C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Assassin\'s Creed Brotherhood',
		'C:/Program Files (x86)/Steam/steamapps/common/Assassin\'s Creed Brotherhood',
		'C:/Program Files/Steam/steamapps/common/Assassin\'s Creed Brotherhood',
		// Linux: Steam's native and Flatpak libraries (the game runs under Proton).
		path.join(app.getPath('home'), '.local/share/Steam/steamapps/common/Assassin\'s Creed Brotherhood'),
		path.join(app.getPath('home'), '.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Assassin\'s Creed Brotherhood'),
	];

	for (const p of possiblePaths) {
		if (fs.existsSync(p)) {
			return p;
		}
	}

	return null;
});

ipcMain.handle('open-external', async (_, url) => {
	await shell.openExternal(url);
});
