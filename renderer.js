const state = {
  settings: null,
  selectedGame: null,
  installedGames: [],
  manifests: [],
  activityLog: [],
  manualZipFile: null,
  updateInfo: null,
  searchResults: [],
  searchCache: new Map(),
  searchRequestId: 0,
  searchDebounceTimer: null,  pendingAutoRetries: new Map(),  autoRetryTimer: null,
  thumbnailCache: new Map(),  suggestionCache: new Map(),  suggestionTimer: null,
  thumbnailInFlight: new Map()
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DISCORD_INVITE_URL = 'https://discord.gg/Tn9KrEr2qv';
const WEBSITE_URL = 'https://charon.vyro.workers.dev/';
const GAME_PLACEHOLDER_IMAGE = 'assets/game-placeholder.png';
const THUMBNAIL_RETRIES = 2;
const THUMBNAIL_RETRY_DELAY_MS = 1000;
const THUMBNAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_DEBOUNCE_MS = 300;

const els = {
  versionLabel: $('#version-label'),
  steamSummary: $('#steam-summary'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  directForm: $('#direct-form'),
  directAppId: $('#direct-appid'),
  clearSearchBtn: $('#clear-search-btn'),
  refreshSearchBtn: $('#refresh-search-btn'),
  searchRefreshStatus: $('#search-refresh-status'),
  searchResults: $('#search-results'),
  detailImage: $('#detail-image'),
  refreshDetailBtn: $('#refresh-detail-btn'),
  detailAppId: $('#detail-appid'),
  detailTitle: $('#detail-title'),
  detailDescription: $('#detail-description'),
  detailMeta: $('#detail-meta'),
  installSelectedBtn: $('#install-selected-btn'),
  openStoreBtn: $('#open-store-btn'),
  autoQuotaLabel: $('#auto-quota-label'),
  installProgress: $('#install-progress'),
  progressBar: $('#progress-bar'),
  installStatus: $('#install-status'),
    installManifestCount: $('#install-manifest-count'),
  manualAppId: $('#manual-appid'),
  manualDropZone: $('#manual-drop-zone'),
  manualFileInput: $('#manual-file-input'),
  manualFileLabel: $('#manual-file-label'),
  manualInstallBtn: $('#manual-install-btn'),
  manualStatus: $('#manual-status'),
  activityList: $('#activity-list'),
  clearActivityBtn: $('#clear-activity-btn'),
  refreshInstalledBtn: $('#refresh-installed-btn'),
  installedStatus: $('#installed-status'),
  installedList: $('#installed-list'),
  refreshManifestBtn: $('#refresh-manifest-btn'),
  manifestStatus: $('#manifest-status'),
  manifestList: $('#manifest-list'),
  restartSteamBtn: $('#restart-steam-btn'),
  joinDiscordBtn: $('#join-discord-btn'),
  openWebsiteBtn: $('#open-website-btn'),
  openSteamSidebarBtn: $('#open-steam-sidebar-btn'),
  restartSteamSidebarBtn: $('#restart-steam-sidebar-btn'),
  saveSettingsBtn: $('#save-settings-btn'),
  steamRoot: $('#steam-root'),
  stPluginPath: $('#st-plugin-path'),
  depotCachePath: $('#depot-cache-path'),
  configDepotCachePath: $('#config-depot-cache-path'),
  detectSteamBtn: $('#detect-steam-btn'),
  pickSteamRoot: $('#pick-steam-root'),
  pickPluginPath: $('#pick-plugin-path'),
  pickDepotPath: $('#pick-depot-path'),
  pickConfigDepotPath: $('#pick-config-depot-path'),
  settingsStatus: $('#settings-status'),
  restartSteamSettingsBtn: $('#restart-steam-settings-btn'),
  settingsVersionLabel: $('#settings-version-label'),
  checkUpdatesBtn: $('#check-updates-btn'),
  downloadUpdateBtn: $('#download-update-btn'),
  updateStatus: $('#update-status'),
  updateGate: $('#update-gate'),
  updateGateTitle: $('#update-gate-title'),
  updateGateCopy: $('#update-gate-copy'),
  updateGateVersion: $('#update-gate-version'),
  updateGateStatus: $('#update-gate-status'),
  updateGateButton: $('#update-gate-button'),
  setupOverlay: $('#setup-overlay'),
  setupSteamPreview: $('#setup-steam-preview'),
  setupPluginPreview: $('#setup-plugin-preview'),
  setupDepotPreview: $('#setup-depot-preview'),
  setupConfigDepotPreview: $('#setup-config-depot-preview'),
  setupDetectBtn: $('#setup-detect-btn'),
  setupBrowseBtn: $('#setup-browse-btn'),
  setupSettingsBtn: $('#setup-settings-btn'),
  setupSkipBtn: $('#setup-skip-btn'),
  setupStatus: $('#setup-status')
};

function setStatus(el, message, kind = "") {
  el.textContent = message || "";
  el.classList.remove("ok", "error");
  if (kind) el.classList.add(kind);
  // Also update progress bar color
  if (el === els.installStatus) {
    els.progressBar.classList.remove("ok", "error");
    if (kind) els.progressBar.classList.add(kind);
  }
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.prevText = button.textContent;
    button.textContent = label || 'Working';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.prevText || button.textContent;
    button.disabled = false;
  }
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[ch]));
}

function thumbnailKey(appId, src) {
  const id = String(appId || '').trim();
  const source = String(src || '').trim();
  return source ? `${id}:${source}` : id;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImageOnce(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.onload = () => resolve(src);
    image.onerror = () => reject(new Error('Image failed to load.'));
    image.src = src;
  });
}

