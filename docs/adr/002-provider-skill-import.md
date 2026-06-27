# ADR 002: Provider Skill Import

## Status

Draft

## Context

Jawfish can import one local path or URL with `jawfish add <source>`, but users
who already use Codex, Claude Code, Hermes, OpenClaw, OpenCode, or Pi may have
many global skills. One-at-a-time import is too slow for onboarding.

ADR 001 says supported tools are internal capability. Migration import should
scan only supported tools and should not imply arbitrary provider support.

## Decision

Add a provider skill import command that scans a supported tool's global skill
directory, copies selected skills into the agentics repo, records them in the
catalog, and adopts them into the global manifest.

Candidate command:

```sh
jawfish import-skills <provider>
```

MVP choices:

- Use `import-skills`, not `migrate`, because migration sounds broader than
  importing existing skills into Jawfish.
- Require a provider argument.
- Scan global provider directories only.
- Support all supported tools: `codex`, `claude-code`, `hermes`, `openclaw`,
  `opencode`, and `pi`.
- Import skills only. Agents and prompts are future work.
- Default to preview, then ask for confirmation.
- Support `-y`/`--yes` to import without prompting.
- On catalog name conflicts, skip by default and show the existing catalog
  entry. Rename/overwrite can be added later.

Scope clarification:

- The top-level `jawfish import-skills <provider>` command scans global provider
  directories only.
- Interactive `jawfish init` can discover both global and current-project source
  provider skills because init is already setting up machine and project state;
  selected imports are recorded into the matching manifest scope.

## Expected Flow

1. Resolve config and agentics repo.
2. Resolve the source provider's global skill directory.
3. Discover importable skills.
4. Show names, types, collisions, and skipped items.
5. With confirmation or `--yes`, import selected skills into the content
   agentics repo.
6. Update catalog.
7. Update global manifest and adopt the existing global skill files as managed.

## Consequences

Users can bootstrap Jawfish from existing provider installs quickly.

Provider skill import introduces collision handling, provider-specific
discovery, and bulk catalog writes. The command needs clear skip reasons and a
stable preview output before writes are allowed.

Future work can add project source directories, agents, prompts, conflict
renames, overwrites, and source-to-target tool rematerialization.
