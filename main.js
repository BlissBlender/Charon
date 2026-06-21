const { app, BrowserWindow, dialog, ipcMain, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile, execSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');

const DEFAULT_API_BASE = 'https://gamegen.lol';
const DEFAULT_DATABASE_1_BASE = 'https://raw.githubusercontent.com/BlissBlender/Charon-Database/main/database-1';
const DEFAULT_DATABASE_2_BASE = 'https://raw.githubusercontent.com/BlissBlender/Charon-Database/main/database-2';
const UPDATE_MANIFEST_URL = 'https://api.github.com/repos/BlissBlender/Charon/contents/latest.json?ref=main';
const UPDATE_MANIFEST_DISPLAY_URL = 'https://raw.githubusercontent.com/BlissBlender/Charon/main/latest.json';
const UPDATE_RELEASES_URL = 'https://github.com/BlissBlender/Charon/releases';
const STORE_SEARCH_URL = 'https://store.steampowered.com/api/storesearch/';
const STORE_DETAILS_URL = 'https://store.steampowered.com/api/appdetails';
const STEAMCMD_INFO_URL = 'https://api.steamcmd.net/v1/info/';
const MANIFEST_VAULT_BASE_URL = 'https://raw.githubusercontent.com/BlissBlender/ManifestVault/main';
const EXTERNAL_MANIFEST_VAULT_BASE_URL = 'https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main';
const BACKFILL_ENDPOINT_URL = 'https://charon-bot.vyro.workers.dev/api/backfill';
const BACKFILL_HEALTH_ENDPOINT_URL = 'https://charon-bot.vyro.workers.dev/health';
const GEN_LOG_ENDPOINT = 'https://charon-bot.vyro.workers.dev/api/gen-log';
const EXCLUDED_APP_IDS = new Set(['228980', '107056', '1110390']);
const AUTO_INSTALL_DAILY_LIMIT = 10;
const AUTO_INSTALL_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 15000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const STEAM_IMAGE_VALIDATE_TIMEOUT_MS = 10000;
const STEAM_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STEAM_BANNER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STEAM_SEARCH_RESULT_LIMIT = 100;
const GAME_PLACEHOLDER_IMAGE = 'assets/game-placeholder.png';
const BUNDLED_GAMEGEN_KEY = 'Dg8+EQwPVlkEEVxeVglURlZaAlFVRFtbVw4CEV1fAA5QEVw=';
const BUNDLED_GAMEGEN_MASK = 'charon';
const DEPOT_ADDAPPID_RE = /addappid\s*\(\s*(\d+)\s*,\s*\d+\s*,\s*["'][a-fA-F0-9]+["']/gi;
const DIRECT_MANIFEST_FILE_RE = /\b(\d{3,})_(\d{3,})\.manifest\b/gi;

function localAppDataBase() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function runtimeUserDataRoot() {
  if (process.env.CHARON_DATA_ROOT) return path.join(process.env.CHARON_DATA_ROOT, 'runtime');
  if (process.env.PORTABLE_EXECUTABLE_DIR || app.isPackaged) return path.join(localAppDataBase(), 'Charon', 'Runtime');
  return path.join(__dirname, 'data', 'runtime');
}

function configureElectronRuntimeStorage() {
  const runtimeRoot = runtimeUserDataRoot();
  fs.mkdirSync(runtimeRoot, { recursive: true });
  app.setPath('userData', runtimeRoot);
}

configureElectronRuntimeStorage();

function exitForCliSmoke() {
  app.exit(0);
}

let mainWindow;
let dataRoot;
let dataRootMigrated = false;
let steamDetectCache = { value: '', time: 0 };
let updateCheckInFlight = null;
let updateCheckCache = null;
const databaseIndexCache = new Map();
const scheduledBackfills = new Set();
const steamDetailsCache = new Map();
const steamDetailsInFlight = new Map();
const bannerResolveInFlight = new Map();
const bannerStats = {
  hits: 0,
  misses: 0,
  resolved: 0,
  placeholders: 0
};

function logMainError(error) {
  const message = error?.stack || error?.message || String(error || 'Unknown error');
  try {
    const logPath = path.join(getDataRoot(), 'charon-errors.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Last-resort crash logging must never trigger another crash.
  }
}

process.on('uncaughtException', (error) => {
  logMainError(error);
});

process.on('unhandledRejection', (reason) => {
  logMainError(reason);
});

function stableDataRoot() {
  return path.join(localAppDataBase(), 'Charon');
}

function probableDriveRoots() {
  const roots = new Set();
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) roots.add(root);
    } catch {
      continue;
    }
  }
  return [...roots];
}

function legacyDataRoots(targetRoot) {
  const roots = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    roots.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'CharonData'));
  }
  if (app.isPackaged) {
    roots.push(path.join(app.getPath('userData'), 'CharonData'));
  }

  const appData = process.env.APPDATA || app.getPath('appData');
  roots.push(path.join(appData, 'charon', 'CharonData'));
  roots.push(path.join(appData, 'Charon', 'CharonData'));

  const userProfile = os.homedir();
  roots.push(path.join(userProfile, 'Desktop', 'CharonData'));
  roots.push(path.join(userProfile, 'Downloads', 'CharonData'));
  roots.push(path.join(userProfile, 'Documents', 'CharonData'));

  for (const drive of probableDriveRoots()) {
    roots.push(path.join(drive, 'CharonData'));
    roots.push(path.join(drive, 'Charon', 'CharonData'));
    roots.push(path.join(drive, 'Charon', 'dist', 'CharonData'));
    roots.push(path.join(drive, 'Charon', 'dist-release', 'CharonData'));
    roots.push(path.join(drive, 'Charon', 'dist-self-update', 'CharonData'));
  }

  const seen = new Set([path.resolve(targetRoot).toLowerCase()]);
  return roots.filter((root) => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return fs.existsSync(root);
  });
}