async function loadImageWithRetry(src) {
  let lastError;
  for (let attempt = 0; attempt <= THUMBNAIL_RETRIES; attempt += 1) {
    try {
      return await loadImageOnce(src);
    } catch (error) {

      startAutoRetry(appId, state.selectedGame?.name || "");
      lastError = error;
      if (attempt < THUMBNAIL_RETRIES) await delay(THUMBNAIL_RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error('Image failed to load.');
}

async function resolveThumbnailSrc(appId, src) {
  const source = String(src || '').trim();
  if (!source) return GAME_PLACEHOLDER_IMAGE;
  if (source === GAME_PLACEHOLDER_IMAGE) return GAME_PLACEHOLDER_IMAGE;

  const key = thumbnailKey(appId, src);
  const cached = state.thumbnailCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.src;
  if (cached) state.thumbnailCache.delete(key);
  if (state.thumbnailInFlight.has(key)) return state.thumbnailInFlight.get(key);

  const promise = (async () => {
    try {
      const resolved = await loadImageWithRetry(source);
      state.thumbnailCache.set(key, {
        src: resolved,
        expiresAt: Date.now() + THUMBNAIL_CACHE_TTL_MS
      });
      return resolved;
    } catch {
      return GAME_PLACEHOLDER_IMAGE;
    }
  })().finally(() => {
    state.thumbnailInFlight.delete(key);
  });

  state.thumbnailInFlight.set(key, promise);
  return promise;
}

function gameThumbnail({ src = '', appId = '', title = '', width = 128, height = 48, className = '' } = {}) {
  return `
    <div class="game-thumbnail is-loading ${escapeText(className)}" data-thumb-src="${escapeText(src)}" data-appid="${escapeText(appId)}" style="--thumb-width:${Number(width) || 128}px;--thumb-height:${Number(height) || 48}px" aria-label="${escapeText(title || `Steam App ${appId}`)}">
      <span class="thumb-shimmer"></span>
      <img alt="${escapeText(title || `Steam App ${appId}`)}" loading="lazy" decoding="async">
    </div>
  `;
}

function hydrateThumbnails(root = document) {
  root.querySelectorAll('.game-thumbnail').forEach((thumb) => {
    if (thumb.dataset.bound === 'true') return;
    thumb.dataset.bound = 'true';
    const img = thumb.querySelector('img');
    if (!img) return;
    const appId = thumb.dataset.appid || '';
    const src = thumb.dataset.thumbSrc || '';

    resolveThumbnailSrc(appId, src)
      .then((resolved) => {
        img.src = resolved;
        thumb.classList.remove('is-loading');
        thumb.classList.toggle('is-fallback', resolved === GAME_PLACEHOLDER_IMAGE);
        requestAnimationFrame(() => thumb.classList.add('is-loaded'));
      })
      .catch(() => {
        img.src = GAME_PLACEHOLDER_IMAGE;
        thumb.classList.remove('is-loading');
        thumb.classList.add('is-loaded', 'is-fallback');
      });
  });
}

async function applyHeroImage(game) {
  const appId = String(game?.appId || '').trim();
  const source = String(game?.bannerUrl || game?.image || '').trim();
  const key = thumbnailKey(appId, source);
  const token = `${appId}:${Date.now()}:${Math.random()}`;
  els.detailImage.dataset.heroToken = token;
  els.detailImage.style.display = 'block';
  els.detailImage.classList.remove('loaded');

  if (!source || source === GAME_PLACEHOLDER_IMAGE) {
    els.detailImage.src = GAME_PLACEHOLDER_IMAGE;
    requestAnimationFrame(() => els.detailImage.classList.add('loaded'));
    return;
  }

  const cached = state.thumbnailCache.get(key);
  if (cached?.expiresAt > Date.now()) {
    els.detailImage.src = cached.src;
    requestAnimationFrame(() => els.detailImage.classList.add('loaded'));
    return;
  }
  if (cached) state.thumbnailCache.delete(key);

  const showPlaceholder = () => {
    if (els.detailImage.dataset.heroToken !== token || state.selectedGame?.appId !== appId) return;
    els.detailImage.src = GAME_PLACEHOLDER_IMAGE;
    requestAnimationFrame(() => els.detailImage.classList.add('loaded'));
  };
  try {
    const resolved = await loadImageWithRetry(source);
    if (els.detailImage.dataset.heroToken !== token || state.selectedGame?.appId !== appId) return;
    state.thumbnailCache.set(key, {
      src: resolved,
      expiresAt: Date.now() + THUMBNAIL_CACHE_TTL_MS
    });
    els.detailImage.src = resolved;
    requestAnimationFrame(() => els.detailImage.classList.add('loaded'));
  } catch {
    showPlaceholder();
  }
}

function dedupeGames(games = []) {
  const seen = new Set();
  const unique = [];
  for (const game of Array.isArray(games) ? games : []) {
    const appId = String(game?.appId || '').trim();
    if (!appId) continue;
    const installDir = String(game?.installDir || '').trim().toLowerCase().replace(/[\\/]+/g, '/');
    const key = installDir ? `${appId}:${installDir}` : appId;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(game);
  }
  return unique;
}

function activeTabName() {
  return $('.nav-btn.active')?.dataset.tab || 'search';
}

function clearThumbnailCacheForAppIds(appIds = []) {
  const ids = new Set((Array.isArray(appIds) ? appIds : [appIds])
    .map((appId) => String(appId || '').trim())
    .filter(Boolean));
  if (!ids.size) return;

  for (const key of state.thumbnailCache.keys()) {
    const appId = String(key).split(':')[0];
    if (ids.has(appId)) state.thumbnailCache.delete(key);
  }
  for (const key of state.thumbnailInFlight.keys()) {
    const appId = String(key).split(':')[0];
    if (ids.has(appId)) state.thumbnailInFlight.delete(key);
  }
}

async function mapWithLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }));
  return results;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatActivityTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatQuotaTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hasSteamConfig(settings) {
  return Boolean(settings?.steamRoot || settings?.stPluginPath || settings?.depotCachePath);
}

function defaultSteamFoldersFromRoot(folder) {
  const steamRoot = String(folder || '').trim().replace(/[\\/]+$/, '');
  return {
    steamRoot,
    stPluginPath: steamRoot ? `${steamRoot}\\config\\stplug-in` : '',
    depotCachePath: steamRoot ? `${steamRoot}\\depotcache` : '',
    configDepotCachePath: steamRoot ? `${steamRoot}\\config\\depotcache` : ''
  };
}

function selectedAppId() {
  return state.selectedGame?.appId || '';
}

async function switchTab(tabName) {
  $$('.nav-btn').forEach((item) => item.classList.toggle('active', item.dataset.tab === tabName));
  $$('.tab').forEach((tab) => tab.classList.remove('active'));
  $(`#tab-${tabName}`).classList.add('active');

  if (tabName === 'installed') await loadInstalledGames();
  if (tabName === 'manifests') await loadManifests();
}

function bindTabs() {
  $$('.nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      void switchTab(button.dataset.tab);
    });
  });
}

async function loadInitialState() {
  const [info, settings] = await Promise.all([
    window.charon.app.info(),
    window.charon.settings.get()
  ]);

  state.settings = settings;
  els.versionLabel.textContent = `v${info.version}`;
  els.settingsVersionLabel.textContent = `v${info.version}`;
  fillSettingsForm(settings);
  updateSteamSummary(settings);
  updateSetupPreview(settings);
  void loadActivityLog();
  void refreshAutoQuota();
  maybeShowFirstRunSetup(settings);
  void enforceStartupUpdate();
}

