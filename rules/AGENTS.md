# Minecraft Datapack Agent Guardrails

These rules define the guardrails for agent behavior when planning, writing, and statically verifying Minecraft datapack code with the `datapack-mcp` plugin active.

## 1. Pre-Generation: Specification & Version Retrieval (MineCode MCP)
Before writing or generating any datapack files, verify target version constraints to prevent LLM hallucination:
1. **Start Datapack Session First**:
   - At the beginning of a datapack task, call `minecraft_start_session` (or `detect_pack_version`) to identify the target Minecraft version from `pack.mcmeta`.
   - Check breaking changes (e.g., 1.20.5 component NBT change, 1.21 singular folder rename `advancement/`, 1.21.2 attribute IDs).
2. **Retrieve Command Syntax Before Writing**:
   - Query `get_command_usage` or `validate_command` before authoring complex commands with arguments to ensure version-exact Brigadier syntax.
3. **Inspect Vanilla JSON Presets**:
   - Call `misode_get_preset_data` or `misode_get_loot_tables` to obtain real vanilla JSON structures before constructing loot tables, recipes, or dimension/worldgen JSON.

## 2. Post-Generation: Mandatory Static Verification (SpyglassLint MCP)
Immediately after writing or modifying datapack files, statically verify correctness:
1. **Diagnose Single Files Immediately After Changes**:
   - After creating or modifying any `.mcfunction` or `.json` file, always call `spyglass_diagnose_file` to validate syntax, mcdoc schemas, and NBT field casing.
   - NBT field casing errors (e.g., `Width` vs. `width`) are silently ignored by Minecraft at runtime and can only be caught statically ahead of time using Spyglass's mcdoc type checker.
2. **Project-Wide Integrity Analysis**:
   - Before completing tasks, finishing multi-file refactoring, or committing changes across functions and tags, always call `spyglass_analyze_project` to ensure there are no broken function calls, missing tags, undeclared symbols, or schema mismatches across the entire datapack.
3. **Reflect Configuration & Version Updates**:
   - Whenever `spyglass.json` or `pack.mcmeta` game version configurations are modified, call `spyglass_restart_server` to immediately reload and apply the updated settings to the language server daemon.

