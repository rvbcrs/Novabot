# cloud-api — frozen tree

This directory is the server's replica of the LFI cloud API. It is consumed by
the official Novabot mobile app. Any change to a response shape or a critical
field value breaks devices in the field.

## Rules

1. **No shared imports with OpenNova.** Files here MUST NOT import from
   `src/routes/dashboard*`, `src/routes/admin*`, or `src/routes/setup*`.
   Dashboard/admin/setup MUST NOT import from `cloud-api/serializers` or
   `cloud-api/helpers`. Enforced by ESLint.

2. **Explicit field picks.** Serializers return objects where every field is
   named explicitly. No `...row`, no `Object.assign(row, …)`. A new DB column
   must not appear in the wire response unless the developer deliberately adds
   it here.

3. **Zod schema per DTO.** Every response DTO is defined as a Zod schema; the
   `rowToCloudDto` function returns `z.infer<typeof schema>`. Contract tests
   call `schema.parse(response.body)` to catch drift.

4. **CHANGELOG mandatory.** Every PR that touches `cloud-api/**` MUST add a
   dated entry to `CHANGELOG.md`. The pre-commit hook blocks commits that
   violate this.

5. **Fixtures live with tests.** `__tests__/fixtures/*.local.json` is the
   current-server snapshot (regenerated via `server/scripts/capture-fixtures.mjs`).
   `*.lfi.json` is the LFI-cloud reference for the 5 hot endpoints.

## Refreshing fixtures

```
cd server
node scripts/capture-fixtures.mjs --target=local   # writes *.local.json
node scripts/capture-fixtures.mjs --target=lfi     # writes *.lfi.json (needs LFI creds in env)
```

Fixtures must be committed together with any CHANGELOG entry that describes
why the shape changed.