async function refreshAutoQuota() {
  try {
    const quota = await window.charon.limits.autoInstallQuota();
    const reset = quota.resetAt ? ` Reset ${formatQuotaTime(quota.resetAt)}.` : '';
    els.autoQuotaLabel.textContent = `Automatic installs: ${quota.remaining}/${quota.limit} left in 24h.${reset}`;
    els.autoQuotaLabel.classList.toggle('limit-reached', quota.remaining <= 0);
  } catch {
    els.autoQuotaLabel.textContent = 'Automatic installs: limit unavailable.';
    els.autoQuotaLabel.classList.remove('limit-reached');
  }
}

async function loadActivityLog() {
  try {
    const file = await window.charon.activity.list();
    state.activityLog = file.records || [];
  } catch {
    state.activityLog = [];
  }
  renderActivityLog();
}

async function addActivity(message, kind = 'info') {
  const text = String(message || '').trim();
  if (!text) return;
  const important = kind === 'error' ||
    /install|inject|manifest|lua|depotcache|stplug|steam path|steam paths|settings saved|auto detected|removed|update|restart steam|quota/i.test(text);
  const noisy = /searched steam|selected .*?\(\d+\)|refreshed game details|library refreshed|opened steam store|opened discord|opened charon website|search view cleared|selected manual zip/i.test(text);
  if (!important || (kind === 'info' && noisy)) return;

  try {
    const file = await window.charon.activity.add({ message: text, kind });
    state.activityLog = file.records || [];
    renderActivityLog();
  } catch {
    // Activity logging must never block the actual app workflow.
  }
}

async function clearActivityLog() {
  try {
    const file = await window.charon.activity.clear();
    state.activityLog = file.records || [];
    renderActivityLog();
  } catch {
    state.activityLog = [];
    renderActivityLog();
  }
}

function renderActivityLog() {
  if (!state.activityLog.length) {
    els.activityList.innerHTML = '<p class="status-line">No activity yet.</p>';
    return;
  }

  els.activityList.innerHTML = state.activityLog.map((entry) => `
    <article class="activity-item ${escapeText(entry.kind || 'info')}">
      <span>${escapeText(formatActivityTime(entry.time))}</span>
      <strong>${escapeText(entry.message)}</strong>
    </article>
  `).join('');
}

function installTargetForPath(filePath, result) {
  const normalized = String(filePath || '').replace(/[\\/]+/g, '/').toLowerCase();
  const stPlugin = String(result?.stPluginPath || '').replace(/[\\/]+/g, '/').toLowerCase();
  const depotCache = String(result?.depotCachePath || '').replace(/[\\/]+/g, '/').toLowerCase();
  if (stPlugin && normalized.startsWith(stPlugin)) return 'Lua folder';
  if (depotCache && normalized.startsWith(depotCache)) return 'Depot cache';
  return 'Steam folder';
}

function describeInstalledFiles(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  if (!files.length) return 'No deployed files were reported.';
  return files
    .slice(0, 8)
    .map((filePath) => `${installTargetForPath(filePath, result)}: ${filePath}`)
    .join(' | ');
}

function installSummary(result) {
  const sourceLabel = result.sourceLabel || result.sourceName || (
    result.sourceType === 'database-url' || result.sourceType === 'lua-url' || result.sourceId === 'github-lua'
      ? 'Charon Repo'
      : 'Other Source'
  );
  const manifestLabel = result.manifestSource || 'No additional manifest vault files';
  const manifestCount = Number.isFinite(Number(result.manifestCount)) ? Number(result.manifestCount) : 0;
  const luaCount = Number.isFinite(Number(result.luaCount)) ? Number(result.luaCount) : 0;
  const sourceFileCount = Number.isFinite(Number(result.sourceFileCount)) ? Number(result.sourceFileCount) : (result.fileCount || 0);
  const sourceLuaCount = Number.isFinite(Number(result.sourceLuaCount)) ? Number(result.sourceLuaCount) : luaCount;
  const sourceManifestCount = Number.isFinite(Number(result.sourceManifestCount)) ? Number(result.sourceManifestCount) : manifestCount;
  const manifestWord = manifestCount === 1 ? 'Manifest' : 'Manifests';
  const sourceManifestWord = sourceManifestCount === 1 ? 'Manifest' : 'Manifests';
  const vaultWord = manifestCount === 1 ? 'manifest' : 'manifests';
  const sourceFileText = `${sourceFileCount} files - ${sourceLuaCount} Lua, ${sourceManifestCount} ${sourceManifestWord}`;
  const vaultText = result.manifestSource
    ? `[${manifestLabel}] ${manifestCount} ${vaultWord}`
    : '[Manifest Vault] No additional manifest files';
  const lines = [
    `[${sourceLabel}] ${sourceFileText}`,
    vaultText,
    `Injected ${result.fileCount || 0} files (${luaCount} Lua, ${manifestCount} ${manifestWord})`,
    '',
    '[Paths]',
    `- Lua:       ${result.stPluginPath || 'Not reported'}`,
    `- Manifests: ${result.depotCachePath || 'Not reported'}`,
  ];
  if (result.configDepotCachePath) lines.push(`             ${result.configDepotCachePath}`);
  lines.push('',
    '[Required] Restart Steam to reload changes.'
  );
  return lines.join('\n');
}

function fillSettingsForm(settings) {
  els.steamRoot.value = settings.steamRoot || '';
  els.stPluginPath.value = settings.stPluginPath || '';
  els.depotCachePath.value = settings.depotCachePath || '';
  els.configDepotCachePath.value = settings.configDepotCachePath || defaultSteamFoldersFromRoot(settings.steamRoot).configDepotCachePath || '';
}

function readSettingsForm() {
  return {
    steamRoot: els.steamRoot.value.trim(),
    stPluginPath: els.stPluginPath.value.trim(),
    depotCachePath: els.depotCachePath.value.trim(),
    configDepotCachePath: els.configDepotCachePath.value.trim()
  };
}

function updateSteamSummary(settings) {
  const hasSteam = Boolean(settings.steamRoot || settings.stPluginPath || settings.depotCachePath);
  els.steamSummary.textContent = hasSteam ? 'Configured' : 'Not configured';
}

function updateSetupPreview(settings) {
  const folders = defaultSteamFoldersFromRoot(settings?.steamRoot || '');
  els.setupSteamPreview.textContent = settings?.steamRoot || '...\\Steam';
  if (els.setupPluginPreview) els.setupPluginPreview.textContent = folders.stPluginPath || '...\\Steam\\config\\stplug-in';
  if (els.setupDepotPreview) els.setupDepotPreview.textContent = folders.depotCachePath || '...\\Steam\\depotcache';
  if (els.setupConfigDepotPreview) els.setupConfigDepotPreview.textContent = folders.configDepotCachePath || '...\\Steam\\config\\depotcache';
}

function maybeShowFirstRunSetup(settings) {
  if (!settings?.setupDismissed && !hasSteamConfig(settings)) {
    els.setupOverlay.classList.remove('hidden');
    updateSetupPreview(settings);
    setStatus(els.setupStatus, '');
  }
}

