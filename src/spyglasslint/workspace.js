/**
 * Spyglass Datapack Workspace Root Resolver
 * 
 * Dynamically detects the Minecraft datapack root directory by searching upward
 * for 'spyglass.json', '.spyglassrc', or directories containing 'pack.mcmeta'.
 * 
 * Works seamlessly whether invoked from:
 * 1. Project-level plugin (.agents/plugins/spyglasslint)
 * 2. Machine-global plugin (~/.gemini/config/plugins/spyglasslint)
 * 3. Deep subdirectories within a datapack (e.g. data/<ns>/function/...)
 * 4. Standalone CLI runner with --workspace option or SPYGLASS_WORKSPACE env
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Checks if a directory is a datapack plugin/extension directory rather than a user datapack.
 */
function isPluginDirectory(dir) {
  if (!dir) return false;
  const abs = path.resolve(dir);
  const normalized = abs.replace(/\\/g, '/');

  if (
    normalized.includes('/.gemini/config/plugins/datapack-mcp') ||
    normalized.includes('/.agents/plugins/datapack-mcp') ||
    normalized.includes('/config/plugins/datapack-mcp')
  ) {
    return true;
  }

  try {
    const pluginJsonPath = path.join(abs, 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      const pJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      if (pJson.name === 'datapack-mcp') return true;
    }
  } catch {}

  try {
    const pkgJsonPath = path.join(abs, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name === 'datapack-mcp') return true;
    }
  } catch {}

  return false;
}

/**
 * Checks if a directory contains datapack markers (pack.mcmeta, spyglass.json, or child packs)
 */
function isDatapackRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    if (fs.existsSync(path.join(dir, 'pack.mcmeta'))) return true;
    if (fs.existsSync(path.join(dir, 'spyglass.json'))) return true;
    if (fs.existsSync(path.join(dir, '.spyglassrc'))) return true;

    // Check multi-pack repo (subdirectories containing pack.mcmeta)
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
        if (fs.existsSync(path.join(dir, ent.name, 'pack.mcmeta'))) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

/**
 * Walks upward from startDir searching for pack.mcmeta or spyglass.json.
 */
function findDatapackRoot(startDir) {
  if (!startDir || !fs.existsSync(startDir)) return null;

  let curr = path.resolve(startDir);
  try {
    const stat = fs.statSync(curr);
    if (!stat.isDirectory()) {
      curr = path.dirname(curr);
    }
  } catch {
    return null;
  }

  const root = path.parse(curr).root;

  while (curr && curr !== root) {
    if (isPluginDirectory(curr)) {
      curr = path.dirname(curr);
      continue;
    }

    if (fs.existsSync(path.join(curr, 'spyglass.json')) || fs.existsSync(path.join(curr, '.spyglassrc'))) {
      return curr;
    }
    if (fs.existsSync(path.join(curr, 'pack.mcmeta'))) {
      return curr;
    }
    // Check if any direct child has pack.mcmeta (multi-pack repository)
    try {
      const entries = fs.readdirSync(curr, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          if (fs.existsSync(path.join(curr, ent.name, 'pack.mcmeta'))) {
            return curr;
          }
        }
      }
    } catch {}

    curr = path.dirname(curr);
  }

  return null;
}

function findWorkspaceRoot(startDir = null) {
  // 1. Explicit environment variable override
  if (process.env.SPYGLASS_WORKSPACE && fs.existsSync(process.env.SPYGLASS_WORKSPACE)) {
    return path.resolve(process.env.SPYGLASS_WORKSPACE);
  }

  // 2. If startDir is explicitly provided, search upward for datapack markers
  if (startDir && fs.existsSync(startDir)) {
    const resolvedStart = path.resolve(startDir);
    const found = findDatapackRoot(resolvedStart);
    if (found) return found;

    // If startDir is explicitly passed and is a directory (and not plugin root), respect it
    if (!isPluginDirectory(resolvedStart)) {
      try {
        if (fs.statSync(resolvedStart).isDirectory()) {
          return resolvedStart;
        }
      } catch {}
    }
  }

  // 3. Search upward from host agent environment variables
  const envCandidates = [
    process.env.WORKSPACE_FOLDER,
    process.env.AGY_WORKSPACE_DIR,
    process.env.CLAUDE_WORKSPACE,
    process.env.INIT_CWD,
    process.env.PWD,
    process.cwd()
  ];

  for (const candidate of envCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      const resolved = path.resolve(candidate);
      if (!isPluginDirectory(resolved)) {
        const found = findDatapackRoot(resolved);
        if (found) return found;
      }
    }
  }

  // 4. Fallback: first valid non-plugin candidate directory
  for (const candidate of envCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      const resolved = path.resolve(candidate);
      if (!isPluginDirectory(resolved)) {
        return resolved;
      }
    }
  }

  // 5. Final fallback
  return startDir ? path.resolve(startDir) : process.cwd();
}

module.exports = { findWorkspaceRoot, findDatapackRoot, isDatapackRoot, isPluginDirectory };
