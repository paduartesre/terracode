# Maintainer guide / Guia do mantenedor

## Pull request validation

`TerraCode CI` runs on pull requests, pushes to `main`, and manual dispatch. It uses Ubuntu 24.04 and Node.js 24.22.1, with locked dependencies and commit-pinned actions. Its token has read-only repository access. No cloud credentials are passed to contribution tests.

Checks: build/type checking, lint, frontend tests, backend tests, isolated live API tests,. The backend suite uses fake CLI fixtures; the API suite uses an isolated local directory. These checks do not provision cloud infrastructure or prove that every provider login works.

Run locally:

```bash
npm ci
npm run build
npm run lint
npm run test:coverage
npm run test:server
npm run test:integration
npm run report:ci
```

The integration command starts and stops its own API; port 3001 must be free. The existing `npm test` command still includes the API integration suite and expects an API already running.

The job summary links to `coverage-and-tests` (HTML coverage, LCOV, JSON results and JUnit) and `validation-report` (concise JSON). Artifacts expire after 14 days. Failed checks stay failed; reporting steps do not override them.

### Initial coverage

All frontend TypeScript/TSX application files are included, even when untested; tests and test setup are excluded. Backend coverage measures `server.cjs` with the backend suite. Live API tests run in a separate process and are not added to that percentage.

| Area | Lines measured | Line minimum | Statement minimum | Function minimum | Branch minimum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Frontend | 19.59% | 19% | 18% | 14% | 12% |
| Backend | 88.24% | 88% | 85% | 92% | 74% |

These initial floors make the current coverage visible and prevent larger regressions; they are not a claim of comprehensive coverage. Improve frontend coverage as the project evolves. For every PR, inspect the changed files and meaningful assertions, including errors and permissions. Do not lower thresholds or exclude application files to make a change pass. CI does not decide whether a feature belongs in the product and never approves or merges PRs automatically.

## Português (Brasil)

A CI valida build/tipos, lint, testes do frontend e backend, API local isolada. Consulte o resumo da execução e os artefatos antes de revisar e aceitar um PR. Os mínimos de cobertura refletem a base atual; a cobertura do frontend ainda precisa crescer. Aprovação e merge continuam sendo decisões do mantenedor.