function hideFirstRunSetup() {
  els.setupOverlay.classList.add('hidden');
}

async function saveSetupSettings(next, message) {
  state.settings = await window.charon.settings.save({
    ...next,
    setupDismissed: true
  });
  fillSettingsForm(state.settings);
  updateSteamSummary(state.settings);
  updateSetupPreview(state.settings);
  hideFirstRunSetup();
  if (message) void addActivity(message, 'ok');
}

async function setupAutoDetectSteam() {
  setBusy(els.setupDetectBtn, true, 'Detecting');
  try {
    const detected = await window.charon.settings.autoDetectSteam();
    if (!detected.steamRoot) {
      setStatus(els.setupStatus, 'Steam was not detected. Choose the folder containing steam.exe.', 'error');
      void addActivity('First-run auto detect could not find Steam.', 'error');
      return;
    }
    await saveSetupSettings({
      steamRoot: detected.steamRoot,
      stPluginPath: detected.stPluginPath,
      depotCachePath: detected.depotCachePath,
      configDepotCachePath: detected.configDepotCachePath
    }, 'First-run setup completed with auto detect.');
  } catch (error) {
    setStatus(els.setupStatus, error.message || String(error), 'error');
    void addActivity('First-run auto detect failed.', 'error');
  } finally {
    setBusy(els.setupDetectBtn, false);
  }
}

async function setupChooseSteamFolder() {
  setBusy(els.setupBrowseBtn, true, 'Choosing');
  try {
    const folder = await window.charon.settings.pickFolder();
    if (!folder) return;
    await saveSetupSettings(defaultSteamFoldersFromRoot(folder), 'First-run setup completed with a Steam folder.');
  } catch (error) {
    setStatus(els.setupStatus, error.message || String(error), 'error');
    void addActivity('First-run folder setup failed.', 'error');
  } finally {
    setBusy(els.setupBrowseBtn, false);
  }
}

async function openSettingsFromSetup() {
  try {
    state.settings = await window.charon.settings.save({ setupDismissed: true });
    fillSettingsForm(state.settings);
    updateSteamSummary(state.settings);
    updateSetupPreview(state.settings);
    hideFirstRunSetup();
    await switchTab('settings');
    void addActivity('First-run setup opened Settings.');
  } catch (error) {
    setStatus(els.setupStatus, error.message || String(error), 'error');
  }
}

async function skipFirstRunSetup() {
  try {
    state.settings = await window.charon.settings.save({ setupDismissed: true });
    hideFirstRunSetup();
    void addActivity('First-run setup skipped.');
  } catch (error) {
    setStatus(els.setupStatus, error.message || String(error), 'error');
  }
}

async function saveSettings({ log = true } = {}) {
  setBusy(els.saveSettingsBtn, true, 'Saving');
  try {
    state.settings = await window.charon.settings.save(readSettingsForm());
    fillSettingsForm(state.settings);
    updateSteamSummary(state.settings);
    updateSetupPreview(state.settings);
    setStatus(els.settingsStatus, 'Settings saved.', 'ok');
    if (log) void addActivity('Settings saved.', 'ok');
  } catch (error) {
    setStatus(els.settingsStatus, error.message || String(error), 'error');
    if (log) void addActivity('Settings save failed.', 'error');
  } finally {
    setBusy(els.saveSettingsBtn, false);
  }
}

async function detectSteam() {
  setBusy(els.detectSteamBtn, true, 'Detecting');
  try {
    const detected = await window.charon.settings.autoDetectSteam();
    if (!detected.steamRoot) {
      setStatus(els.settingsStatus, 'Steam was not detected. Choose the folder containing steam.exe.', 'error');
      return;
    }
    els.steamRoot.value = detected.steamRoot;
    els.stPluginPath.value = detected.stPluginPath;
    els.depotCachePath.value = detected.depotCachePath;
    els.configDepotCachePath.value = detected.configDepotCachePath;
    await saveSettings({ log: false });
    setStatus(els.settingsStatus, `Steam detected: ${detected.steamRoot}`, 'ok');
    void addActivity('Steam paths auto detected.', 'ok');
  } catch (error) {
    setStatus(els.settingsStatus, error.message || String(error), 'error');
    void addActivity('Steam auto detect failed.', 'error');
  } finally {
    setBusy(els.detectSteamBtn, false);
  }
}

async function pickFolder(input) {
  const folder = await window.charon.settings.pickFolder();
  if (folder) input.value = folder;
}

function renderSearchResults(results) {
  const uniqueResults = dedupeGames(results);
  state.searchResults = uniqueResults;
  if (!uniqueResults.length) {
    els.searchResults.innerHTML = '<p class="status-line">No results.</p>';
    return;
  }

  els.searchResults.innerHTML = uniqueResults.map((game) => `
    <article class="game-row" data-appid="${escapeText(game.appId)}" data-name="${escapeText(game.name)}" data-image="${escapeText(game.bannerUrl || game.image || '')}">
      ${gameThumbnail({ src: game.bannerUrl || game.image, appId: game.appId, title: game.name })}
      <div class="row-main">
        <strong>${escapeText(game.name)}</strong>
        <span>App ID ${escapeText(game.appId)}</span>
      </div>
      <button class="small secondary" data-select="${escapeText(game.appId)}">Open</button>
    </article>
  `).join('');
  hydrateThumbnails(els.searchResults);

  els.searchResults.querySelectorAll('.game-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      event.preventDefault();
      selectGame({
        appId: row.dataset.appid,
        name: row.dataset.name,
        bannerUrl: row.dataset.image || '',
        image: row.dataset.image || ''
      });
    });
  });
}

async function runSearch(query, { immediate = false, force = false } = {}) {
  const term = String(query || '').trim();
  const requestId = ++state.searchRequestId;
  if (!term) {
    els.searchResults.innerHTML = '';
    state.searchResults = [];
    return;
  }

  const cacheKey = term.toLowerCase();
  if (force) {
    state.searchCache.delete(cacheKey);
    clearThumbnailCacheForAppIds(state.searchResults.map((game) => game.appId));
    setStatus(els.searchRefreshStatus, 'Refreshing search results...');
  }

  if (!force && state.searchCache.has(cacheKey)) {
    renderSearchResults(state.searchCache.get(cacheKey));
    if (!immediate) return;
  }

  els.searchResults.innerHTML = '<p class="status-line">Searching Steam Store...</p>';
  try {
    const results = await window.charon.steam.search(term, {
      forceMetadata: force,
      forceBanner: force
    });
    if (requestId !== state.searchRequestId) return;
    state.searchCache.set(cacheKey, results);
    renderSearchResults(results);
    if (force) setStatus(els.searchRefreshStatus, `Updated ${results.filter((item) => item.bannerUrl || item.image).length} banners.`, 'ok');
    void addActivity(`Searched Steam for "${term}".`);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    els.searchResults.innerHTML = `<p class="status-line error">${escapeText(error.message || String(error))}</p>`;
    if (force) setStatus(els.searchRefreshStatus, `Could not refresh search results: ${error.message || String(error)}`, 'error');
    void addActivity(`Steam search failed for "${term}".`, 'error');
  }
}

