# Fixtures

These fixtures are **built by hand from each provider's documented response format**
(links in `packages/core/src/sources/registry.ts`). They are **not live responses**: the
build environment blocked network access to these providers on 2026-10-23.
They check that our parsers follow the documented schema. Live schema matching
is done by `npm run probe`, which saves real samples to `data/runtime/probe/`.
