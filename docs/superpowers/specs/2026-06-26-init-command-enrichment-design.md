# Init Command Enrichment Design

## Goal

Make `jawfish init` the fastest path from a fresh machine or project to usable
Jawfish state, while keeping the command memorable and avoiding syntax-heavy
flows.

## Scope

Enrich `jawfish init` only. Keep existing add/install/import/list/update/remove
behavior intact except where init reuses existing helpers.

`jawfish init <repo>` becomes invalid. Repository choice moves into the
interactive flow.

## Command Surface

`jawfish init`

Runs an interactive setup flow. The flow is state-aware:

- If machine setup is missing, run machine setup.
- If machine setup exists, ask whether to set up this project or reinitialize
  machine setup.
- If `jawfish.json` already exists in the project, ask whether to add/update
  project items or reinitialize machine setup.

`jawfish init -y` / `jawfish init --yes`

Runs without prompts:

- If machine setup is missing, create minimum machine setup.
- If machine setup exists, create a project manifest if missing.
- Never import skills or install selected items.

Unsupported options and positional arguments fail with `Usage: jawfish init
[options]`.

## Machine Setup

Machine setup creates the minimum usable state:

- `~/.jawfish/config.json`
- `defaultTool`
- local skills repo at `~/.jawfish/agentics`
- repo `.gitignore`
- global manifest at `~/.jawfish/jawfish.json`

Interactive machine setup asks:

1. Select default tool.
2. Use an existing skills repo?
   - No, create local repo (default).
   - Yes, enter local path or git URL.
3. Inspect linked repo and show what Jawfish can see.
4. If registered items exist, optionally install multiple starter items globally.
5. Optionally import existing global skills at the end.

If the linked repo is empty, offer import before starter selection so imported
skills can be installed during the same setup.

The flow does not create GitHub repositories, manage branches in UI, or ask
branch questions.

## Machine Reinitialize

Machine reinitialize is an edit menu, not a full wipe:

- change default tool
- change skills repo link
- install global starter items
- import existing global skills

It shows current config before prompting. It does not delete repo contents or
managed installs unless existing lower-level install/import behavior already
does that for selected items.

## Project Setup

Project setup requires minimum machine setup first. If missing, init performs
machine setup before continuing.

Project setup:

1. Inspect the configured skills repo.
2. Show registered skills, agents, and prompts.
3. Warn about visible unregistered or malformed candidates.
4. Multi-select registered items to add/update in the current project.
5. Install selected items with the configured default tool.
6. Write/update project `jawfish.json`.

Existing project manifest items are preselected. Deselecting an item does not
remove it; project init only adds or updates.

If no registered items exist, print that the repo is empty and suggest adding or
importing items, then exit successfully after ensuring `jawfish.json` exists.

## Repo Inspection

Add reusable repo inspection for both linked-repo setup and project setup.

Inspection reports:

- registered entries from `index.json` or legacy `catalog.json`
- counts by type: skills, agents, prompts
- item names visible to selection flows
- broken registered entries, such as missing paths or invalid files
- unregistered-looking repo entries, with concise reasons

Inspection is observability only. It does not auto-register missing items.

Output should answer:

- what Jawfish can see
- what it cannot use
- why likely misses were skipped

## Noninteractive Defaults

For `jawfish init -y` with no machine config:

- use `JAWFISH_DEFAULT_TOOL` when present
- otherwise use the first supported tool
- use `JAWFISH_AGENTICS_REPO` when present
- otherwise create/use `~/.jawfish/agentics`
- create an empty global manifest
- do not import or install starters

For `jawfish init -y` with machine config:

- create project `jawfish.json` if missing
- do not install anything

## Code Organization

Move init-specific behavior into `src/init-command.ts`.

Keep shared lower-level helpers reusable from `src/main.ts` or extracted modules
as needed:

- config load/save
- repo resolution/setup
- catalog read/write
- manifest read/write
- materialization/install
- provider import planning/apply

Avoid broad CLI refactors outside what init needs.

## Documentation

Update user-facing documentation for the new init flow:

- README quick start
- README command table
- README init examples
- command help text

Do not add or update developer reference docs for this change.

## Error Handling

Errors should be concrete and recoverable:

- invalid positional args: usage
- invalid default tool: supported tools list
- invalid repo URL/path: failing git/path operation surfaced clearly
- invalid catalog: show invalid catalog path and entry issue
- unmanaged install conflict: preserve existing conflict behavior

Canceled interactive prompts exit without partial destructive changes.

## Testing

Add integration coverage for:

- `jawfish init <repo>` rejects positional args
- `jawfish init -y` creates minimum machine setup with env defaults
- `jawfish init -y` creates project manifest when machine setup exists
- first interactive machine setup with local repo
- first interactive machine setup with existing repo
- empty repo import-before-starter branch
- nonempty repo starter global install
- project init installs selected registered entries
- existing project manifest entries are preselected and not removed by omission
- repo inspection reports registered counts and unregistered-looking misses
- machine reinitialize edit menu updates default tool or repo link

Success criteria:

- `bun run test` passes
- `bun run typecheck` passes
- user-facing init docs match the new flow
