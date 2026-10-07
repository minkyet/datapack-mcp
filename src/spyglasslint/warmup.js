/**
 * Spyglass Cache Warmup & Multi-Version Verification Utility
 * 
 * Dynamically detects the target Minecraft version from `spyglass.json` or `pack.mcmeta`,
 * verifies the local offline cache in `~/.cache/spyglassmc-nodejs/http/`,
 * and lists all available cached versions.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { findWorkspaceRoot } = require('./workspace');

function resolveCacheRoot() {
  const home = os.homedir();
  const pkgName = 'spyglassmc-nodejs';
  let cacheDir;

  if (process.platform === 'darwin') {
    cacheDir = path.join(home, 'Library', 'Caches', pkgName);
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    cacheDir = path.join(localAppData, pkgName, 'Cache');
  } else {
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(home, '.cache');
    cacheDir = path.join(xdgCache, pkgName);
  }

  return path.join(cacheDir, 'http');
}

const CACHE_ROOT = resolveCacheRoot();
const INDEX_PATH = path.join(CACHE_ROOT, 'index.json');
const OBJECTS_DIR = path.join(CACHE_ROOT, 'objects');

function getVersionsManifest() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return null;
    const rawWrapper = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const indexData = rawWrapper.index || rawWrapper;
    const versionsEntry = indexData['https://api.spyglassmc.com/mcje/versions'];
    if (!versionsEntry || !versionsEntry['']) return null;
    const sha1 = versionsEntry[''].sha1;
    const objPath = path.join(OBJECTS_DIR, sha1.slice(0, 2), sha1);
    if (!fs.existsSync(objPath)) return null;
    return JSON.parse(fs.readFileSync(objPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves the target game version in priority:
 * 1. CLI argument (e.g. `node warmup.js 1.21.4`)
 * 2. `spyglass.json` (`env.gameVersion`)
 * 3. `pack.mcmeta` (`pack_format` dynamically mapped via versions manifest)
 * 4. Default fallback: '26.3'
 */
function detectTargetVersion(workspaceRoot = findWorkspaceRoot(), explicitVersion = null) {
  if (explicitVersion && !explicitVersion.startsWith('-')) {
    return explicitVersion;
  }

  // 1. Check spyglass.json
  const spyglassConfig = path.join(workspaceRoot, 'spyglass.json');
  if (fs.existsSync(spyglassConfig)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(spyglassConfig, 'utf8'));
      if (cfg.env?.gameVersion && cfg.env.gameVersion !== 'auto') {
        return cfg.env.gameVersion;
      }
    } catch {}
  }

  // 2. Check pack.mcmeta (root or any subfolder)
  const mcmetaCandidates = [path.join(workspaceRoot, 'pack.mcmeta')];
  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
        mcmetaCandidates.push(path.join(workspaceRoot, ent.name, 'pack.mcmeta'));
      }
    }
  } catch {}

  for (const mcmetaPath of mcmetaCandidates) {
    if (fs.existsSync(mcmetaPath)) {
      try {
        const mcmeta = JSON.parse(fs.readFileSync(mcmetaPath, 'utf8'));
        const format = mcmeta.pack?.pack_format;
        if (typeof format === 'number') {
          const manifest = getVersionsManifest();
          if (manifest) {
            const match = manifest.find(v => v.data_pack_version === format);
            if (match) return match.id;
          }
        }
      } catch {}
    }
  }

  return '26.3';
}

function getCachedVersions() {
  const versions = new Set();
  try {
    if (!fs.existsSync(INDEX_PATH)) return [];
    const rawWrapper = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const indexData = rawWrapper.index || rawWrapper;

    const regex = /^https:\/\/api\.spyglassmc\.com\/mcje\/versions\/([^/]+)\//;
    for (const url of Object.keys(indexData)) {
      const match = url.match(regex);
      if (match) {
        versions.add(match[1]);
      }
    }
  } catch {}
  return Array.from(versions).sort();
}

