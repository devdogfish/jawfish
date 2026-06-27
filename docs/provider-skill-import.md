# Provider Skill Import Notes

## MVP

Command:

```sh
jawfish import-skills <provider>
jawfish import-skills <provider> -y
jawfish import-skills <provider> --yes
```

Command scope:

- Source: global provider skill dirs only.
- Providers: all supported tools.
- Type: skills only.
- Default: preview, then skill selection prompt.
- Writes: require skill selection or `-y`/`--yes`.
- Target: agentics repo plus global `jawfish.json`.
- Adoption: imported global files become Jawfish-managed.
- Conflicts: skip existing catalog names and report them.

Init scope:

- Interactive `jawfish init` can discover global and current-project provider
  skills.
- Duplicate discovered names are conflicts because the catalog is keyed by
  agentic name.

## Rationale

`migrate` is too ambiguous. This feature imports existing skills into Jawfish; it
does not move the user from one provider to another or promise full provider
conversion.

Preview plus selection is better because global provider dirs may contain
personal, stale, or experimental skills. Bulk writes should be explicit, and
`-y`/`--yes` gives scripts a fast path.

## Future Work

- Project provider dirs for `jawfish import-skills <provider>`.
- Agents and prompts.
- Rename or overwrite conflict modes.
- `--from` and `--to` rematerialization between providers.
- JSON preview output for scripting.