function readJsonSync(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mergeRecordsByAppId(current, incoming, removedIds = new Set()) {
  const records = new Map();
  for (const record of [...(current?.records || []), ...(incoming?.records || [])]) {
    if (!record || typeof record !== 'object') continue;
    const appId = String(record.appId || '').trim();
    if (!appId) continue;
    if (removedIds.has(appId)) continue;
    const previous = records.get(appId);
    const previousTime = new Date(previous?.installedAt || 0).getTime();
    const nextTime = new Date(record.installedAt || 0).getTime();
    if (!previous || nextTime >= previousTime) records.set(appId, record);
  }
  return { records: [...records.values()] };
}

function mergeActivity(current, incoming) {
  const records = [...(current || []), ...(incoming || [])]
    .map(normalizeActivityRecord)
    .filter(Boolean)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return records.slice(0, 100);
}

function mergeUsage(current, incoming) {
  return {
    autoInstallUses: cleanAutoInstallUses([
      ...(current?.autoInstallUses || []),
      ...(incoming?.autoInstallUses || [])
    ])
  };
}

function migrateLegacyDataRoots(targetRoot) {
  if (dataRootMigrated || process.env.CHARON_DATA_ROOT) return;
  dataRootMigrated = true;

  for (const legacyRoot of legacyDataRoots(targetRoot)) {
    const removedManifestIds = new Set([
      ...(readJsonSync(path.join(targetRoot, 'removed-manifests.json'), { appIds: [] })?.appIds || []),
      ...(readJsonSync(path.join(legacyRoot, 'removed-manifests.json'), { appIds: [] })?.appIds || [])
    ].map((appId) => String(appId || '').trim()).filter(Boolean));

    const migrations = [
      { name: 'settings.json', merge: (current, incoming) => ({ ...(incoming || {}), ...(current || {}) }) },
      { name: 'installed-manifests.json', merge: (current, incoming) => mergeRecordsByAppId(current, incoming, removedManifestIds) },
      { name: 'activity-log.json', merge: mergeActivity },
      { name: 'usage-limits.json', merge: mergeUsage },
      {
        name: 'removed-manifests.json',
        merge: (current, incoming) => ({
          appIds: [...new Set([...(current?.appIds || []), ...(incoming?.appIds || [])].map((appId) => String(appId || '').trim()).filter(Boolean))].sort()
        })
      },
      { name: 'api-sources.json', merge: (current, incoming) => current || incoming }
    ];

    for (const migration of migrations) {
      const from = path.join(legacyRoot, migration.name);
      const to = path.join(targetRoot, migration.name);
      if (!fs.existsSync(from)) continue;

      const incoming = readJsonSync(from, null);
      const current = readJsonSync(to, null);
      const merged = current === null ? incoming : migration.merge(current, incoming);
      if (merged !== null && merged !== undefined) writeJsonSync(to, merged);
    }
  }
}

function getDataRoot() {
  if (dataRoot) return dataRoot;

  if (process.env.CHARON_DATA_ROOT) {
    dataRoot = process.env.CHARON_DATA_ROOT;
  } else if (process.env.PORTABLE_EXECUTABLE_DIR || app.isPackaged) {
    dataRoot = stableDataRoot();
  } else {
    dataRoot = path.join(__dirname, 'data');
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  migrateLegacyDataRoots(dataRoot);
  return dataRoot;
}

function settingsPath() {
  return path.join(getDataRoot(), 'settings.json');
}

function installedPath() {
  return path.join(getDataRoot(), 'installed-manifests.json');
}

function removedManifestsPath() {
  return path.join(getDataRoot(), 'removed-manifests.json');
}

function activityPath() {
  return path.join(getDataRoot(), 'activity-log.json');
}

function limitsPath() {
  return path.join(getDataRoot(), 'usage-limits.json');
}

function bannerCacheDir() {
  return path.join(getDataRoot(), 'cache', 'banner');
}

function bannerCachePath(appId) {
  return path.join(bannerCacheDir(), `${String(appId || '').trim()}.json`);
}

function bannerResolutionLogPath() {
  return path.join(getDataRoot(), 'logs', 'banner-resolution.log');
}

function durableLimitsPath() {
  if (process.env.CHARON_DATA_ROOT) {
    return path.join(getDataRoot(), 'durable-usage-limits.json');
  }

  const base = process.env.LOCALAPPDATA || app.getPath('appData') || getDataRoot();
  return path.join(base, 'Charon', 'usage-limits.json');
}

function sourcesPath() {
  return path.join(getDataRoot(), 'api-sources.json');
}

function defaultSettings() {
  return {
    steamRoot: '',
    stPluginPath: '',
    depotCachePath: '',
    machineId: crypto.randomUUID().replaceAll('-', ''),
    setupDismissed: false,
    lastActivatedAt: '',
    theme: 'dark'
  };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await fsp.rename(tmp, filePath);
  } catch {
    await fsp.rm(filePath, { force: true });
    await fsp.rename(tmp, filePath);
  }
}

async function writeFileAtomic(filePath, bytes) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.charon-${crypto.randomUUID()}.tmp`);
  const backup = path.join(dir, `.charon-${crypto.randomUUID()}.bak`);
  let hadExisting = false;

  await fsp.writeFile(tmp, bytes);
  try {
    await fsp.access(filePath);
    hadExisting = true;
    await fsp.rename(filePath, backup);
  } catch {
    hadExisting = false;
  }

  try {
    await fsp.rename(tmp, filePath);
    return {
      rollback: async function rollback() {
      await fsp.rm(filePath, { force: true }).catch(() => {});
      if (hadExisting) await fsp.rename(backup, filePath).catch(() => {});
      },
      cleanup: async function cleanup() {
        await fsp.rm(backup, { force: true }).catch(() => {});
      }
    };
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (hadExisting) await fsp.rename(backup, filePath).catch(() => {});
    throw error;
  } finally {
    if (!hadExisting) await fsp.rm(backup, { force: true }).catch(() => {});
  }
}

async function rollbackAtomicWrites(writes) {
  for (const write of [...writes].reverse()) {
    if (typeof write?.rollback === 'function') await write.rollback().catch(() => {});
  }
}

async function cleanupAtomicWrites(writes) {
  for (const write of writes) {
    if (typeof write?.cleanup === 'function') await write.cleanup().catch(() => {});
  }
}

function normalizeActivityRecord(record) {
  const message = String(record?.message || '').trim();
  if (!message) return null;

  const allowedKinds = new Set(['info', 'ok', 'error']);
  const kind = allowedKinds.has(record.kind) ? record.kind : 'info';
  const time = Number.isNaN(new Date(record.time).getTime()) ? new Date().toISOString() : record.time;

  return {
    id: String(record.id || crypto.randomUUID()),
    time,
    kind,
    message: message.slice(0, 240)
  };
}

async function loadActivityLog() {
  const records = await readJson(activityPath(), []);
  return {
    records: Array.isArray(records)
      ? records.map(normalizeActivityRecord).filter(Boolean).slice(0, 100)
      : []
  };
}

async function appendActivityLog(entry) {
  const current = await loadActivityLog();
  const record = normalizeActivityRecord({
    ...entry,
    id: crypto.randomUUID(),
    time: new Date().toISOString()
  });

  if (!record) return current;

  const next = [record, ...current.records].slice(0, 100);
  await writeJson(activityPath(), next);
  return { records: next };
}

async function clearActivityLog() {
  await writeJson(activityPath(), []);
  return { records: [] };
}

function cleanAutoInstallUses(value) {
  const cutoff = Date.now() - AUTO_INSTALL_WINDOW_MS;
  return Array.isArray(value)
    ? value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > cutoff)
      .sort((a, b) => a - b)
    : [];
}

function autoInstallQuotaFromUses(uses) {
  const activeUses = cleanAutoInstallUses(uses);
  const used = activeUses.length;
  const remaining = Math.max(0, AUTO_INSTALL_DAILY_LIMIT - used);
  const resetAt = used > 0
    ? new Date(activeUses[0] + AUTO_INSTALL_WINDOW_MS).toISOString()
    : '';

  return {
    limit: AUTO_INSTALL_DAILY_LIMIT,
    used,
    remaining,
    resetAt,
    windowHours: Math.round(AUTO_INSTALL_WINDOW_MS / (60 * 60 * 1000))
  };
}

function formatQuotaReset(resetAt) {
  const resetTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetTime)) return 'later';

  const remainingMs = Math.max(0, resetTime - Date.now());
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${Math.max(1, minutes)}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

async function loadUsageLimits() {
  const paths = [...new Map([limitsPath(), durableLimitsPath()].map((filePath) => [path.resolve(filePath).toLowerCase(), filePath])).values()];
  const files = await Promise.all(paths.map((filePath) => readJson(filePath, {})));

  const merged = files.flatMap((file) => cleanAutoInstallUses(file?.autoInstallUses));

  return {
    autoInstallUses: cleanAutoInstallUses([...new Set(merged)])
  };
}

async function saveUsageLimits(file) {
  const next = {
    autoInstallUses: cleanAutoInstallUses(file?.autoInstallUses)
  };
  const paths = [...new Map([limitsPath(), durableLimitsPath()].map((filePath) => [path.resolve(filePath).toLowerCase(), filePath])).values()];
  await Promise.all(paths.map((filePath) => writeJson(filePath, next)));
  return next;
}

async function getAutoInstallQuota() {
  const file = await loadUsageLimits();
  const cleaned = await saveUsageLimits(file);
  return autoInstallQuotaFromUses(cleaned.autoInstallUses);
}

async function assertAutoInstallQuota() {
  const quota = await getAutoInstallQuota();
  if (quota.remaining <= 0) {
    throw new Error(`Daily automatic install limit reached (${quota.used}/${quota.limit}). Try again in ${formatQuotaReset(quota.resetAt)}.`);
  }
  return quota;
}

async function recordAutoInstallUse() {
  const file = await loadUsageLimits();
  file.autoInstallUses.push(Date.now());
  const saved = await saveUsageLimits(file);
  return autoInstallQuotaFromUses(saved.autoInstallUses);
}

function normalizeSettings(settings) {
  const normalized = { ...settings };
  const steamRoot = String(normalized.steamRoot || '').trim().replace(/[\\/]+$/, '');
  const depotCachePath = String(normalized.depotCachePath || '').trim();
  const legacyDepotPath = steamRoot ? path.join(steamRoot, 'config', 'depotcache') : '';
  const currentDepotPath = steamRoot ? path.join(steamRoot, 'depotcache') : '';

  normalized.steamRoot = steamRoot;
  if (steamRoot && depotCachePath && path.normalize(depotCachePath).toLowerCase() === path.normalize(legacyDepotPath).toLowerCase()) {
    normalized.depotCachePath = currentDepotPath;
  }

  return normalized;
}

async function loadSettings() {
  const stored = await readJson(settingsPath(), null);
  const settings = normalizeSettings({
    ...defaultSettings(),
    ...(stored || {})
  });
  delete settings.apiKey;
  delete settings.apiBaseUrl;
  delete settings.adminEndpointUrl;

  if (!stored || !stored.machineId) {
    settings.machineId = crypto.randomUUID().replaceAll('-', '');
    await saveSettings(settings);
  }

  return settings;
}

async function saveSettings(next) {
  const current = await readJson(settingsPath(), {});
  const {
    apiKey: _legacyApiKey,
    apiBaseUrl: _legacyApiBaseUrl,
    adminEndpointUrl: _legacyAdminEndpointUrl,
    ...safeCurrent
  } = current;
  const merged = normalizeSettings({
    ...defaultSettings(),
    ...safeCurrent,
    ...next
  });
  await writeJson(settingsPath(), merged);
  return merged;
}

function defaultSourceConfig(legacy = {}) {
  const legacyApiKey = typeof legacy.apiKey === 'string' ? legacy.apiKey.trim() : '';
  const legacyApiBaseUrl = validBaseUrl(legacy.apiBaseUrl) ? legacy.apiBaseUrl.trim().replace(/\/+$/, '') : DEFAULT_API_BASE;

  return {
    activeSourceId: '',
    sources: [
      {
        id: 'charon-database-1',
        name: 'Charon Database 1',
        type: 'database-url',
        enabled: true,
        baseUrl: DEFAULT_DATABASE_1_BASE,
        indexUrl: `${DEFAULT_DATABASE_1_BASE}/index.json`,
        headers: {}
      },
      {
        id: 'charon-database-2',
        name: 'Charon Database 2',
        type: 'database-url',
        enabled: true,
        baseUrl: DEFAULT_DATABASE_2_BASE,
        indexUrl: `${DEFAULT_DATABASE_2_BASE}/index.json`,
        headers: {}
      },
      {
        id: 'gamegen-primary',
        name: 'GameGen Primary',
        type: 'gamegen',
        enabled: Boolean(legacyApiKey),
        apiBaseUrl: legacyApiBaseUrl,
        apiKey: legacyApiKey,
        generatePath: '/api/{key}/generate/{appId}?format=zip',
        requestPath: '/api/{key}/request/{appId}',
        statsPath: '/api/{key}/stats',
        activatePath: '/api/{key}/activate',
        headers: {}
      },
      {
        id: 'repo-template',
        name: 'Repository ZIP Template',
        type: 'zip-url',
        enabled: false,
        urlTemplate: 'https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/manifests/{appId}.zip',
        headers: {}
      },
      {
        id: 'local-folder',
        name: 'Local ZIP Folder',
        type: 'local-folder',
        enabled: false,
        folder: 'E:\\Manifests',
        fileTemplate: '{appId}.zip'
      }
    ]
  };
}

function decodeBundledGameGenKey() {
  const bytes = Buffer.from(BUNDLED_GAMEGEN_KEY, 'base64');
  return [...bytes]
    .map((byte, index) => String.fromCharCode(byte ^ BUNDLED_GAMEGEN_MASK.charCodeAt(index % BUNDLED_GAMEGEN_MASK.length)))
    .join('');
}

function bundledSourceConfig() {
  return {
    activeSourceId: 'charon-database-1',
    sources: [
      {
        id: 'charon-database-1',
        name: 'Charon Database 1',
        type: 'database-url',
        enabled: true,
        baseUrl: DEFAULT_DATABASE_1_BASE,
        indexUrl: `${DEFAULT_DATABASE_1_BASE}/index.json`,
        headers: {}
      },
      {
        id: 'charon-database-2',
        name: 'Charon Database 2',
        type: 'database-url',
        enabled: true,
        baseUrl: DEFAULT_DATABASE_2_BASE,
        indexUrl: `${DEFAULT_DATABASE_2_BASE}/index.json`,
        headers: {}
      },
      {
        id: 'gamegen-primary',
        name: 'GameGen Primary',
        type: 'gamegen',
        enabled: true,
        apiBaseUrl: DEFAULT_API_BASE,
        apiKey: decodeBundledGameGenKey(),
        generatePath: '/api/{key}/generate/{appId}?format=zip',
        requestPath: '/api/{key}/request/{appId}',
        statsPath: '/api/{key}/stats',
        activatePath: '/api/{key}/activate',
        headers: {}
      },
      {
        id: 'repo-template',
        name: 'Repository ZIP Template',
        type: 'zip-url',
        enabled: false,
        urlTemplate: 'https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/manifests/{appId}.zip',
        headers: {}
      },
      {
        id: 'local-folder',
        name: 'Local ZIP Folder',
        type: 'local-folder',
        enabled: false,
        folder: 'E:\\Manifests',
        fileTemplate: '{appId}.zip',
        headers: {}
      }
    ]
  };
}

function normalizeSourceConfig(config) {
  const normalized = {
    activeSourceId: typeof config?.activeSourceId === 'string' ? config.activeSourceId : '',
    sources: Array.isArray(config?.sources) ? config.sources : []
  };

  normalized.sources = normalized.sources
    .filter((source) => source && typeof source === 'object')
    .map((source, index) => ({
      ...source,
      id: String(source.id || `source-${index + 1}`),
      name: String(source.name || source.id || `Source ${index + 1}`),
      type: String(source.type || 'gamegen').toLowerCase(),
      enabled: source.enabled !== false,
      headers: source.headers && typeof source.headers === 'object' ? source.headers : {}
    }));

  return normalized;
}

function sourceHasAccess(source) {
  if (!source || source.enabled === false) return false;
  if (source.type === 'database-url') return Boolean(String(source.baseUrl || source.indexUrl || '').trim());
  if (source.type === 'lua-url') return Boolean(String(source.urlTemplate || '').trim());
  if (source.type === 'gamegen') return Boolean(String(source.apiKey || '').trim());
  if (source.type === 'zip-url') return Boolean(String(source.urlTemplate || '').trim());
  if (source.type === 'local-folder') return Boolean(String(source.folder || '').trim());
  return false;
}

function withBundledPrioritySources(config) {
  const normalized = normalizeSourceConfig(config);
  const bundled = normalizeSourceConfig(bundledSourceConfig());
  const existingById = new Map(normalized.sources.map((source) => [source.id, source]));
  const priorityIds = ['charon-database-1', 'charon-database-2', 'gamegen-primary'];
  const retiredIds = new Set(['github-lua', 'github-lua-2']);
  const prioritySources = priorityIds.map((id) => {
    const existing = existingById.get(id);
    return sourceHasAccess(existing) ? existing : bundled.sources.find((source) => source.id === id);
  }).filter(Boolean);
  const rest = normalized.sources.filter((source) => !priorityIds.includes(source.id) && !retiredIds.has(source.id));

  return {
    activeSourceId: 'charon-database-1',
    sources: [...prioritySources, ...rest]
  };
}

async function loadSourcesConfig() {
  const existing = await readJson(sourcesPath(), null);
  if (existing) {
    await scrubLegacyApiSettings();
    return withBundledPrioritySources(existing);
  }

  const legacySettings = await readJson(settingsPath(), {});
  await scrubLegacyApiSettings();

  if (legacySettings.apiKey) {
    const created = defaultSourceConfig(legacySettings);
    await saveSourcesConfig(created);
    return normalizeSourceConfig(created);
  }

  return normalizeSourceConfig(bundledSourceConfig());
}

async function scrubLegacyApiSettings() {
  const settings = await readJson(settingsPath(), {});
  if (settings.apiKey || settings.apiBaseUrl || settings.adminEndpointUrl) {
    await saveSettings(await loadSettings());
  }
}

async function saveSourcesConfig(config) {
  const normalized = normalizeSourceConfig(config);
  await writeJson(sourcesPath(), normalized);
  return normalized;
}

async function getSourcesSummary() {
  const config = await loadSourcesConfig();
  const sources = config.sources.map((source) => ({
    id: source.id,
    name: source.name,
    type: source.type,
    enabled: Boolean(source.enabled),
    hasApiKey: Boolean(String(source.apiKey || '').trim()),
    hasUrlTemplate: Boolean(String(source.urlTemplate || '').trim()),
    hasBaseUrl: Boolean(String(source.baseUrl || '').trim()),
    hasIndexUrl: Boolean(String(source.indexUrl || '').trim()),
    hasFolder: Boolean(String(source.folder || '').trim())
  }));

  return {
    configPath: sourcesPath(),
    activeSourceId: config.activeSourceId,
    enabledCount: sources.filter((source) => source.enabled).length,
    totalCount: sources.length,
    sources
  };
}

async function loadInstalled() {
  const file = await readJson(installedPath(), { records: [] });
  if (!Array.isArray(file.records)) file.records = [];
  const removedIds = await loadRemovedManifestIds();
  file.records = file.records.filter((record) => {
    const appId = String(record?.appId || '').trim();
    return appId && !removedIds.has(appId);
  });
  file.records = mergeRecordsByAppId({ records: [] }, file, removedIds).records;
  file.records.sort((a, b) => String(a.gameName || a.appId).localeCompare(String(b.gameName || b.appId)));
  return file;
}

async function saveInstalled(file) {
  file.records = mergeRecordsByAppId({ records: [] }, {
    records: Array.isArray(file.records) ? file.records : []
  }).records;
  await writeJson(installedPath(), file);
}

async function loadRemovedManifestIds() {
  const file = await readJson(removedManifestsPath(), { appIds: [] });
  return new Set((Array.isArray(file.appIds) ? file.appIds : [])
    .map((appId) => String(appId || '').trim())
    .filter(Boolean));
}

async function saveRemovedManifestIds(ids) {
  await writeJson(removedManifestsPath(), {
    appIds: [...ids].map((appId) => String(appId || '').trim()).filter(Boolean).sort()
  });
}

async function rememberRemovedManifest(appId) {
  const id = String(appId || '').trim();
  if (!id) return;
  const ids = await loadRemovedManifestIds();
  ids.add(id);
  await saveRemovedManifestIds(ids);
}

async function forgetRemovedManifest(appId) {
  const id = String(appId || '').trim();
  if (!id) return;
  const ids = await loadRemovedManifestIds();
  if (!ids.delete(id)) return;
  await saveRemovedManifestIds(ids);
}

function validBaseUrl(value) {
  if (!value || typeof value !== 'string') return false;
  return /^https?:\/\//i.test(value.trim());
}

function resolveApiBase(source) {
  return validBaseUrl(source?.apiBaseUrl) ? source.apiBaseUrl.trim().replace(/\/+$/, '') : DEFAULT_API_BASE;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || '').trim());
}

function makeHeaders(extra = {}) {
  return {
    'User-Agent': `Charon/${app.getVersion()}`,
    'Accept': 'application/json',
    ...extra
  };
}

async function httpFetch(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const code = error?.cause?.code;
    if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
      return net.fetch(url, options);
    }
    throw error;
  }
}

async function httpFetchWithTimeout(url, options = {}, timeoutMs = STEAM_IMAGE_VALIDATE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await httpFetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function sourceHeaders(source, extra = {}) {
  return {
    ...makeHeaders(),
    ...(source?.headers || {}),
    ...extra
  };
}

function orderedSources(config) {
  const enabled = config.sources.filter((source) => source.enabled !== false);
  if (!config.activeSourceId) return enabled;

  const active = enabled.find((source) => source.id === config.activeSourceId);
  if (!active) return enabled;
  return [active, ...enabled.filter((source) => source.id !== active.id)];
}

function applySourceTemplate(template, source, appId) {
  return String(template || '')
    .replaceAll('{baseUrl}', resolveApiBase(source))
    .replaceAll('{key}', encodePathSegment(source.apiKey || ''))
    .replaceAll('{apiKey}', encodePathSegment(source.apiKey || ''))
    .replaceAll('{appId}', encodeURIComponent(String(appId || '').trim()));
}

function sourceEndpoint(source, pathTemplate, appId) {
  const resolved = applySourceTemplate(pathTemplate, source, appId);
  if (/^https?:\/\//i.test(resolved)) return resolved;
  const base = resolveApiBase(source);
  return `${base}${resolved.startsWith('/') ? '' : '/'}${resolved}`;
}

function databaseBaseUrl(source) {
  const base = String(source?.baseUrl || '').trim().replace(/\/+$/, '');
  if (validBaseUrl(base)) return base;

  const indexUrl = String(source?.indexUrl || '').trim();
  if (validBaseUrl(indexUrl)) {
    const parsed = new URL(indexUrl);
    parsed.pathname = parsed.pathname.replace(/\/index\.json$/i, '');
    return parsed.toString().replace(/\/+$/, '');
  }

  throw new Error('database source is missing a valid baseUrl.');
}

function cleanDatabaseFileName(fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error('database file name is invalid.');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error('database file name escapes the database folder.');
  }
  return parts.join('/');
}

function databaseFileUrl(source, fileName) {
  const safeName = cleanDatabaseFileName(fileName);
  const encoded = safeName.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${databaseBaseUrl(source)}/${encoded}`;
}

function databaseIndexUrl(source) {
  const explicit = String(source?.indexUrl || '').trim();
  if (validBaseUrl(explicit)) return explicit;
  return databaseFileUrl(source, 'index.json');
}