function scheduleSearch() {
  clearTimeout(state.searchDebounceTimer);
  const term = els.searchInput.value.trim();
  if (!term) {
    state.searchRequestId += 1;
    els.searchResults.innerHTML = '';
    return;
  }
  if (term.length < 2 && !/^\d+$/.test(term)) return;
  state.searchDebounceTimer = setTimeout(() => {
    void runSearch(term);
  }, SEARCH_DEBOUNCE_MS);
}

async function refreshSearchResults({ force = true } = {}) {
  const term = els.searchInput.value.trim();
  if (!term) {
    setStatus(els.searchRefreshStatus, 'Enter a search query before refreshing.', 'error');
    return;
  }
  const selected = state.selectedGame?.appId || '';
  const scrollTop = els.searchResults.scrollTop;
  setBusy(els.refreshSearchBtn, true, 'Refreshing...');
  try {
    await runSearch(term, { immediate: true, force });
    els.searchResults.scrollTop = scrollTop;
    if (selected) {
      const row = els.searchResults.querySelector(`[data-appid="${CSS.escape(selected)}"]`);
      row?.classList.add('is-selected');
    }
  } finally {
    setBusy(els.refreshSearchBtn, false);
  }
}

async function refreshCurrentTab(force = false) {
  const tab = activeTabName();
  if (tab === 'installed') {
    await loadInstalledGames({ force });
    return;
  }
  if (tab === 'manifests') {
    await loadManifests({ force });
    return;
  }
  await refreshSearchResults({ force });
}

async function selectGame(game) {
  state.selectedGame = {
    appId: String(game.appId),
    name: game.name || `Steam App ${game.appId}`,
    bannerUrl: game.bannerUrl || game.image || '',
    image: game.bannerUrl || game.image || ''
  };
  renderSelectedGame(state.selectedGame);
  void addActivity(`Selected ${state.selectedGame.name} (${state.selectedGame.appId}).`);

  try {
    const details = await window.charon.steam.details(state.selectedGame.appId);
    if (details) {
      if (state.selectedGame?.appId !== details.appId) return;
      state.selectedGame = { ...state.selectedGame, ...details };
      renderSelectedGame(state.selectedGame);
    }
  } catch {
    renderSelectedGame(state.selectedGame);
  }
}

function renderSelectedGame(game) {
  void applyHeroImage(game);
  els.detailAppId.textContent = `App ID ${game.appId}`;
  els.detailTitle.textContent = game.name || `Steam App ${game.appId}`;
  els.detailDescription.textContent = game.shortDescription || 'Ready to generate and install manifests.';
  els.installSelectedBtn.disabled = false;
  els.openStoreBtn.disabled = false;
  els.refreshDetailBtn.disabled = false;
  if (!els.manualAppId.value.trim()) els.manualAppId.value = game.appId;
  updateManualState();
  els.detailMeta.innerHTML = [
    game.releaseDate ? `Released ${game.releaseDate}` : '',
    ...(game.developers || []),
    ...(game.genres || [])
  ].filter(Boolean).slice(0, 6).map((item) => `<span>${escapeText(item)}</span>`).join('');
  setStatus(els.installStatus, '');
}

async function refreshSelectedGame({ force = true } = {}) {
  if (!state.selectedGame?.appId) return;
  const appId = state.selectedGame.appId;
  clearThumbnailCacheForAppIds([appId]);
  setBusy(els.refreshDetailBtn, true, '↻');
  setStatus(els.installStatus, 'Refreshing selected game details...');
  try {
    const details = await window.charon.steam.details(appId, {
      forceMetadata: force,
      forceBanner: force
    });
    state.selectedGame = {
      ...state.selectedGame,
      ...details,
      bannerUrl: details.bannerUrl,
      image: details.bannerUrl
    };
    renderSelectedGame(state.selectedGame);
    setStatus(els.installStatus, 'Game details refreshed.', 'ok');
    void addActivity(`Refreshed game details for App ID ${appId}.`, 'ok');
  } catch (error) {
    setStatus(els.installStatus, error.message || String(error), 'error');
    void addActivity(`Game detail refresh failed for App ID ${appId}.`, 'error');
  } finally {
    setBusy(els.refreshDetailBtn, false);
  }
}

function resetSearchView() {
  state.selectedGame = null;
  state.searchRequestId += 1;
  state.searchResults = [];
  clearTimeout(state.searchDebounceTimer);
  els.searchInput.value = '';
  els.directAppId.value = '';
  els.searchResults.innerHTML = '';
  els.detailImage.removeAttribute('src');
  els.detailImage.onload = null;
  els.detailImage.onerror = null;
  delete els.detailImage.dataset.heroToken;
  els.detailImage.classList.remove('loaded');
  els.detailImage.style.display = 'none';
  els.detailAppId.textContent = 'No App ID selected';
  els.detailTitle.textContent = 'Select a game';
  els.detailDescription.textContent = 'Search Steam or load an App ID directly.';
  els.detailMeta.innerHTML = '';
  els.installSelectedBtn.disabled = true;
  els.openStoreBtn.disabled = true;
  els.refreshDetailBtn.disabled = true;
  els.installProgress.classList.add('hidden');
  els.progressBar.style.width = '0%';
  setStatus(els.installStatus, '');
  void addActivity('Search view cleared.');
}

async function installSelected() {
  if (!state.selectedGame) return;

  setBusy(els.installSelectedBtn, true, 'Installing');
  els.installProgress.classList.remove('hidden');
  els.progressBar.style.width = '0%';
  setStatus(els.installStatus, 'Contacting manifest service...');
  void addActivity(`Manifest install started for ${state.selectedGame.name} (${state.selectedGame.appId}).`);

  try {
    await saveSettings({ log: false });
    const result = await window.charon.api.generateInstall({
      appId: state.selectedGame.appId,
      gameName: state.selectedGame.name
    });
    setStatus(els.installStatus, installSummary(result), 'ok');
    void addActivity(`Injected manifests for ${state.selectedGame.name} (${state.selectedGame.appId}). ${installSummary(result)} ${describeInstalledFiles(result)}`, 'ok');
    if (result.quota) {
      els.autoQuotaLabel.textContent = `Automatic installs: ${result.quota.remaining}/${result.quota.limit} left in 24h.`;
      els.autoQuotaLabel.classList.toggle('limit-reached', result.quota.remaining <= 0);
    } else {
      await refreshAutoQuota();
    }
    await loadManifests();
  } catch (error) {
    setStatus(els.installStatus, error.message || String(error), 'error');
    void addActivity(`Manifest install failed for ${state.selectedGame.name} (${state.selectedGame.appId}).`, 'error');
    await refreshAutoQuota();
  } finally {
    setBusy(els.installSelectedBtn, false);
  }
}

function setManualZipFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.zip')) {
    state.manualZipFile = null;
    els.manualFileInput.value = '';
    els.manualFileLabel.textContent = 'Choose a .zip file.';
    setStatus(els.manualStatus, 'Only .zip files are supported.', 'error');
    updateManualState();
    return;
  }

  state.manualZipFile = file;
  els.manualFileLabel.textContent = `${file.name} - ${formatBytes(file.size)}`;
  setStatus(els.manualStatus, '');
  void addActivity(`Selected manual ZIP: ${file.name}.`);
  updateManualState();
}

function updateManualState() {
  const hasAppId = /^\d+$/.test(els.manualAppId.value.trim());
  els.manualInstallBtn.disabled = !(hasAppId && state.manualZipFile);
}

async function installManualZip() {
  const appId = els.manualAppId.value.trim();
  if (!/^\d+$/.test(appId)) {
    setStatus(els.manualStatus, 'Enter a numeric Steam App ID before installing.', 'error');
    updateManualState();
    return;
  }

  if (!state.manualZipFile) {
    setStatus(els.manualStatus, 'Choose or drop a manifest ZIP first.', 'error');
    updateManualState();
    return;
  }

  setBusy(els.manualInstallBtn, true, 'Installing');
  setStatus(els.manualStatus, 'Reading ZIP and deploying manifest files...');
  void addActivity(`Manual ZIP install started for App ID ${appId}.`);

  try {
    await saveSettings({ log: false });
    const zipBytes = await state.manualZipFile.arrayBuffer();
    const result = await window.charon.api.installZipBytes({
      appId,
      gameName: state.selectedGame?.appId === appId ? state.selectedGame.name : `Steam App ${appId}`,
      zipBytes
    });

    setStatus(els.manualStatus, `Installed ${result.fileCount} file(s). Restart Steam to reload changes.`, 'ok');
    state.manualZipFile = null;
    els.manualFileInput.value = '';
    els.manualFileLabel.textContent = 'No ZIP selected';
    await loadManifests();
    updateManualState();
    void addActivity(`Manual ZIP injected ${result.fileCount} file(s) for App ID ${appId}. ${describeInstalledFiles(result)}`, 'ok');
  } catch (error) {
    setStatus(els.manualStatus, error.message || String(error), 'error');
    void addActivity(`Manual ZIP install failed for App ID ${appId}.`, 'error');
  } finally {
    setBusy(els.manualInstallBtn, false);
    updateManualState();
  }
}

async function loadInstalledGames({ force = false } = {}) {
  const started = Date.now();
  if (force) {
    clearThumbnailCacheForAppIds(state.installedGames.map((game) => game.appId));
    setStatus(els.installedStatus, 'Refreshing installed metadata...');
  } else {
    setStatus(els.installedStatus, '');
  }
  els.installedList.innerHTML = '<p class="status-line">Scanning Steam libraries...</p>';
  setBusy(els.refreshInstalledBtn, true, 'Refreshing...');
  try {
    const result = await window.charon.steam.installed({
      forceMetadata: force,
      forceBanner: force
    });
    state.installedGames = dedupeGames(result.games || []);
    if (result.steamRoot) {
      els.steamSummary.textContent = `Unique Installed Games: ${state.installedGames.length}`;
    }
    renderInstalledGames();
    setStatus(els.installedStatus, `Updated ${state.installedGames.length} games in ${Date.now() - started}ms.`, 'ok');
    void addActivity(`Installed library refreshed (${state.installedGames.length} unique games).`);
  } catch (error) {
    els.installedList.innerHTML = `<p class="status-line error">${escapeText(error.message || String(error))}</p>`;
    setStatus(els.installedStatus, `Could not refresh installed games: ${error.message || String(error)}`, 'error');
    void addActivity('Installed library refresh failed.', 'error');
  } finally {
    setBusy(els.refreshInstalledBtn, false);
  }
}

function renderInstalledGames() {
  if (!state.installedGames.length) {
    els.installedList.innerHTML = '<p class="status-line">No installed Steam games were found.</p>';
    return;
  }

  els.installedList.innerHTML = state.installedGames.map((game) => `
    <article class="table-row">
      ${gameThumbnail({ src: game.bannerUrl || game.image, appId: game.appId, title: game.name })}
      <div class="row-main">
        <strong>${escapeText(game.name)}</strong>
        <span>App ID ${escapeText(game.appId)} - ${escapeText(game.libraryPath || '')}</span>
      </div>
      <div class="table-actions">
        <button class="small secondary" data-installed-open="${escapeText(game.appId)}">Open</button>
      </div>
    </article>
  `).join('');
  hydrateThumbnails(els.installedList);

  els.installedList.querySelectorAll('[data-installed-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      await window.charon.steam.open({ action: 'store', appId: button.dataset.installedOpen });
      void addActivity(`Opened Steam store for App ID ${button.dataset.installedOpen}.`);
    });
  });
}

async function loadManifests({ force = false } = {}) {
  if (force) {
    clearThumbnailCacheForAppIds(state.manifests.map((record) => record.appId));
    setStatus(els.manifestStatus, 'Refreshing manifest metadata...');
  } else {
    setStatus(els.manifestStatus, '');
  }
  setBusy(els.refreshManifestBtn, true, 'Refreshing...');
  try {
    const file = await window.charon.manifests.list();
    state.manifests = file.records || [];
    renderManifests();
    void hydrateManifestMetadata({ force });
  } catch (error) {
    els.manifestList.innerHTML = `<p class="status-line error">${escapeText(error.message || String(error))}</p>`;
    setStatus(els.manifestStatus, error.message || String(error), 'error');
  } finally {
    setBusy(els.refreshManifestBtn, false);
  }
}

