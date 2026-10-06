# SpyglassLint Agent Guardrails

These rules define the guardrails for agent behavior when writing and statically verifying Minecraft datapack code while the `spyglasslint` plugin is active.

## 1. Mandatory Static Verification & Diagnostics
1. **Diagnose Single Files Immediately After Changes**:
   - After creating or modifying any datapack `.mcfunction` or `.json` file, always call the MCP tool `spyglass_diagnose_file` to validate mcdoc schemas and NBT field casing.
   - NBT field casing errors (e.g., `Width` vs. `width`) are silently ignored by Minecraft at runtime and can only be caught statically ahead of time using Spyglass's mcdoc type checker.
2. **Project-Wide Integrity Analysis**:
   - Before completing tasks, finishing multi-file refactoring, or committing changes across functions and tags, always call `spyglass_analyze_project` to ensure there are no broken function calls, missing tags, undeclared symbols, or schema mismatches across the entire datapack.
3. **Reflect Configuration & Version Updates**:
   - Whenever `spyglass.json` or `pack.mcmeta` game version configurations are modified, call `spyglass_restart_server` to immediately reload and apply the updated settings to the language server daemon.
