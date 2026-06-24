# Contributing

## Verification

```bash
bun run lint
bun run check
bun test
```

The test suite drives the engine through an in-process fake harness, so it spawns no host CLI and
spends no model tokens.
