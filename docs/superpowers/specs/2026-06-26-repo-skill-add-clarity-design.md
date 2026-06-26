# Repo Skill Add Clarity Design

## Goal

Make `jawfish add <skill source>` feel clearly successful when the source repo contains more skills, without changing the current workflow much.

## Behavior

When a direct skill URL/path is added, Jawfish should lead with the installed skill result:

```text
Added focus to project
```

If Jawfish also detects sibling repo skills, print one short follow-up line instead of making the discovered skills list the dominant output:

```text
Also found 2 repo skills. Run jawfish add <repo> to choose them.
```

Do not repeat the added skill in multiple output blocks.

## Config

Add machine config option:

```json
{
  "autoScanRepoSkills": false
}
```

Default is `true` to preserve current behavior.

When `autoScanRepoSkills` is `false`, direct skill URL/path adds import only that direct skill. Explicit repo-root adds still scan because the user directly asked to add a repo.

## Implementation Notes

Extend `JawfishConfig` read/write handling to preserve `autoScanRepoSkills`.

Gate repo-source scan in `addCommand`:

- direct skill source + `autoScanRepoSkills: false`: use single-package import path
- repo root source: use repo skill candidate selection
- default/missing config: current behavior

Adjust CLI output for direct skill add from repos so success is the first clear result and sibling discovery is summarized.

## Tests

Add focused CLI coverage:

- config false with a direct repo skill path imports only that skill
- sibling repo skill is not installed
- stdout clearly includes `Added <name> to project`
- README documents the option
