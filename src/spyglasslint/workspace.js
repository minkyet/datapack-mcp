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

function findWorkspaceRoot(startDir = process.cwd()) {
  if (process.env.SPYGLASS_WORKSPACE && fs.existsSync(process.env.SPYGLASS_WORKSPACE)) {
    return path.resolve(process.env.SPYGLASS_WORKSPACE);
  }

  let curr = path.resolve(startDir);
  const root = path.parse(curr).root;

  // 1. Walk upward checking for configuration markers
  while (curr !== root) {
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

  // 2. If startDir didn't find anything, try searching relative to this script directory
  let pluginParent = path.resolve(__dirname, '..');
  while (pluginParent !== root) {
    if (fs.existsSync(path.join(pluginParent, 'spyglass.json')) || fs.existsSync(path.join(pluginParent, 'pack.mcmeta'))) {
      return pluginParent;
    }
    try {
      const entries = fs.readdirSync(pluginParent, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          if (fs.existsSync(path.join(pluginParent, ent.name, 'pack.mcmeta'))) {
            return pluginParent;
          }
        }
      }
    } catch {}
    pluginParent = path.dirname(pluginParent);
  }

  return path.resolve(startDir);
}

module.exports = { findWorkspaceRoot };