function databaseIndexEntry(index, appId) {
  const id = String(appId || '').trim();
  const apps = index?.apps && typeof index.apps === 'object' ? index.apps : index;
  const entry = apps?.[id];
  return entry && typeof entry === 'object' ? entry : null;
}

function uniqueStrings(values) {
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }));

  return results;
}

async function loadDatabaseIndex(source) {
  const url = databaseIndexUrl(source);
  const cached = databaseIndexCache.get(url);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.index;

  const response = await httpFetch(url, {
    headers: sourceHeaders(source, { Accept: 'application/json' })
  });
  const raw = await readBodyBytes(response);
  if (!response.ok) throw new Error(response.status === 404 ? 'database index was not found.' : formatHttpError(response, raw.toString('utf8')));

  let index;
  try {
    index = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('database index was not valid JSON.');
  }

  databaseIndexCache.set(url, { index, time: Date.now() });
  return index;
}

async function downloadDatabaseFile(source, fileName, appId, sender, phase, accept) {
  const url = databaseFileUrl(source, fileName);
  const response = await httpFetch(url, {
    headers: sourceHeaders(source, { Accept: accept || 'application/octet-stream' })
  });
  const raw = await readBodyBytes(response, (pct) => {
    if (sender) {
      sender.send('download-progress', {
        appId,
        sourceId: source.id,
        sourceName: source.name,
        phase,
      message: "Searching " + source.name + "...",
      sourceIndex: i,
      sourceCount: sources.length,
        percent: pct
      });
    }
  });

  if (!response.ok) {
    throw new Error(response.status === 404 ? `${fileName} was not found.` : formatHttpError(response, raw.toString('utf8')));
  }

  if (raw.length === 0) throw new Error(`${fileName} was empty.`);
  return raw;
}

function rawFileUrl(baseUrl, fileName) {
  const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const cleanName = cleanDatabaseFileName(fileName);
  const encoded = cleanName.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${cleanBase}/${encoded}`;
}

function manifestVaultSources() {
  return [
    { id: 'manifest-vault', label: 'Manifest Vault', source: 'primary', baseUrl: MANIFEST_VAULT_BASE_URL },
    { id: 'external-vault', label: 'External Vault', source: 'fallback', baseUrl: EXTERNAL_MANIFEST_VAULT_BASE_URL }
  ];
}

function extractDepotIdsFromLua(luaText) {
  const depots = new Set();
  const content = String(luaText || '');
  for (const match of content.matchAll(DEPOT_ADDAPPID_RE)) {
    depots.add(match[1]);
  }
  return [...depots];
}

function extractDirectManifestFileNames(luaText) {
  const files = new Set();
  const content = String(luaText || '');
  for (const match of content.matchAll(DIRECT_MANIFEST_FILE_RE)) {
    files.add(`${match[1]}_${match[2]}.manifest`);
  }
  return [...files];
}

async function fetchSteamCmdAppInfo(appId) {
  try {
    const response = await httpFetchWithTimeout(`${STEAMCMD_INFO_URL}${encodeURIComponent(String(appId))}`, {
      headers: makeHeaders({ Accept: 'application/json' })
    }, 12000);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.status === 'success' ? data : null;
  } catch (error) {
    logMainError(new Error(`SteamCMD app info unavailable for ${appId}: ${error.message || String(error)}`));
    return null;
  }
}

function manifestFileNamesFromAppInfo(appInfo, appId, depotIds) {
  const files = new Set();
  const depots = appInfo?.data?.[appId]?.depots;
  if (!depots || typeof depots !== 'object') return [];

  for (const depotId of depotIds) {
    const manifestId = depots?.[depotId]?.manifests?.public?.gid;
    if (manifestId) files.add(`${depotId}_${manifestId}.manifest`);
  }

  return [...files];
}

async function requiredManifestFileNamesForLuaEntries(appId, luaEntries) {
  const requiredFiles = new Set();
  const depotIds = new Set();

  for (const luaEntry of luaEntries) {
    try {
      const luaText = Buffer.from(luaEntry.bytes).toString('utf8');
      for (const fileName of extractDirectManifestFileNames(luaText)) requiredFiles.add(fileName);
      for (const depotId of extractDepotIdsFromLua(luaText)) depotIds.add(depotId);
    } catch (error) {
      logMainError(new Error(`Lua parsing skipped for ${luaEntry?.name || appId}: ${error.message || String(error)}`));
    }
  }

  if (depotIds.size) {
    const appInfo = await fetchSteamCmdAppInfo(appId);
    for (const fileName of manifestFileNamesFromAppInfo(appInfo, String(appId), [...depotIds])) {
      requiredFiles.add(fileName);
    }
  }

  return [...requiredFiles];
}

function manifestSourceLabel(source) {
  return source === 'fallback' ? 'External Vault' : 'Manifest Vault';
}

function summarizeManifestSources(manifests) {
  return [...new Set((manifests || []).map((item) => manifestSourceLabel(item.source)).filter(Boolean))].join(' + ');
}

async function scheduleBackfill(payload) {
  if (!payload || !payload.type) return;
  const key = JSON.stringify(payload);
  if (scheduledBackfills.has(key)) return;
  scheduledBackfills.add(key);

  try {
    const health = await httpFetchWithTimeout(BACKFILL_HEALTH_ENDPOINT_URL, {
      method: 'GET',
      headers: makeHeaders({ Accept: 'application/json' })
    }, 10000);
    if (!health.ok) {
      const text = await health.text().catch(() => '');
      logMainError(new Error(`Backfill health check failed: HTTP ${health.status} ${text}`));
      return;
    }

    const response = await httpFetchWithTimeout(BACKFILL_ENDPOINT_URL, {
      method: 'POST',
      headers: makeHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: key
    }, 20000);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logMainError(new Error(`Backfill skipped: HTTP ${response.status} ${text}`));
    }
  } catch (error) {
    logMainError(new Error(`Backfill endpoint unavailable: ${error.message || String(error)}`));
  }
}



async function sendAppGenLog(result, startedAt) {
  try {
    if (!result || !result.appId) return;
    const payload = {
      appId: result.appId,
      game: result.game || null,
      source: result.sourceId || result.source || "",
      manifestCount: result.manifestCount || 0,
      manifestSource: result.manifestSource || "",
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      backfillStatus: result.backfillStatus || ""
    };
    await httpFetchWithTimeout(GEN_LOG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 10000);
  } catch (err) {
    console.log("sendAppGenLog failed:", err.message);
  }
}
async function findManifestInVaults(fileName, cache, appId, sender) {
  if (cache.has(fileName)) return cache.get(fileName);

  for (const source of manifestVaultSources()) {
    const url = rawFileUrl(source.baseUrl, fileName);
    try {
      const response = await httpFetchWithTimeout(url, {
        headers: makeHeaders({ Accept: 'application/octet-stream' })
      }, 15000);
      const bytes = await readBodyBytes(response, (pct) => {
        if (sender) {
          sender.send('download-progress', {
            appId,
            sourceId: source.id,
            sourceName: source.label,
            phase: 'manifest',
            percent: pct
          });
        }
      });

      if (!response.ok || !bytes.length) throw new Error(response.ok ? 'empty manifest' : `HTTP ${response.status}`);
      const found = {
        name: path.basename(cleanDatabaseFileName(fileName)),
        bytes,
        targetType: 'manifest',
        source: source.source,
        sourceName: source.label
      };
      cache.set(fileName, found);
      if (source.source === 'fallback') void scheduleBackfill({ type: 'manifest-vault', fileName });
      return found;
    } catch {
      // Optional manifest enrichment must never block Lua/package installation.
    }
  }

  cache.set(fileName, null);
  return null;
}

async function downloadOptionalManifestFiles(appId, fileNames, sender) {
  const manifests = [];
  const added = new Set();
  const cache = new Map();

  for (const fileName of uniqueStrings(fileNames)) {
    const found = await findManifestInVaults(fileName, cache, appId, sender);
    if (!found || added.has(found.name.toLowerCase())) continue;
    added.add(found.name.toLowerCase());
    manifests.push(found);
  }

  return manifests;
}

async function enrichFilesWithRequiredManifests(appId, files, sender) {
  const baseFiles = Array.isArray(files) ? files : [];
  const luaEntries = baseFiles
    .filter((file) => String(file?.name || '').toLowerCase().endsWith('.lua') && Buffer.isBuffer(file.bytes))
    .map((file) => ({ name: file.name, bytes: file.bytes }));

  if (!luaEntries.length) return { files: baseFiles, manifestSource: '' };

  const existingManifests = new Set(baseFiles
    .filter((file) => String(file?.name || '').toLowerCase().endsWith('.manifest'))
    .map((file) => path.basename(String(file.name)).toLowerCase()));
  const requiredFiles = await requiredManifestFileNamesForLuaEntries(appId, luaEntries);
  const missingFiles = requiredFiles.filter((fileName) => !existingManifests.has(path.basename(fileName).toLowerCase()));
  const manifests = await downloadOptionalManifestFiles(appId, missingFiles, sender);

  return {
    files: [...baseFiles, ...manifests],
    manifestSource: summarizeManifestSources(manifests)
  };
}

async function enrichZipWithRequiredManifests(appId, zipBytes, sender) {
  try {
    const zip = new AdmZip(zipBytes);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const luaEntries = entries
      .filter((entry) => path.extname(entry.entryName).toLowerCase() === '.lua')
      .map((entry) => ({ name: entry.entryName, bytes: entry.getData() }));

    if (!luaEntries.length) return { zipBytes, manifestSource: '' };

    const existingManifests = new Set(entries
      .filter((entry) => path.extname(entry.entryName).toLowerCase() === '.manifest')
      .map((entry) => path.basename(entry.entryName).toLowerCase()));
    const requiredFiles = await requiredManifestFileNamesForLuaEntries(appId, luaEntries);
    const missingFiles = requiredFiles.filter((fileName) => !existingManifests.has(path.basename(fileName).toLowerCase()));
    const manifests = await downloadOptionalManifestFiles(appId, missingFiles, sender);

    for (const manifest of manifests) {
      const fileName = path.basename(manifest.name);
      if (!zip.getEntry(fileName)) zip.addFile(fileName, manifest.bytes);
    }

    return {
      zipBytes: manifests.length ? zip.toBuffer() : zipBytes,
      manifestSource: summarizeManifestSources(manifests)
    };
  } catch (error) {
    logMainError(new Error(`Manifest enrichment skipped for ${appId}: ${error.message || String(error)}`));
    return { zipBytes, manifestSource: '' };
  }
}

function manifestFileNamesFromZip(zipBytes) {
  try {
    const zip = new AdmZip(zipBytes);
    return uniqueStrings(zip.getEntries()
      .filter((entry) => !entry.isDirectory && path.extname(entry.entryName).toLowerCase() === '.manifest')
      .map((entry) => path.basename(entry.entryName)));
  } catch {
    return [];
  }
}

function scheduleManifestVaultBackfills(fileNames) {
  for (const fileName of uniqueStrings(fileNames)) {
    if (/^\d+_\d+\.manifest$/i.test(fileName)) {
      void scheduleBackfill({ type: 'manifest-vault', fileName });
    }
  }
}

function formatHttpError(response, bodyText) {
  let detail = '';
  try {
    const json = JSON.parse(bodyText);
    detail = json.error || json.message || '';
  } catch {
    detail = bodyText && bodyText.length < 200 ? bodyText : '';
  }

  const suffix = detail ? `: ${detail}` : '';
  return `HTTP ${response.status}${suffix}`;
}

function parseVersionParts(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const number = Number.parseInt(part, 10);
      return Number.isFinite(number) ? number : 0;
    });
}

function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function withTimeout(promise, ms, message) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function isTrustedUpdateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'github.com' ||
    host === 'api.github.com' ||
    host === 'raw.githubusercontent.com' ||
    host === 'release-assets.githubusercontent.com' ||
    host.endsWith('.githubusercontent.com');
}

function assertTrustedUpdateUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Update manifest contains an invalid URL.');
  }

  if (parsed.protocol !== 'https:' || !isTrustedUpdateHost(parsed.hostname)) {
    throw new Error('Update URL must use trusted GitHub HTTPS hosting.');
  }

  return parsed;
}

function updateHttpRequest(url, { headers = {}, timeoutMs = UPDATE_CHECK_TIMEOUT_MS, onProgress } = {}, redirectCount = 0) {
  const parsed = assertTrustedUpdateUrl(url);

  return new Promise((resolve, reject) => {
    const request = https.request(parsed, {
      method: 'GET',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false
    }, (response) => {
      const statusCode = Number(response.statusCode) || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location && redirectCount < 5) {
        response.resume();
        resolve(updateHttpRequest(new URL(location, parsed).toString(), { headers, timeoutMs, onProgress }, redirectCount + 1));
        return;
      }

      const total = Number(response.headers['content-length']) || 0;
      const chunks = [];
      let received = 0;

      response.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;
        if (onProgress && total > 0) onProgress(Math.min(100, (received / total) * 100));
      });

      response.on('end', () => {
        if (onProgress) onProgress(100);
        resolve({
          statusCode,
          ok: statusCode >= 200 && statusCode < 300,
          headers: response.headers,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    request.on('timeout', () => request.destroy(new Error('Update request timed out. Try again later.')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchUpdateInfo() {
  const currentVersion = app.getVersion();
  const response = await updateHttpRequest(UPDATE_MANIFEST_URL, {
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    headers: makeHeaders({ Accept: 'application/json' })
  });
  const body = response.buffer.toString('utf8');

  if (!response.ok) {
    throw new Error(`Update check failed: HTTP ${response.statusCode}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(body);
    if (manifest?.encoding === 'base64' && manifest?.content) {
      const decoded = Buffer.from(String(manifest.content).replace(/\s/g, ''), 'base64').toString('utf8');
      manifest = JSON.parse(decoded);
    }
  } catch {
    throw new Error('Update manifest was not valid JSON.');
  }

  const latestVersion = String(manifest.version || '').trim().replace(/^v/i, '');
  if (!latestVersion) throw new Error('Update manifest is missing a version.');

  const downloadUrl = String(manifest.downloadUrl || '').trim();
  const releaseUrl = String(manifest.releaseUrl || UPDATE_RELEASES_URL).trim();
  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadUrl,
    releaseUrl,
    notes: String(manifest.notes || '').trim(),
    sha256: String(manifest.sha256 || '').trim(),
    publishedAt: String(manifest.publishedAt || '').trim(),
    manifestUrl: UPDATE_MANIFEST_DISPLAY_URL
  };
}

async function checkForUpdates({ force = false } = {}) {
  const now = Date.now();
  if (!force && updateCheckCache && now - updateCheckCache.time < 15000) {
    return updateCheckCache.info;
  }
  if (updateCheckInFlight) return updateCheckInFlight;

  updateCheckInFlight = fetchUpdateInfo()
    .then((info) => {
      updateCheckCache = { info, time: Date.now() };
      return info;
    })
    .finally(() => {
      updateCheckInFlight = null;
    });

  return updateCheckInFlight;
}

