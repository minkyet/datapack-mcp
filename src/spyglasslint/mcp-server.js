#!/usr/bin/env node

/**
 * Spyglass MCP Server
 * 
 * Persistent JSON-RPC stdio Model Context Protocol (MCP) server
 * providing live diagnostics and full project analysis to AI coding agents.
 * 
 * Supports automatic hot-reload when `spyglass.json` or `pack.mcmeta` changes.
 */

const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { LspClient } = require('./lsp-client');
const { findWorkspaceRoot, isDatapackRoot } = require('./workspace');

class McpServer {
  constructor(options = {}) {
    const rawRoot = options.workspaceRoot || this._parseCliWorkspace() || null;
    this.workspaceRoot = path.resolve(findWorkspaceRoot(rawRoot));
    this.client = new LspClient({ workspaceRoot: this.workspaceRoot });
    this.initPromise = null;
    this.isReady = false;
    this.initError = null;
    this.configWatchers = [];
  }

  _parseCliWorkspace() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '-w' || args[i] === '--workspace') && args[i + 1]) {
        return args[i + 1];
      }
    }
    return null;
  }

  start() {
    this._startLsp();
    this._watchConfigs();
    this._listenStdio();
  }

  _startLsp() {
    this.initPromise = (async () => {
      try {
        await this.client.start();
        this.isReady = true;
      } catch (err) {
        this.initError = err;
        console.error('[McpServer] Failed to initialize Spyglass LSP:', err);
      }
    })();
  }

  async switchWorkspace(newRoot, reason = 'Workspace switch') {
    const resolved = path.resolve(newRoot);
    if (this.workspaceRoot === resolved && this.client && this.isReady) {
      return;
    }

    for (const w of this.configWatchers) {
      try { w.close(); } catch {}
    }
    this.configWatchers = [];

    this.workspaceRoot = resolved;
    this.isReady = false;
    this.initPromise = (async () => {
      try {
        if (this.client) {
          await this.client.close().catch(() => {});
        }
        this.client = new LspClient({ workspaceRoot: this.workspaceRoot });
        await this.client.start();
        this.isReady = true;
        this.initError = null;
      } catch (err) {
        this.initError = err;
        console.error(`[McpServer] Failed to switch workspace to ${resolved}:`, err);
      }
    })();

    this._watchConfigs();
    return await this.initPromise;
  }

  async _ensureWorkspace(targetHint = null) {
    if (targetHint) {
      let candidate = targetHint;
      if (!path.isAbsolute(candidate)) {
        const base = process.env.PWD || this.workspaceRoot || process.cwd();
        candidate = path.resolve(base, candidate);
      }
      const detected = findWorkspaceRoot(candidate);
      if (detected && detected !== this.workspaceRoot) {
        await this.switchWorkspace(detected, `Detected workspace from target: ${targetHint}`);
        return;
      }
    }

    if (!isDatapackRoot(this.workspaceRoot)) {
      const detected = findWorkspaceRoot();
      if (detected && detected !== this.workspaceRoot) {
        await this.switchWorkspace(detected, 'Auto-detected valid datapack workspace');
      }
    }
  }

  async restart(reason = 'Manual reload') {
    this.isReady = false;
    this.initPromise = (async () => {
      try {
        if (this.client) {
          await this.client.close().catch(() => {});
        }
        this.client = new LspClient({ workspaceRoot: this.workspaceRoot });
        await this.client.start();
        this.isReady = true;
      } catch (err) {
        this.initError = err;
        console.error('[McpServer] Failed to restart LSP engine:', err);
      }
    })();
    return await this.initPromise;
  }

  _watchConfigs() {
    const candidates = [
      path.join(this.workspaceRoot, 'spyglass.json'),
      path.join(this.workspaceRoot, '.spyglassrc'),
      path.join(this.workspaceRoot, '.spyglassrc.json'),
      path.join(this.workspaceRoot, 'pack.mcmeta')
    ];

    try {
      const entries = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          candidates.push(path.join(this.workspaceRoot, ent.name, 'pack.mcmeta'));
        }
      }
    } catch {}

    let debounceTimer = null;
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          const watcher = fs.watch(file, () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.restart(`Config file modified: ${path.basename(file)}`);
            }, 300);
          });
          this.configWatchers.push(watcher);
        } catch {
          // File watching might not be supported on some sandbox mounts; gracefully ignore
        }
      }
    }
  }

  _listenStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async line => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const msg = JSON.parse(trimmed);
        await this._handleMessage(msg);
      } catch (err) {
        this._sendError(null, -32700, `Parse error: ${err.message}`);
      }
    });

    process.on('SIGTERM', () => this._shutdown());
    process.on('SIGINT', () => this._shutdown());
  }

  async _shutdown() {
    for (const w of this.configWatchers) {
      try { w.close(); } catch {}
    }
    if (this.client) {
      await this.client.close().catch(() => {});
    }
    process.exit(0);
  }

  async _handleMessage(msg) {
    if (msg.jsonrpc !== '2.0') {
      return this._sendError(msg.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    }

    if (msg.id === undefined) {
      if (msg.method === 'notifications/initialized') {
        return;
      }
      return;
    }

    const { id, method, params } = msg;

    switch (method) {
      case 'initialize': {
        const rawUri = params?.rootUri || params?.workspaceFolders?.[0]?.uri;
        let clientRoot = null;
        if (rawUri) {
          try {
            clientRoot = fileURLToPath(rawUri);
          } catch {
            clientRoot = rawUri;
          }
        } else if (params?.rootPath) {
          clientRoot = params.rootPath;
        }

        if (clientRoot && fs.existsSync(clientRoot)) {
          const detected = findWorkspaceRoot(clientRoot);
          if (detected && detected !== this.workspaceRoot) {
            await this.switchWorkspace(detected, `Client initialize rootUri: ${clientRoot}`);
          }
        }

        return this._sendResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'spyglass-mcp',
            version: '1.0.0'
          }
        });
      }

      case 'ping':
        return this._sendResult(id, {});

      case 'tools/list':
        return this._sendResult(id, {
          tools: [
            {
              name: 'spyglass_diagnose_file',
              description: 'Diagnose syntax, mcdoc/NBT schema, command references, and undeclared symbols in a single datapack file (.mcfunction, .json, .mcmeta, etc.). Returns line/column locations, severity, and error descriptions.',
              inputSchema: {
                type: 'object',
                properties: {
                  file_path: {
                    type: 'string',
                    description: 'Relative or absolute path to the file to diagnose (e.g. data/my_pack/function/tick.mcfunction)'
                  },
                  content: {
                    type: 'string',
                    description: 'Optional uncommitted file text to validate in-memory before writing to disk.'
                  }
                },
                required: ['file_path']
              }
            },
            {
              name: 'spyglass_analyze_project',
              description: 'Perform a comprehensive project-wide AST and cross-reference analysis across all files in the datapack. Detects broken function calls, missing tags, and invalid NBT schemas.',
              inputSchema: {
                type: 'object',
                properties: {
                  workspace_path: {
                    type: 'string',
                    description: 'Optional path to the datapack root directory (relative or absolute). If omitted, automatically detects from active context.'
                  }
                }
              }
            },
            {
              name: 'spyglass_set_workspace',
              description: 'Explicitly switch or set the active datapack workspace root directory for the Spyglass Language Server daemon.',
              inputSchema: {
                type: 'object',
                properties: {
                  workspace_path: {
                    type: 'string',
                    description: 'Absolute or relative path to the target datapack root directory containing pack.mcmeta or spyglass.json.'
                  }
                },
                required: ['workspace_path']
              }
            },
            {
              name: 'spyglass_restart_server',
              description: 'Restart the Spyglass Language Server daemon to immediately reload updated configuration (spyglass.json) or switch Minecraft versions.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'spyglass_get_status',
              description: 'Check the status of the Spyglass Language Server daemon, including workspace directory, configured version, and readiness state.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            }
          ]
        });

      case 'tools/call':
        return await this._handleToolCall(id, params);

      default:
        return this._sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  async _handleToolCall(id, params) {
    const { name, arguments: args = {} } = params || {};

    try {
      switch (name) {
        case 'spyglass_set_workspace': {
          const wsPath = args.workspace_path;
          if (!wsPath) {
            return this._sendToolError(id, 'Missing required argument: workspace_path');
          }
          const base = process.env.PWD || process.cwd();
          const resolved = path.isAbsolute(wsPath) ? wsPath : path.resolve(base, wsPath);
          if (!fs.existsSync(resolved)) {
            return this._sendToolError(id, `Specified workspace directory does not exist: ${wsPath}`);
          }
          const detected = findWorkspaceRoot(resolved) || resolved;
          await this.switchWorkspace(detected, `Manual set_workspace: ${detected}`);

          return this._sendResult(id, {
            content: [{
              type: 'text',
              text: `✓ **Spyglass workspace successfully switched to:** \`${this.workspaceRoot}\`\n(LSP re-indexed)`
            }],
            isError: false
          });
        }

        case 'spyglass_diagnose_file': {
          const filePath = args.file_path;
          if (!filePath) {
            return this._sendToolError(id, 'Missing required argument: file_path');
          }

          let absPath = filePath;
          if (!path.isAbsolute(filePath)) {
            const candidatePwd = process.env.PWD ? path.resolve(process.env.PWD, filePath) : null;
            const candidateWs = this.workspaceRoot ? path.resolve(this.workspaceRoot, filePath) : null;
            const candidateCwd = path.resolve(process.cwd(), filePath);

            if (candidatePwd && fs.existsSync(candidatePwd)) {
              absPath = candidatePwd;
            } else if (candidateWs && fs.existsSync(candidateWs)) {
              absPath = candidateWs;
            } else if (fs.existsSync(candidateCwd)) {
              absPath = candidateCwd;
            } else {
              absPath = candidateWs || candidatePwd || candidateCwd;
            }
          }

          const content = typeof args.content === 'string' ? args.content : null;
          if (content === null && !fs.existsSync(absPath)) {
            return this._sendToolError(id, `File does not exist: ${filePath} (resolved: ${absPath})`);
          }

          // Auto-switch workspace if file belongs to a different datapack
          await this._ensureWorkspace(path.dirname(absPath));

          if (!this.isReady) {
            if (this.initPromise) await this.initPromise;
            if (this.initError) {
              return this._sendToolError(id, `Spyglass LSP initialization failed: ${this.initError.message}`);
            }
          }

          const diags = await this.client.diagnoseFile(absPath, content);
          const relPath = path.relative(this.workspaceRoot, absPath) || filePath;

          let textOutput = `### Spyglass Diagnostics: \`${relPath}\`\n\n`;
          if (diags.length === 0) {
            textOutput += '✓ **No errors or warnings found! File is completely valid.**\n';
          } else {
            textOutput += `Found **${diags.length}** issue(s):\n\n`;
            textOutput += '| Line:Col | Severity | Message | Rule / Source |\n';
            textOutput += '| :--- | :--- | :--- | :--- |\n';
            for (const d of diags) {
              const rule = d.ruleCode ? `\`${d.ruleCode}\`` : `\`${d.source}\``;
              textOutput += `| \`${d.line}:${d.character}\` | **${d.severityName}** | ${d.message} | ${rule} |\n`;
            }
          }

          return this._sendResult(id, {
            content: [
              {
                type: 'text',
                text: textOutput
              },
              {
                type: 'text',
                text: JSON.stringify({ filePath: relPath, diagnostics: diags }, null, 2)
              }
            ],
            isError: false
          });
        }

        case 'spyglass_analyze_project': {
          if (args.workspace_path) {
            await this._ensureWorkspace(args.workspace_path);
          } else {
            await this._ensureWorkspace();
          }

          if (!this.isReady) {
            if (this.initPromise) await this.initPromise;
            if (this.initError) {
              return this._sendToolError(id, `Spyglass LSP initialization failed: ${this.initError.message}`);
            }
          }

          const hasMcmeta = fs.existsSync(path.join(this.workspaceRoot, 'pack.mcmeta'));
          const hasDataDir = fs.existsSync(path.join(this.workspaceRoot, 'data'));
          const hasSpyglassCfg = fs.existsSync(path.join(this.workspaceRoot, 'spyglass.json'));

          const result = await this.client.analyzeProject();
          const fileCount = Object.keys(result.diagnosticsByFile).length;

          if (result.totalFiles === 0 && !hasMcmeta && !hasDataDir && !hasSpyglassCfg) {
            return this._sendResult(id, {
              content: [{
                type: 'text',
                text: `⚠️ **[Warning] No Minecraft datapack files found in workspace:** \`${this.workspaceRoot}\`\n\n` +
                      `- The current workspace directory does not contain \`pack.mcmeta\` or \`data/\`.\n` +
                      `- **Actionable fix:** Please provide the \`workspace_path\` argument (e.g. \`{"workspace_path": "/path/to/datapack"}\`) or call \`spyglass_set_workspace\`.`
              }],
              isError: true
            });
          }

          let textOutput = `### Spyglass Full Project Analysis\n\n`;
          textOutput += `- **Workspace Root:** \`${this.workspaceRoot}\`\n`;
          textOutput += `- **Total Files:** ${result.totalFiles}\n`;
          textOutput += `- **Analyzed Files:** ${result.analyzedFiles}\n`;
          textOutput += `- **Files with Issues:** ${fileCount}\n\n`;

          if (fileCount === 0) {
            textOutput += '✓ **All files across the entire datapack passed with 0 issues!**\n';
          } else {
            textOutput += '#### Files with Issues:\n\n';
            for (const [fPath, diags] of Object.entries(result.diagnosticsByFile)) {
              const rel = path.relative(this.workspaceRoot, fPath) || fPath;
              textOutput += `**${rel}** (${diags.length} issues):\n`;
              for (const d of diags) {
                textOutput += `- \`[${d.severityName}]\` L${d.line}:${d.character} - ${d.message}\n`;
              }
              textOutput += '\n';
            }
          }

          return this._sendResult(id, {
            content: [
              {
                type: 'text',
                text: textOutput
              },
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ],
            isError: false
          });
        }

        case 'spyglass_restart_server': {
          await this.restart('Requested via tool call');
          return this._sendResult(id, {
            content: [{ type: 'text', text: '✓ **Spyglass Language Server restarted and re-indexed successfully.**' }],
            isError: false
          });
        }

        case 'spyglass_get_status': {
          let configuredVersion = 'auto';
          const configFile = path.join(this.workspaceRoot, 'spyglass.json');
          if (fs.existsSync(configFile)) {
            try {
              const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
              configuredVersion = cfg.env?.gameVersion || 'auto (resolved via pack.mcmeta)';
            } catch {}
          }

          const isValidDatapack = isDatapackRoot(this.workspaceRoot);

          const statusText = [
            `### Spyglass Language Server Status`,
            `- **Status:** ${this.isReady ? 'Active & Ready' : 'Initializing...'}`,
            `- **Workspace Root:** \`${this.workspaceRoot}\``,
            `- **Is Valid Datapack:** ${isValidDatapack ? '✓ Yes' : '✗ No (missing pack.mcmeta or data/)'}`,
            `- **Configured Game Version:** \`${configuredVersion}\``,
            `- **LSP Process ID:** ${this.client?.process?.pid || 'N/A'}`
          ].join('\n');

          return this._sendResult(id, {
            content: [{ type: 'text', text: statusText }],
            isError: false
          });
        }

        default:
          return this._sendToolError(id, `Unknown tool: ${name}`);
      }
    } catch (err) {
      return this._sendToolError(id, `Tool execution failed: ${err.message}`);
    }
  }

  _sendResult(id, result) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(payload + '\n');
  }

  _sendError(id, code, message) {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message }
    });
    process.stdout.write(payload + '\n');
  }

  _sendToolError(id, message) {
    this._sendResult(id, {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true
    });
  }
}

if (require.main === module) {
  const server = new McpServer();
  server.start();
}

module.exports = { McpServer };
