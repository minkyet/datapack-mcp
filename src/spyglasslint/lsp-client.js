/**
 * Spyglass LSP Client Core
 * 
 * Manages the Language Server stdio child process and abstracts LSP communication
 * for single-file diagnostics and project-wide analysis.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');

function resolveServerPath() {
  if (process.env.SPYGLASS_SERVER_PATH && fs.existsSync(process.env.SPYGLASS_SERVER_PATH)) {
    return process.env.SPYGLASS_SERVER_PATH;
  }

  const possibleExtensionDirs = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
    path.join(os.homedir(), '.vscode-oss', 'extensions')
  ];

  for (const extDir of possibleExtensionDirs) {
    if (fs.existsSync(extDir)) {
      try {
        const candidates = fs.readdirSync(extDir)
          .filter(name => name.startsWith('spgoding.datapack-language-server'))
          .sort()
          .reverse();
        for (const candidate of candidates) {
          const full = path.join(extDir, candidate, 'dist', 'server.js');
          if (fs.existsSync(full)) return full;
        }
      } catch {}
    }
  }

  return path.join(os.homedir(), '.vscode', 'extensions', 'spgoding.datapack-language-server', 'dist', 'server.js');
}

const DEFAULT_SERVER_PATH = resolveServerPath();
const DEFAULT_PRELOAD_PATH = path.join(__dirname, 'preload.js');

const SEVERITY_NAMES = {
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'HINT'
};

class LspClient {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.serverPath = options.serverPath || resolveServerPath();
    this.preloadPath = options.preloadPath || DEFAULT_PRELOAD_PATH;
    this.debug = Boolean(options.debug);

    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.requestId = 1;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.diagnosticsByUri = new Map(); // uri -> diagnostics array
    this.fileDiagnosticsWaiters = new Map(); // uri -> array of { resolve, reject, timer }
    this.openedFiles = new Map(); // uri -> version
    this.isReady = false;
    this.isClosed = false;
  }

  /**
   * Spawns the language server and performs the initialize handshake.
   */
  async start() {
    if (!fs.existsSync(this.serverPath)) {
      throw new Error(
        `Spyglass Language Server not found at: ${this.serverPath}\n` +
        `Please ensure the 'Datapack Helper Plus' (spgoding.datapack-language-server) extension is installed in VS Code, ` +
        `or set the SPYGLASS_SERVER_PATH environment variable.`
      );
    }

    const rootUri = pathToFileURL(this.workspaceRoot).href + '/';

    const nodeArgs = [
      '-r', this.preloadPath,
      this.serverPath,
      '--stdio'
    ];

    this.process = spawn('node', nodeArgs, {
      cwd: this.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', chunk => this._handleData(chunk));
    this.process.stderr.on('data', chunk => {
      if (this.debug) {
        console.error('[LspClient stderr]', chunk.toString());
      }
    });

    this.process.on('error', err => {
      if (this.debug) {
        console.error('[LspClient process error]', err);
      }
    });

    // Send initialize request
    const initResult = await this._sendRequest('initialize', {
      processId: process.pid,
      rootUri: rootUri,
      capabilities: {
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true }
        },
        textDocument: {
          documentSymbol: {}
        }
      },
      workspaceFolders: [
        {
          name: path.basename(this.workspaceRoot),
          uri: rootUri
        }
      ]
    }, 15000);

    // Send initialized notification
    this._sendNotification('initialized', {});

    // Wait until server progress completes (or max 5 seconds)
    await this._waitForReady();
    this.isReady = true;

    return initResult;
  }

  /**
   * Diagnoses a single file.
   * If `content` is omitted, reads the file directly from disk.
   */
  async diagnoseFile(filePath, content = null) {
    if (!this.isReady) {
      throw new Error('LspClient is not ready. Call start() first.');
    }

    const absPath = path.resolve(filePath);
    const uri = pathToFileURL(absPath).href;

    if (content === null) {
      content = fs.readFileSync(absPath, 'utf8');
    }

    const languageId = this._detectLanguageId(absPath);
    let version = (this.openedFiles.get(uri) || 0) + 1;

    // Invalidate stale cached diagnostics for this URI so that we only receive fresh results
    this.diagnosticsByUri.delete(uri);

    const diagPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Return whatever diagnostics we received (or empty array) if timeout occurs
        const diags = this.diagnosticsByUri.get(uri) || [];
        resolve(this._normalizeDiagnostics(diags, absPath));
      }, 5000);

      const waiters = this.fileDiagnosticsWaiters.get(uri) || [];
      waiters.push({ resolve, reject, timer, filePath: absPath });
      this.fileDiagnosticsWaiters.set(uri, waiters);
    });

    if (this.openedFiles.has(uri)) {
      this._sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      });
    } else {
      this._sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version, text: content }
      });
    }
    this.openedFiles.set(uri, version);

    // Trigger diagnostics calculation by requesting project analysis
    try {
      await this._sendCustomRequestWithoutParams('spyglassmc/analyzeProject', 15000);
    } catch {
      try {
        await this._sendRequest('textDocument/documentSymbol', {
          textDocument: { uri }
        }, 2500);
      } catch {
        // ignore
      }
    }

    return await diagPromise;
  }

  /**
   * Runs project-wide analysis across all files in the workspace.
   */
  async analyzeProject() {
    if (!this.isReady) {
      throw new Error('LspClient is not ready. Call start() first.');
    }

    // Clear diagnostics collection before analysis
    this.diagnosticsByUri.clear();

    // Note: Do NOT pass params object to spyglassmc/analyzeProject
    // because vscode-languageserver expects CancellationToken as 1st param
    const result = await this._sendCustomRequestWithoutParams('spyglassmc/analyzeProject', 60000);

    const diagnosticsByFile = {};
    for (const [uri, diags] of this.diagnosticsByUri.entries()) {
      if (diags.length > 0) {
        try {
          const filePath = fileURLToPath(uri);
          diagnosticsByFile[filePath] = this._normalizeDiagnostics(diags, filePath);
        } catch {
          diagnosticsByFile[uri] = this._normalizeDiagnostics(diags, uri);
        }
      }
    }

    return {
      totalFiles: result?.total ?? 0,
      analyzedFiles: result?.analyzed ?? 0,
      cancelled: Boolean(result?.cancelled),
      diagnosticsByFile
    };
  }

  /**
   * Gracefully shuts down the language server process.
   */
  async close() {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      if (this.process && !this.process.killed) {
        await this._sendRequest('shutdown', null, 2000).catch(() => {});
        this._sendNotification('exit', {});
        this.process.kill('SIGTERM');
      }
    } catch {
      if (this.process) this.process.kill('SIGKILL');
    }
  }

  // --- Private Helpers ---

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Discard malformed header chunk
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) break;

      const bodyBuf = this.buffer.subarray(headerEnd + 4, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const msg = JSON.parse(bodyBuf.toString('utf8'));
        this._handleMessage(msg);
      } catch (err) {
        if (this.debug) {
          console.error('[LspClient] Failed to parse JSON-RPC message:', err);
        }
      }
    }
  }

  _handleMessage(msg) {
    // 1. Server request (has method and id)
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'workspace/configuration') {
        this._sendResponse(msg.id, [{}]);
      } else {
        this._sendResponse(msg.id, null);
      }
      return;
    }

    // 2. Server notification (has method, no id)
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'textDocument/publishDiagnostics') {
        const uri = msg.params.uri;
        const diags = msg.params.diagnostics || [];
        this.diagnosticsByUri.set(uri, diags);

        const waiters = this.fileDiagnosticsWaiters.get(uri);
        if (waiters && waiters.length > 0) {
          this.fileDiagnosticsWaiters.delete(uri);
          for (const w of waiters) {
            clearTimeout(w.timer);
            w.resolve(this._normalizeDiagnostics(diags, w.filePath));
          }
        }
      }
      return;
    }

    // 3. Server response to client request (has id, no method)
    if (!msg.method && msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `LSP error code ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  _sendRequest(method, params, timeoutMs = 5000) {
    const id = `req-${this.requestId++}`;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this._write(payload);
    });
  }

  _sendCustomRequestWithoutParams(method, timeoutMs = 60000) {
    const id = `req-${this.requestId++}`;
    const payload = { jsonrpc: '2.0', id, method };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this._write(payload);
    });
  }

  _sendNotification(method, params) {
    const payload = { jsonrpc: '2.0', method, params };
    this._write(payload);
  }

  _sendResponse(id, result) {
    const payload = { jsonrpc: '2.0', id, result };
    this._write(payload);
  }

  _write(payload) {
    if (!this.process || this.process.killed) return;
    const jsonStr = JSON.stringify(payload);
    const byteLen = Buffer.byteLength(jsonStr, 'utf8');
    const header = `Content-Length: ${byteLen}\r\n\r\n`;
    this.process.stdin.write(header + jsonStr);
  }

  async _waitForReady() {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, 3000);
      const onProgress = chunk => {
        if (chunk.toString().includes('"kind":"end"')) {
          clearTimeout(timeout);
          this.process?.stdout.removeListener('data', onProgress);
          resolve();
        }
      };
      this.process?.stdout.on('data', onProgress);
    });
  }

  _detectLanguageId(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.mcfunction': return 'mcfunction';
      case '.json':
      case '.mcmeta': return 'json';
      case '.mcdoc': return 'mcdoc';
      case '.snbt': return 'snbt';
      default: return 'plaintext';
    }
  }

  _normalizeDiagnostics(rawDiags, filePath) {
    return rawDiags.map(d => ({
      filePath,
      line: (d.range?.start?.line ?? 0) + 1,
      character: (d.range?.start?.character ?? 0) + 1,
      endLine: (d.range?.end?.line ?? 0) + 1,
      endCharacter: (d.range?.end?.character ?? 0) + 1,
      severity: d.severity || 1,
      severityName: SEVERITY_NAMES[d.severity] || 'UNKNOWN',
      message: d.message,
      ruleCode: d.code || null,
      source: d.source || 'spyglassmc'
    }));
  }
}

module.exports = { LspClient, SEVERITY_NAMES, resolveServerPath };
