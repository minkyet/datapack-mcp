---
name: spyglass-lint
description: Diagnose syntax, mcdoc/NBT schema, command references, and undeclared symbols in Minecraft datapacks using Spyglass Language Server.
---

# Spyglass Datapack Linter & Analyzer

Statically verifies Minecraft datapack code using Spyglass Language Server and mcdoc schemas via persistent MCP tools.

## Mandatory Agent Execution Rule
- **STRICT MCP USAGE**: Always invoke static verification directly via the MCP tools (`spyglass_diagnose_file`, `spyglass_analyze_project`).
- **DO NOT EXECUTE CLI COMMANDS**: Never run `spyglass-lint` CLI via bash/terminal commands. The MCP server keeps a persistent LSP daemon running in memory for sub-second responses, whereas the CLI restarts the entire LSP process on every run.

## Available MCP Tools & Usage

### 1. Single File Diagnosis (`spyglass_diagnose_file`)
- **When to use**: Immediately after creating or editing any `.mcfunction` or `.json` file to verify syntax, command structure, and NBT field casing.
- **Parameters**:
  - `file_path` (string, required): Relative or absolute path to the file (e.g. `data/my_pack/function/tick.mcfunction`).
  - `content` (string, optional): In-memory uncommitted file text to validate before writing to disk.
- **Example call**:
  - Tool: `spyglass_diagnose_file`
  - Arguments: `{"file_path": "data/my_pack/function/tick.mcfunction"}`

### 2. Project-Wide Analysis (`spyglass_analyze_project`)
- **When to use**: After large refactorings or before concluding a task to perform comprehensive AST and cross-reference analysis across the entire datapack.
- **Checked items**: Broken function calls, missing tags, undeclared symbols, and invalid NBT schemas.
- **Parameters**: None (`{}`)
- **Example call**:
  - Tool: `spyglass_analyze_project`
  - Arguments: `{}`

### 3. Server Status & Restart
- `spyglass_get_status`: Inspect LSP readiness, active Minecraft version, workspace path, and process ID.
- `spyglass_restart_server`: Restart the language server daemon to immediately reload updated configuration (`spyglass.json` or `pack.mcmeta`).
