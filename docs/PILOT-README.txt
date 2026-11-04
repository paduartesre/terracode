TerraCode — Community Edition — Linux x64

Run locally without Node.js, npm, or access to the source repository.
Target: Linux x64 with glibc, including Ubuntu 24.04 and Ubuntu in WSL2.
This is not a native Windows, macOS, ARM64, or Alpine Linux executable.

1. Extract the archive and enter its directory in your Linux terminal.
2. Run chmod +x terracode, then ./terracode.
3. Open http://localhost:5173. Keep the terminal open; stop with Ctrl+C.
Do not use sudo or run as root.

To select an existing project:
  ./terracode --project /absolute/linux/project/path
Otherwise the initial workspace is ~/.terracode-pilot/workspace.
You can open another folder in the interface.

Install Git and Terraform in the same Linux environment. The included demo
requires Terraform >=1.4. Copy demo.tf.example into a new empty folder as
main.tf and load that folder using Load Terraform project….
Try Init, Format, Validate, and Plan. The built-in terraform_data resource
needs no cloud account and provisions no cloud resources. For Apply, use
Save plan & prepare apply… > Review saved plan > Apply saved plan.
Inspect State and Outputs. Real Apply/Destroy operations change infrastructure
and may incur costs; start with disposable or authorized test projects.

Ports 5173 and 3001 must be free. Both listeners bind only to 127.0.0.1.
Do not expose them over a network. Terraform and Git must be on PATH.
Cloud CLIs are required only for their corresponding login flows.
tfenv and Infracost are optional and are not included.
The app can modify files and infrastructure in the projects you open.
Credentials registered in the app use ~/.terraform-code. Never share it.
No repository login or automatic feedback upload is required. Cloud operations,
remote Git, registry, version installation, and cost estimates may contact
their respective external services when used.

Send FEEDBACK.txt observations to pedroduarte@terracodeiac.com. Include OS,
./terracode --version, installation experience, workflows tried, and issues.
Never include credentials, PATs, private keys, state, plans, or client data.

Copyright (c) 2026 Pedro Duarte. Licensed under AGPL-3.0-only; see LICENSE.
Use, modification, and redistribution follow that license, including its
corresponding-source requirements. SOURCE.txt identifies the matching source
and build instructions on GitHub. Third-party licenses remain applicable;
see THIRD-PARTY-NOTICES.txt. This software is provided without warranty.
The backend uses V8 bytecode and the browser assets are compiled; original
source files, Git history, and source maps are not bundled. Obtain the
corresponding source using SOURCE.txt. Browser JavaScript remains inspectable.
Community participation and usability feedback are voluntary and unpaid.

There is no automatic updater. Stop the process, extract a new package and
run it. Projects and credentials remain outside the executable.
Integrity check: sha256sum -c SHA256SUMS (not a publisher digital signature).