function currentPortableExecutablePath() {
  const portablePath = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  if (portablePath && path.extname(portablePath).toLowerCase() === '.exe') return portablePath;

  if (app.isPackaged && path.extname(process.execPath).toLowerCase() === '.exe') {
    return process.execPath;
  }

  return '';
}

function normalizeSha256(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, '')
    .replace(/[^a-f0-9]/g, '');
}

function releaseTagFromUpdateInfo(info) {
  const releaseUrl = String(info?.releaseUrl || '').trim();
  const downloadUrl = String(info?.downloadUrl || '').trim();
  const releaseMatch = releaseUrl.match(/\/releases\/tag\/([^/?#]+)/i);
  if (releaseMatch) return decodeURIComponent(releaseMatch[1]);
  const downloadMatch = downloadUrl.match(/\/releases\/download\/([^/?#]+)/i);
  if (downloadMatch) return decodeURIComponent(downloadMatch[1]);
  const version = String(info?.latestVersion || '').trim();
  return version ? `v${version.replace(/^v/i, '')}` : '';
}

function assetNameFromUpdateInfo(info) {
  try {
    const parsed = new URL(String(info?.downloadUrl || ''));
    const name = path.posix.basename(parsed.pathname);
    return decodeURIComponent(name);
  } catch {
    return '';
  }
}

async function githubReleaseAssetInfo(info) {
  const tag = releaseTagFromUpdateInfo(info);
  const assetName = assetNameFromUpdateInfo(info);
  if (!tag || !assetName) return null;

  const url = `https://api.github.com/repos/BlissBlender/Charon/releases/tags/${encodeURIComponent(tag)}`;
  const response = await updateHttpRequest(url, {
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    headers: makeHeaders({ Accept: 'application/vnd.github+json' })
  });
  if (!response.ok) return null;

  let release;
  try {
    release = JSON.parse(response.buffer.toString('utf8'));
  } catch {
    return null;
  }

  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => String(item.name || '') === assetName)
    : null;
  if (!asset) return null;

  return {
    name: asset.name,
    size: Number(asset.size) || 0,
    downloadUrl: String(asset.browser_download_url || ''),
    digest: normalizeSha256(asset.digest || '')
  };
}

async function verifyUpdateDownload(info, exeBytes) {
  const expectedSha = normalizeSha256(info.sha256);
  const actualSha = crypto.createHash('sha256').update(exeBytes).digest('hex');
  if (!expectedSha || expectedSha === actualSha) {
    return { ok: true, actualSha, verifiedBy: expectedSha ? 'manifest' : 'executable' };
  }

  const asset = await githubReleaseAssetInfo(info);
  if (asset?.digest && asset.digest === actualSha) {
    return { ok: true, actualSha, verifiedBy: 'github-release-digest', expectedSha, githubDigest: asset.digest };
  }

  const details = [
    `expected ${expectedSha}`,
    `got ${actualSha}`,
    `${exeBytes.length} bytes`
  ];
  if (asset?.digest) details.push(`GitHub asset digest ${asset.digest}`);
  if (asset?.size) details.push(`GitHub asset size ${asset.size} bytes`);
  throw new Error(`Downloaded update failed SHA-256 verification (${details.join(', ')}).`);
}

function batchValue(value) {
  return String(value || '').replace(/%/g, '%%');
}

function vbsString(value) {
  return String(value || '').replace(/"/g, '""');
}

async function downloadAndInstallUpdate(event) {
  const info = await checkForUpdates({ force: true });
  if (!info.updateAvailable) {
    return { ok: false, message: `Charon ${info.currentVersion} is already up to date.` };
  }

  if (!/^https?:\/\//i.test(info.downloadUrl)) {
    throw new Error('Update manifest is missing a valid download URL.');
  }

  const targetExe = currentPortableExecutablePath();
  if (!targetExe) {
    throw new Error('Automatic replacement only works from the packaged portable exe.');
  }

  const sender = event?.sender;
  const response = await updateHttpRequest(info.downloadUrl, {
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    headers: makeHeaders({ Accept: 'application/octet-stream' }),
    onProgress: (percent) => {
      if (sender) sender.send('update-progress', { phase: 'download', percent });
    }
  });

  if (!response.ok) {
    throw new Error(`Update download failed: HTTP ${response.statusCode}`);
  }

  const exeBytes = response.buffer;

  if (exeBytes.length < 1024 * 1024 || exeBytes[0] !== 0x4d || exeBytes[1] !== 0x5a) {
    throw new Error('Downloaded update was not a valid Windows executable.');
  }

  const verification = await verifyUpdateDownload(info, exeBytes);

  if (sender) sender.send('update-progress', { phase: 'verify', percent: 100 });

  const updatesDir = path.join(getDataRoot(), 'updates');
  await fsp.mkdir(updatesDir, { recursive: true });
  const updateExe = path.join(updatesDir, `Charon-${info.latestVersion}.exe`);
  const updaterScript = path.join(updatesDir, `apply-update-${Date.now()}.cmd`);
  const launcherScript = path.join(updatesDir, `launch-update-${Date.now()}.vbs`);
  const updateLog = path.join(updatesDir, 'last-update.log');
  await fsp.writeFile(updateExe, exeBytes);

  const script = [
    '@echo off',
    'setlocal',
    `set "CHARON_PID=${process.pid}"`,
    `set "TARGET_EXE=${batchValue(targetExe)}"`,
    `set "UPDATE_EXE=${batchValue(updateExe)}"`,
    `set "LAUNCHER_VBS=${batchValue(launcherScript)}"`,
    `set "UPDATE_LOG=${batchValue(updateLog)}"`,
    'echo [%date% %time%] Starting Charon update. > "%UPDATE_LOG%"',
    'for /l %%i in (1,1,90) do (',
    '  tasklist /FI "PID eq %CHARON_PID%" 2>nul | findstr /C:"%CHARON_PID%" >nul',
    '  if errorlevel 1 goto replace',
    '  timeout /t 1 /nobreak >nul',
    ')',
    'echo [%date% %time%] Wait timed out, attempting replacement anyway. >> "%UPDATE_LOG%"',
    ':replace',
    'for /l %%i in (1,1,30) do (',
    '  copy /y "%UPDATE_EXE%" "%TARGET_EXE%" >nul 2>nul',
    '  if not errorlevel 1 goto relaunch_target',
    '  timeout /t 1 /nobreak >nul',
    ')',
    'echo [%date% %time%] Replacement failed, launching downloaded update directly. >> "%UPDATE_LOG%"',
    'start "" "%UPDATE_EXE%"',
    'goto cleanup_keep_update',
    ':relaunch_target',
    'echo [%date% %time%] Replacement completed. >> "%UPDATE_LOG%"',
    'start "" "%TARGET_EXE%"',
    ':cleanup',
    'del "%UPDATE_EXE%" >nul 2>nul',
    ':cleanup_keep_update',
    'del "%LAUNCHER_VBS%" >nul 2>nul',
    'del "%~f0" >nul 2>nul'
  ].join('\r\n');

  await fsp.writeFile(updaterScript, script, 'utf8');
  const launcher = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "cmd.exe /d /c ""${vbsString(updaterScript)}""", 0, False`,
    'Set shell = Nothing'
  ].join('\r\n');
  await fsp.writeFile(launcherScript, launcher, 'utf8');
  if (sender) sender.send('update-progress', { phase: 'install', percent: 100 });

  const child = spawn('wscript.exe', ['//B', launcherScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  setTimeout(() => app.exit(0), 500);

  return {
    ok: true,
    latestVersion: info.latestVersion,
    sha256: verification.actualSha,
    verifiedBy: verification.verifiedBy,
    targetExe
  };
}

async function readBodyBytes(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0;

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (onProgress) onProgress(100);
    return buffer;
  }

  const chunks = [];
  const reader = response.body.getReader();
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.length;

    if (onProgress && total > 0) {
      onProgress(Math.min(100, (received / total) * 100));
    }
  }

  if (onProgress) onProgress(100);
  return Buffer.concat(chunks);
}

function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function absoluteUrl(baseUrl, relativeOrAbsolute) {
  const value = String(relativeOrAbsolute || '').trim();
  if (/^https?:\/\//i.test(value)) return value;
  return new URL(value.replace(/^\/+/, ''), `${baseUrl}/`).toString();
}

function parseUsageReset(value) {
  if (typeof value === 'number') {
    try {
      return new Date(value * 1000).toISOString();
    } catch {
      return '';
    }
  }
  return typeof value === 'string' ? value : '';
}

function normalizeStatsPayload(root) {
  const usage = root && typeof root.usage === 'object' ? root.usage : {};
  const user = root && typeof root.user === 'object' ? root.user : {};
  const displayName = user.username || root.displayName || root.username || '';

  return {
    ok: true,
    plan: root.plan || user.plan || '',
    creditsRemaining: numberOrNull(usage.remaining ?? root.creditsRemaining ?? root.remaining ?? root.credits),
    creditsTotal: numberOrNull(usage.limit ?? root.creditsTotal ?? root.dailyLimit ?? root.limit),
    usageToday: numberOrNull(usage.today),
    resetAt: parseUsageReset(usage.resetAt),
    displayName,
    role: user.role || root.role || '',
    isStaff: Boolean(user.isStaff || root.isStaff)
  };
}

function normalizeActivationPayload(root) {
  if (root && root.success === false) {
    return { ok: false, errorMessage: root.error || 'Activation rejected by server.' };
  }

  const data = root && typeof root.data === 'object' ? root.data : {};
  const user = data && typeof data.user === 'object' ? data.user : {};
  const usage = root && typeof root.usage === 'object' ? root.usage : {};

  return {
    ok: true,
    activationId: data.activationId || '',
    isNewUser: Boolean(data.isNewUser),
    displayName: user.username || '',
    plan: user.plan || '',
    role: user.role || '',
    isStaff: Boolean(user.isStaff),
    usageToday: numberOrNull(usage.today),
    creditsTotal: numberOrNull(usage.limit),
    creditsRemaining: numberOrNull(usage.remaining),
    resetAt: parseUsageReset(usage.resetAt)
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function osDescription() {
  const version = typeof os.version === 'function' ? os.version() : '';
  return [os.type(), os.release(), version].filter(Boolean).join(' ');
}

function readRegistryValue(command) {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000
    });
    const match = output.match(/\s+REG_\w+\s+(.+)\s*$/im);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function readRegistryValueAsync(keyPath, valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', keyPath, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }

      const match = String(stdout || '').match(/\s+REG_\w+\s+(.+)\s*$/im);
      resolve(match ? match[1].trim() : '');
    });
  });
}

function detectSteamRoot() {
  const candidates = [
    readRegistryValue('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath'),
    readRegistryValue('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath'),
    readRegistryValue('reg query "HKLM\\SOFTWARE\\Valve\\Steam" /v InstallPath'),
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = path.normalize(candidate).replace(/\//g, '\\');
    if (fs.existsSync(normalized) && fs.existsSync(path.join(normalized, 'steam.exe'))) {
      return normalized;
    }
  }

  return '';
}

async function pathHasSteamExe(candidate) {
  if (!candidate) return false;
  try {
    const normalized = path.normalize(candidate).replace(/\//g, '\\');
    await fsp.access(path.join(normalized, 'steam.exe'));
    return normalized;
  } catch {
    return '';
  }
}

async function detectSteamRootAsync({ useCache = true } = {}) {
  const now = Date.now();
  if (useCache && steamDetectCache.value && now - steamDetectCache.time < 5 * 60 * 1000) {
    return steamDetectCache.value;
  }

  const registryCandidates = await Promise.all([
    readRegistryValueAsync('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    readRegistryValueAsync('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    readRegistryValueAsync('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath')
  ]);

  const candidates = [
    ...registryCandidates,
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam'
  ];

  for (const candidate of candidates) {
    const found = await pathHasSteamExe(candidate);
    if (found) {
      steamDetectCache = { value: found, time: now };
      return found;
    }
  }

  steamDetectCache = { value: '', time: now };
  return '';
}

function defaultSteamFolders(steamRoot) {
  if (!steamRoot) return { stPluginPath: '', depotCachePath: '' };
  return {
    stPluginPath: path.join(steamRoot, 'config', 'stplug-in'),
    depotCachePath: path.join(steamRoot, 'depotcache')
  };
}

function resolveSteamRoot(settings) {
  const configured = String(settings.steamRoot || '').trim();
  if (configured && fs.existsSync(path.join(configured, 'steam.exe'))) return configured;
  return detectSteamRoot();
}

function resolveInstallFolders(settings) {
  const steamRoot = resolveSteamRoot(settings);
  const defaults = defaultSteamFolders(steamRoot);
  return {
    steamRoot,
    stPluginPath: String(settings.stPluginPath || '').trim() || defaults.stPluginPath,
    depotCachePath: String(settings.depotCachePath || '').trim() || defaults.depotCachePath
  };
}

function readLibraryRoots(steamRoot) {
  const roots = new Set();
  if (!steamRoot) return [];

  const mainSteamApps = path.join(steamRoot, 'steamapps');
  if (fs.existsSync(mainSteamApps)) roots.add(mainSteamApps);

  const libraryVdf = path.join(mainSteamApps, 'libraryfolders.vdf');
  if (!fs.existsSync(libraryVdf)) return [...roots];

  try {
    const content = fs.readFileSync(libraryVdf, 'utf8');
    const pathRegex = /"path"\s+"([^"]+)"/gi;
    let match;
    while ((match = pathRegex.exec(content)) !== null) {
      const libRoot = match[1].replace(/\\\\/g, '\\').trim();
      const steamApps = libRoot.toLowerCase().endsWith('steamapps')
        ? libRoot
        : path.join(libRoot, 'steamapps');
      if (fs.existsSync(steamApps)) roots.add(path.normalize(steamApps));
    }
  } catch {
    return [...roots];
  }

  return [...roots];
}

function readAcfValue(content, key) {
  const re = new RegExp(`"${key}"\\s+"([^"]*)"`, 'i');
  const match = content.match(re);
  return match ? match[1] : '';
}

function normalizeInstallDirKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\\/]+/g, '/');
}

function dedupeInstalledGames(games) {
  const seen = new Set();
  const unique = [];
  for (const game of Array.isArray(games) ? games : []) {
    const appId = String(game?.appId || '').trim();
    if (!appId) continue;
    const installDir = normalizeInstallDirKey(game.installDir);
    const key = installDir ? `${appId}:${installDir}` : appId;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(game);
  }
  return unique;
}

function normalizeSteamOptions(options = {}) {
  return {
    forceMetadata: Boolean(options?.forceMetadata),
    forceBanner: Boolean(options?.forceBanner)
  };
}

function steamCdnBannerCandidates(appId) {
  const id = String(appId || '').trim();
  if (!id) return [];
  return [
    { source: 'cdn-header', url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg` },
    { source: 'cdn-capsule-616', url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg` },
    { source: 'cdn-capsule-467', url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_467x181.jpg` },
    { source: 'cdn-capsule-small', url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/capsule_sm_120.jpg` }
  ];
}

function steamBannerCandidates(appId, appData = {}) {
  const candidates = [
    { source: 'appdetails-header', url: appData?.header_image },
    { source: 'appdetails-capsule', url: appData?.capsule_image },
    ...steamCdnBannerCandidates(appId)
  ];

  const seen = new Set();
  return candidates
    .map((candidate) => ({
      source: candidate.source,
      url: String(candidate.url || '').trim()
    }))
    .filter((candidate) => {
      if (!candidate.url || seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      try {
        const parsed = new URL(candidate.url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch {
        return false;
      }
    });
}

function appendBannerResolutionLog(entry) {
  try {
    fs.mkdirSync(path.dirname(bannerResolutionLogPath()), { recursive: true });
    fs.appendFileSync(bannerResolutionLogPath(), `${JSON.stringify({
      time: new Date().toISOString(),
      appid: String(entry.appid || ''),
      source: String(entry.source || ''),
      url: String(entry.url || ''),
      status: String(entry.status || ''),
      final: String(entry.final || '')
    })}\n`, 'utf8');
  } catch {
    // Banner logging is diagnostic only and must never block UI rendering.
  }
}

async function readBannerCache(appId) {
  const id = String(appId || '').trim();
  if (!id) return null;
  const cached = await readJson(bannerCachePath(id), null);
  if (!cached || cached.placeholder || cached.url === GAME_PLACEHOLDER_IMAGE) return null;
  const age = Date.now() - Number(cached.cachedAt || 0);
  if (!cached.url || age < 0 || age > STEAM_BANNER_CACHE_TTL_MS) return null;
  return cached;
}

async function writeBannerCache(appId, url, source) {
  if (!url || url === GAME_PLACEHOLDER_IMAGE) return;
  await writeJson(bannerCachePath(appId), {
    appId: String(appId),
    url,
    source,
    cachedAt: Date.now()
  });
}

async function validateImageUrl(url) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, status: 'empty-url' };

  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, status: 'invalid-protocol' };
    }
  } catch {
    return { ok: false, status: 'invalid-url' };
  }

  try {
    const response = await httpFetchWithTimeout(target, {
      headers: makeHeaders({ Accept: 'image/*' })
    }, STEAM_IMAGE_VALIDATE_TIMEOUT_MS);

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (response.status !== 200) return { ok: false, status: `http-${response.status}` };
    if (!contentType.startsWith('image/')) return { ok: false, status: contentType ? `type-${contentType}` : 'missing-content-type' };
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0
      ? { ok: true, status: '200' }
      : { ok: false, status: 'empty-image' };
  } catch (error) {
    return { ok: false, status: error?.name === 'AbortError' ? 'timeout' : `error:${error.message || String(error)}` };
  }
}

