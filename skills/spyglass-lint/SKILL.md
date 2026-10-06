---
name: spyglass-lint
description: Diagnose syntax, mcdoc/NBT schema, command references, and undeclared symbols in Minecraft datapacks using Spyglass Language Server.
---

# Spyglass Datapack Linter & Analyzer

Statically verifies Minecraft datapack code using Spyglass Language Server and mcdoc schemas.

## Available Tools & When to Use

### 1. Single File Diagnosis (`spyglass_diagnose_file`)
- **When to use**: Immediately after creating or editing a file to verify syntax, command structure, and NBT field casing.
- **Parameters**:
  - `file_path`: Path to the target file (e.g., `data/my_pack/function/my_func.mcfunction`).
  - `content`: (Optional) Uncommitted file content in memory to validate before writing to disk.

### 2. Project-Wide Analysis (`spyglass_analyze_project`)
- **When to use**: After large refactorings or before concluding a task to perform comprehensive AST and cross-reference analysis across the entire datapack.
- **Checked items**: Broken function calls, missing tags, undeclared symbols, and invalid NBT schemas.

### 3. Server Status & Restart
- `spyglass_get_status`: Inspect LSP readiness, active Minecraft version, workspace path, and process ID.
- `spyglass_restart_server`: Restart the language server daemon to immediately reload updated configuration (`spyglass.json` or `pack.mcmeta`).

## CLI Usage

```bash
# 1. Static analysis of a single file
spyglass-lint data/my_pack/function/my_func.mcfunction

# 2. Full analysis of all files in the datapack project
spyglass-lint --all

# 3. Output analysis results in JSON format
spyglass-lint --all --json

# 4. Analyze by specifying the datapack workspace path
spyglass-lint --all -w /path/to/datapack
```

#### CLI options

```text
Usage: spyglass-lint [options] [file_path]

Options:
  -a, --all               Run project-wide analysis across all files
  --json                  Output raw JSON diagnostics instead of formatted text
  -w, --workspace <dir>   Set workspace root directory (default: auto-detected)
  -h, --help              Show help information
```
