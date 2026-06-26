# CLI Edge Cases Design

## Goal

Make Jawfish CLI behavior reliable across common user stories, especially when
agentics repo, manifest, project installs, global installs, provider imports, and
source imports disagree.

## Scope

Cover all current commands:

- `init`
- `add`
- `install` / `i`
- `import-skills`
- `list`
- `update`
- `remove`
- `upgrade`

Do not redesign provider adapters or storage formats unless tests expose a bug
that cannot be fixed locally.

## Approach

Use a command/state matrix, then add tests before fixes. The important state axes
are:

- agentics repo missing, empty, local git, or remote-backed git
- catalog entry exists or is missing
- project manifest entry exists or is missing
- global manifest entry exists or is missing
- destination files exist, are managed, are unmanaged, or are partly stale
- package source is a repo entry name, local path, URL file, or URL directory
- default tool differs from the original installed tool
- command targets project scope or global scope

## Expected Behaviors

`add <name>` installs a catalog entry into the selected scope and records only
that scope's manifest. Existing global installs do not imply project install,
and existing project installs do not imply global install.

`add <source>` imports the source into the agentics repo if absent, then
installs it into the selected scope. If the same source is already imported, the
command installs the existing repo package into the requested scope without
duplicating catalog entries.

`install` with no target materializes the selected scope's manifest only. Missing
catalog entries fail clearly. Managed files may be replaced and stale managed
files removed. Unmanaged destination conflicts abort without data loss.

`import-skills <provider>` imports global provider skills only, skips catalog
name conflicts, adopts imported global skills as managed, and writes the global
manifest. Empty provider dirs and unsupported providers produce clear output.

`list` reports catalog entries and install status from project/global manifests.
Ghost manifest entries not in the catalog are not listed. Filters compose
predictably.

`update [name]` refreshes upstream-backed catalog packages, preserves unmanaged
destination files, and reinstalls updated packages only in the selected scope.
Non-upstream packages are skipped in bulk and rejected clearly by name.

`remove <name>` removes only managed files for the selected scope, preserves
unmanaged files, and removes only that scope's manifest entry.

`init` is idempotent, creates or connects the agentics repo, and rejects the
old nested managed repo path.

`upgrade` delegates to the package-manager command and rejects unrelated options.

## Test Plan

Add integration tests for realistic stories:

- install same catalog package to project and global, then remove one scope
- install source once to project, then same source to global
- manifest references missing catalog package
- destination missing files but manifest exists
- managed destination has stale files and unmanaged extra files
- unmanaged destination conflicts with incoming source file
- import provider skills with empty dir, valid dir, conflict, and managed adoption
- update named upstream package, bulk update, skipped non-upstream package, and
  selected-scope reinstall
- list empty catalog, ghost manifest entries, project/global/both/none filters
- invalid options for each command reject with usage or clear error

## Success Criteria

`bun run test` and `bun run typecheck` pass. Tests describe behavior before each
fix. No unrelated staged changes are reverted.