async function resolveSteamBanner(appId, appData = {}, options = {}) {
  const id = String(appId || '').trim();
  if (!/^\d+$/.test(id)) return GAME_PLACEHOLDER_IMAGE;
  const force = Boolean(options?.force);
  const inflightKey = `${id}:${force ? 'force' : 'normal'}`;
  if (bannerResolveInFlight.has(inflightKey)) return bannerResolveInFlight.get(inflightKey);

  const promise = (async () => {
    if (!force) {
      const cached = await readBannerCache(id);
      if (cached?.url) {
        bannerStats.hits += 1;
        appendBannerResolutionLog({
          appid: id,
          source: cached.source || 'cache',
          url: cached.url,
          status: 'cache-hit',
          final: cached.url
        });
        return cached.url;
      }
    }

    bannerStats.misses += 1;
    for (const candidate of steamBannerCandidates(id, appData)) {
      const result = await validateImageUrl(candidate.url);
      appendBannerResolutionLog({
        appid: id,
        source: candidate.source,
        url: candidate.url,
        status: result.status,
        final: result.ok ? candidate.url : ''
      });
      if (result.ok) {
        bannerStats.resolved += 1;
        await writeBannerCache(id, candidate.url, candidate.source);
        return candidate.url;
      }
    }

    bannerStats.placeholders += 1;
    appendBannerResolutionLog({
      appid: id,
      source: 'placeholder',
      url: GAME_PLACEHOLDER_IMAGE,
      status: 'fallback',
      final: GAME_PLACEHOLDER_IMAGE
    });
    return GAME_PLACEHOLDER_IMAGE;
  })().finally(() => {
    bannerResolveInFlight.delete(inflightKey);
  });

  bannerResolveInFlight.set(inflightKey, promise);
  return promise;
}

function normalizeSteamDetails(appId, data = {}, bannerUrl = GAME_PLACEHOLDER_IMAGE) {
  const id = String(appId || '').trim();
  return {
    appId: id,
    name: data?.name || `Steam App ${id}`,
    bannerUrl,
    image: bannerUrl,
    shortDescription: data?.short_description || '',
    releaseDate: data?.release_date?.date || '',
    developers: Array.isArray(data?.developers) ? data.developers : [],
    publishers: Array.isArray(data?.publishers) ? data.publishers : [],
    genres: Array.isArray(data?.genres) ? data.genres.map((g) => g.description).filter(Boolean) : [],
    sourceData: data && typeof data === 'object' ? data : {}
  };
}

async function fetchSteamAppDetails(appId, options = {}) {
  const id = String(appId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Steam App ID must be numeric.');
  const normalizedOptions = normalizeSteamOptions(options);
  const cached = steamDetailsCache.get(id);
  if (
    cached &&
    !normalizedOptions.forceMetadata &&
    !normalizedOptions.forceBanner &&
    Date.now() - cached.cachedAt < STEAM_METADATA_CACHE_TTL_MS
  ) {
    return cached.details;
  }

  if (
    cached &&
    !normalizedOptions.forceMetadata &&
    normalizedOptions.forceBanner &&
    Date.now() - cached.cachedAt < STEAM_METADATA_CACHE_TTL_MS
  ) {
    const bannerUrl = await resolveSteamBanner(id, cached.details.sourceData || {}, { force: true });
    const refreshed = { ...cached.details, bannerUrl, image: bannerUrl };
    steamDetailsCache.set(id, { details: refreshed, cachedAt: Date.now() });
    return refreshed;
  }

  const inflightKey = `${id}:${normalizedOptions.forceMetadata ? 'force-meta' : 'normal'}:${normalizedOptions.forceBanner ? 'force-banner' : 'normal-banner'}`;
  if (steamDetailsInFlight.has(inflightKey)) return steamDetailsInFlight.get(inflightKey);

  const promise = (async () => {
    let data = {};
    try {
      const url = `${STORE_DETAILS_URL}?appids=${encodeURIComponent(id)}&l=english&cc=US`;
      const response = await httpFetch(url, { headers: makeHeaders() });
      if (!response.ok) throw new Error(formatHttpError(response, await response.text()));
      const json = await response.json();
      const entry = json[id];
      if (entry && entry.success !== false && entry.data) data = entry.data;
    } catch (error) {
      appendBannerResolutionLog({
        appid: id,
        source: 'appdetails',
        url: STORE_DETAILS_URL,
        status: `metadata-error:${error.message || String(error)}`,
        final: ''
      });
    }

    const bannerUrl = await resolveSteamBanner(id, data, { force: normalizedOptions.forceBanner });
    const details = normalizeSteamDetails(id, data, bannerUrl);
    steamDetailsCache.set(id, { details, cachedAt: Date.now() });
    return details;
  })().finally(() => {
    steamDetailsInFlight.delete(inflightKey);
  });

  steamDetailsInFlight.set(inflightKey, promise);
  return promise;
}

async function hydrateGameListMetadata(games, options = {}) {
  return mapWithConcurrency(games, 6, async (game) => {
    const appId = String(game?.appId || '').trim();
    if (!/^\d+$/.test(appId)) return game;
    try {
      const details = await fetchSteamAppDetails(appId, options);
      return {
        ...game,
        name: game.name || details.name,
        shortDescription: details.shortDescription,
        releaseDate: details.releaseDate,
        developers: details.developers,
        publishers: details.publishers,
        genres: details.genres,
        bannerUrl: details.bannerUrl,
        image: details.bannerUrl
      };
    } catch {
      const bannerUrl = await resolveSteamBanner(appId, {}, { force: Boolean(options?.forceBanner) });
      return { ...game, bannerUrl, image: bannerUrl };
    }
  });
}

async function listInstalledGames(settings, options = {}) {
  const steamRoot = resolveSteamRoot(settings);
  const steamAppsDirs = readLibraryRoots(steamRoot);
  const games = [];

  for (const dir of steamAppsDirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => /^appmanifest_\d+\.acf$/i.test(name));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const appId = readAcfValue(content, 'appid');
        const name = readAcfValue(content, 'name');
        const installDir = readAcfValue(content, 'installdir');
        if (!appId || !name || EXCLUDED_APP_IDS.has(appId)) continue;
        games.push({
          appId,
          name,
          installDir,
          libraryPath: dir
        });
      } catch {
        continue;
      }
    }
  }

  const uniqueGames = dedupeInstalledGames(games).sort((a, b) => a.name.localeCompare(b.name));
  const hydratedGames = await hydrateGameListMetadata(uniqueGames, options);
  return { steamRoot, games: hydratedGames, count: hydratedGames.length };
}

async function searchSteam(query, options = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];

  const url = `${STORE_SEARCH_URL}?term=${encodeURIComponent(trimmed)}&l=english&cc=US&count=${STEAM_SEARCH_RESULT_LIMIT}`;
  const response = await httpFetch(url, { headers: makeHeaders() });
  if (!response.ok) throw new Error(formatHttpError(response, await response.text()));

  const json = await response.json();
  const items = Array.isArray(json.items) ? json.items : [];
  const seen = new Set();
  const games = items.map((item) => ({
    appId: String(item.id),
    name: item.name || `Steam App ${item.id}`,
    price: item.price?.final ? item.price.final / 100 : null
  })).filter((game) => {
    if (!/^\d+$/.test(game.appId) || seen.has(game.appId)) return false;
    seen.add(game.appId);
    return true;
  }).slice(0, STEAM_SEARCH_RESULT_LIMIT);

  return hydrateGameListMetadata(games, options);
}

async function steamDetails(appId, options = {}) {
  const id = String(appId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Steam App ID must be numeric.');
  return fetchSteamAppDetails(id, options);
}

function gamegenSources(config) {
  return orderedSources(config).filter((source) =>
    source.type === 'gamegen' && String(source.apiKey || '').trim());
}

function noWorkingSourceResult(errors, fallback) {
  return {
    ok: false,
    errorMessage: errors.length ? `No backend source worked. ${errors.join(' | ')}` : fallback
  };
}

async function activateApi() {
  const settings = await loadSettings();
  const config = await loadSourcesConfig();
  const errors = [];

  for (const source of gamegenSources(config)) {
    const pathTemplate = source.activatePath || '/api/{key}/activate';
    const url = sourceEndpoint(source, pathTemplate);

    try {
      const response = await httpFetch(url, {
        method: 'POST',
        headers: sourceHeaders(source, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          machineId: settings.machineId,
          os: osDescription(),
          version: app.getVersion()
        })
      });

      const raw = await response.text();
      if (response.status === 401) throw new Error('invalid API key (401)');
      if (response.status === 429) throw new Error('daily quota exceeded (429)');
      if (!response.ok) throw new Error(formatHttpError(response, raw));

      const normalized = normalizeActivationPayload(JSON.parse(raw));
      if (normalized.ok) {
        settings.lastActivatedAt = new Date().toISOString();
        await saveSettings(settings);
        return { ...normalized, sourceId: source.id, sourceName: source.name };
      }

      throw new Error(normalized.errorMessage || 'activation rejected');
    } catch (error) {
      errors.push(`${source.name}: ${error.message || String(error)}`);
    }
  }

  return noWorkingSourceResult(errors, `Add at least one enabled GameGen source with an apiKey in ${sourcesPath()}.`);
}

async function statsApi() {
  const config = await loadSourcesConfig();
  const errors = [];

  for (const source of gamegenSources(config)) {
    const pathTemplate = source.statsPath || '/api/{key}/stats';
    const url = sourceEndpoint(source, pathTemplate);

    try {
      const response = await httpFetch(url, { headers: sourceHeaders(source) });
      const raw = await response.text();
      if (!response.ok) throw new Error(formatHttpError(response, raw));
      return { ...normalizeStatsPayload(JSON.parse(raw)), sourceId: source.id, sourceName: source.name };
    } catch (error) {
      errors.push(`${source.name}: ${error.message || String(error)}`);
    }
  }

  return noWorkingSourceResult(errors, `Add at least one enabled GameGen source with an apiKey in ${sourcesPath()}.`);
}

async function requestGameApi(payload) {
  const appId = String(payload.appId || '').trim();
  if (!/^\d+$/.test(appId)) return { ok: false, errorMessage: 'Steam App ID must be numeric.' };

  const config = await loadSourcesConfig();
  const errors = [];

  for (const source of gamegenSources(config)) {
    const pathTemplate = source.requestPath || '/api/{key}/request/{appId}';
    const url = sourceEndpoint(source, pathTemplate, appId);

    try {
      const response = await httpFetch(url, {
        method: 'POST',
        headers: sourceHeaders(source, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ reason: String(payload.reason || '').trim() || null })
      });
      const raw = await response.text();

      if (!response.ok) throw new Error(formatHttpError(response, raw));

      const json = raw ? JSON.parse(raw) : {};
      if (json.status === 'sent' || json.success === true) {
        return {
          ok: true,
          sourceId: source.id,
          sourceName: source.name,
          appId: json.appId || appId,
          gameName: json.gameName || ''
        };
      }

      throw new Error(json.error || json.message || `request not sent (status: ${json.status || 'unknown'})`);
    } catch (error) {
      errors.push(`${source.name}: ${error.message || String(error)}`);
    }
  }

  return noWorkingSourceResult(errors, `Requests need an enabled GameGen source in ${sourcesPath()}.`);
}

