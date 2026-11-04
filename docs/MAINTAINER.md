# Maintainer guide / Guia do mantenedor

## Pull request validation

`TerraCode CI` runs on pull requests, pushes to `main`, and manual dispatch. It uses Ubuntu 24.04 and Node.js 24.22.1, with locked dependencies and commit-pinned actions. Its token has read-only repository access. No SMTP or cloud credentials are passed to contribution tests.

Checks: build/type checking, lint, frontend tests, backend tests, isolated live API tests, and notification safety tests. The backend suite uses fake CLI fixtures; the API suite uses an isolated local directory. These checks do not provision cloud infrastructure or prove that every provider login works.

Run locally:

```bash
npm ci
npm run build
npm run lint
npm run test:coverage
npm run test:server
npm run test:integration
python3 -m unittest discover -s scripts -p 'test_notify_ci.py'
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

## Email reports

The separate `CI email report` workflow runs after CI completes and sends results to **pedroduarte@terracodeiac.com**. It checks out the trusted workflow revision only, never a pull request's code. It reads bounded JSON from the report artifact as data, never executes it, and never forwards the GitHub credential to artifact storage.

In repository **Settings → Secrets and variables → Actions**, add these repository secrets using the actual mail provider's SMTP settings:

| Secret | Value |
| --- | --- |
| `SMTP_HOST` | SMTP hostname of the provider that hosts the mailbox |
| `SMTP_PORT` | `465` for implicit TLS or `587` for STARTTLS; defaults to `465` |
| `SMTP_USERNAME` | Sending mailbox address, normally `pedroduarte@terracodeiac.com` |
| `SMTP_PASSWORD` | SMTP password or provider-issued app password |

Do not put these values in files, issues, PRs or chat. Domain registration at a provider does not by itself identify where email is hosted. The recipient is fixed in trusted code and cannot be overridden by a contributor's artifact.

Without the required secrets, the email job explicitly reports **Email delivery pending** and sends nothing. After configuration, run CI and confirm delivery to the mailbox; repository configuration alone does not prove delivery. GitHub's normal notification preferences are separate. SMTP delivery failures fail the email workflow and do not change the CI result.

## Repository configuration

Before public launch, set the repository About description, homepage `https://terracodeiac.com`, and topics such as `terraform`, `devops`, `sre`, `platform-engineering`, and `infrastructure-as-code`.

Protect `main`: require pull requests, the **Build, tests and coverage** status check from this repository's GitHub Actions app, and resolution of conversations. Keep force pushes and deletion disabled. Since this project has one maintainer, do not require approval from a second maintainer who does not exist. Review workflow, notification, dependency and coverage-policy changes personally. Rules availability depends on GitHub plan and visibility; confirm that the rule is enforced.

Use forks and pull requests for public contributions. Keep the private GitLab development repository separate. Do not set up an automatic reverse sync that overwrites GitHub contributions.

## Executable releases

No executable is published by CI. Build a release from the final GitHub commit, follow [PILOT-BUILD.md](PILOT-BUILD.md), verify its source/build links and license, and validate its platform before uploading it. Never re-label a previously built private pilot artifact with a new commit. Public availability of source code does not require a binary for every platform.

## Português (Brasil)

A CI valida build/tipos, lint, testes do frontend e backend, API local isolada e segurança do envio de notificações. Consulte o resumo da execução e os artefatos antes de revisar e aceitar um PR. Os mínimos de cobertura refletem a base atual; a cobertura do frontend ainda precisa crescer. Aprovação e merge continuam sendo decisões do mantenedor.

Para receber o relatório completo em **pedroduarte@terracodeiac.com**, configure os secrets SMTP indicados acima no GitHub. Sem eles, o workflow mostra **Email delivery pending** e não envia mensagens. Use os dados do provedor real da caixa postal, mantenha-os fora do código e confirme uma entrega de teste após configurar. Credenciais de e-mail nunca ficam disponíveis aos testes de PRs.

Proteja a `main` com PR e o check **Build, tests and coverage**, mantendo bloqueados force push e exclusão. Não exija aprovação de outro mantenedor enquanto o projeto tiver apenas um. A revisão humana deve conferir comportamento, testes relevantes, permissões, dependências e lacunas de cobertura.

