# Community executable distribution

The community source, issues, and executable releases belong in [paduartesre/terracode](https://github.com/paduartesre/terracode). Executables are an optional installation method; publish each package only after platform validation and confirmation of its corresponding source. Community participation is voluntary, free of charge, and unpaid.

## Tester package

The Linux x64 `.tar.gz` contains only:

- `terracode`: Node.js runtime, V8 bytecode backend, and built browser assets in one executable.
- `LEIA-ME.txt` / `README.txt`: Portuguese and English startup instructions.
- `FEEDBACK.txt`: usability questions and support email.
- `demo.tf.example`: a cloud-free Terraform example.
- `BUILD-INFO.json`, `SHA256SUMS`, and `THIRD-PARTY-NOTICES.txt`.
- `LICENSE` (AGPLv3) and `SOURCE.txt` pointing to the exact corresponding source and build instructions.

No Git history, original application sources, `node_modules`, or source maps are bundled in the executable archive. The corresponding source is provided separately through the GitHub version recorded in `SOURCE.txt`; the executable is an installation convenience, not a restriction on access to the source. Browser JavaScript remains inspectable.

This artifact targets Linux x64 with glibc (including Ubuntu 24.04 / Ubuntu in WSL2). Native Windows, macOS, ARM64 and Alpine builds are not included or validated. Node.js and npm are not required by testers. Git, Terraform and optional provider CLIs remain local prerequisites; Terraform is not redistributed.

## Build from source

Use Linux x64 and **Node.js v24.22.1**. Compiler and embedded runtime must match because V8 bytecode is runtime-specific. The packaging dependencies are pinned in `package-lock.json`.

```bash
npm ci
NODE_LICENSE_FILE=/absolute/path/to/node-v24.22.1/LICENSE npm run package:pilot
PILOT_TEST_TERRAFORM=/absolute/path/to/terraform npm run test:pilot
```

Use the LICENSE from the matching official Node.js distribution. The builder requires it so runtime notices are not omitted. The builder type-checks, generates the Vite production output, bundles the backend and its dependencies, compiles that bundle with Bytenode, injects the bytecode and web assets into the runtime using Node SEA, and creates an allowlisted archive under `release/`.

`PILOT_SOURCE_COMMIT` may override the default `git rev-parse HEAD` when building from a verified export. Set it to the full commit that contains the packaging implementation. Do not relabel an artifact with a different SHA after building it.

For a public release, build from the final commit in the GitHub repository. Before publishing, verify that `SOURCE.txt` and `BUILD-INFO.json` identify the exact source used to build the executable and that those source files and build instructions are accessible to its recipients. The builder records the link but does not verify remote availability. Include the matching Node.js distribution license and preserve all third-party notices.

The smoke test copies only the executable into a fresh temporary directory, uses an isolated HOME and a PATH without Node.js, then checks web assets, file operations, path boundaries, a local Git commit, real Terraform commands on the built-in `terraform_data` example, port-conflict handling and shutdown. It does not access cloud accounts.

## Distribution and review

After validation, publish executables through [GitHub Releases](https://github.com/paduartesre/terracode/releases) with their matching source and build instructions.

Start with the included demo, then an authorized test project. Ask each tester whether they installed without help, what task they attempted, what was useful/confusing and whether they would use TerraCode again. Never collect credentials, state or client data. There is no automatic telemetry, feedback upload or updater added by the packaging layer.

The executable listens on loopback ports 5173 (interface) and 3001 (API). Existing CORS restrictions and file-root controls remain in effect. It deliberately overrides HOST/PORT for this distribution to avoid unintentionally exposing the local API. Cloud logins and paid integrations still depend on the user's environment and are outside the cloud-free smoke test.

TerraCode is licensed under [AGPL-3.0-only](../LICENSE), Copyright (c) 2026 Pedro Duarte. Distribution, modification, and commercial use follow that license, including the corresponding-source obligations. Contributions follow [CONTRIBUTING.md](../CONTRIBUTING.md); no source-project invitation is required after the GitHub launch.

## Português (Brasil)

O GitHub é o canal comunitário de código, issues e releases. Executáveis são uma opção de instalação e cada pacote exige validação da plataforma e acesso ao código correspondente. A participação é voluntária, gratuita e sem remuneração. Use `LEIA-ME.txt` e `FEEDBACK.txt` para instalação e retorno dos testes.

O pacote inclui runtime, backend em bytecode, interface compilada, exemplo local, instruções, checksum, avisos de terceiros, `LICENSE` e `SOURCE.txt`. Os fontes são disponibilizados separadamente na versão exata do GitHub identificada no pacote. Não inclui histórico Git, `node_modules` nem source maps. O JavaScript do navegador continua inspecionável. A licença é AGPL-3.0-only.

O alvo atual é Linux x64 com glibc, como Ubuntu 24.04 e Ubuntu no WSL2. Windows nativo, macOS, ARM64 e Alpine não estão incluídos. Git, Terraform e CLIs opcionais permanecem instalados no ambiente do usuário. Antes da release pública, gere o pacote a partir do commit final no GitHub e confira se o código e as instruções apontados em `SOURCE.txt` estão acessíveis aos destinatários. O script grava o link, mas não valida sua disponibilidade remota. Preserve as licenças do runtime e dos demais componentes. As instruções de build e validação estão acima.

References: [Node SEA](https://nodejs.org/download/release/v24.22.1/docs/api/single-executable-applications.html), [Bytenode](https://github.com/bytenode/bytenode).