async function zipFromHttpResponse(response, source, appId, sender, phase, baseForRelativeUrls) {
  const raw = await readBodyBytes(response, (pct) => {
    if (sender) {
      sender.send('download-progress', {
        appId,
        sourceId: source.id,
        sourceName: source.name,
        phase,
        percent: pct
      });
    }
  });

  if (looksLikeZip(raw)) return raw;

  const json = parseJsonBuffer(raw);
  if (!json) {
    if (!response.ok) throw new Error(formatHttpError(response, raw.toString('utf8')));
    throw new Error('response was not a ZIP archive.');
  }

  if (!response.ok) {
    throw new Error(json.error || json.message || `HTTP ${response.status}`);
  }

  if (json.success === false) {
    throw new Error(json.error || json.message || 'Manifest service rejected the request.');
  }

  const downloadUrl =
    json.manifest?.downloadUrl ||
    json.downloadUrl ||
    json.download_url ||
    json.browser_download_url;
  const returnedAppId = String(json.manifest?.appId || json.appId || appId);

  if (returnedAppId && returnedAppId !== appId) {
    throw new Error(`Manifest package was for app ${returnedAppId}, but install targets ${appId}.`);
  }

  if (!downloadUrl) {
    throw new Error(json.error || json.message || 'Manifest service did not return a ZIP download URL.');
  }

  const resolvedDownloadUrl = absoluteUrl(baseForRelativeUrls, downloadUrl);
  const zipResponse = await httpFetch(resolvedDownloadUrl, {
    headers: sourceHeaders(source, {
      'Accept': 'application/zip, application/octet-stream'
    })
  });

  return zipFromHttpResponse(zipResponse, source, appId, sender, 'download', resolvedDownloadUrl);
}

async function downloadFromGameGenSource(source, appId, sender) {
  if (!String(source.apiKey || '').trim()) throw new Error('missing apiKey');

  const pathTemplate = source.generatePath || '/api/{key}/generate/{appId}?format=zip';
  const url = sourceEndpoint(source, pathTemplate, appId);
  const response = await httpFetch(url, {
    headers: sourceHeaders(source, {
      'Accept': 'application/zip, application/octet-stream, application/json'
    })
  });

  return zipFromHttpResponse(response, source, appId, sender, 'generate', resolveApiBase(source));
}

