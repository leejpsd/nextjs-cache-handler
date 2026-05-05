# Contributing

Thank you for considering a contribution. This package is small and
deliberately scoped, so please open an issue describing the change
before sending a PR if it's larger than a typo or test fix.

## Local development

```bash
git clone https://github.com/leejpsd/nextjs-cache-handler.git
cd nextjs-cache-handler
npm install

npm run typecheck
npm run test:unit
npm run build
```

## Adding a changeset

Every code-changing PR must include a [changeset](https://github.com/changesets/changesets):

```bash
npx changeset
```

Pick `patch`, `minor`, or `major` per [SemVer](https://semver.org). The
generated `.changeset/*.md` is human-edited prose that ships in the
release notes.

## Testing your change

- **Unit**: `npm run test:unit` — 60+ tests, fully mocked Redis
- **Build verification**: `npm run build && npx attw --pack . && npx publint`
- **Dogfood** (recommended for behavioral changes): swap the in-tree
  handlers in [`next-redis-cache-demo`](https://github.com/leejpsd/next-redis-cache)
  with this package via `npm link` and run that project's `npm run build` /
  `npm test` / `npm run test:e2e:consistency-sim`.

## Code style

- TypeScript strict, `exactOptionalPropertyTypes: true`,
  `noUncheckedIndexedAccess: true`
- ESLint via `npm run lint`. Run `npm run lint:fix` for autofixes.
- Prettier defaults (`.prettierrc.json`)

## Coverage thresholds

- Lines ≥ 90%, branches ≥ 85%, functions ≥ 90%, statements ≥ 90%.
- CI fails below thresholds.

## Spec drift

The Next.js 16 cache handler spec is captured in
[`docs/next16-spec.md`](./docs/next16-spec.md). When the upstream docs
change, update that file **first**, then propagate to code. CI prints a
SHA of the spec snapshot on every run to detect silent drift.

## Code of Conduct

Be kind. The project follows the spirit of the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Personal attacks or harassment are not tolerated.
