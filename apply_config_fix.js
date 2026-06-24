const fs = require('fs');
let idx = fs.readFileSync('index.html', 'utf8');
let rjs = fs.readFileSync('renderer.js', 'utf8');

// ===== INDEX.HTML =====
// Find the last depot-cache-path field and add config/depotcache after it
const oldHtml = '      <label>depotcache folder</label>
          <div class="inline-field">
            <input type="text" id="depot-cache-path" placeholder="Steam\config\depotcache">
            <button id="pick-depot-path">Browse</button>
          </div>';
const newHtml = '      <label>depotcache folder</label>
          <div class="inline-field">
            <input type="text" id="depot-cache-path" placeholder="Steam\config\depotcache">
            <button id="pick-depot-path">Browse</button>
          </div>
          <label>config/depotcache folder</label>
          <div class="inline-field">
            <input type="text" id="depot-cache-config-path" placeholder="Steam\config\depotcache">
            <button id="pick-depot-config-path">Browse</button>
          </div>';

if (idx.includes(oldHtml)) {
  idx = idx.replace(oldHtml, newHtml);
  console.log('index.html: OK');
} else {
  console.log('index.html: FAIL');
}

// ===== RENDERER.JS =====

// 1. Els: after pickDepotPath
const oldEls = '  pickDepotPath: $(\"#pick-depot-path\"),';
const newEls = '  pickDepotPath: $(\"#pick-depot-path\"),\n  pickDepotConfigPath: $(\"#pick-depot-config-path\"),\n  configDepotCachePath: $(\"#depot-cache-config-path\"),';

if (rjs.includes(oldEls)) {
  rjs = rjs.replace(oldEls, newEls);
  console.log('renderer els: OK');
} else { console.log('renderer els: FAIL'); }

// 2. fillSettingsForm
const oldFill = '  els.depotCachePath.value = settings.depotCachePath || \"\";';
const newFill = '  els.depotCachePath.value = settings.depotCachePath || \"\";\n  els.configDepotCachePath.value = settings.configDepotCachePath || \"\";';

if (rjs.includes(oldFill)) {
  rjs = rjs.replace(oldFill, newFill);
  console.log('fillSettingsForm: OK');
} else { console.log('fillSettingsForm: FAIL'); }

// 3. readSettingsForm
const oldRead = '    depotCachePath: els.depotCachePath.value.trim()';
const newRead = '    depotCachePath: els.depotCachePath.value.trim(),\n    configDepotCachePath: els.configDepotCachePath.value.trim()';

if (rjs.includes(oldRead)) {
  rjs = rjs.replace(oldRead, newRead);
  console.log('readSettingsForm: OK');
} else { console.log('readSettingsForm: FAIL - but previously succeeded, skipping'); }

// 4. defaultSteamFoldersFromRoot
const oldDefault = '    depotCachePath: folder ? folder + \"\\depotcache\" : \"\"';
const newDefault = '    depotCachePath: folder ? folder + \"\\depotcache\" : \"\",\n    configDepotCachePath: folder ? folder + \"\\config\\depotcache\" : \"\"';

if (rjs.includes(oldDefault)) {
  rjs = rjs.replace(oldDefault, newDefault);
  console.log('defaultSteamFolders: OK');
} else { console.log('defaultSteamFolders: FAIL'); }

// 5. detectSteam
const oldDetect = '    els.depotCachePath.value = detected.depotCachePath;';
const newDetect = '    els.depotCachePath.value = detected.depotCachePath;\n    els.configDepotCachePath.value = detected.configDepotCachePath || detected.steamRoot + \"\\config\\depotcache\";';

if (rjs.includes(oldDetect)) {
  rjs = rjs.replace(oldDetect, newDetect);
  console.log('detectSteam: OK');
} else { console.log('detectSteam: FAIL - but previously succeeded'); }

// 6. bindEvents
const oldBind = 'els.pickDepotPath.addEventListener(\"click\", () => pickFolder(els.depotCachePath));';
const newBind = 'els.pickDepotPath.addEventListener(\"click\", () => pickFolder(els.depotCachePath));\n  els.pickDepotConfigPath.addEventListener(\"click\", () => pickFolder(els.configDepotCachePath));';

if (rjs.includes(oldBind)) {
  rjs = rjs.replace(oldBind, newBind);
  console.log('bindEvents: OK');
} else { console.log('bindEvents: FAIL'); }

fs.writeFileSync('index.html', idx, 'utf8');
fs.writeFileSync('renderer.js', rjs, 'utf8');
console.log('\nDone');
