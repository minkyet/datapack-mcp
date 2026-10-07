#!/usr/bin/env node

/**
 * Spyglass LSP & MCP Comprehensive E2E Test Suite
 * 
 * Verifies that:
 * 1. Cache warmup succeeds in offline/sandboxed conditions.
 * 2. LspClient correctly starts, detects valid files, and catches NBT/symbol errors.
 * 3. CLI runner accurately formats and exits with appropriate status codes.
 * 4. MCP Server protocol handles initialize, tools/list, and tools/call.
 * 5. Full project analysis executes and indexes workspace files.
 */

const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const os = require('node:os');
const { checkCache } = require('../src/spyglasslint/warmup');
const { LspClient } = require('../src/spyglasslint/lsp-client');
const { findWorkspaceRoot } = require('../src/spyglasslint/workspace');

const FIXTURE_PACK_ROOT = path.resolve(__dirname, 'fixtures/test_pack');
const WORKSPACE_ROOT = findWorkspaceRoot(FIXTURE_PACK_ROOT);

function findSampleMcfunction(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    const match = files.find(f => f.isFile() && f.name.endsWith('.mcfunction') && ((f.parentPath || f.path || '') + '').includes('data')) ||
                  files.find(f => f.isFile() && f.name.endsWith('.mcfunction') && !f.name.includes('node_modules') && !f.name.includes('.tmp'));
    if (match) {
      return path.join(match.parentPath || match.path, match.name);
    }
  } catch {}
  const fallbackDir = path.join(os.tmpdir(), '.tmp_spyglass_test');
  fs.mkdirSync(fallbackDir, { recursive: true });
  const fallbackFile = path.join(fallbackDir, 'sample.mcfunction');
  if (!fs.existsSync(fallbackFile)) {
    fs.writeFileSync(fallbackFile, '# Temporary test file\n');
  }
  return fallbackFile;
}

const TEST_TARGET_FILE = findSampleMcfunction(WORKSPACE_ROOT);
const TEST_TARGET_REL = path.relative(WORKSPACE_ROOT, TEST_TARGET_FILE);

async function runTests() {
  console.log('====================================================');
  console.log('  Running Spyglass Tooling E2E Test Suite');
  console.log(`  Workspace: ${WORKSPACE_ROOT}`);
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• Testing ${name}... `);
    try {
      await fn();
      console.log('\x1b[32m[PASS]\x1b[0m');
      passed++;
    } catch (err) {
      console.log('\x1b[31m[FAIL]\x1b[0m');
      console.error(`  Error: ${err.message}`);
      if (err.stack) console.error('  ' + err.stack.split('\n').slice(1, 4).join('\n  '));
      failed++;
    }
  }

  // Test 1: Cache verification
  await test('Cache Warmup Status', async () => {
    const isCached = await checkCache();
    assert.strictEqual(isCached, true, 'Required metadata cache must be present');
  });

  // Test 2: Core LSP Client start & clean file diagnosis
  const client = new LspClient({ workspaceRoot: WORKSPACE_ROOT });
  await test('LspClient Start & Clean File Diagnosis', async () => {
    await client.start();
    assert.strictEqual(client.isReady, true, 'LSP client should be ready');

    const diags = await client.diagnoseFile(TEST_TARGET_FILE);
    assert.ok(Array.isArray(diags), 'Diagnostics should be an array');
    assert.strictEqual(diags.length, 0, 'Clean file should produce 0 diagnostics');
  });

  // Test 3: In-memory NBT error & undeclared function detection
  await test('NBT Casing & Undeclared Symbol Detection', async () => {
    const badCode = [
      'summon interaction ~ ~ ~ {Width: 4.0f}',
      'function dummy_pack:zzz/non_existent_fn_e2e_test'
    ].join('\n');

    const diags = await client.diagnoseFile(TEST_TARGET_FILE, badCode);
    assert.strictEqual(diags.length >= 2, true, `Should detect at least 2 issues, got ${diags.length}: ${JSON.stringify(diags)}`);

    const hasNbtError = diags.some(d => d.message.includes('Width') || d.message.includes('Unknown key'));
    assert.strictEqual(hasNbtError, true, 'Should detect invalid NBT key Width');

    const hasSymbolError = diags.some(d => d.message.includes('non_existent_fn_e2e_test'));
    assert.strictEqual(hasSymbolError, true, 'Should detect undeclared function symbol');
  });

  // Test 4: Project-wide analysis
  await test('Project-wide AST & Cross-reference Analysis', async () => {
    const result = await client.analyzeProject();
    assert.strictEqual(result.cancelled, false, 'Analysis should not be cancelled');
    assert.ok(typeof result.diagnosticsByFile === 'object', 'diagnosticsByFile should be an object');
  });

  // Close LSP client
  await client.close();

  // Test 5: CLI Script execution on clean file
  await test('CLI Runner Execution (--json)', async () => {
    const cliScript = path.join(__dirname, '../src/spyglasslint/cli.js');
    const cliRes = spawnSync('node', [
      cliScript,
      TEST_TARGET_FILE,
      '--json'
    ], {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8'
    });

    assert.strictEqual(cliRes.status, 0, `CLI should exit with 0, got ${cliRes.status} (stderr: ${cliRes.stderr})`);
    const parsed = JSON.parse(cliRes.stdout);
    assert.strictEqual(parsed.diagnostics.length, 0, 'CLI should report 0 issues for clean file');
  });

  // Test 6: MCP Server JSON-RPC Protocol (Initialize -> Tools List -> Call)
  await test('MCP Server Protocol Handshake & Tool Call', async () => {
    const mcpScript = path.join(__dirname, '../src/spyglasslint/mcp-server.js');
    const targetFile = TEST_TARGET_FILE;

    const promise = new Promise((resolve, reject) => {
      const p = spawn('node', [mcpScript, '--workspace', WORKSPACE_ROOT], {
        cwd: WORKSPACE_ROOT,
        stdio: ['pipe', 'pipe', 'inherit']
      });

      const timer = setTimeout(() => {
        p.kill();
        reject(new Error('MCP server handshake test timed out'));
      }, 30000);

      const rl = readline.createInterface({ input: p.stdout });
      rl.on('line', l => {
        try {
          const msg = JSON.parse(l);
          if (msg.id === 1) {
            assert.strictEqual(msg.result.serverInfo.name, 'spyglass-mcp');
            p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (msg.id === 2) {
            assert.ok(msg.result.tools.some(t => t.name === 'spyglass_diagnose_file'));
            p.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'spyglass_diagnose_file',
                arguments: { file_path: targetFile }
              }
            }) + '\n');
          } else if (msg.id === 3) {
            assert.strictEqual(msg.result.isError, false);
            p.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 4,
              method: 'tools/call',
              params: { name: 'spyglass_get_status', arguments: {} }
            }) + '\n');
          } else if (msg.id === 4) {
            assert.strictEqual(msg.result.isError, false);
            clearTimeout(timer);
            p.kill();
            resolve();
          }
        } catch (err) {
          clearTimeout(timer);
          p.kill();
          reject(err);
        }
      });

      p.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      p.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      }) + '\n');
    });

    await promise;
  });

  console.log('\n====================================================');
  console.log(`  Tests completed: \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
