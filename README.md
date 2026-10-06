# SpyglassLint

SpyglassLint is a static analysis linter and AI agent plugin for Minecraft datapacks, based on the Spyglass Language Server (LSP) from the VS Code [Datapack Helper Plus](https://marketplace.visualstudio.com/items?itemName=spgoding.datapack-language-server) extension.

## Install

### Claude Code

```text
/plugin marketplace add minkyet/spyglasslint
/plugin install spyglasslint
```

### Codex

#### Codex CLI
```bash
codex plugin marketplace add minkyet/spyglasslint
codex plugin add spyglasslint@spyglasslint-marketplace
```

#### Codex App (GUI)
1. In the Codex App - open **Plugins** from the sidebar.
2. Click the arrow next to Create, then select Add marketplace.
3. Enter:
   - **Source**: `minkyet/spyglasslint`
   - **Git ref**: `main`
   - **Sparse paths**: (leave blank)
4. Click **Add marketplace**, select **spyglasslint** plugin from list and install.
5. Restart Codex.

### Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/minkyet/spyglasslint
```

---

### Link/Install as a standalone CLI tool

To use the `spyglass-lint` CLI command directly from the terminal:

```bash
npm link
```

## Usage

### MCP Usage

MCP tools are automatically registered to the agent session after the SpyglassLint plugin is installed and activated.

| MCP Tool | description | parameters |
| :--- | :--- | :--- |
| `spyglass_diagnose_file` | file-level syntax, mcdoc/NBT schemas, and real-time diagnostics for symbol reference errors. | `file_path`, `content` (optional) |
| `spyglass_analyze_project` | full inspection of AST and cross-references (function calls, tags, etc.) for all files within the datapack. | none |
| `spyglass_restart_server` | restart LSP process and reload `spyglass.json` / `pack.mcmeta` setting. | none |
| `spyglass_get_status` | retrieve LSP server readiness status, target Minecraft version, and workspace information. | none |

### CLI Usage

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


## Prerequisites

- **Node.js**: v18.0.0 or later
- **VS Code Extension**: [Datapack Helper Plus](https://marketplace.visualstudio.com/items?itemName=spgoding.datapack-language-server) installed in VS Code, Cursor, or VSCodium (or specify custom path via `SPYGLASS_SERVER_PATH` environment variable)


## License

MIT License
