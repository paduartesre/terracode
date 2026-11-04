# TerraCode — Community Edition

[Português (Brasil)](README.pt-BR.md) · [GitHub](https://github.com/paduartesre/terracode) · [Project website](https://terracodeiac.com) · [Contact](https://terracodeiac.com/#contact)

A local workspace for editing configuration, running Terraform, and inspecting Git changes and infrastructure in one interface.

TerraCode runs a React frontend in your browser and a Node.js backend on your machine. Commands use your local Terraform, Git, and, when needed, cloud CLI installations. The presentation website does not execute these commands.

> TerraCode Community Edition is free software under [GNU AGPLv3](LICENSE). Source code, issues and contributions are maintained at [paduartesre/terracode](https://github.com/paduartesre/terracode).

## 1. Prerequisites

This guide uses Bash commands. Run them on Linux, macOS, or a Linux distribution in WSL2. Native Windows execution was not validated for this guide. Install Node.js, Git, and Terraform in the environment where the backend will run.

| Tool | Purpose |
| --- | --- |
| Node.js 24.x with npm | Install and run TerraCode. This release line satisfies the requirements of the dependencies in the reviewed lockfile. |
| Git CLI | Clone the repository and use the Git panel. |
| Terraform CLI | Run infrastructure commands. Select the version required by your project. The included example requires Terraform 1.4 or later. |
| An up-to-date browser | Open the local interface. |

Install the tools using the official [Node.js](https://nodejs.org/en/download) and [Terraform](https://developer.hashicorp.com/terraform/install) instructions for your operating system and architecture. No cloud account is needed for the first example.

Verify the installations in the terminal you will use to start TerraCode:

```bash
node --version
npm --version
git --version
terraform version
```

AWS CLI (`aws`), Azure CLI (`az`), and Google Cloud CLI (`gcloud`) are only required for their respective in-app login flows. `tfenv` and Infracost are optional.

## 2. Install and start

From the directory where you keep your projects:

```bash
git clone https://github.com/paduartesre/terracode.git
cd terracode
npm ci
npm start
```

Clone the repository using the commands above. Do not embed tokens in the repository URL.

Prefer an executable? Packages will be listed under [GitHub Releases](https://github.com/paduartesre/terracode/releases) once validated and published. Check each release's supported operating system, architecture, instructions, and corresponding source version; an executable is not yet promised for every platform.

`npm ci` installs the dependencies from `package-lock.json`. `npm start` launches two processes in the same terminal:

| Process | Default address |
| --- | --- |
| Vite interface | `http://localhost:5173` |
| Express API | `http://localhost:3001` — binds to `127.0.0.1` by default |

Open `http://localhost:5173` and keep the terminal running. Press `Ctrl+C` in that terminal to stop the local session. Stopping TerraCode does not roll back infrastructure changes.

To use separate terminals, run `npm run server` in the first and `npm run dev -- --port 5173 --strictPort` in the second, both from `terracode`.

> The current frontend calls the API at `http://localhost:3001`. Keep ports 5173 and 3001 available. Vite automatically switching to port 5174 is incompatible with the API's current allowed browser origins.

## 3. Open a Terraform project

1. Click **Load Terraform project…** in the interface.
2. Enter the path of the folder containing your `.tf` files and click **Go**.
3. If the folder is outside the allowed roots, verify the path and select **Open this folder** when **Access denied** appears.
4. Select **Load this folder**.
5. Check the directory, Terraform version, workspace, and variable file before running commands.

Use paths that exist in the backend's environment. For a backend running inside WSL2, use the corresponding Linux path. A folder located only on another machine cannot be opened.

An explicitly loaded project determines where Terraform commands run. Opening a different file in the editor does not automatically replace that loaded project.

## 4. First run without a cloud account

Create a new demo directory. This command does not overwrite an existing project:

```bash
tc_demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/terracode-demo.XXXXXX")
cat > "$tc_demo_dir/main.tf" <<'HCL'
terraform {
  required_version = ">= 1.4.0"
}

resource "terraform_data" "demo" {
  input = "TerraCode local demo"
}

output "demo_message" {
  value = terraform_data.demo.output
}
HCL
printf 'Demo directory: %s\n' "$tc_demo_dir"
```

A copy is included in `examples/local-demo/main.tf` in this repository. `terraform_data` is a built-in Terraform resource; this example does not provision cloud resources.

Load the directory printed in your terminal, then:

1. Select **Init** to initialize the directory.
2. Select **Format** to format the `.tf` files.
3. Select **Validate** to validate the configuration.
4. Select **Plan** to inspect the planned creation of `terraform_data.demo`.
5. From the plan result, select **Save plan & prepare apply…** and confirm creation of a fresh `tf.plan`.
6. Select **Review saved plan** to inspect it.
7. Select **Apply saved plan** and explicitly confirm the apply.
8. Open **State** and **Outputs**. The `demo_message` output should show `TerraCode local demo`.
9. Run **Plan** again. With the unchanged example, the expected result is no pending changes.

To clean up this demo, first verify that the loaded directory is the demo directory. Select **Destroy…**, review its plan, and confirm **Apply destroy plan — delete resources**. This removes the resource from the demo's local state.

In real projects, **Apply** and **Destroy** can create, modify, or delete infrastructure and incur costs. Check the directory, workspace, backend, and execution plan before confirming.

## 5. Everyday use

| Area | Workflow |
| --- | --- |
| Working Tree and editor | Search and edit files; create files and folders. Saving modifies local files. |
| Terraform | Initialize, format, validate, and plan. Apply only after inspecting the saved plan. |
| Workspaces and variables | Check the selected workspace. Terraform automatically loads `terraform.tfvars` and `*.auto.tfvars`; other files can be selected in the interface. |
| Graph and Drift | Inspect resource dependencies and check configuration against infrastructure. Cloud projects may require credentials. |
| State and Outputs | Inspect resources and outputs. Importing, moving, or removing addresses are advanced state operations. |
| Git | Check the branch, diffs, and selected files before committing. Push, pull, and fetch use the Git authentication available on your machine. |
| Registry | Look up public modules using `namespace/name/provider`. Adding one writes a module block to `modules-registry.tf` in the loaded project. |
| Settings | Adjust code zoom, word wrap, font, and theme; register cloud credentials when needed. |

TerraCode does not replace operating system, remote repository, or cloud provider permissions.

## 6. Connect a cloud provider

For in-app login, install the relevant cloud CLI in the backend's environment. Open **Settings → Cloud credentials → Register credentials…**, enter the provider details, and create a passphrase of at least eight characters.

| Provider | Supported registration fields |
| --- | --- |
| AWS | Access key ID and secret access key; session token for temporary credentials and region when applicable. |
| Azure | Client ID, client secret, tenant ID, and subscription ID. |
| Google Cloud | Service account JSON; optional project ID. |

Next, open **Login** in the Terraform panel, unlock the credential store if prompted, and authenticate with the provider. Registering credentials alone does not create an authenticated session. Projects already using a CLI/provider's standard credential chain may continue to depend on that local configuration.

Registered credentials are stored encrypted at `~/.terraform-code/credentials.enc`. Unlocking holds a decrypted copy in server memory for a limited time, 15 minutes by default. **Logout** ends that provider's in-app session and stops its session credential injection into subsequent runs. It does not revoke provider keys or replace cloud CLI logout commands.

Do not include credentials, state files, execution plans, or logs containing sensitive data in support requests.

## 7. Optional tools and configuration

TerraCode detects `tfenv` at `~/.tfenv/bin`. It enables Terraform version installation and selection per project; selecting a version writes `.terraform-version`. Without tfenv, commands use `terraform` from `PATH`; version installation controls require tfenv.

For cost estimates, install Infracost and make `INFRACOST_API_KEY` available to the backend process. This feature is optional and depends on the Infracost service.

The backend reads environment variables from its process. It does not automatically load a `.env` file.

| Variable | Purpose / default |
| --- | --- |
| `BASE_DIR` | Primary allowed root; defaults to the TerraCode source directory. |
| `BASE_DIRS` | Additional roots separated by `:` on POSIX environments. |
| `TFENV_BIN` | Alternative tfenv binary directory. |
| `TFENV_DISABLE=1` | Ignore tfenv and use Terraform from `PATH`. |
| `TF_TIMEOUT_MS` | Terraform command timeout; defaults to `120000` ms. |
| `TF_CODE_CRED_DIR` | Credential store directory; defaults to `~/.terraform-code`. |
| `WATCH_FILES=0` | Disable external filesystem change notifications. |

Example, from the TerraCode repository:

```bash
BASE_DIR="/absolute/path/to/terraform-project" npm start
```

The folder must exist. Keep the service local: the current API performs file operations and executes commands; the multiuser layer envisioned for a future SaaS edition is not implemented here.

## 8. Troubleshooting

| Symptom | What to check |
| --- | --- |
| Clone denied | Check the GitHub URL and your network connection. |
| Unsupported Node version | Use Node 24.x in the terminal running `npm ci` and `npm start`. |
| Interface opens but files do not load | Ensure the API is running on port 3001. Both processes must remain active. |
| Interface started on port 5174 | Free port 5173 or use the `--strictPort` startup described above. |
| Terraform or a cloud CLI cannot be found | Check `terraform version` or the cloud CLI in the backend's terminal. Restart TerraCode after changing `PATH`. |
| Folder access denied | Verify the path and use **Open this folder**. Symlinks outside the allowed roots can also be rejected. |
| Cloud login unavailable or failing | Check the CLI installation, passphrase, credentials, and provider permissions. |
| File changed outside the editor | Reload and compare before saving; the API detects write conflicts. |
| A command timed out | Inspect the execution log and state before retrying: terminating the process does not guarantee a remote operation was rolled back. |

## 9. Update and check the project

Stop TerraCode, check `git status`, and preserve local changes before updating. If you are on `main` with no local changes or divergence:

```bash
git pull --ff-only
npm ci
npm start
```

CI runs build, lint, tests and coverage on pull requests. See the [maintainer guide](docs/MAINTAINER.md) for commands, coverage baselines and artifacts.

Existing contributor scripts are `npm run build`, `npm run lint`, and `npm test`. `tests/integration/terraform.test.ts` expects a running API at `http://localhost:3001`; start `npm run server` in another terminal before running `npm test`. The `server.test.mjs` backend suite has a separate configuration:

```bash
npx vitest run --config vitest.server.config.mts
```

## 10. Participate and get help

Use TerraCode, report issues, fork it, and propose improvements through [GitHub](https://github.com/paduartesre/terracode). See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow. No selection or invitation is required for community participation.

Community participation is voluntary, free of charge, and unpaid.

When reporting an issue, include your operating system, installation method, TerraCode version or commit, Terraform version, Node version if running from source, reproduction steps, expected behavior, and a sanitized error message. Use [GitHub issues](https://github.com/paduartesre/terracode/issues) for reproducible problems. For sensitive reports or direct inquiries, contact Pedro Duarte through [pedroduarte@terracodeiac.com](mailto:pedroduarte@terracodeiac.com), the [website](https://terracodeiac.com/#contact), or [LinkedIn](https://www.linkedin.com/in/duarpadevops).

The Community Edition is intended for local use. Enterprise SaaS, pipeline provisioning, multiuser governance, and enterprise security integrations are planned directions, not features available in this edition.

## 11. License and authorship

Copyright (c) 2026 Pedro Duarte. TerraCode is licensed under the [GNU Affero General Public License, version 3 only](LICENSE) (`AGPL-3.0-only`), without warranty. Preserve applicable copyright and license notices when redistributing. Commercial use is permitted under the license; it does not require contributions to be submitted to this repository.

Redistributed covered versions must provide their corresponding source under the license. Modified versions used for interaction over a network must offer their corresponding source to those users as specified in section 13. Executable releases must provide access to their matching source and build instructions. Third-party components retain their own licenses.
