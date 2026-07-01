const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();

if (!version) {
  throw new Error('package.json version is missing.');
}

const exeName = `Charon-${version}.exe`;
const exePath = path.join(root, 'dist', exeName);

if (!fs.existsSync(exePath)) {
  throw new Error(`Build output not found: ${exePath}`);
}

const exeBytes = fs.readFileSync(exePath);
const sha256 = crypto.createHash('sha256').update(exeBytes).digest('hex');
const tag = `v${version}`;

const latest = {
  version,
  downloadUrl: `https://github.com/BlissBlender/Charon/releases/download/${tag}/${exeName}`,
  releaseUrl: `https://github.com/BlissBlender/Charon/releases/tag/${tag}`,
  sha256,
  notes: 'Charon 8.0.0 production release with improved inject status, dual depotcache manifest install, app GenLog, manifest enrichment, and cleaner path settings.',
  publishedAt: new Date().toISOString()
};

fs.writeFileSync(path.join(root, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`Updated latest.json for ${exeName}`);
console.log(`SHA-256: ${sha256}`);
