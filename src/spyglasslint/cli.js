/**
 * Spyglass CLI Linter Runner
 * 
 * Provides an on-demand, terminal-friendly linter interface for individual files
 * or the entire datapack project using Spyglass Language Server.
 */

const path = require('node:path');
const { LspClient } = require('./lsp-client');
const { findWorkspaceRoot } = require('./workspace');

// ANSI Color Codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';

const SEVERITY_COLORS = {
  ERROR: RED + '[ERROR]' + RESET,
  WARN: YELLOW + '[WARN]' + RESET,
  INFO: CYAN + '[INFO]' + RESET,
  HINT: GRAY + '[HINT]' + RESET,
  UNKNOWN: GRAY + '[UNKNOWN]' + RESET
};

function printHelp() {
  console.log(`
${BOLD}Spyglass Datapack Linter (CLI)${RESET}
Powered by Spyglass Language Server & mcdoc schemas.

${BOLD}USAGE:${RESET}
  spyglasslint <file_path>        Lint a single file
  spyglasslint --all              Lint all files in the datapack project
  spyglasslint --help             Show this help message

${BOLD}OPTIONS:${RESET}
  -a, --all               Run project-wide analysis across all files
  --json                  Output raw JSON diagnostics instead of formatted text
  -w, --workspace <dir>   Set workspace root directory (default: auto-detected)
  -h, --help              Show help information

${BOLD}EXAMPLES:${RESET}
  spyglasslint data/my_pack/function/tick.mcfunction
  spyglasslint --all
  spyglasslint --all --json
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  let isAll = false;
  let isJson = false;
  let targetFile = null;
  let explicitWorkspace = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all' || arg === '-a') {
      isAll = true;
    } else if (arg === '--json') {
      isJson = true;
    } else if (arg === '--workspace' || arg === '-w') {
      explicitWorkspace = path.resolve(args[++i]);
    } else if (!arg.startsWith('-')) {
      targetFile = arg;
    }
  }

  const workspaceRoot = explicitWorkspace || findWorkspaceRoot(process.cwd());

  if (!isAll && !targetFile) {
    console.error(`${RED}Error:${RESET} No target file specified. Use --all to check all files, or --help for usage.`);
    process.exit(1);
  }

  if (!isJson) {
    console.log(`${CYAN}Initializing Spyglass LSP engine (workspace: ${workspaceRoot})...${RESET}`);
  }

  const client = new LspClient({ workspaceRoot });
  try {
    await client.start();

    if (isAll) {
      if (!isJson) {
        console.log(`${CYAN}Analyzing full project...${RESET}`);
      }
      const result = await client.analyzeProject();
      await client.close();

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        renderProjectResult(result, workspaceRoot);
      }

      const hasErrors = Object.values(result.diagnosticsByFile).some(diags =>
        diags.some(d => d.severity === 1)
      );
      process.exit(hasErrors ? 1 : 0);
    } else {
      const absTarget = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceRoot, targetFile);
      const diags = await client.diagnoseFile(absTarget);
      await client.close();

      if (isJson) {
        console.log(JSON.stringify({ filePath: absTarget, diagnostics: diags }, null, 2));
      } else {
        renderSingleFileResult(absTarget, diags, workspaceRoot);
      }

      const hasErrors = diags.some(d => d.severity === 1);
      process.exit(hasErrors ? 1 : 0);
    }
  } catch (err) {
    await client.close().catch(() => {});
    if (isJson) {
      console.error(JSON.stringify({ error: err.message }));
    } else {
      console.error(`${RED}Linter execution failed:${RESET}`, err.message);
    }
    process.exit(1);
  }
}

function renderSingleFileResult(filePath, diags, workspaceRoot) {
  const relPath = path.relative(workspaceRoot, filePath) || filePath;
  console.log(`\n${BOLD}File:${RESET} ${relPath}`);

  if (diags.length === 0) {
    console.log(`${GREEN}✓ No issues found.${RESET}\n`);
    return;
  }

  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const d of diags) {
    if (d.severity === 1) errors++;
    else if (d.severity === 2) warnings++;
    else infos++;

    const badge = SEVERITY_COLORS[d.severityName] || SEVERITY_COLORS.UNKNOWN;
    const loc = `${d.line}:${d.character}`;
    const rule = d.ruleCode ? ` ${DIM}(${d.ruleCode})${RESET}` : '';
    console.log(`  ${badge} ${BOLD}${relPath}:${loc}${RESET} - ${d.message}${rule}`);
  }

  console.log(`\n${BOLD}Summary:${RESET} ${errors > 0 ? RED : GREEN}${errors} error(s)${RESET}, ${warnings > 0 ? YELLOW : GREEN}${warnings} warning(s)${RESET}, ${infos} info(s)\n`);
}

function renderProjectResult(result, workspaceRoot) {
  const fileEntries = Object.entries(result.diagnosticsByFile);
  console.log(`\n${BOLD}Project Analysis Complete:${RESET} ${result.analyzedFiles}/${result.totalFiles} files analyzed.\n`);

  if (fileEntries.length === 0) {
    console.log(`${GREEN}✓ All files passed inspection with 0 issues!${RESET}\n`);
    return;
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const [filePath, diags] of fileEntries) {
    const relPath = path.relative(workspaceRoot, filePath) || filePath;
    console.log(`${BOLD}${relPath}:${RESET}`);
    for (const d of diags) {
      if (d.severity === 1) totalErrors++;
      else if (d.severity === 2) totalWarnings++;

      const badge = SEVERITY_COLORS[d.severityName] || SEVERITY_COLORS.UNKNOWN;
      const loc = `${d.line}:${d.character}`;
      const rule = d.ruleCode ? ` ${DIM}(${d.ruleCode})${RESET}` : '';
      console.log(`  ${badge} ${loc} - ${d.message}${rule}`);
    }
    console.log('');
  }

  console.log(`${BOLD}Overall Result:${RESET} ${fileEntries.length} file(s) with issues | ${totalErrors > 0 ? RED : GREEN}${totalErrors} total error(s)${RESET}, ${totalWarnings > 0 ? YELLOW : GREEN}${totalWarnings} total warning(s)${RESET}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