async function hydrateManifestMetadata({ force = false } = {}) {
  const records = state.manifests.filter((record) => /^\d+$/.test(String(record?.appId || '').trim()));
  if (!records.length) return;
  const started = Date.now();
  let completed = 0;
  let failed = 0;

  await mapWithLimit(records, 5, async (record) => {
    try {
      const details = await window.charon.steam.details(record.appId, {
        forceMetadata: force,
        forceBanner: force || !record.bannerUrl
      });
      Object.assign(record, {
        gameName: record.gameName || details.name,
        name: details.name,
        shortDescription: details.shortDescription,
        releaseDate: details.releaseDate,
        developers: details.developers,
        publishers: details.publishers,
        genres: details.genres,
        bannerUrl: details.bannerUrl,
        image: details.bannerUrl
      });
      completed += 1;
    } catch {
      failed += 1;
    }
    setStatus(els.manifestStatus, `Refreshing ${completed + failed}/${records.length}...`);
  });

  renderManifests();
  const message = failed
    ? `Updated ${completed} banners, ${failed} failed in ${Date.now() - started}ms.`
    : `Updated ${completed} banners in ${Date.now() - started}ms.`;
  setStatus(els.manifestStatus, message, failed ? 'error' : 'ok');
}

function renderManifests() {
  if (!state.manifests.length) {
    els.manifestList.innerHTML = '<p class="status-line">No manifests are tracked yet.</p>';
    return;
  }

  els.manifestList.innerHTML = state.manifests.map((record) => `
    <article class="table-row">
      ${gameThumbnail({ src: record.bannerUrl || record.image, appId: record.appId, title: record.gameName || record.name || `Steam App ${record.appId}` })}
      <div class="row-main">
        <strong>${escapeText(record.gameName || record.name || `Steam App ${record.appId}`)}</strong>
        <span>App ID ${escapeText(record.appId)} - ${escapeText((record.files || []).length)} file(s) - ${escapeText(formatDate(record.installedAt))}</span>
      </div>
      <div class="table-actions">
        <button class="small secondary" data-store="${escapeText(record.appId)}">Store</button>
        <button class="small secondary" data-remove="${escapeText(record.appId)}">Remove</button>
      </div>
    </article>
  `).join('');
  hydrateThumbnails(els.manifestList);

  els.manifestList.querySelectorAll('[data-store]').forEach((button) => {
    button.addEventListener('click', async () => {
      await window.charon.steam.open({ action: 'store', appId: button.dataset.store });
      void addActivity(`Opened Steam store for App ID ${button.dataset.store}.`);
    });
  });

  els.manifestList.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const appId = button.dataset.remove;
      setBusy(button, true, 'Removing');
      try {
        state.manifests = state.manifests.filter((record) => String(record.appId) !== String(appId));
        renderManifests();

        const result = await window.charon.manifests.remove(appId);
        if (Array.isArray(result?.records)) {
          state.manifests = result.records;
          renderManifests();
        } else {
          await loadManifests();
        }
        void addActivity(`Removed tracked manifests for App ID ${appId}.`, 'ok');
      } catch (error) {
        await loadManifests();
        void addActivity(`Removing tracked manifests failed for App ID ${appId}.`, 'error');
      } finally {
        if (button.isConnected) setBusy(button, false);
      }
    });
  });
}

async function restartSteam(button, statusEl) {
  setBusy(button, true, 'Restarting');
  try {
    await window.charon.steam.restart();
    if (statusEl) setStatus(statusEl, 'Steam restart command sent.', 'ok');
    void addActivity('Steam restart command sent.', 'ok');
  } catch (error) {
    if (statusEl) setStatus(statusEl, error.message || String(error), 'error');
    void addActivity('Steam restart command failed.', 'error');
  } finally {
    setBusy(button, false);
  }
}

async function openSteam(button, statusEl) {
  setBusy(button, true, 'Opening');
  try {
    await window.charon.steam.openClient();
    if (statusEl) setStatus(statusEl, 'Steam open command sent.', 'ok');
    els.steamSummary.textContent = 'Opening';
    void addActivity('Steam open command sent.', 'ok');
  } catch (error) {
    if (statusEl) setStatus(statusEl, error.message || String(error), 'error');
    void addActivity('Steam open command failed.', 'error');
  } finally {
    setBusy(button, false);
  }
}

async function openDiscordInvite() {
  try {
    await window.charon.external.open(DISCORD_INVITE_URL);
    void addActivity('Opened Discord invite.', 'ok');
  } catch {
    void addActivity('Discord invite failed to open.', 'error');
  }
}

async function openWebsite() {
  try {
    await window.charon.external.open(WEBSITE_URL);
    void addActivity('Opened Charon website.', 'ok');
  } catch {
    void addActivity('Charon website failed to open.', 'error');
  }
}

async function checkForUpdates() {
  setBusy(els.checkUpdatesBtn, true, 'Checking');
  setUpdateStatus('Checking Charon releases...');
  els.downloadUpdateBtn.classList.add('hidden');

  try {
    const info = await window.charon.updates.check();
    state.updateInfo = info;

    if (info.updateAvailable) {
      const notes = info.notes ? ` ${info.notes}` : '';
      setUpdateStatus(`Update available: ${info.latestVersion}.${notes}`, 'ok');
      els.downloadUpdateBtn.classList.remove('hidden');
      void addActivity(`Update available: Charon ${info.latestVersion}.`, 'ok');
    } else {
      setUpdateStatus(`Charon ${info.currentVersion} is up to date.`, 'ok');
      void addActivity('Update check completed. Charon is up to date.', 'ok');
    }
  } catch (error) {
    state.updateInfo = null;
    setUpdateStatus(error.message || String(error), 'error');
    void addActivity('Update check failed.', 'error');
  } finally {
    setBusy(els.checkUpdatesBtn, false);
  }
}

function setUpdateStatus(message, kind = '') {
  setStatus(els.updateStatus, message, kind);
  if (els.updateGate && !els.updateGate.classList.contains('hidden')) {
    setStatus(els.updateGateStatus, message, kind);
  }
}

function showRequiredUpdate(info) {
  if (!info?.updateAvailable) return;
  state.updateInfo = info;
  els.updateGateVersion.textContent = `v${info.latestVersion}`;
  els.updateGateCopy.textContent = info.notes || 'A newer production build is available. Update now to continue using Charon.';
  setStatus(els.updateGateStatus, 'Update is required before continuing.', 'ok');
  els.updateGate.classList.remove('hidden');
  els.setupOverlay.classList.add('hidden');
  els.downloadUpdateBtn.classList.remove('hidden');
}

async function enforceStartupUpdate() {
  try {
    const info = await window.charon.updates.check();
    state.updateInfo = info;
    if (info.updateAvailable) {
      showRequiredUpdate(info);
      void addActivity(`Startup update required: Charon ${info.latestVersion}.`, 'ok');
    }
  } catch (error) {
    void addActivity(`Startup update check failed: ${error.message || String(error)}`, 'error');
  }
}

