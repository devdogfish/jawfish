# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists - it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** - read ADRs that touch the area you're about to work in.

If any of these files don't exist, proceed silently.

## File structure

Single-context repo:

```txt
/
|-- CONTEXT.md
|-- docs/adr/
`-- src/
```

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`. If the concept is missing, note the gap.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding.
