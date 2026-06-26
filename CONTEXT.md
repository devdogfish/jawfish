# Jawfish Domain

Jawfish is a package manager for reusable agentics: skills, agents, and prompts.

## Glossary

- **Agentic**: A reusable skill, agent, or prompt package managed by Jawfish.
- **Agentics repo**: Git-backed source directory containing the agentic catalog and package files.
- **Supported tool**: A tool Jawfish knows how to materialize agentics for. This is product capability, not user configuration.
- **Default tool**: The user's preferred supported tool for new installs when no tool is otherwise recorded.
- **Manifest**: A `jawfish.json` file recording installed agentics and their target tool for a project or global scope.
- **Scope**: Install target location, either `project` or `global`.
- **Source provider**: A supported tool whose existing local agentics are scanned for migration.
- **Migration import**: Bulk import from a source provider into the agentics repo, then optional materialization into a Jawfish manifest.
- **Discovered agentic**: An existing local skill, agent, or prompt found during migration before it is recorded in the catalog.