async function downloadFromZipUrlSource(source, appId, sender) {
  const url = applySourceTemplate(source.urlTemplate, source, appId);
  if (!/^https?:\/\//i.test(url)) throw new Error('urlTemplate must resolve to http(s).');

  const response = await httpFetch(url, {
    headers: sourceHeaders(source, {
      'Accept': 'application/zip, application/octet-stream, application/json'
    })
  });

  return zipFromHttpResponse(response, source, appId, sender, 'repository', url);
}

async function downloadFromLuaUrlSource(source, appId, sender) {
  const url = applySourceTemplate(source.urlTemplate, source, appId);
  if (!/^https?:\/\//i.test(url)) throw new Error('urlTemplate must resolve to http(s).');

  const response = await httpFetch(url, {
    headers: sourceHeaders(source, {
      'Accept': 'text/plain, application/octet-stream'
    })
  });
  const raw = await readBodyBytes(response, (pct) => {
    if (sender) {
      sender.send('download-progress', {
        appId,
        sourceId: source.id,
        sourceName: source.name,
        phase: 'lua',
        percent: pct
      });
    }
  });

  if (!response.ok) {
    throw new Error(response.status === 404 ? 'Lua file was not found.' : formatHttpError(response, raw.toString('utf8')));
  }

  if (raw.length === 0) throw new Error('Lua file was empty.');
  if (looksLikeZip(raw)) throw new Error('Lua source returned a ZIP archive.');

  return raw;
}

async function downloadFromLocalFolderSource(source, appId) {
  const folder = path.resolve(String(source.folder || ''));
  const fileName = applySourceTemplate(source.fileTemplate || '{appId}.zip', source, appId);
  const filePath = path.resolve(folder, fileName);
  const relative = path.relative(folder, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('local fileTemplate resolves outside the configured folder.');
  }

  const zipBytes = await fsp.readFile(filePath);
  if (!looksLikeZip(zipBytes)) throw new Error(`${filePath} is not a ZIP archive.`);
  return zipBytes;
}

async function downloadLooseDatabasePackage(source, appId, entry, sender, allowWithoutManifests = false) {
  const manifestNames = uniqueStrings(Array.isArray(entry?.manifests) ? entry.manifests : []);
  if (!allowWithoutManifests && !manifestNames.length) {
    throw new Error('database entry has no loose manifests.');
  }

  const luaCandidates = uniqueStrings([entry?.lua, `${appId}.lua`]);
  let luaName = '';
  let luaBytes = null;
  let luaError = null;
  for (const candidate of luaCandidates) {
    try {
      luaBytes = await downloadDatabaseFile(source, candidate, appId, sender, 'lua', 'text/plain, application/octet-stream');
      luaName = candidate;
      break;
    } catch (error) {
      luaError = error;
    }
  }
  if (!luaBytes) throw luaError || new Error('database Lua file was not found.');
  if (looksLikeZip(luaBytes)) throw new Error('database Lua source returned a ZIP archive.');

  const files = [{
    name: path.basename(cleanDatabaseFileName(luaName)),
    bytes: luaBytes,
    targetType: 'lua'
  }];

  for (const manifestName of manifestNames) {
    const manifestBytes = await downloadDatabaseFile(source, manifestName, appId, sender, 'manifest', 'application/octet-stream');
    files.push({
      name: path.basename(cleanDatabaseFileName(manifestName)),
      bytes: manifestBytes,
      targetType: 'manifest'
    });
  }

  return files;
}

async function downloadDatabaseZip(source, zipName, appId, sender) {
  const zipBytes = await downloadDatabaseFile(source, zipName, appId, sender, 'repository', 'application/zip, application/octet-stream');
  if (!looksLikeZip(zipBytes)) throw new Error(`${zipName} was not a ZIP archive.`);
  return zipBytes;
}

async function downloadFromDatabaseSource(source, appId, sender) {
  const errors = [];
  let directLuaFiles = null;
  let index = null;
  let entry = null;

  try {
    const luaBytes = await downloadDatabaseFile(source, `${appId}.lua`, appId, sender, 'lua', 'text/plain, application/octet-stream');
    if (looksLikeZip(luaBytes)) throw new Error('database Lua source returned a ZIP archive.');

    directLuaFiles = [{
      name: `${appId}.lua`,
      bytes: luaBytes,
      targetType: 'lua'
    }];

    try {
      index = await loadDatabaseIndex(source);
      entry = databaseIndexEntry(index, appId);
      const manifestNames = uniqueStrings(Array.isArray(entry?.manifests) ? entry.manifests : []);
      for (const manifestName of manifestNames) {
        const manifestBytes = await downloadDatabaseFile(source, manifestName, appId, sender, 'manifest', 'application/octet-stream');
        directLuaFiles.push({
          name: path.basename(cleanDatabaseFileName(manifestName)),
          bytes: manifestBytes,
          targetType: 'manifest'
        });
      }
    } catch (error) {
      errors.push(`optional index manifests: ${error.message || String(error)}`);
    }

    if (directLuaFiles.length > 1) return { kind: 'files', files: directLuaFiles };
  } catch (error) {
    errors.push(`${appId}.lua: ${error.message || String(error)}`);
  }

  try {
    return { kind: 'zip', bytes: await downloadDatabaseZip(source, `${appId}.zip`, appId, sender) };
  } catch (error) {
    errors.push(`${appId}.zip: ${error.message || String(error)}`);
  }

  if (directLuaFiles) return { kind: 'files', files: directLuaFiles };

  try {
    if (!index) index = await loadDatabaseIndex(source);
    entry = databaseIndexEntry(index, appId);
  } catch (error) {
    errors.push(`index: ${error.message || String(error)}`);
  }

  for (const zipName of uniqueStrings([entry?.zip]).filter((name) => name !== `${appId}.zip`)) {
    try {
      return { kind: 'zip', bytes: await downloadDatabaseZip(source, zipName, appId, sender) };
    } catch (error) {
      errors.push(`${zipName}: ${error.message || String(error)}`);
    }
  }

  if (entry?.lua) {
    try {
      return { kind: 'files', files: await downloadLooseDatabasePackage(source, appId, entry, sender, true) };
    } catch (error) {
      errors.push(`indexed loose package: ${error.message || String(error)}`);
    }
  }

  throw new Error(errors.length ? errors.join(' | ') : 'database package was not found.');
}

async function downloadFromSource(source, appId, sender) {
  if (source.type === 'database-url') return downloadFromDatabaseSource(source, appId, sender);
  if (source.type === 'lua-url') return { kind: 'lua', bytes: await downloadFromLuaUrlSource(source, appId, sender) };
  if (source.type === 'gamegen') return downloadFromGameGenSource(source, appId, sender);
  if (source.type === 'zip-url') return downloadFromZipUrlSource(source, appId, sender);
  if (source.type === 'local-folder') return downloadFromLocalFolderSource(source, appId);
  throw new Error('Manifest provider is unavailable.');
}

async function downloadManifestPackage(appId, sender) {
  const id = String(appId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Steam App ID must be numeric.');

  const config = await loadSourcesConfig();
  const sources = orderedSources(config);
  const errors = [];

  if (!sources.length) {
    throw new Error('Manifest service is not configured.');
  }

  for (const source of sources) {
    try {
      if (sender) sender.send('download-progress', {
        appId: id,
        sourceId: source.id,
        sourceName: source.name,
        phase: 'source',
        percent: 0
      });

      const result = await downloadFromSource(source, id, sender);
      if (result?.kind === 'files') return { kind: 'files', files: result.files, source };
      if (result?.kind === 'lua') return { kind: 'lua', luaBytes: result.bytes, source };
      if (result?.kind === 'zip') return { kind: 'zip', zipBytes: result.bytes, source };
      return { kind: 'zip', zipBytes: result, source };
    } catch (error) {
      errors.push(`${source.name}: ${error.message || String(error)}`);
    }
  }

  throw new Error('Manifest download failed. Check your connection or try again later.');
}

async function installZipForApp({ appId, gameName, zipBytes }) {
  const settings = await loadSettings();
  const folders = resolveInstallFolders(settings);

  if (!folders.stPluginPath || !folders.depotCachePath) {
    throw new Error('Steam plugin or depot cache folder cannot be resolved. Set paths in Settings.');
  }

  await fsp.mkdir(folders.stPluginPath, { recursive: true });
  await fsp.mkdir(folders.depotCachePath, { recursive: true });

  const zip = new AdmZip(zipBytes);
  const deployed = [];
  const atomicWrites = [];
  const luaAppIds = zip.getEntries()
    .filter((entry) => !entry.isDirectory && path.extname(entry.entryName).toLowerCase() === '.lua')
    .map((entry) => path.basename(entry.entryName, path.extname(entry.entryName)))
    .filter((value) => /^\d+$/.test(value));
  if (luaAppIds.length && !luaAppIds.includes(String(appId))) {
    throw new Error(`The ZIP contains Lua for App ID ${luaAppIds[0]}, but install targets ${appId}.`);
  }

  try {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;

      const ext = path.extname(entry.entryName).toLowerCase();
      const targetDir = ext === '.lua'
        ? folders.stPluginPath
        : ext === '.manifest'
          ? folders.depotCachePath
          : '';

      if (!targetDir) continue;

      const dest = path.join(targetDir, path.basename(entry.entryName));
      atomicWrites.push(await writeFileAtomic(dest, entry.getData()));
      deployed.push(path.resolve(dest));
    }

    if (deployed.length === 0) {
      throw new Error('The downloaded ZIP did not contain any .lua or .manifest files.');
    }

    const hash = crypto.createHash('sha256').update(zipBytes).digest('hex');
    await forgetRemovedManifest(appId);
    const installed = await loadInstalled();
    installed.records = installed.records.filter((record) => String(record.appId) !== String(appId));
    installed.records.push({
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      installedAt: new Date().toISOString(),
      zipSha256: hash,
      files: deployed
    });
    await saveInstalled(installed);
    await cleanupAtomicWrites(atomicWrites);

    return {
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      files: deployed,
      fileCount: deployed.length,
      stPluginPath: folders.stPluginPath,
      depotCachePath: folders.depotCachePath
    };
  } catch (error) {
    await rollbackAtomicWrites(atomicWrites);
    throw error;
  }
}

async function installLuaForApp({ appId, gameName, luaBytes }) {
  const settings = await loadSettings();
  const folders = resolveInstallFolders(settings);

  if (!folders.stPluginPath) {
    throw new Error('Steam plugin folder cannot be resolved. Set paths in Settings.');
  }

  await fsp.mkdir(folders.stPluginPath, { recursive: true });
  const dest = path.join(folders.stPluginPath, `${appId}.lua`);
  const atomicWrites = [];
  try {
    atomicWrites.push(await writeFileAtomic(dest, luaBytes));
    const resolvedDest = path.resolve(dest);
    const hash = crypto.createHash('sha256').update(luaBytes).digest('hex');
    await forgetRemovedManifest(appId);
    const installed = await loadInstalled();
    installed.records = installed.records.filter((record) => String(record.appId) !== String(appId));
    installed.records.push({
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      installedAt: new Date().toISOString(),
      luaSha256: hash,
      files: [resolvedDest]
    });
    await saveInstalled(installed);
    await cleanupAtomicWrites(atomicWrites);

    return {
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      files: [resolvedDest],
      fileCount: 1,
      stPluginPath: folders.stPluginPath,
      depotCachePath: folders.depotCachePath
    };
  } catch (error) {
    await rollbackAtomicWrites(atomicWrites);
    throw error;
  }
}

async function installFilePackageForApp({ appId, gameName, files }) {
  const settings = await loadSettings();
  const folders = resolveInstallFolders(settings);

  if (!folders.stPluginPath || !folders.depotCachePath) {
    throw new Error('Steam plugin or depot cache folder cannot be resolved. Set paths in Settings.');
  }

  await fsp.mkdir(folders.stPluginPath, { recursive: true });
  await fsp.mkdir(folders.depotCachePath, { recursive: true });

  const deployed = [];
  const atomicWrites = [];
  const hash = crypto.createHash('sha256');

  try {
    for (const file of Array.isArray(files) ? files : []) {
      const fileName = path.basename(String(file?.name || ''));
      const ext = path.extname(fileName).toLowerCase();
      const targetDir = file.targetType === 'lua' || ext === '.lua'
        ? folders.stPluginPath
        : file.targetType === 'manifest' || ext === '.manifest'
          ? folders.depotCachePath
          : '';

      if (!fileName || !targetDir || !Buffer.isBuffer(file.bytes)) continue;

      const dest = path.join(targetDir, fileName);
      atomicWrites.push(await writeFileAtomic(dest, file.bytes));
      hash.update(fileName);
      hash.update(file.bytes);
      deployed.push(path.resolve(dest));
    }

    if (deployed.length === 0) {
      throw new Error('The database package did not contain any .lua or .manifest files.');
    }

    await forgetRemovedManifest(appId);
    const installed = await loadInstalled();
    installed.records = installed.records.filter((record) => String(record.appId) !== String(appId));
    installed.records.push({
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      installedAt: new Date().toISOString(),
      packageSha256: hash.digest('hex'),
      files: deployed
    });
    await saveInstalled(installed);
    await cleanupAtomicWrites(atomicWrites);

    return {
      appId: String(appId),
      gameName: gameName || `Steam App ${appId}`,
      files: deployed,
      fileCount: deployed.length,
      stPluginPath: folders.stPluginPath,
      depotCachePath: folders.depotCachePath
    };
  } catch (error) {
    await rollbackAtomicWrites(atomicWrites);
    throw error;
  }
}

async function generateAndInstall(event, payload) {
  const appId = String(payload.appId || '').trim();
  const gameName = String(payload.gameName || '').trim();
  await assertAutoInstallQuota();
  const downloaded = await downloadManifestPackage(appId, event.sender);
  let manifestSource = '';
  let result;

  if (downloaded.kind === 'files') {
    const enriched = await enrichFilesWithRequiredManifests(appId, downloaded.files, event.sender);
    manifestSource = enriched.manifestSource;
    result = await installFilePackageForApp({ appId, gameName, files: enriched.files });
  } else if (downloaded.kind === 'lua') {
    const enriched = await enrichFilesWithRequiredManifests(appId, [{
      name: `${appId}.lua`,
      bytes: downloaded.luaBytes,
      targetType: 'lua'
    }], event.sender);
    manifestSource = enriched.manifestSource;
    result = await installFilePackageForApp({ appId, gameName, files: enriched.files });
  } else {
    const enriched = await enrichZipWithRequiredManifests(appId, downloaded.zipBytes, event.sender);
    manifestSource = enriched.manifestSource;
    result = await installZipForApp({ appId, gameName, zipBytes: enriched.zipBytes });
    if (downloaded.source?.type === 'gamegen') {
      scheduleManifestVaultBackfills(manifestFileNamesFromZip(enriched.zipBytes));
    }
  }

  if (downloaded.source?.type === 'gamegen') {
    void scheduleBackfill({ type: 'external-package', appId });
  }

  const quota = await recordAutoInstallUse();
  return {
    ...result,
    sourceId: downloaded.source.id,
    sourceName: downloaded.source.name,
    sourceType: downloaded.source.type,
    manifestSource,
    quota
  };
}

async function installZipBytes(payload) {
  const appId = String(payload.appId || '').trim();
  if (!/^\d+$/.test(appId)) throw new Error('Steam App ID must be numeric.');

  if (!payload.zipBytes) throw new Error('Choose a manifest ZIP file first.');

  const zipBytes = Buffer.from(payload.zipBytes);
  if (!looksLikeZip(zipBytes)) throw new Error('Selected file is not a ZIP archive.');

  const gameName = String(payload.gameName || '').trim() || `Steam App ${appId}`;
  return installZipForApp({ appId, gameName, zipBytes });
}

async function removeInstalledManifest(appId) {
  const id = String(appId || '').trim();
  if (!id) return { ok: true, removed: 0, records: [] };

  const installed = await readJson(installedPath(), { records: [] });
  if (!Array.isArray(installed.records)) installed.records = [];
  const records = installed.records.filter((item) => String(item.appId) === id);
  await rememberRemovedManifest(id);
  if (!records.length) {
    const refreshed = await loadInstalled();
    return { ok: true, removed: 0, records: refreshed.records };
  }

  let removed = 0;
  const filePaths = new Set(records.flatMap((record) => Array.isArray(record.files) ? record.files : []));
  for (const filePath of filePaths) {
    const resolved = String(filePath || '').trim();
    if (!resolved) continue;
    try {
      if (fs.existsSync(resolved)) {
        await fsp.unlink(resolved);
        removed += 1;
      }
    } catch {
      continue;
    }
  }

  installed.records = installed.records.filter((item) => String(item.appId) !== id);
  await saveInstalled(installed);
  const refreshed = await loadInstalled();
  return { ok: true, removed, records: refreshed.records };
}

async function restartSteam() {
  try {
    execSync('taskkill /F /IM steam.exe', { stdio: 'ignore', windowsHide: true });
  } catch {
    // Steam was not running.
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  await shell.openExternal('steam://open/main');
  return { ok: true };
}

async function openSteamClient() {
  await shell.openExternal('steam://open/main');
  return { ok: true };
}

async function installDownloadedPackage(appId, gameName, downloaded) {
  if (downloaded.kind === 'files') {
    return installFilePackageForApp({ appId, gameName, files: downloaded.files });
  }
  if (downloaded.kind === 'lua') {
    return installLuaForApp({ appId, gameName, luaBytes: downloaded.luaBytes });
  }
  return installZipForApp({ appId, gameName, zipBytes: downloaded.zipBytes });
}

async function withIsolatedSmokeDataRoot(prefix, task) {
  const previousEnvRoot = process.env.CHARON_DATA_ROOT;
  const previousDataRoot = dataRoot;
  const previousMigrated = dataRootMigrated;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    process.env.CHARON_DATA_ROOT = root;
    dataRoot = root;
    dataRootMigrated = true;
    return await task(root);
  } finally {
    dataRoot = previousDataRoot;
    dataRootMigrated = previousMigrated;
    if (previousEnvRoot === undefined) {
      delete process.env.CHARON_DATA_ROOT;
    } else {
      process.env.CHARON_DATA_ROOT = previousEnvRoot;
    }
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runManualImportSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-manual-import-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    const zip = new AdmZip();
    zip.addFile('smoke.lua', Buffer.from('-- smoke lua\n', 'utf8'));
    zip.addFile('smoke.manifest', Buffer.from('smoke manifest\n', 'utf8'));

    const result = await installZipBytes({
      appId: '123456',
      gameName: 'Manual Import Smoke',
      zipBytes: zip.toBuffer()
    });

    const luaExists = fs.existsSync(path.join(stPluginPath, 'smoke.lua'));
    const manifestExists = fs.existsSync(path.join(depotCachePath, 'smoke.manifest'));
    const ok = result.fileCount === 2 && luaExists && manifestExists;

    console.log(JSON.stringify({
      ok,
      fileCount: result.fileCount,
      luaExists,
      manifestExists
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runLuaSourceSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-lua-source-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    const appId = '413150';
    const downloaded = await downloadManifestPackage(appId, null);
    const result = await installDownloadedPackage(appId, 'Database Source Smoke', downloaded);
    const luaExists = fs.existsSync(path.join(stPluginPath, `${appId}.lua`));
    const manifestExists = fs.existsSync(path.join(depotCachePath, '413151_4278718763097142923.manifest'));

    console.log(JSON.stringify({
      ok: downloaded.kind === 'files' && downloaded.source.id === 'charon-database-1' && luaExists && manifestExists && result.fileCount >= 4,
      kind: downloaded.kind,
      sourceId: downloaded.source.id,
      sourceName: downloaded.source.name,
      luaExists,
      manifestExists,
      fileCount: result.fileCount
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runLuaFallbackSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-lua-fallback-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    await saveSourcesConfig({
      activeSourceId: 'charon-database-1',
      sources: [
        {
          id: 'charon-database-1',
          name: 'Missing Charon Database 1',
          type: 'database-url',
          enabled: true,
          baseUrl: 'https://raw.githubusercontent.com/BlissBlender/Charon-Database/main/__missing__',
          indexUrl: 'https://raw.githubusercontent.com/BlissBlender/Charon-Database/main/__missing__/index.json',
          headers: {}
        },
        {
          id: 'charon-database-2',
          name: 'Charon Database 2',
          type: 'database-url',
          enabled: true,
          baseUrl: DEFAULT_DATABASE_2_BASE,
          indexUrl: `${DEFAULT_DATABASE_2_BASE}/index.json`,
          headers: {}
        }
      ]
    });

    const appId = '413150';
    const downloaded = await downloadManifestPackage(appId, null);
    const result = await installDownloadedPackage(appId, 'Database Fallback Smoke', downloaded);
    const luaExists = fs.existsSync(path.join(stPluginPath, `${appId}.lua`));

    console.log(JSON.stringify({
      ok: downloaded.kind === 'files' && downloaded.source.id === 'charon-database-2' && luaExists && result.fileCount >= 1,
      kind: downloaded.kind,
      sourceId: downloaded.source.id,
      sourceName: downloaded.source.name,
      luaExists,
      fileCount: result.fileCount
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runDatabaseZipSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-database-zip-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    const appId = '1190600';
    const downloaded = await downloadManifestPackage(appId, null);
    const result = await installDownloadedPackage(appId, 'Database ZIP Smoke', downloaded);
    const luaCount = fs.readdirSync(stPluginPath).filter((name) => name.toLowerCase().endsWith('.lua')).length;
    const manifestCount = fs.readdirSync(depotCachePath).filter((name) => name.toLowerCase().endsWith('.manifest')).length;

    console.log(JSON.stringify({
      ok: downloaded.kind === 'zip' && downloaded.source.id === 'charon-database-1' && luaCount > 0 && manifestCount > 0,
      kind: downloaded.kind,
      sourceId: downloaded.source.id,
      luaCount,
      manifestCount,
      fileCount: result.fileCount
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runDatabaseDirectNoIndexSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-database-direct-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    await saveSourcesConfig({
      activeSourceId: 'charon-database-1',
      sources: [{
        id: 'charon-database-1',
        name: 'Charon Database 1',
        type: 'database-url',
        enabled: true,
        baseUrl: DEFAULT_DATABASE_1_BASE,
        indexUrl: `${DEFAULT_DATABASE_1_BASE}/__missing-index.json`,
        headers: {}
      }]
    });

    const luaAppId = '1086940';
    const luaDownloaded = await downloadManifestPackage(luaAppId, null);
    const luaResult = await installDownloadedPackage(luaAppId, 'Direct Lua No Index Smoke', luaDownloaded);
    const luaExists = fs.existsSync(path.join(stPluginPath, `${luaAppId}.lua`));

    const zipAppId = '1190600';
    const zipDownloaded = await downloadManifestPackage(zipAppId, null);
    const zipResult = await installDownloadedPackage(zipAppId, 'Direct ZIP No Index Smoke', zipDownloaded);
    const zipLuaCount = fs.readdirSync(stPluginPath).filter((name) => name.toLowerCase().endsWith('.lua')).length;
    const manifestCount = fs.readdirSync(depotCachePath).filter((name) => name.toLowerCase().endsWith('.manifest')).length;

    console.log(JSON.stringify({
      ok: luaDownloaded.kind === 'files' &&
        luaResult.fileCount === 1 &&
        luaExists &&
        zipDownloaded.kind === 'zip' &&
        zipLuaCount > 1 &&
        manifestCount > 0 &&
        zipResult.fileCount > 1,
      luaKind: luaDownloaded.kind,
      zipKind: zipDownloaded.kind,
      luaExists,
      zipLuaCount,
      manifestCount,
      luaFileCount: luaResult.fileCount,
      zipFileCount: zipResult.fileCount
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runManifestRemoveSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-remove-manifest-'));
  const fakeSteam = path.join(root, 'Steam');
  const stPluginPath = path.join(fakeSteam, 'config', 'stplug-in');
  const depotCachePath = path.join(fakeSteam, 'depotcache');

  try {
    await fsp.mkdir(stPluginPath, { recursive: true });
    await fsp.mkdir(depotCachePath, { recursive: true });
    await fsp.writeFile(path.join(fakeSteam, 'steam.exe'), '');

    await saveSettings({
      steamRoot: fakeSteam,
      stPluginPath,
      depotCachePath
    });

    const zip = new AdmZip();
    zip.addFile('remove-smoke.lua', Buffer.from('-- remove smoke lua\n', 'utf8'));
    zip.addFile('remove-smoke.manifest', Buffer.from('remove smoke manifest\n', 'utf8'));

    await installZipBytes({
      appId: '654321',
      gameName: 'Remove Smoke',
      zipBytes: zip.toBuffer()
    });

    const result = await removeInstalledManifest('654321');
    const listed = await loadInstalled();
    const luaExists = fs.existsSync(path.join(stPluginPath, 'remove-smoke.lua'));
    const manifestExists = fs.existsSync(path.join(depotCachePath, 'remove-smoke.manifest'));
    const stillListed = listed.records.some((record) => String(record.appId) === '654321');

    console.log(JSON.stringify({
      ok: result.removed === 2 && !luaExists && !manifestExists && !stillListed,
      removed: result.removed,
      luaExists,
      manifestExists,
      stillListed
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runQuotaSmokeTest() {
  return withIsolatedSmokeDataRoot('charon-quota-smoke-', async () => {
    await saveUsageLimits({ autoInstallUses: [] });
    const before = await getAutoInstallQuota();
    for (let index = 0; index < AUTO_INSTALL_DAILY_LIMIT; index += 1) {
      await assertAutoInstallQuota();
      await recordAutoInstallUse();
    }

    const after = await getAutoInstallQuota();
    let blocked = false;
    let message = '';
    try {
      await assertAutoInstallQuota();
    } catch (error) {
      blocked = true;
      message = error.message || String(error);
    }

    console.log(JSON.stringify({
      ok: before.limit === AUTO_INSTALL_DAILY_LIMIT && after.remaining === 0 && blocked,
      limit: before.limit,
      remainingAfterLimit: after.remaining,
      blocked,
      message
    }));
  });
}

async function runDurableQuotaSmokeTest() {
  return withIsolatedSmokeDataRoot('charon-durable-quota-smoke-', async () => {
    await saveUsageLimits({ autoInstallUses: [] });
    await recordAutoInstallUse();
    await fsp.rm(limitsPath(), { force: true });
    const quota = await getAutoInstallQuota();

    console.log(JSON.stringify({
      ok: quota.used === 1 && quota.remaining === AUTO_INSTALL_DAILY_LIMIT - 1,
      usedAfterPortableDelete: quota.used,
      remaining: quota.remaining,
      portablePath: limitsPath(),
      durablePath: durableLimitsPath()
    }));
  });
}

async function runUpdateDownloadSmokeTest() {
  const info = await fetchUpdateInfo();
  if (!/^https?:\/\//i.test(info.downloadUrl)) {
    throw new Error('Update manifest is missing a valid download URL.');
  }

  const response = await updateHttpRequest(info.downloadUrl, {
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    headers: makeHeaders({ Accept: 'application/octet-stream' })
  });
  if (!response.ok) throw new Error(`Update download failed: HTTP ${response.statusCode}`);

  const exeBytes = response.buffer;
  if (exeBytes.length < 1024 * 1024 || exeBytes[0] !== 0x4d || exeBytes[1] !== 0x5a) {
    throw new Error('Downloaded update was not a valid Windows executable.');
  }

  const verification = await verifyUpdateDownload(info, exeBytes);
  console.log(JSON.stringify({
    ok: true,
    latestVersion: info.latestVersion,
    bytes: exeBytes.length,
    sha256: verification.actualSha,
    verifiedBy: verification.verifiedBy
  }));
}

async function runFolderSmokeTest() {
  const steamRoot = 'C:\\Program Files (x86)\\Steam';
  const defaults = defaultSteamFolders(steamRoot);
  const normalized = normalizeSettings({
    steamRoot,
    stPluginPath: defaults.stPluginPath,
    depotCachePath: path.join(steamRoot, 'config', 'depotcache')
  });

  console.log(JSON.stringify({
    ok: defaults.stPluginPath === path.join(steamRoot, 'config', 'stplug-in') &&
      defaults.depotCachePath === path.join(steamRoot, 'depotcache') &&
      normalized.depotCachePath === path.join(steamRoot, 'depotcache'),
    stPluginPath: defaults.stPluginPath,
    depotCachePath: defaults.depotCachePath,
    migratedDepotCachePath: normalized.depotCachePath
  }));
}

async function runSearchSmokeTest() {
  const results = await searchSteam('Stardew Valley');
  const match = results.find((item) => String(item.appId) === '413150');
  const details = await steamDetails('413150');

  console.log(JSON.stringify({
    ok: Boolean(match && details?.appId === '413150' && details?.name),
    resultCount: results.length,
    matchedAppId: match?.appId || '',
    detailName: details?.name || ''
  }));
}

async function runBannerCoverageSmokeTest() {
  const terms = ['a', 'e', 's', 't', 'r', 'g', 'm', 'c', 'd', 'p', 'b', 'l', 'n', 'f', 'war', 'space', 'city', 'sim'];
  const gamesById = new Map();
  const statsStart = { ...bannerStats };

  for (const term of terms) {
    if (gamesById.size >= 100) break;
    try {
      const results = await searchSteam(term, { forceMetadata: true, forceBanner: true });
      for (const game of results) {
        if (gamesById.size >= 100) break;
        if (!gamesById.has(game.appId)) gamesById.set(game.appId, game);
      }
    } catch {
      continue;
    }
  }

  const games = [...gamesById.values()].slice(0, 100);
  const realImages = games.filter((game) => {
    const src = String(game.bannerUrl || game.image || '').trim();
    return src && src !== GAME_PLACEHOLDER_IMAGE;
  }).length;
  const placeholders = games.filter((game) => String(game.bannerUrl || game.image || '').trim() === GAME_PLACEHOLDER_IMAGE).length;
  const blanks = games.filter((game) => !String(game.bannerUrl || game.image || '').trim()).length;
  const coverageNumber = games.length ? (realImages / games.length) * 100 : 0;
  const cacheHits = bannerStats.hits - statsStart.hits;
  const cacheMisses = bannerStats.misses - statsStart.misses;
  const cacheProbe = games.slice(0, 25);
  const hitsBeforeProbe = bannerStats.hits;
  steamDetailsCache.clear();
  await mapWithConcurrency(cacheProbe, 6, async (game) => {
    await fetchSteamAppDetails(game.appId, { forceMetadata: true, forceBanner: false });
  });
  const cacheProbeHits = bannerStats.hits - hitsBeforeProbe;
  const cacheHitRate = cacheProbe.length ? (cacheProbeHits / cacheProbe.length) * 100 : 0;

  console.log(JSON.stringify({
    ok: games.length === 100 && coverageNumber >= 95 && blanks === 0,
    games: games.length,
    realImages,
    placeholders,
    blankBanners: blanks,
    coverage: `${coverageNumber.toFixed(1)}%`,
    cacheHits,
    cacheMisses,
    cacheProbeGames: cacheProbe.length,
    cacheProbeHits,
    cacheHitRate: `${cacheHitRate.toFixed(1)}%`,
    sample: games.slice(0, 10).map((game) => ({
      appId: game.appId,
      name: game.name,
      bannerUrl: game.bannerUrl || game.image || ''
    }))
  }));
}

async function runInstalledDedupeSmokeTest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-installed-dedupe-'));
  try {
    const steamRoot = path.join(root, 'Steam');
    const mainSteamApps = path.join(steamRoot, 'steamapps');
    const secondLibrary = path.join(root, 'Library');
    const secondSteamApps = path.join(secondLibrary, 'steamapps');
    await fsp.mkdir(mainSteamApps, { recursive: true });
    await fsp.mkdir(secondSteamApps, { recursive: true });
    await fsp.writeFile(path.join(steamRoot, 'steam.exe'), '');
    await fsp.writeFile(path.join(mainSteamApps, 'libraryfolders.vdf'), `"libraryfolders"\n{\n  "1"\n  {\n    "path" "${secondLibrary.replace(/\\/g, '\\\\')}"\n  }\n}\n`);
    const manifest = `"AppState"\n{\n  "appid" "999001"\n  "name" "Duplicate Smoke"\n  "installdir" "DuplicateSmoke"\n}\n`;
    await fsp.writeFile(path.join(mainSteamApps, 'appmanifest_999001.acf'), manifest);
    await fsp.writeFile(path.join(secondSteamApps, 'appmanifest_999001.acf'), manifest);

    const result = await listInstalledGames({ steamRoot }, { forceMetadata: false, forceBanner: false });
    console.log(JSON.stringify({
      ok: result.games.length === 1,
      count: result.games.length,
      appId: result.games[0]?.appId || ''
    }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function runManifestEnrichmentSmokeTest() {
  const luaBytes = Buffer.from('addappid(123456, 1, "0123456789abcdef0123456789abcdef")\n-- 987654_123456789.manifest\n', 'utf8');
  const required = await requiredManifestFileNamesForLuaEntries('999999', [{ name: '999999.lua', bytes: luaBytes }]);
  const files = [{ name: '999999.lua', bytes: luaBytes, targetType: 'lua' }];
  const enriched = await enrichFilesWithRequiredManifests('999999', files, null);

  console.log(JSON.stringify({
    ok: required.includes('987654_123456789.manifest') && enriched.files.length >= 1,
    required,
    enrichedFileCount: enriched.files.length,
    manifestSource: enriched.manifestSource || ''
  }));
}

async function runBannerRenderSmokeTest() {
  const testWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    show: false,
    backgroundColor: '#111316',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  try {
    await testWindow.loadFile(path.join(__dirname, 'index.html'));
    const result = await testWindow.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const waitForImages = async (selector, expectedCount) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const images = [...document.querySelectorAll(selector)];
            const loaded = images.filter((img) =>
              img.complete &&
              img.naturalWidth > 32 &&
              !String(img.getAttribute('src') || '').includes('game-placeholder')
            );
            if (images.length >= expectedCount && loaded.length >= expectedCount) {
              return loaded.map((img) => img.getAttribute('src'));
            }
            await wait(250);
          }
          return [...document.querySelectorAll(selector)].map((img) => ({
            src: img.getAttribute('src'),
            complete: img.complete,
            naturalWidth: img.naturalWidth
          }));
        };

        const searchData = await window.charon.steam.search('Stardew Valley', { forceMetadata: false, forceBanner: false });
        const gmod = await window.charon.steam.details('4000', { forceMetadata: false, forceBanner: false });
        renderSearchResults([
          searchData.find((item) => item.appId === '413150') || await window.charon.steam.details('413150', { forceMetadata: false, forceBanner: false }),
          gmod
        ]);
        const searchImages = await waitForImages('#search-results .game-thumbnail img', 2);

        await selectGame(await window.charon.steam.details('413150', { forceMetadata: false, forceBanner: false }));
        const detailImages = await waitForImages('#detail-image', 1);

        state.installedGames = [
          { ...(await window.charon.steam.details('413150', { forceMetadata: false, forceBanner: false })), installDir: 'Stardew Valley', libraryPath: 'C:/Steam/steamapps' },
          { ...(await window.charon.steam.details('4000', { forceMetadata: false, forceBanner: false })), installDir: 'GarrysMod', libraryPath: 'C:/Steam/steamapps' }
        ];
        renderInstalledGames();
        const installedImages = await waitForImages('#installed-list .game-thumbnail img', 2);

        state.manifests = [
          { appId: '413150', gameName: 'Stardew Valley', installedAt: new Date().toISOString(), files: ['413150.lua'] },
          { appId: '4000', gameName: "Garry's Mod", installedAt: new Date().toISOString(), files: ['4000.lua'] }
        ];
        renderManifests();
        await hydrateManifestMetadata({ force: false });
        const manifestImages = await waitForImages('#manifest-list .game-thumbnail img', 2);

        const ok =
          Array.isArray(searchImages) && searchImages.length === 2 && typeof searchImages[0] === 'string' &&
          Array.isArray(detailImages) && detailImages.length === 1 && typeof detailImages[0] === 'string' &&
          Array.isArray(installedImages) && installedImages.length === 2 && typeof installedImages[0] === 'string' &&
          Array.isArray(manifestImages) && manifestImages.length === 2 && typeof manifestImages[0] === 'string';

        return {
          ok,
          searchImages,
          detailImages,
          installedImages,
          manifestImages,
          placeholderCount: [...document.querySelectorAll('img')]
            .filter((img) => String(img.getAttribute('src') || '').includes('game-placeholder')).length
        };
      })();
    `, true);
    console.log(JSON.stringify(result));
  } finally {
    testWindow.destroy();
  }
}

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    name: 'Charon',
    version: app.getVersion(),
    dataRoot: getDataRoot(),
    isPackaged: app.isPackaged
  }));

  ipcMain.handle('sources:summary', async () => getSourcesSummary());
  ipcMain.handle('sources:openConfig', async () => {
    await loadSourcesConfig();
    const result = await shell.openPath(sourcesPath());
    return { ok: !result, errorMessage: result || '' };
  });
  ipcMain.handle('sources:openFolder', async () => {
    const result = await shell.openPath(getDataRoot());
    return { ok: !result, errorMessage: result || '' };
  });

  ipcMain.handle('settings:get', async () => loadSettings());
  ipcMain.handle('settings:save', async (_event, value) => saveSettings(value || {}));
  ipcMain.handle('settings:autoDetectSteam', async () => {
    const steamRoot = await detectSteamRootAsync();
    return {
      steamRoot,
      ...defaultSteamFolders(steamRoot)
    };
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('steam:search', async (_event, query, options) => searchSteam(query, options || {}));
  ipcMain.handle('steam:details', async (_event, appId, options) => steamDetails(appId, options || {}));
  ipcMain.handle('steam:installed', async (_event, options) => {
    const settings = await loadSettings();
    return listInstalledGames(settings, options || {});
  });
  ipcMain.handle('steam:restart', async () => restartSteam());
  ipcMain.handle('steam:openClient', async () => openSteamClient());
  ipcMain.handle('steam:open', async (_event, payload) => {
    const appId = String(payload?.appId || '').trim();
    const action = String(payload?.action || 'store');
    if (!/^\d+$/.test(appId)) return { ok: false, errorMessage: 'Steam App ID must be numeric.' };
    const url = action === 'run'
      ? `steam://run/${appId}`
      : action === 'install'
        ? `steam://install/${appId}`
        : action === 'uninstall'
          ? `steam://uninstall/${appId}`
          : `https://store.steampowered.com/app/${appId}`;
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('api:activate', async () => activateApi());
  ipcMain.handle('api:stats', async () => statsApi());
  ipcMain.handle('api:requestGame', async (_event, payload) => requestGameApi(payload || {}));
  ipcMain.handle('api:generateInstall', async (event, payload) => {
  const startedAt = Date.now();
  try {
    const result = await generateAndInstall(event, payload || {});
    sendAppGenLog(result, startedAt).catch(() => {});
    return result;
  } catch (err) {
    sendAppGenLog({ appId: payload?.appId, source: "error", backfillStatus: "failed: " + (err.message || err) }, startedAt).catch(() => {});
    throw err;
  }
});
  ipcMain.handle('api:installZipBytes', async (_event, payload) => installZipBytes(payload || {}));
  ipcMain.handle('limits:autoInstallQuota', async () => getAutoInstallQuota());
  ipcMain.handle('updates:check', async () => checkForUpdates());
  ipcMain.handle('updates:downloadAndInstall', async (event) => downloadAndInstallUpdate(event));

  ipcMain.handle('manifests:list', async () => loadInstalled());
  ipcMain.handle('manifests:remove', async (_event, appId) => removeInstalledManifest(appId));
  ipcMain.handle('activity:list', async () => loadActivityLog());
  ipcMain.handle('activity:add', async (_event, payload) => appendActivityLog(payload || {}));
  ipcMain.handle('activity:clear', async () => clearActivityLog());
  ipcMain.handle('external:open', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: '#111316',
    icon: path.join(__dirname, 'assets', 'app-logo.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  getDataRoot();
  registerIpc();

  if (process.argv.includes('--smoke-test')) {
    const sources = await getSourcesSummary();
    console.log(JSON.stringify({
      ok: true,
      app: 'Charon',
      version: app.getVersion(),
      dataRoot: getDataRoot(),
      sources: {
        enabledCount: sources.enabledCount,
        totalCount: sources.totalCount
      }
    }));
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--manual-import-smoke-test')) {
    await runManualImportSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--lua-source-smoke-test')) {
    await runLuaSourceSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--lua-fallback-smoke-test')) {
    await runLuaFallbackSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--database-zip-smoke-test')) {
    await runDatabaseZipSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--database-direct-no-index-smoke-test')) {
    await runDatabaseDirectNoIndexSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--remove-manifest-smoke-test')) {
    await runManifestRemoveSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--activity-smoke-test')) {
    const message = `Activity smoke ${Date.now()}`;
    await appendActivityLog({ message, kind: 'ok' });
    const file = await loadActivityLog();
    const ok = file.records.some((record) => record.message === message && record.kind === 'ok');
    await clearActivityLog();
    console.log(JSON.stringify({ ok, recordsChecked: file.records.length }));
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--quota-smoke-test')) {
    await runQuotaSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--durable-quota-smoke-test')) {
    await runDurableQuotaSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--update-smoke-test')) {
    try {
      const result = await checkForUpdates();
      console.log(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message || String(error) }));
    }
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--update-download-smoke-test')) {
    try {
      await runUpdateDownloadSmokeTest();
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message || String(error) }));
    }
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--auto-detect-smoke-test')) {
    const started = Date.now();
    const steamRoot = await detectSteamRootAsync({ useCache: false });
    console.log(JSON.stringify({
      ok: true,
      elapsedMs: Date.now() - started,
      steamRoot,
      ...defaultSteamFolders(steamRoot)
    }));
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--folder-smoke-test')) {
    await runFolderSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--search-smoke-test')) {
    try {
      await runSearchSmokeTest();
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message || String(error) }));
    }
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--banner-coverage-smoke-test')) {
    await runBannerCoverageSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--installed-dedupe-smoke-test')) {
    await runInstalledDedupeSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--manifest-enrichment-smoke-test')) {
    await runManifestEnrichmentSmokeTest();
    exitForCliSmoke();
    return;
  }

  if (process.argv.includes('--banner-render-smoke-test')) {
    await runBannerRenderSmokeTest();
    exitForCliSmoke();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