function verifyCache(targetVersion) {
  const requiredUrls = [
    'https://api.spyglassmc.com/mcje/versions',
    `https://api.spyglassmc.com/mcje/versions/${targetVersion}/block_states`,
    `https://api.spyglassmc.com/mcje/versions/${targetVersion}/commands`,
    `https://api.spyglassmc.com/mcje/versions/${targetVersion}/registries`,
    'https://api.spyglassmc.com/vanilla-mcdoc/tarball'
  ];

  if (!fs.existsSync(INDEX_PATH)) {
    return { ok: false, missing: requiredUrls, reason: 'Index file does not exist' };
  }

  let indexData;
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    indexData = raw.index || raw;
  } catch (err) {
    return { ok: false, missing: requiredUrls, reason: `Failed to parse index: ${err.message}` };
  }

  const missing = [];
  for (const url of requiredUrls) {
    const entry = indexData[url];
    if (!entry || !entry['']) {
      missing.push(url);
      continue;
    }
    const sha1 = entry[''].sha1;
    const objPath = path.join(OBJECTS_DIR, sha1.slice(0, 2), sha1);
    if (!fs.existsSync(objPath)) {
      missing.push(url);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    requiredUrls
  };
}

async function downloadUrlToCache(url) {
  console.log(`Downloading: ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  const objSubdir = path.join(OBJECTS_DIR, sha1.slice(0, 2));
  fs.mkdirSync(objSubdir, { recursive: true });
  fs.writeFileSync(path.join(objSubdir, sha1), buffer);

  let raw = { index: {} };
  if (fs.existsSync(INDEX_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      if (!raw.index) raw = { index: raw };
    } catch {}
  }

  const etag = res.headers.get('etag') || `"${sha1}"`;
  const lastModified = res.headers.get('last-modified') || new Date().toUTCString();

  raw.index[url] = {
    '': {
      sha1,
      headers: {
        etag,
        'last-modified': lastModified
      }
    }
  };

  fs.writeFileSync(INDEX_PATH, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`[OK] Cached: ${url} (sha1: ${sha1.slice(0, 8)}...)`);
}

async function checkCache(explicitVersion = null, doDownload = false) {
  const targetVersion = detectTargetVersion(findWorkspaceRoot(), explicitVersion);
  console.log(`=== Spyglass Metadata Cache Verifier ===`);
  console.log(`Target Minecraft Version: ${targetVersion}`);
  console.log(`Cache Root: ${CACHE_ROOT}`);

  const cachedVersions = getCachedVersions();
  console.log(`Available cached versions in local system (${cachedVersions.length}):`);
  console.log(`  ${cachedVersions.join(', ') || 'None'}\n`);

  const status = verifyCache(targetVersion);

  if (status.ok) {
    for (const url of status.requiredUrls) {
      console.log(`  [OK] Cached: ${url}`);
    }
    console.log(`\n✓ All metadata for version ${targetVersion} is fully cached and ready for offline use!\n`);
    return true;
  }

  console.log(`[WARN] Missing ${status.missing.length} cache item(s) for version ${targetVersion}:`);
  for (const m of status.missing) {
    console.log(`  - ${m}`);
  }

  if (doDownload) {
    console.log('\nAttempting to download missing metadata online...');
    try {
      for (const url of status.missing) {
        await downloadUrlToCache(url);
      }
      console.log(`\n✓ Download complete! All files cached for version ${targetVersion}.\n`);
      return true;
    } catch (err) {
      console.error(`\n[ERROR] Failed to download cache: ${err.message}`);
      return false;
    }
  } else {
    console.log('\nTo download missing metadata, run on a machine with internet:');
    console.log(`  node warmup.js ${targetVersion} --download\n`);
    return false;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const doDownload = args.includes('--download') || args.includes('-d');
  const explicitVersion = args.find(a => !a.startsWith('-')) || null;

  checkCache(explicitVersion, doDownload).then(ok => {
    process.exit(ok ? 0 : 1);
  });
}

module.exports = {
  checkCache,
  detectTargetVersion,
  getCachedVersions,
  verifyCache,
  CACHE_ROOT
};
