#!/usr/bin/env node

/**
 * MineCode MCP Bootstrap Runner Smoke Test Suite
 * 
 * Verifies that:
 * 1. resolveLaunchCommand correctly resolves an execution environment.
 * 2. minecode-runner transparently handles MCP JSON-RPC protocol over stdio.
 * 3. initialize handshake and tools/list requests return valid MCP responses.
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { resolveLaunchCommand, getAugmentedEnv } = require('../src/minecode/runner');

async function testLaunchResolution() {
  console.log('[TEST 1] Testing launcher resolution...');
  const launchConfig = resolveLaunchCommand();
  assert(launchConfig !== null, 'Launch command should resolve to a valid environment');
  assert(typeof launchConfig.cmd === 'string', 'launchConfig.cmd must be a string');
  assert(Array.isArray(launchConfig.args), 'launchConfig.args must be an array');
  console.log(`  ✓ Resolved successfully: ${launchConfig.cmd} ${launchConfig.args.join(' ')}`);
}

async function testMcpHandshake() {
  console.log('\n[TEST 2] Testing MineCode MCP JSON-RPC stdio handshake...');
  
  const runnerPath = path.join(__dirname, '../src/minecode/runner.js');
  const child = spawn('node', [runnerPath], {
    env: getAugmentedEnv(),
    stdio: ['pipe', 'pipe', 'inherit']
  });

  const rl = readline.createInterface({ input: child.stdout });

  const sendRequest = (req) => {
    child.stdin.write(JSON.stringify(req) + '\n');
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('MineCode MCP handshake timed out after 10 seconds'));
    }, 10000);

    let stage = 0;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // Non-JSON lines (if any) are ignored
      }

      if (stage === 0 && msg.id === 1) {
        assert(msg.result, 'Initialize response must contain result');
        assert(msg.result.serverInfo || msg.result.capabilities, 'Initialize response must contain serverInfo or capabilities');
        console.log(`  ✓ Received initialize response from: ${msg.result.serverInfo?.name || 'minecode'}`);

        stage = 1;
        // Send initialized notification followed by tools/list request
        sendRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
        sendRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      } else if (stage === 1 && msg.id === 2) {
        assert(msg.result && Array.isArray(msg.result.tools), 'tools/list must return an array of tools');
        const toolNames = msg.result.tools.map(t => t.name);
        console.log(`  ✓ Received tools/list with ${toolNames.length} tools`);
        assert(toolNames.includes('minecraft_start_session'), 'Must include minecraft_start_session tool');
        assert(toolNames.includes('get_command_usage'), 'Must include get_command_usage tool');
        console.log(`  ✓ Verified key tools: minecraft_start_session, get_command_usage`);

        clearTimeout(timeout);
        child.kill('SIGTERM');
        resolve();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (stage < 2 && code !== 0 && signal !== 'SIGTERM') {
        reject(new Error(`Runner exited unexpectedly with code ${code}, signal ${signal}`));
      }
    });

    // Send initialize request
    sendRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'spyglasslint-test-client', version: '1.0.0' }
      }
    });
  });
}

async function run() {
  console.log('====================================================');
  console.log('  Running MineCode MCP Runner Smoke Test Suite');
  console.log('====================================================\n');

  try {
    await testLaunchResolution();
    await testMcpHandshake();
    console.log('\n====================================================');
    console.log('  ✓ ALL MINECODE RUNNER TESTS PASSED');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n[ERROR]', err.message);
    process.exit(1);
  }
}

run();