async function installUpdateNow() {
  if (!state.updateInfo?.updateAvailable) {
    await checkForUpdates();
  }

  if (!state.updateInfo?.updateAvailable) return;

  setBusy(els.downloadUpdateBtn, true, 'Updating');
  setBusy(els.updateGateButton, true, 'Updating');
  els.checkUpdatesBtn.disabled = true;
  setUpdateStatus('Downloading update... keep Charon open.');

  try {
    const result = await window.charon.updates.downloadAndInstall();
    if (!result.ok) {
      setUpdateStatus(result.message || 'No update is available.', 'ok');
      return;
    }

    setUpdateStatus(`Update ready. Restarting into Charon ${result.latestVersion}...`, 'ok');
    void addActivity(`Charon update ${result.latestVersion} installed. Restarting.`, 'ok');
  } catch (error) {
    setUpdateStatus(error.message || String(error), 'error');
    void addActivity('Automatic update failed.', 'error');
    setBusy(els.downloadUpdateBtn, false);
    setBusy(els.updateGateButton, false);
    els.checkUpdatesBtn.disabled = false;
  }
}

function bindEvents() {
  bindTabs();

  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(state.searchDebounceTimer);
    void runSearch(els.searchInput.value, { immediate: true });
  });
  els.searchInput.addEventListener('input', scheduleSearch);

  els.directForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const appId = els.directAppId.value.trim();
    if (/^\d+$/.test(appId)) await selectGame({ appId, name: `Steam App ${appId}` });
  });

  els.clearSearchBtn.addEventListener('click', resetSearchView);
  els.refreshSearchBtn.addEventListener('click', () => refreshSearchResults({ force: true }));
  els.refreshDetailBtn.addEventListener('click', () => refreshSelectedGame({ force: true }));
  els.clearActivityBtn.addEventListener('click', clearActivityLog);
  els.installSelectedBtn.addEventListener('click', installSelected);
  els.openStoreBtn.addEventListener('click', async () => {
    if (selectedAppId()) {
      await window.charon.steam.open({ action: 'store', appId: selectedAppId() });
      void addActivity(`Opened Steam store for App ID ${selectedAppId()}.`);
    }
  });

  els.refreshInstalledBtn.addEventListener('click', () => loadInstalledGames({ force: true }));
  els.refreshManifestBtn.addEventListener('click', () => loadManifests({ force: true }));
  els.restartSteamBtn.addEventListener('click', () => restartSteam(els.restartSteamBtn, null));
  els.joinDiscordBtn.addEventListener('click', openDiscordInvite);
  els.openWebsiteBtn.addEventListener('click', openWebsite);
  els.openSteamSidebarBtn.addEventListener('click', () => openSteam(els.openSteamSidebarBtn, null));
  els.restartSteamSidebarBtn.addEventListener('click', () => restartSteam(els.restartSteamSidebarBtn, null));
  els.restartSteamSettingsBtn.addEventListener('click', () => restartSteam(els.restartSteamSettingsBtn, els.settingsStatus));
  els.checkUpdatesBtn.addEventListener('click', checkForUpdates);
  els.downloadUpdateBtn.addEventListener('click', installUpdateNow);
  els.updateGateButton.addEventListener('click', installUpdateNow);
  els.saveSettingsBtn.addEventListener('click', saveSettings);
  els.detectSteamBtn.addEventListener('click', detectSteam);
  els.pickSteamRoot.addEventListener('click', () => pickFolder(els.steamRoot));
  els.pickPluginPath.addEventListener('click', () => pickFolder(els.stPluginPath));
  els.pickDepotPath.addEventListener('click', () => pickFolder(els.depotCachePath));
  els.pickConfigDepotPath.addEventListener('click', () => pickFolder(els.configDepotCachePath));
  els.setupDetectBtn.addEventListener('click', setupAutoDetectSteam);
  els.setupBrowseBtn.addEventListener('click', setupChooseSteamFolder);
  els.setupSettingsBtn.addEventListener('click', openSettingsFromSetup);
  els.setupSkipBtn.addEventListener('click', skipFirstRunSetup);
  els.manualAppId.addEventListener('input', updateManualState);
  els.manualFileInput.addEventListener('change', () => setManualZipFile(els.manualFileInput.files[0]));
  els.manualInstallBtn.addEventListener('click', installManualZip);

  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'r' || !event.ctrlKey) return;
    event.preventDefault();
    void refreshCurrentTab(Boolean(event.shiftKey));
  });

  document.querySelector('.detail-panel')?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void refreshSelectedGame({ force: true });
  });

  els.manualDropZone.addEventListener('click', () => els.manualFileInput.click());
  els.manualDropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.manualFileInput.click();
    }
  });
  els.manualDropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.manualDropZone.classList.add('dragging');
  });
  els.manualDropZone.addEventListener('dragleave', () => {
    els.manualDropZone.classList.remove('dragging');
  });
  els.manualDropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    els.manualDropZone.classList.remove('dragging');
    setManualZipFile(event.dataTransfer.files[0]);
  });

  window.charon.onDownloadProgress((payload) => {
    els.installProgress.classList.remove('hidden');
    els.progressBar.style.width = `${Math.round(payload.percent || 0)}%`;
    var pct = Math.round(payload.percent || 0);
    if (payload.message) {
      setStatus(els.installStatus, payload.message + ' ' + pct + '%');
    } else {
      var msg =
        payload.phase === 'source'
          ? 'Preparing manifest download...'
          : payload.phase === 'lua'
          ? 'Checking repository for Lua data...'
          : payload.phase === 'manifest'
          ? 'Resolving manifest dependencies...'
          : payload.phase === 'download'
          ? 'Downloading package...'
          : payload.phase === 'repository'
          ? 'Checking package map...'
          : 'Contacting manifest service...';
      setStatus(els.installStatus, msg + ' ' + pct + '%');
    }
  });

  window.charon.onUpdateProgress((payload) => {
    const percent = Math.round(payload.percent || 0);
    const message = payload.phase === 'download'
      ? `Downloading update... ${percent}%`
      : payload.phase === 'verify'
        ? 'Verifying update...'
        : payload.phase === 'install'
          ? 'Applying update and restarting...'
          : 'Preparing update...';
    setUpdateStatus(message);
  });
}


  // Listen for download progress from main process
  if (window.charon.onProgress) {
    window.charon.onProgress(function(data) {
      if (data && data.message) {
        setStatus(els.installProgress, data.message, 'info');
      }
    });
  }
function bindGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    const message = event.error?.message || event.message || 'Unexpected UI error.';
    setStatus(els.settingsStatus, 'A UI error was recovered. Check Activity for details.', 'error');
    void addActivity(`Recovered UI error: ${message}`, 'error');
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.message || String(event.reason || 'Unexpected async error.');
    setStatus(els.settingsStatus, 'A background action failed safely. Check Activity for details.', 'error');
    void addActivity(`Recovered background error: ${reason}`, 'error');
  });
}

bindGlobalErrorHandlers();
bindEvents();
loadInitialState().catch((error) => {
  setStatus(els.settingsStatus, error.message || String(error), 'error');
});
