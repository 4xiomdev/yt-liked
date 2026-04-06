# Contributing

Thanks for taking a look at `ytl`.

## Current Scope

The project is intentionally focused on an archive-first workflow:

- import an existing YouTube likes archive
- classify it locally
- search and inspect it from the terminal

`ytl sync` is still exploratory. Please avoid presenting it as production-ready unless the implementation meaningfully changes.

## Development

```bash
npm install
npm run build
npm test
```

Link the local binary while iterating:

```bash
npm link
ytl --help
```

## Design Notes

- Keep storage local-first
- Keep classification explicit about which engine is being used
- Prefer small, understandable command flows over provider abstraction
- Preserve the current YouTube-red terminal identity rather than copying FT verbatim

## Pull Requests

- include tests for behavior changes where practical
- keep README/help output aligned with actual command behavior
- call out anything that changes the experimental sync story
