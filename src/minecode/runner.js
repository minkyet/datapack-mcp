#!/usr/bin/env node

/**
 * MineCode MCP Bootstrap Runner
 * 
 * Automatically detects and transparently launches the minecode-mcp server
 * across uvx, pipx, or an isolated python3 virtual environment.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Augment PATH with common user binary directories (e.g., ~/.local/bin, ~/.cargo/bin)
function getAugmentedEnv() {
  const env = { ...process.env };
  const home = os.homedir();
  const extraPaths = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin')
  ];

  const currentPath = env.PATH || '';
  const delimiter = path.delimiter;
  const pathsToAdd = extraPaths.filter(p => !currentPath.split(delimiter).includes(p));

  if (pathsToAdd.length > 0) {
    env.PATH = pathsToAdd.join(delimiter) + delimiter + currentPath;
  }
  return env;
}

const env = getAugmentedEnv();

function commandExists(cmd, testArgs = ['--version']) {
  try {
    const result = spawnSync(cmd, testArgs, {
      env,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveCacheDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'spyglasslint', 'minecode-venv');
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdgCache, 'spyglasslint', 'minecode-venv');
}

function getVenvBin(venvDir, binName) {
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', `${binName}.exe`);
  }
  return path.join(venvDir, 'bin', binName);
}

function setupPythonVenv(pythonCmd, cacheVenvDir) {
  process.stderr.write(`[minecode-runner] Setting up isolated virtual environment in: ${cacheVenvDir}\n`);
  fs.mkdirSync(path.dirname(cacheVenvDir), { recursive: true });

  const createResult = spawnSync(pythonCmd, ['-m', 'venv', cacheVenvDir], {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (createResult.status !== 0) {
    throw new Error(`Failed to create virtual environment with ${pythonCmd}`);
  }

  const pipBin = getVenvBin(cacheVenvDir, 'pip');
  process.stderr.write(`[minecode-runner] Installing minecode-mcp via pip...\n`);
  const installResult = spawnSync(pipBin, ['install', '--upgrade', 'minecode-mcp'], {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (installResult.status !== 0) {
    throw new Error('Failed to install minecode-mcp into virtual environment');
  }
}

function resolveLaunchCommand() {
  // Check priority 0: Existing user venv (~/.venvs/minecode-mcp or cache dir)
  const userVenvDir = path.join(os.homedir(), '.venvs', 'minecode-mcp');
  const userVenvMinecode = getVenvBin(userVenvDir, 'minecode');
  if (fs.existsSync(userVenvMinecode)) {
    return { cmd: userVenvMinecode, args: [] };
  }

  // Check priority 1: uvx
  if (commandExists('uvx')) {
    return { cmd: 'uvx', args: ['minecode-mcp'] };
  }

  // Check priority 2: pipx
  if (commandExists('pipx')) {
    return { cmd: 'pipx', args: ['run', 'minecode-mcp'] };
  }

  // Check priority 3: python3 / python with cache venv
  const pythonCmds = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  let validPython = null;

  for (const py of pythonCmds) {
    try {
      const check = spawnSync(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], {
        env,
        stdio: 'ignore',
        shell: process.platform === 'win32'
      });
      if (check.status === 0) {
        validPython = py;
        break;
      }
    } catch {
      // Continue searching
    }
  }

  if (validPython) {
    const cacheVenvDir = resolveCacheDir();
    const venvMinecode = getVenvBin(cacheVenvDir, 'minecode');

    if (!fs.existsSync(venvMinecode)) {
      setupPythonVenv(validPython, cacheVenvDir);
    }

    if (fs.existsSync(venvMinecode)) {
      return { cmd: venvMinecode, args: [] };
    }
  }

  return null;
}

function main() {
  const launchConfig = resolveLaunchCommand();

  if (!launchConfig) {
    process.stderr.write(`
\x1b[31m[ERROR] minecode-mcp runtime not found.\x1b[0m
Please install one of the following to use MineCode tools:
  1. uv (recommended): https://docs.astral.sh/uv/
     Run: curl -LsSf https://astral.sh/uv/install.sh | sh
  2. pipx: pipx install minecode-mcp
  3. Python 3.10 or newer: https://www.python.org/
\n`);
    process.exit(1);
  }

  const { cmd, args } = launchConfig;
  
  // Forward process arguments if provided
  const combinedArgs = [...args, ...process.argv.slice(2)];

  const child = spawn(cmd, combinedArgs, {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32'
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);

  child.on('error', (err) => {
    process.stderr.write(`[minecode-runner] Failed to spawn '${cmd}': ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  const forwardSignal = (sig) => {
    if (child && !child.killed) {
      child.kill(sig);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  resolveLaunchCommand,
  getAugmentedEnv
};
