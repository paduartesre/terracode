import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Fixture layout (created in beforeAll):
//   base/
//     outside.txt          <- exists OUTSIDE the allowed root
//     root/                <- BASE_DIR
//       hello.txt
//       tokenfile.txt
//       binary.bin
//       big.txt            (> 1 MB)
//       sub/nested.md
//       link-etc -> /etc/hostname        (absolute symlink escape)
//       link-out -> ../outside.txt       (relative symlink escape)
//       link-dir -> ..                   (directory symlink escaping the root)

// Fake terraform binary so the /api/tf/run tests never depend on a real
// installation. fmt strips trailing whitespace from .tf files (and prints the
// changed ones), validate greps for an INVALID marker, plan sleeps briefly and
// sleeps much longer when a .slow-plan marker file is present. Lifecycle
// commands: init/output/state/apply are static fixtures; mutating invocations
// are recorded in .init-log / .apply-log (args verbatim) so tests can assert
// the fixed server-side arguments. plan -json emits an NDJSON stream with one
// resource_change per line (skipped when a .plan-nochanges marker exists), and
// -out=<file> touches that file like a real saved execution plan.
const FAKE_TERRAFORM_SCRIPT = `#!/bin/bash
# Record any injected cloud-credential env vars (empty file when none).
env | grep -E '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_REGION|ARM_CLIENT_ID|ARM_CLIENT_SECRET|ARM_TENANT_ID|ARM_SUBSCRIPTION_ID|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET|AZURE_TENANT_ID|AZURE_SUBSCRIPTION_ID|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT)=' > "\${PWD}/.cred-env" 2>/dev/null || true
# Snapshot the GCP key file content (it persists in the store dir, but a copy
# here makes assertions independent of later logins).
if [ -n "$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  cat "$GOOGLE_APPLICATION_CREDENTIALS" > "\${PWD}/.gcp-key-snapshot"
fi
case "$1" in
  fmt)
    find . -name '*.tf' -not -path './.git/*' -type f | while IFS= read -r f; do
      if grep -qE '[[:space:]]+$' "$f"; then
        sed -i 's/[[:space:]]*$//' "$f"
        echo "\${f#./}"
      fi
    done
    exit 0
    ;;
  validate)
    if grep -rq 'INVALID' --include='*.tf' .; then
      printf '%s\\n' '{"format_version":"1.0","valid":false,"error_count":1,"warning_count":0,"diagnostics":[{"severity":"error","summary":"Invalid reference","detail":"An invalid reference to INVALID was detected."}]}'
      exit 1
    fi
    printf '%s\\n' '{"format_version":"1.0","valid":true,"error_count":0,"warning_count":0,"diagnostics":[]}'
    exit 0
    ;;
  init)
    printf '%s\\n' "$*" > .init-log
    echo 'Terraform has been successfully initialized!'
    exit 0
    ;;
  output)
    printf '%s\\n' '{"env":{"value":"prod","type":"string","sensitive":false},"secret_key":{"value":"hidden-value","type":"string","sensitive":true}}'
    exit 0
    ;;
  state)
    case "$2" in
      list)
        echo 'aws_instance.web'
        echo 'module.vpc.aws_subnet.private[0]'
        exit 0
        ;;
      show)
        printf '%s\\n' "Resource address: \${4:-}"
        exit 0
        ;;
      mv)
        printf '%s\\n' "$*" > .state-mv-log
        echo 'Moved 1 object(s).'
        exit 0
        ;;
      rm)
        printf '%s\\n' "$*" > .state-rm-log
        echo 'Removed 1 resource(s).'
        exit 0
        ;;
    esac
    exit 1
    ;;
  plan)
    if [ -f .slow-plan ]; then sleep 4; fi
    printf '%s\n' "$*" > .plan-args
    json=0
    destroy=0
    detailed=0
    for a in "$@"; do
      case "$a" in
        -json) json=1 ;;
        -destroy) destroy=1 ;;
        -detailed-exitcode) detailed=1 ;;
        -out=*) touch "\${a#-out=}" ;;
      esac
    done
    if [ "$json" = "1" ]; then
      printf '%s\n' '{"type":"planned_values","values":{}}'
      changes=0
      if [ ! -f .plan-nochanges ]; then
        changes=1
        printf '%s\n' '{"type":"resource_change","address":"aws_instance.web","change":{"actions":["create"],"before":null,"after":{"instance_type":"t2.micro"},"after_unknown":{}},"resource":{"mode":"managed","type":"aws_instance","name":"web"}}'
        printf '%s\n' '{"type":"resource_change","address":"aws_s3_bucket.logs","change":{"actions":["update"],"before":{"bucket":"logs-old","acl":"private"},"after":{"bucket":"logs-new","acl":null},"after_unknown":{"bucket":false,"acl":true}},"resource":{"mode":"managed","type":"aws_s3_bucket","name":"logs"}}'
        printf '%s\n' '{"type":"resource_change","address":"aws_iam_role.old","change":{"actions":["create","delete"]},"resource":{"mode":"managed","type":"aws_iam_role","name":"old"}}'
      fi
      if [ "$detailed" = "1" ]; then
        # -detailed-exitcode: 2 when changes were detected, 0 otherwise.
        if [ "$changes" = "1" ]; then exit 2; else exit 0; fi
      fi
      exit 0
    fi
    sleep 0.5
    echo 'Terraform used the selected providers to generate the following execution plan.'
    if [ "$destroy" = "1" ]; then
      echo 'Plan: 0 to add, 0 to change, 1 to destroy.'
    else
      echo 'Plan: 1 to add, 0 to change, 0 to destroy.'
    fi
    exit 0
    ;;
  apply)
    if [ ! -f tf.plan ]; then
      echo 'Error: Plan file "tf.plan" not found.' >&2
      exit 1
    fi
    printf '%s\\n' "$*" > .apply-log
    echo 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.'
    exit 0
    ;;
  version)
    if [ "$2" = "-json" ]; then
      printf '%s\\n' '{"terraform_version":"1.9.8","platform":"linux_amd64"}'
    else
      echo 'Terraform v1.5.0'
    fi
    exit 0
    ;;
  workspace)
    case "$2" in
      list)
        printf '%s\\n' '* default' 'staging' 'prod'
        exit 0
        ;;
      new|select)
        printf '%s\\n' "$*" > .ws-log
        echo 'Workspace switched.'
        exit 0
        ;;
    esac
    exit 1
    ;;
  graph)
    cat <<'DOT'
digraph {
	compound = "true"
	newrank = "true"
	subgraph "root" {
		"[root]" label="configuration root" penwidth="2" style="bold"
		"aws_instance.web" label="aws_instance.web" shape="box"
		"aws_s3_bucket.logs" label="aws_s3_bucket.logs" shape="box"
	}
	"provider[\\"registry.terraform.io/hashicorp/aws\\"]" label="provider[\\"registry.terraform.io/hashicorp/aws\\"]" shape="ellipse" style="rounded"
	"[root]" -> "aws_instance.web"
	"[root]" -> "aws_s3_bucket.logs"
	"aws_instance.web" -> "provider[\\"registry.terraform.io/hashicorp/aws\\"]"
	"aws_s3_bucket.logs" -> "provider[\\"registry.terraform.io/hashicorp/aws\\"]"
}
DOT
    exit 0
    ;;
  show)
    if [ ! -f tf.plan ]; then
      echo 'Error: Plan file "tf.plan" not found.' >&2
      exit 1
    fi
    printf '%s\\n' "$*" > .show-log
    echo 'Terraform will perform the following actions:'
    echo '  # aws_instance.web will be created'
    echo 'Plan: 1 to add, 0 to change, 0 to destroy.'
    exit 0
    ;;
  import)
    printf '%s\\n' "$*" > .import-log
    echo 'Import successful!'
    exit 0
    ;;
  console)
    cat > .console-stdin
    echo '2'
    exit 0
    ;;
esac
exit 2
`

// Fake cloud CLIs so /api/cloud/login tests never touch real accounts. Each
// appends its args + relevant env to $FAKE_CLI_LOG_DIR/<name>.log and mimics
// just enough of the real command for the server's invocations.
const FAKE_AWS_SCRIPT = `#!/bin/bash
LOG="\${FAKE_CLI_LOG_DIR:-/tmp}/aws.log"
{ echo "args: $*"; env | grep -E '^AWS_' ; } >> "$LOG" 2>/dev/null || true
if [ "\${1:-}" = "sts" ] && [ "\${2:-}" = "get-caller-identity" ]; then
  if [ "$AWS_ACCESS_KEY_ID" = "AKIABADKEY0000" ]; then
    echo 'An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.' >&2
    exit 1
  fi
  printf '%s\\n' '{"UserId":"AIDAEXAMPLE","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/test"}'
  exit 0
fi
exit 1
`

const FAKE_AZ_SCRIPT = `#!/bin/bash
LOG="\${FAKE_CLI_LOG_DIR:-/tmp}/az.log"
echo "args: $*" >> "$LOG" 2>/dev/null || true
# az passes the service principal as explicit flags (no env-var support).
pw=""
for a in "$@"; do case "$a" in --password=*) pw="\${a#--password=}";; esac; done
case "\${1:-}" in
  login)
    if [ "$pw" = "bad-secret-123456" ]; then
      echo '[{"error":"AADSTS7000215: Invalid client secret provided."}]' >&2
      exit 1
    fi
    printf '%s\\n' '[{"id":"sub-fake","name":"fake-subscription","user":{"name":"sp@test"}}]'
    ;;
  account)
    case "\${2:-}" in
      set) printf '%s\\n' '{"id":"'"\${3#--subscription=}"'","name":"fake-subscription"}' ;;
      show) printf '%s\\n' '{"id":"sub-fake","name":"fake-subscription","user":{"name":"sp@test"}}' ;;
    esac
    ;;
esac
exit 0
`

const FAKE_GCLOUD_SCRIPT = `#!/bin/bash
LOG="\${FAKE_CLI_LOG_DIR:-/tmp}/gcloud.log"
echo "args: $*" >> "$LOG" 2>/dev/null || true
case "\${1:-} \${2:-}" in
  "auth activate-service-account")
    kf=""
    for a in "$@"; do case "$a" in --key-file=*) kf="\${a#--key-file=}";; esac; done
    if [ -z "$kf" ] || [ ! -f "$kf" ]; then
      echo 'ERROR: (gcloud.auth.activate-service-account) The file does not exist.' >&2
      exit 1
    fi
    email=$(grep -o '"client_email"[[:space:]]*:[[:space:]]*"[^"]*"' "$kf" | head -1 | cut -d'"' -f4)
    printf '%s\\n' "\${email:-unknown}" > "\${FAKE_CLI_LOG_DIR}/gcloud-account" 2>/dev/null || true
    echo "Activated service account credentials for: [\${email:-unknown}]"
    exit 0
    ;;
  "config set")
    exit 0
    ;;
  "config get-value")
    if [ "\${3:-}" = "account" ]; then cat "\${FAKE_CLI_LOG_DIR}/gcloud-account" 2>/dev/null; fi
    exit 0
    ;;
esac
exit 1
`

// Fake git binary so the /api/git/* tests never depend on a real repository.
// A directory is "a repo" when it contains a .git/ dir, EXCEPT `init`, which
// works on non-repos and creates .git. Fixtures live inside .git:
//   .git/current-branch    name for `rev-parse --abbrev-ref HEAD` (default "HEAD")
//   .git/branches-list     one branch per line (`for-each-ref refs/heads`)
//   .git/remotes-fixture   raw `remote -v` output ("<name>\t<url> (fetch|push)")
//   .git/status-fixture    raw bytes emitted by `status --porcelain=v1 -z`
//   .git/toplevel          optional override for `rev-parse --show-toplevel`
//   .git/heads/<path>      content returned by `show HEAD:<path>`
//   .git/add-log           one line per `add` invocation (args verbatim)
//   .git/staged            marker: staged changes exist (created by add, cleared
//                          by commit); its presence makes `diff --cached --quiet`
//                          exit 1 like real git
//   .git/noop-add          when present, `add` stages nothing (clean tree)
//   .git/op-log            one line per mutating op (branch/checkout/merge/rebase/
//                          push/pull/fetch/init/remote add), args verbatim
//   .git/origin-url        url recorded by `remote add origin <url>`
//   .git/init-meta         "branch=<name>" when init was given -b <name>
//   .git/merge-conflict    when present, merge exits 1 with conflict output
//   .git/rebase-conflict   when present, rebase exits 1 with conflict output
//   .git/push-fail         when present, push exits 128 (auth failure)
const FAKE_GIT_SCRIPT = `#!/bin/bash
if [ "$1" = "init" ]; then
  mkdir -p .git
  shift
  printf '%s\\n' "init $*" >> .git/op-log
  while [ $# -gt 0 ]; do
    case "$1" in
      -b) echo "branch=$2" >> .git/init-meta; shift 2 ;;
      *) shift ;;
    esac
  done
  exit 0
fi

if [ ! -d .git ]; then
  echo 'fatal: not a git repository (or any of the parent directories): .git' >&2
  exit 128
fi

case "$1" in
  status)
    cat .git/status-fixture 2>/dev/null || true
    ;;
  rev-parse)
    case "$2" in
      --show-toplevel)
        if [ -f .git/toplevel ]; then cat .git/toplevel; else printf '%s\\n' "$PWD"; fi
        ;;
      --abbrev-ref)
        if [ -f .git/current-branch ]; then cat .git/current-branch; else echo 'HEAD'; fi
        ;;
      --is-inside-work-tree)
        echo true
        ;;
      --short) echo abc1234 ;;
    esac
    ;;
  for-each-ref)
    cat .git/branches-list 2>/dev/null || true
    ;;
  remote)
    case "$2" in
      -v)
        cat .git/remotes-fixture 2>/dev/null || true
        exit 0
        ;;
      add)
        printf '%s\\n' "$*" >> .git/op-log
        echo "$4" > .git/origin-url
        ;;
    esac
    ;;
  branch)
    printf '%s\\n' "$*" >> .git/op-log
    exit 0
    ;;
  checkout)
    printf '%s\\n' "$*" >> .git/op-log
    if [ -f .git/checkout-fail ]; then echo 'error: pathspec did not match any file(s)' >&2; exit 1; fi
    if [ "$2" = "-b" ]; then echo "\${3:-}" > .git/current-branch; else echo "\${2:-}" > .git/current-branch; fi
    exit 0
    ;;
  merge)
    printf '%s\\n' "$*" >> .git/op-log
    if [ -f .git/merge-conflict ]; then
      echo 'Auto-merging file.txt' >&2
      echo 'CONFLICT (content): Merge conflict in file.txt' >&2
      exit 1
    fi
    echo 'Merge made by the "ort" strategy.'
    exit 0
    ;;
  rebase)
    printf '%s\\n' "$*" >> .git/op-log
    case "$2" in
      --abort|--continue|--skip) exit 0 ;;
      *)
        if [ -f .git/rebase-conflict ]; then
          echo 'error: could not apply abc1234... commit msg' >&2
          echo 'CONFLICT (content): Merge conflict in file.txt' >&2
          exit 1
        fi
        echo 'Successfully rebased and updated refs/heads/main.'
        exit 0
        ;;
    esac
    ;;
  push)
    printf '%s\\n' "$*" >> .git/op-log
    if [ -f .git/push-fail ]; then
      echo 'fatal: could not read Username for https://github.com: terminal prompts disabled' >&2
      exit 128
    fi
    echo 'To github.com:owner/repo.git'
    echo ' * [new branch] main -> main'
    exit 0
    ;;
  pull)
    printf '%s\\n' "$*" >> .git/op-log
    if [ -f .git/pull-conflict ]; then
      echo 'Auto-merging file.txt' >&2
      echo 'CONFLICT (content): Merge conflict in file.txt' >&2
      exit 1
    fi
    echo 'Already up to date.'
    exit 0
    ;;
  fetch)
    printf '%s\\n' "$*" >> .git/op-log
    echo 'From github.com:owner/repo'
    exit 0
    ;;
  log)
    # Metadata mode has a trailing <hash> arg (5 args); list mode has exactly 4.
    if [ $# -ge 5 ]; then
      if [ -f .git/commit-missing ]; then
        echo "fatal: bad revision 'xyz123'" >&2
        exit 128
      fi
      cat .git/commit-meta 2>/dev/null || true
      exit 0
    fi
    cat .git/log-fixture 2>/dev/null || true
    exit 0
    ;;
  show)
    # git show --name-status --format= <hash> -> changed-files list (no header).
    if [ "$2" = "--name-status" ]; then
      cat .git/name-status 2>/dev/null || true
      exit 0
    fi
    case "$2" in
      HEAD:*)
        f=".git/heads/\${2#HEAD:}"
        if [ -f "$f" ]; then cat "$f"; exit 0; fi
        echo "fatal: path '\${2#HEAD:}' does not exist in 'HEAD'" >&2
        exit 1
        ;;
      *)
        # git show <hash>:<path> or <hash>^:<path> -> commit blob fetch.
        key="$(printf '%s' "$2" | tr / _)"
        b=".git/blobs/$key"
        if [ -f "$b" ]; then cat "$b"; exit 0; fi
        echo "fatal: path '$2' does not exist in commit" >&2
        exit 1
        ;;
    esac
    ;;
  add)
    printf '%s\\n' "$*" >> .git/add-log
    if [ ! -f .git/noop-add ]; then touch .git/staged; fi
    ;;
  diff)
    if [ -f .git/staged ]; then exit 1; fi
    exit 0
    ;;
  commit)
    printf '%s\\n' "$3" > .git/last-commit-msg
    rm -f .git/staged
    echo "[master abc1234] $3"
    ;;
esac
exit 0
`

let base = ''
let root = ''
let app = null
let startFileWatcher = null
let stopFileWatcher = null
let registryServer = null
// Fake infracost binary so /api/tf/cost never downloads price data or needs an
// API key: records its args, emits a fixed breakdown JSON, and fails when a
// .infracost-fail marker file exists in the working directory.
const FAKE_INFRACOST_SCRIPT = `#!/bin/bash
echo "$*" > .infracost-args
if [ -f .infracost-fail ]; then
  echo 'Error: something went wrong in the fake infracost' >&2
  exit 1
fi
cat <<'JSON'
{
  "version": "0.15.0",
  "currency_symbol": "$",
  "total_monthly_cost": "37.46",
  "projects": [
    {
      "id": "proj-1",
      "path": ".",
      "name": "root module",
      "monthly_cost": "37.46",
      "resources": [
        {"address": "aws_instance.web", "monthly_cost": "29.50"},
        {"address": "aws_s3_bucket.logs", "monthly_cost": "7.96"}
      ]
    }
  ],
  "errors": [],
  "warnings": []
}
JSON
exit 0`

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-api-'))
  root = path.join(base, 'root')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE SECRET\n')
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world\n')
  fs.writeFileSync(path.join(root, 'tokenfile.txt'), 'prefix line\nzebra42 unique token\nsuffix\n')
  fs.writeFileSync(path.join(root, 'sub', 'nested.md'), '# nested\n')
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  fs.writeFileSync(path.join(root, 'big.txt'), 'a\n'.repeat(600_000)) // ~1.2 MB
  fs.symlinkSync('/etc/hostname', path.join(root, 'link-etc'))
  fs.symlinkSync('../outside.txt', path.join(root, 'link-out'))
  fs.symlinkSync('..', path.join(root, 'link-dir'))

  // Terraform fixture directories (populated by the /api/tf/run tests).
  for (const name of ['fmt', 'valid', 'invalid', 'plan', 'slow']) {
    fs.mkdirSync(path.join(root, 'tf', name), { recursive: true })
  }

  // Multi-root fixture: a second "repository" outside BASE_DIR.
  const extra = path.join(base, 'extra')
  fs.mkdirSync(extra)
  fs.writeFileSync(path.join(extra, 'note.txt'), 'extra repo file\n')
  fs.symlinkSync('/etc/hostname', path.join(extra, 'link-etc'))

  // Fake terraform on PATH (shadows any real installation) and a short timeout
  // so the plan-timeout test stays fast. Both must be set before import:
  // TF_TIMEOUT_MS is read at server module load.
  const fakeBin = path.join(base, 'bin')
  fs.mkdirSync(fakeBin)
  const tfScript = path.join(fakeBin, 'terraform')
  fs.writeFileSync(tfScript, FAKE_TERRAFORM_SCRIPT)
  fs.chmodSync(tfScript, 0o755)

  // Fake git on PATH (shadows any real installation).
  const gitScript = path.join(fakeBin, 'git')
  fs.writeFileSync(gitScript, FAKE_GIT_SCRIPT)
  fs.chmodSync(gitScript, 0o755)

  // Fake cloud CLIs on PATH (shadow any real installation) so /api/cloud/login
  // never touches real accounts; they log args+env to FAKE_CLI_LOG_DIR.
  const awsScript = path.join(fakeBin, 'aws')
  fs.writeFileSync(awsScript, FAKE_AWS_SCRIPT)
  fs.chmodSync(awsScript, 0o755)
  const azCliScript = path.join(fakeBin, 'az')
  fs.writeFileSync(azCliScript, FAKE_AZ_SCRIPT)
  fs.chmodSync(azCliScript, 0o755)
  const gcloudScript = path.join(fakeBin, 'gcloud')
  fs.writeFileSync(gcloudScript, FAKE_GCLOUD_SCRIPT)
  fs.chmodSync(gcloudScript, 0o755)

  // Fake infracost on PATH so /api/tf/cost never downloads price data or needs
  // an API key; it emits a fixed breakdown JSON (or fails via .infracost-fail).
  const infracostScript = path.join(fakeBin, 'infracost')
  fs.writeFileSync(infracostScript, FAKE_INFRACOST_SCRIPT)
  fs.chmodSync(infracostScript, 0o755)

  // Fake Terraform Registry (REGISTRY_BASE points here) so /api/tf/registry/*
  // never touches the network. Versions are intentionally out of order to cover
  // the newest-first sort.
  registryServer = http.createServer((req, res) => {
    const parts = req.url.split('/')
    if (parts.length === 6 && parts[1] === 'v1' && parts[2] === 'modules') {
      const [, , , ns, name, provider] = parts
      // hashicorp/consul/aws mirrors the real registry: versions are plain
      // strings, oldest first. acme/widget/aws covers the object form plus
      // description/downloads passthrough.
      if (ns === 'hashicorp' && name === 'consul' && provider === 'aws') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ namespace: ns, name, provider, versions: ['1.0.0', '1.2.3', '1.1.0'] }))
        return
      }
      if (ns === 'acme' && name === 'widget' && provider === 'aws') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          namespace: ns,
          name,
          provider,
          description: 'A fake widget module for tests',
          downloads: 123456,
          versions: [
            { version: '2.0.0', published_at: '2025-01-01T00:00:00Z' },
            { version: '1.9.0', published_at: '2024-06-01T00:00:00Z' }
          ]
        }))
        return
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise(resolve => registryServer.listen(0, '127.0.0.1', resolve))
  process.env.REGISTRY_BASE = `http://127.0.0.1:${registryServer.address().port}`
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`
  // Isolate the global credential store and CLI resolution from this machine.
  process.env.FAKE_CLI_LOG_DIR = path.join(base, 'cli-logs')
  fs.mkdirSync(process.env.FAKE_CLI_LOG_DIR)
  process.env.TF_CODE_CRED_DIR = path.join(base, 'cred-home')
  // '' disables the extra PATH dirs so real CLIs can never shadow the fakes.
  process.env.CLOUD_CLI_EXTRA_PATH = ''
  process.env.TF_TIMEOUT_MS = '2000'
  // Keep the real ~/.tfenv out of these tests: terraform must resolve to the
  // fake binary on PATH. The tfenv suite below re-enables detection with a
  // fake bin dir (TFENV_BIN) since detection is dynamic per request.
  process.env.TFENV_DISABLE = '1'

  process.env.BASE_DIR = root
  const serverModule = await import('./server.cjs')
  app = serverModule.default
  startFileWatcher = serverModule.startFileWatcher
  stopFileWatcher = serverModule.stopFileWatcher
})

afterAll(async () => {
  if (stopFileWatcher !== null) stopFileWatcher()
  if (registryServer !== null) await new Promise(resolve => registryServer.close(resolve))
  fs.rmSync(base, { recursive: true, force: true })
})

describe('GET /api/files', () => {
  it('rejects a missing path param with 400', async () => {
    const res = await request(app).get('/api/files')
    expect(res.status).toBe(400)
  })

  it('rejects an empty path param with 400', async () => {
    const res = await request(app).get('/api/files').query({ path: '' })
    expect(res.status).toBe(400)
  })

  it('lists the root directory', async () => {
    const res = await request(app).get('/api/files').query({ path: root })
    expect(res.status).toBe(200)
    const names = res.body.map(e => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('sub')
    const sub = res.body.find(e => e.name === 'sub')
    expect(sub.isDirectory).toBe(true)
  })

  it('denies paths outside the root with 403', async () => {
    const res = await request(app).get('/api/files').query({ path: '/etc' })
    expect(res.status).toBe(403)
  })

  it('denies traversal with 403', async () => {
    const res = await request(app).get('/api/files').query({ path: '../../..' })
    expect(res.status).toBe(403)
  })

  it('returns 404 for a missing path', async () => {
    const res = await request(app).get('/api/files').query({ path: path.join(root, 'nope') })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/file-content', () => {
  it('reads a text file with mtimeMs', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'hello.txt') })
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('hello world\n')
    expect(typeof res.body.mtimeMs).toBe('number')
  })

  it('returns 404 for a missing file', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'nope.txt') })
    expect(res.status).toBe(404)
  })

  it('rejects a directory with 400', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'sub') })
    expect(res.status).toBe(400)
  })

  it('rejects binary files with 415', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'binary.bin') })
    expect(res.status).toBe(415)
  })

  it('rejects oversized files with 413', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'big.txt') })
    expect(res.status).toBe(413)
  })
})

describe('PUT /api/file-content', () => {
  it('round-trips a save with the current mtime', async () => {
    const p = path.join(root, 'hello.txt')
    const before = await request(app).get('/api/file-content').query({ path: p })
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: p, content: 'updated world\n', mtimeMs: before.body.mtimeMs })
    expect(res.status).toBe(200)
    expect(typeof res.body.mtimeMs).toBe('number')
    const after = await request(app).get('/api/file-content').query({ path: p })
    expect(after.body.content).toBe('updated world\n')
  })

  it('rejects a stale mtime with 409', async () => {
    const p = path.join(root, 'hello.txt')
    const before = await request(app).get('/api/file-content').query({ path: p })
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: p, content: 'conflict\n', mtimeMs: before.body.mtimeMs - 5000 })
    expect(res.status).toBe(409)
  })

  it('rejects a body without path/content with 400', async () => {
    const res = await request(app).put('/api/file-content').send({})
    expect(res.status).toBe(400)
  })

  it('denies writes outside the root with 403', async () => {
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: '/etc/passwd', content: 'x' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when writing a missing file', async () => {
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: path.join(root, 'ghost.txt'), content: 'x' })
    expect(res.status).toBe(404)
  })

  it('writes atomically and leaves no temp files behind', async () => {
    const p = path.join(root, 'atomic.txt')
    fs.writeFileSync(p, 'original\n')
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: p, content: 'rewritten\n' })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(p, 'utf-8')).toBe('rewritten\n')
    const leftovers = fs.readdirSync(root).filter(n => n.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('preserves the file permission bits across a rewrite', async () => {
    const p = path.join(root, 'atomic-mode.txt')
    fs.writeFileSync(p, 'v1\n')
    fs.chmodSync(p, 0o640)
    const res = await request(app).put('/api/file-content').send({ path: p, content: 'v2\n' })
    expect(res.status).toBe(200)
    expect(fs.statSync(p).mode & 0o777).toBe(0o640)
  })

  it('keeps the original file intact when the write cannot complete', async () => {
    const dir = path.join(root, 'ro-dir')
    fs.mkdirSync(dir)
    const p = path.join(dir, 'locked.txt')
    fs.writeFileSync(p, 'keep me\n')
    fs.chmodSync(dir, 0o555) // no write permission -> temp file creation fails
    try {
      const res = await request(app).put('/api/file-content').send({ path: p, content: 'x\n' })
      expect(res.status).toBe(500)
      expect(fs.readFileSync(p, 'utf-8')).toBe('keep me\n')
      expect(fs.readdirSync(dir)).toEqual(['locked.txt'])
    } finally {
      fs.chmodSync(dir, 0o755)
    }
  })
})

describe('GET /api/search', () => {
  it('rejects an empty query with 400', async () => {
    const res = await request(app).get('/api/search').query({ q: '' })
    expect(res.status).toBe(400)
  })

  it('finds files by name', async () => {
    const res = await request(app).get('/api/search').query({ q: 'hello', path: root })
    expect(res.status).toBe(200)
    expect(res.body.some(r => r.name === 'hello.txt' && !r.isDirectory)).toBe(true)
  })

  it('finds files by content with line numbers', async () => {
    const res = await request(app).get('/api/search').query({ q: 'zebra42', path: root })
    expect(res.status).toBe(200)
    const hit = res.body.find(r => r.name === 'tokenfile.txt')
    expect(hit).toBeDefined()
    expect(hit.matches[0].line).toBe(2)
  })

  it('finds directories by name', async () => {
    const res = await request(app).get('/api/search').query({ q: 'sub', path: root })
    expect(res.status).toBe(200)
    expect(res.body.some(r => r.name === 'sub' && r.isDirectory)).toBe(true)
  })
})

describe('GET /api/search (regex/case/ext filters)', () => {
  let sdir = ''

  beforeAll(() => {
    sdir = path.join(root, 'searchfix')
    fs.mkdirSync(sdir, { recursive: true })
    fs.writeFileSync(path.join(sdir, 'alpha.ts'), 'const Foo = 1\nfoo bar\nFOO baz\n')
    fs.writeFileSync(path.join(sdir, 'beta.md'), 'foo qux\n')
    fs.writeFileSync(path.join(sdir, 'gamma.txt'), 'nothing here\n')
  })

  it('matches case-insensitively by default', async () => {
    const res = await request(app).get('/api/search').query({ q: 'foo', path: sdir })
    expect(res.status).toBe(200)
    const names = res.body.filter(r => !r.isDirectory).map(r => r.name)
    expect(names).toContain('alpha.ts')
    expect(names).toContain('beta.md')
    expect(names).not.toContain('gamma.txt')
  })

  it('honors the case filter', async () => {
    const res = await request(app).get('/api/search').query({ q: 'FOO', path: sdir, case: '1' })
    expect(res.status).toBe(200)
    const hit = res.body.find(r => r.name === 'alpha.ts')
    expect(hit.matches.map(m => m.line)).toEqual([3])
  })

  it('supports regex matching', async () => {
    const res = await request(app).get('/api/search').query({ q: '^const ', path: sdir, regex: '1' })
    expect(res.status).toBe(200)
    const hit = res.body.find(r => r.name === 'alpha.ts')
    expect(hit.matches[0].line).toBe(1)
  })

  it('rejects an invalid regex with 400', async () => {
    const res = await request(app).get('/api/search').query({ q: '[unclosed', path: sdir, regex: '1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Invalid regular expression')
  })

  it('filters by extension and skips directory results', async () => {
    const res = await request(app).get('/api/search').query({ q: 'foo', path: sdir, ext: 'ts' })
    expect(res.status).toBe(200)
    expect(res.body.every(r => !r.isDirectory)).toBe(true)
    expect(res.body.map(r => r.name)).toEqual(['alpha.ts'])
  })

  it('includes mtimeMs on file results', async () => {
    const res = await request(app).get('/api/search').query({ q: 'foo', path: sdir, ext: 'ts' })
    expect(res.status).toBe(200)
    expect(typeof res.body[0].mtimeMs).toBe('number')
  })
})

describe('POST /api/replace', () => {
  let rdir = ''
  const mkFile = (name, content) => {
    const p = path.join(rdir, name)
    fs.writeFileSync(p, content)
    return p
  }

  beforeAll(() => {
    rdir = path.join(root, 'replacefix')
    fs.mkdirSync(rdir, { recursive: true })
  })

  it('replaces literal matches case-insensitively by default', async () => {
    const p = mkFile('lit.txt', 'foo FOO foo\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: 'foo', replacement: 'bar' })
    expect(res.status).toBe(200)
    expect(res.body.replaced).toBe(3)
    expect(fs.readFileSync(p, 'utf-8')).toBe('bar bar bar\n')
  })

  it('replaces case-sensitively when requested', async () => {
    const p = mkFile('cs.txt', 'foo FOO foo\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: 'FOO', replacement: 'baz', caseSensitive: true })
    expect(res.status).toBe(200)
    expect(res.body.replaced).toBe(1)
    expect(fs.readFileSync(p, 'utf-8')).toBe('foo baz foo\n')
  })

  it('supports regex with backreferences', async () => {
    const p = mkFile('re.txt', 'a=1 b=2 c=3\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: '(\\w+)=(\\d+)', replacement: '$2 $1', regex: true })
    expect(res.status).toBe(200)
    expect(res.body.replaced).toBe(3)
    expect(fs.readFileSync(p, 'utf-8')).toBe('1 a 2 b 3 c\n')
  })

  it('reports replaced:0 when nothing matches and leaves the file untouched', async () => {
    const p = mkFile('none.txt', 'hello\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: 'zzz', replacement: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.replaced).toBe(0)
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello\n')
  })

  it('rejects a stale mtime with 409', async () => {
    const p = mkFile('conflict.txt', 'foo\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: 'foo', replacement: 'bar', mtimeMs: Date.now() - 60_000 })
    expect(res.status).toBe(409)
  })

  it('rejects an invalid regex with 400', async () => {
    const p = mkFile('badre.txt', 'x\n')
    const res = await request(app).post('/api/replace').send({ path: p, find: '[unclosed', replacement: 'y', regex: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Invalid regular expression')
  })

  it('rejects a missing find with 400', async () => {
    const res = await request(app).post('/api/replace').send({ path: path.join(rdir, 'x.txt'), replacement: 'y' })
    expect(res.status).toBe(400)
  })

  it('denies writes outside the root with 403', async () => {
    const res = await request(app).post('/api/replace').send({ path: '/etc/passwd', find: 'a', replacement: 'b' })
    expect(res.status).toBe(403)
  })

  it('returns 415 for a binary file', async () => {
    const p = mkFile('bin.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    const res = await request(app).post('/api/replace').send({ path: p, find: 'a', replacement: 'b' })
    expect(res.status).toBe(415)
  })

  it('returns 404 for a missing file', async () => {
    const res = await request(app).post('/api/replace').send({ path: path.join(rdir, 'ghost.txt'), find: 'a', replacement: 'b' })
    expect(res.status).toBe(404)
  })
})

describe('CORS', () => {
  it('allows the Vite dev origin', async () => {
    const res = await request(app)
      .get('/api/files')
      .query({ path: root })
      .set('Origin', 'http://localhost:5173')
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('sends no CORS header for a foreign origin', async () => {
    const res = await request(app)
      .get('/api/files')
      .query({ path: root })
      .set('Origin', 'http://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('answers the PUT preflight for an allowed origin', async () => {
    const res = await request(app)
      .options('/api/file-content')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'content-type')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    expect(res.headers['access-control-allow-methods']).toContain('PUT')
  })
})

describe('symlink escape (F1)', () => {
  it('blocks an absolute symlink pointing outside the root', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'link-etc') })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('hostname')
  })

  it('blocks a relative symlink escaping the root', async () => {
    const res = await request(app).get('/api/file-content').query({ path: path.join(root, 'link-out') })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('OUTSIDE SECRET')
  })

  it('blocks listing a symlinked directory that escapes the root', async () => {
    const res = await request(app).get('/api/files').query({ path: path.join(root, 'link-dir') })
    expect(res.status).toBe(403)
  })

  it('blocks writing through a symlink to an outside file', async () => {
    const res = await request(app)
      .put('/api/file-content')
      .send({ path: path.join(root, 'link-out'), content: 'PWNED\n' })
    expect(res.status).toBe(403)
    expect(fs.readFileSync(path.join(base, 'outside.txt'), 'utf-8')).toBe('OUTSIDE SECRET\n')
  })

  it('blocks deleting through a symlink to an outside file', async () => {
    const res = await request(app).delete('/api/files').query({ path: path.join(root, 'link-out') })
    expect(res.status).toBe(403)
    expect(fs.readFileSync(path.join(base, 'outside.txt'), 'utf-8')).toBe('OUTSIDE SECRET\n')
  })
})

describe('POST /api/files (create)', () => {
  it('creates a file with content', async () => {
    const p = path.join(root, 'created.txt')
    const res = await request(app).post('/api/files').send({ path: p, type: 'file', content: 'new\n' })
    expect(res.status).toBe(200)
    expect(res.body.isDirectory).toBe(false)
    expect(fs.readFileSync(p, 'utf-8')).toBe('new\n')
  })

  it('creates a directory', async () => {
    const p = path.join(root, 'created-dir')
    const res = await request(app).post('/api/files').send({ path: p, type: 'directory' })
    expect(res.status).toBe(200)
    expect(res.body.isDirectory).toBe(true)
    expect(fs.statSync(p).isDirectory()).toBe(true)
  })

  it('rejects an existing target with 409', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: path.join(root, 'hello.txt'), type: 'file' })
    expect(res.status).toBe(409)
  })

  it('rejects a missing or invalid body with 400', async () => {
    const res = await request(app).post('/api/files').send({ type: 'file' })
    expect(res.status).toBe(400)
    const badType = await request(app)
      .post('/api/files')
      .send({ path: path.join(root, 'x.txt'), type: 'symlink' })
    expect(badType.status).toBe(400)
  })

  it('denies creation outside the root with 403', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: path.join(base, 'evil.txt'), type: 'file' })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'evil.txt'))).toBe(false)
  })

  it('denies creation via traversal with 403', async () => {
    const res = await request(app).post('/api/files').send({ path: '../escape.txt', type: 'file' })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'escape.txt'))).toBe(false)
  })

  it('denies creation through a symlinked parent with 403', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: path.join(root, 'link-dir', 'evil.txt'), type: 'file' })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'evil.txt'))).toBe(false)
  })

  it('denies an absolute target outside the root with 403', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: '/etc/hostname-evil', type: 'file' })
    expect(res.status).toBe(403)
  })

  it('rejects content larger than the size limit with 413 and creates nothing', async () => {
    const p = path.join(root, 'huge.txt')
    const res = await request(app)
      .post('/api/files')
      .send({ path: p, type: 'file', content: 'a'.repeat(1_200_000) }) // > 1 MB limit
    expect(res.status).toBe(413)
    expect(fs.existsSync(p)).toBe(false)
  })

  it('returns 404 when the parent directory does not exist', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: path.join(root, 'nope', 'x.txt'), type: 'file' })
    expect(res.status).toBe(404)
    expect(fs.existsSync(path.join(root, 'nope'))).toBe(false)
  })

  it('refuses to create over an existing symlink without touching its target', async () => {
    const target = path.join(root, 'link-target.txt')
    fs.writeFileSync(target, 'precious\n')
    const link = path.join(root, 'link-conflict')
    fs.symlinkSync('link-target.txt', link)
    const res = await request(app)
      .post('/api/files')
      .send({ path: link, type: 'file', content: 'overwrite\n' })
    expect(res.status).toBe(409)
    // Without the lstat check, writeFileSync would follow the link and clobber its target.
    expect(fs.readFileSync(target, 'utf-8')).toBe('precious\n')
  })

  it('denies creation at a symlink that points outside the root with 403', async () => {
    const res = await request(app)
      .post('/api/files')
      .send({ path: path.join(root, 'link-out'), type: 'file' })
    expect(res.status).toBe(403)
    expect(fs.readFileSync(path.join(base, 'outside.txt'), 'utf-8')).toBe('OUTSIDE SECRET\n')
  })
})

describe('POST /api/rename', () => {
  it('renames a file within the root', async () => {
    const from = path.join(root, 'rename-me.txt')
    fs.writeFileSync(from, 'x\n')
    const to = path.join(root, 'renamed.txt')
    const res = await request(app).post('/api/rename').send({ from, to })
    expect(res.status).toBe(200)
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readFileSync(to, 'utf-8')).toBe('x\n')
  })

  it('moves a file into a subdirectory', async () => {
    const from = path.join(root, 'move-me.txt')
    fs.writeFileSync(from, 'y\n')
    const to = path.join(root, 'sub', 'moved.txt')
    const res = await request(app).post('/api/rename').send({ from, to })
    expect(res.status).toBe(200)
    expect(fs.readFileSync(to, 'utf-8')).toBe('y\n')
  })

  it('rejects an existing destination with 409', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(root, 'hello.txt'), to: path.join(root, 'tokenfile.txt') })
    expect(res.status).toBe(409)
  })

  it('denies renaming outside the root with 403', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(root, 'hello.txt'), to: path.join(base, 'stolen.txt') })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'stolen.txt'))).toBe(false)
  })

  it('returns 404 for a missing source', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(root, 'ghost.txt'), to: path.join(root, 'ghost2.txt') })
    expect(res.status).toBe(404)
  })

  it('rejects renaming a directory into its own subtree with 400', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(root, 'sub'), to: path.join(root, 'sub', 'inner') })
    expect(res.status).toBe(400)
  })

  it('renames a directory and keeps its children intact', async () => {
    const from = path.join(root, 'dir-a')
    fs.mkdirSync(from)
    fs.writeFileSync(path.join(from, 'child.txt'), 'c\n')
    const to = path.join(root, 'dir-b')
    const res = await request(app).post('/api/rename').send({ from, to })
    expect(res.status).toBe(200)
    expect(res.body.isDirectory).toBe(true)
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readFileSync(path.join(to, 'child.txt'), 'utf-8')).toBe('c\n')
  })

  it('denies a source outside the root with 403', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(base, 'outside.txt'), to: path.join(root, 'stolen2.txt') })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'outside.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'stolen2.txt'))).toBe(false)
  })

  it('rejects a body missing from/to with 400', async () => {
    const res = await request(app).post('/api/rename').send({ to: path.join(root, 'x.txt') })
    expect(res.status).toBe(400)
  })

  it('denies a destination through a symlinked parent with 403', async () => {
    const res = await request(app)
      .post('/api/rename')
      .send({ from: path.join(root, 'hello.txt'), to: path.join(root, 'link-dir', 'evil2.txt') })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(base, 'evil2.txt'))).toBe(false)
  })
})

describe('DELETE /api/files', () => {
  it('deletes a file', async () => {
    const p = path.join(root, 'doomed.txt')
    fs.writeFileSync(p, 'bye\n')
    const res = await request(app).delete('/api/files').query({ path: p })
    expect(res.status).toBe(200)
    expect(fs.existsSync(p)).toBe(false)
  })

  it('deletes a directory recursively', async () => {
    const dir = path.join(root, 'doomed-dir')
    fs.mkdirSync(path.join(dir, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'inner', 'f.txt'), 'x\n')
    const res = await request(app).delete('/api/files').query({ path: dir })
    expect(res.status).toBe(200)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('refuses to delete the allowed root with 403', async () => {
    const res = await request(app).delete('/api/files').query({ path: root })
    expect(res.status).toBe(403)
    expect(fs.existsSync(root)).toBe(true)
  })

  it('denies deletion outside the root with 403', async () => {
    const res = await request(app).delete('/api/files').query({ path: base })
    expect(res.status).toBe(403)
    expect(fs.existsSync(base)).toBe(true)
  })

  it('returns 404 for a missing path', async () => {
    const res = await request(app).delete('/api/files').query({ path: path.join(root, 'ghost.txt') })
    expect(res.status).toBe(404)
  })

  it('rejects a missing path param with 400', async () => {
    const res = await request(app).delete('/api/files')
    expect(res.status).toBe(400)
  })

  it('deletes a nested file while keeping the parent directory', async () => {
    const dir = path.join(root, 'del-nested')
    fs.mkdirSync(dir)
    const p = path.join(dir, 'f.txt')
    fs.writeFileSync(p, 'x\n')
    const res = await request(app).delete('/api/files').query({ path: p })
    expect(res.status).toBe(200)
    expect(fs.existsSync(p)).toBe(false)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })
})

describe('POST /api/tf/run', () => {
  // root is only known after the top-level beforeAll runs, so resolve lazily.
  const tfDir = (name) => path.join(root, 'tf', name)

  it('rejects a missing command with 400', async () => {
    const res = await request(app).post('/api/tf/run').send({ path: tfDir('plan') })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown command (destroy is not whitelisted) with 400', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'destroy', path: tfDir('plan') })
    expect(res.status).toBe(400)
  })

  it('rejects a prototype-polluting command name with 400', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'constructor', path: tfDir('plan') })
    expect(res.status).toBe(400)
  })

  it('rejects a missing path with 400', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'plan' })
    expect(res.status).toBe(400)
  })

  it('denies paths outside the root with 403', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: '/etc' })
    expect(res.status).toBe(403)
  })

  it('denies running through a symlink escaping the root with 403', async () => {
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'plan', path: path.join(root, 'link-dir') })
    expect(res.status).toBe(403)
  })

  it('returns 404 for a missing directory', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: path.join(root, 'nope') })
    expect(res.status).toBe(404)
  })

  it('rejects a file (not directory) with 400', async () => {
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'plan', path: path.join(root, 'hello.txt') })
    expect(res.status).toBe(400)
  })

  it('fmt rewrites .tf files and returns before/after content', async () => {
    const dir = tfDir('fmt')
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "a" "b" {\n  count = 1   \n}\n')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'clean.tf'), 'output "ok" {}\n')

    const res = await request(app).post('/api/tf/run').send({ command: 'fmt', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.command).toBe('fmt')
    expect(res.body.changedFiles).toHaveLength(1)
    const changed = res.body.changedFiles[0]
    expect(changed.path.endsWith(path.join('tf', 'fmt', 'main.tf'))).toBe(true)
    expect(changed.before).toBe('resource "a" "b" {\n  count = 1   \n}\n')
    expect(changed.after).toBe('resource "a" "b" {\n  count = 1\n}\n')
    expect(fs.readFileSync(path.join(dir, 'main.tf'), 'utf-8')).toBe(changed.after)
  })

  it('fmt reports no changes when everything is already formatted', async () => {
    const dir = tfDir('fmt')
    const res = await request(app).post('/api/tf/run').send({ command: 'fmt', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.changedFiles).toHaveLength(0)
  })

  it('validate reports a valid configuration', async () => {
    const dir = tfDir('valid')
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "ok" "fine" {}\n')
    const res = await request(app).post('/api/tf/run').send({ command: 'validate', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.valid).toBe(true)
    expect(res.body.errorCount).toBe(0)
  })

  it('validate reports diagnostics for an invalid configuration', async () => {
    const dir = tfDir('invalid')
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "bad" "x" {\n  value = INVALID\n}\n')
    const res = await request(app).post('/api/tf/run').send({ command: 'validate', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.valid).toBe(false)
    expect(res.body.errorCount).toBe(1)
    expect(res.body.diagnostics[0].summary).toContain('Invalid reference')
  })

  it('plan returns output and exit code', async () => {
    const dir = tfDir('plan')
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "p" "q" {}\n')
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.timedOut).toBe(false)
    expect(res.body.output).toContain('Plan: 1 to add')
  })

  it('rejects a concurrent run for the same directory with 409', async () => {
    const dir = tfDir('plan')
    const [a, b] = await Promise.all([
      request(app).post('/api/tf/run').send({ command: 'plan', path: dir }),
      request(app).post('/api/tf/run').send({ command: 'plan', path: dir })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('refuses a git checkout in the project while terraform is running', async () => {
    const dir = tfDir('locked')
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "s" "t" {}\n')
    fs.writeFileSync(path.join(dir, '.slow-plan'), '')
    const plan = request(app).post('/api/tf/run').send({ command: 'plan', path: dir }).then(r => r)
    await new Promise(resolve => setTimeout(resolve, 300))
    const checkout = await request(app).post('/api/git/checkout').send({ path: dir, ref: 'other' })
    expect(checkout.status).toBe(409)
    expect(checkout.body.error).toContain('terraform')
    expect(fs.existsSync(path.join(dir, '.git', 'op-log'))).toBe(false)
    await plan
  }, 15_000)

  it('refuses a git checkout at the repository root while terraform runs in a folder inside it', async () => {
    const repoRoot = tfDir('locked-repo')
    const project = path.join(repoRoot, 'infra')
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true })
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'main.tf'), 'resource "s" "t" {}\n')
    fs.writeFileSync(path.join(project, '.slow-plan'), '')
    const plan = request(app).post('/api/tf/run').send({ command: 'plan', path: project }).then(r => r)
    await new Promise(resolve => setTimeout(resolve, 300))
    const checkout = await request(app).post('/api/git/checkout').send({ path: repoRoot, ref: 'other' })
    expect(checkout.status).toBe(409)
    await plan
  }, 15_000)

  it('kills a plan that exceeds the timeout', async () => {
    const dir = tfDir('slow')
    fs.writeFileSync(path.join(dir, 'main.tf'), 'resource "s" "t" {}\n')
    fs.writeFileSync(path.join(dir, '.slow-plan'), '')
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.timedOut).toBe(true)
    expect(res.body.exitCode).toBeNull()
  }, 15_000)
})

describe('POST /api/tf/run (lifecycle)', () => {
  const tfDir = (name) => path.join(root, 'tf', name)

  it('init runs with fixed args and reports success', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, '.init-log'), { force: true })
    const res = await request(app).post('/api/tf/run').send({ command: 'init', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.output).toContain('successfully initialized')
    expect(fs.readFileSync(path.join(dir, '.init-log'), 'utf-8').trim()).toBe('init -input=false -no-color')
  })

  it('plan-json parses the NDJSON stream into a summary and resource list', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, '.plan-nochanges'), { force: true })
    const res = await request(app).post('/api/tf/run').send({ command: 'plan-json', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.summary).toEqual({ add: 1, update: 1, replace: 1, destroy: 0 })
    expect(res.body.resources).toHaveLength(3)
    const web = res.body.resources.find(r => r.address === 'aws_instance.web')
    expect(web.actions).toEqual(['create'])
    expect(web.type).toBe('aws_instance')
    expect(web.name).toBe('web')

    // Plan deep-dive: per-resource attribute diffs from before/after.
    // Create with a known after → each attribute gets its own row (null → value).
    expect(web.changes).toEqual([{ path: 'instance_type', before: null, after: 't2.micro' }])

    const logs = res.body.resources.find(r => r.address === 'aws_s3_bucket.logs')
    // Update: changed value plus a value only known after apply (after_unknown).
    expect(logs.changes).toEqual([
      { path: 'bucket', before: 'logs-old', after: 'logs-new' },
      { path: 'acl', before: 'private', after: null, unknown: true }
    ])

    // Replace without before/after in the fixture → no attribute rows.
    const old = res.body.resources.find(r => r.address === 'aws_iam_role.old')
    expect(old.changes).toEqual([])
  })

  it('plan-json reports an empty summary when nothing changes', async () => {
    const dir = tfDir('valid')
    fs.writeFileSync(path.join(dir, '.plan-nochanges'), '')
    try {
      const res = await request(app).post('/api/tf/run').send({ command: 'plan-json', path: dir })
      expect(res.status).toBe(200)
      expect(res.body.summary).toEqual({ add: 0, update: 0, replace: 0, destroy: 0 })
      expect(res.body.resources).toEqual([])
    } finally {
      fs.rmSync(path.join(dir, '.plan-nochanges'), { force: true })
    }
  })

  it('output parses JSON outputs and flags sensitive values', async () => {
    const dir = tfDir('valid')
    const res = await request(app).post('/api/tf/run').send({ command: 'output', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.outputs.env.value).toBe('prod')
    expect(res.body.outputs.secret_key.sensitive).toBe(true)
  })

  it('state-list returns the resource addresses from state', async () => {
    const dir = tfDir('valid')
    const res = await request(app).post('/api/tf/run').send({ command: 'state-list', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.addresses).toEqual(['aws_instance.web', 'module.vpc.aws_subnet.private[0]'])
  })

  it('state-show returns the state for a valid address (including indexed ones)', async () => {
    const dir = tfDir('valid')
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'state-show', path: dir, address: 'module.vpc.aws_subnet.private[0]' })
    expect(res.status).toBe(200)
    expect(res.body.address).toBe('module.vpc.aws_subnet.private[0]')
    expect(res.body.output).toContain('Resource address: module.vpc.aws_subnet.private[0]')
  })

  it.each(['', 'aws_instance.web;rm -rf /', '../etc/passwd', 'a b', '.hidden', 'aws_instance.web/'])(
    'state-show rejects an invalid address (%s) with 400 without spawning terraform',
    async (address) => {
      const dir = tfDir('valid')
      fs.rmSync(path.join(dir, '.apply-log'), { force: true })
      const res = await request(app).post('/api/tf/run').send({ command: 'state-show', path: dir, address })
      expect(res.status).toBe(400)
    },
  )

  it('plan-file writes the execution plan to tf.plan in the directory', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, 'tf.plan'), { force: true })
    const res = await request(app).post('/api/tf/run').send({ command: 'plan-file', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(fs.existsSync(path.join(dir, 'tf.plan'))).toBe(true)
  })

  it('apply applies the saved plan file with fixed args', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, '.apply-log'), { force: true })
    await request(app).post('/api/tf/run').send({ command: 'plan-file', path: dir })
    const res = await request(app).post('/api/tf/run').send({ command: 'apply', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.output).toContain('Apply complete')
    expect(fs.readFileSync(path.join(dir, '.apply-log'), 'utf-8').trim()).toBe('apply -input=false -no-color tf.plan')
  })

  it('apply fails cleanly when no plan file exists', async () => {
    const dir = tfDir('slow')
    fs.rmSync(path.join(dir, 'tf.plan'), { force: true })
    const res = await request(app).post('/api/tf/run').send({ command: 'apply', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(1)
    expect(res.body.output).toContain('not found')
  })
})

describe('POST /api/tf/run (new commands)', () => {
  const tfDir = (name) => path.join(root, 'tf', name)

  it('version parses terraform version -json into version + platform', async () => {
    const dir = tfDir('valid')
    const res = await request(app).post('/api/tf/run').send({ command: 'version', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.version).toBe('1.9.8')
    expect(res.body.platform).toBe('linux_amd64')
  })

  it('init-upgrade runs init with -upgrade and appends backend-config pairs', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, '.init-log'), { force: true })
    const res = await request(app)
      .post('/api/tf/run')
      .send({
        command: 'init-upgrade',
        path: dir,
        backendConfig: [
          { key: 'bucket', value: 'my-bucket' },
          { key: 'region', value: 'us-east-1' }
        ]
      })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(dir, '.init-log'), 'utf-8').trim()).toBe(
      'init -input=false -no-color -upgrade -backend-config=bucket=my-bucket -backend-config=region=us-east-1'
    )
  })

  it('workspace-list parses names and marks the current workspace', async () => {
    const dir = tfDir('valid')
    const res = await request(app).post('/api/tf/run').send({ command: 'workspace-list', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.workspaces).toEqual([
      { name: 'default', current: true },
      { name: 'staging', current: false },
      { name: 'prod', current: false }
    ])
  })

  it('show-plan renders the saved plan file with fixed args (fails without tf.plan)', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, 'tf.plan'), { force: true })
    const missing = await request(app).post('/api/tf/run').send({ command: 'show-plan', path: dir })
    expect(missing.status).toBe(200)
    expect(missing.body.exitCode).toBe(1)
    expect(missing.body.output).toContain('not found')

    fs.writeFileSync(path.join(dir, 'tf.plan'), '')
    const res = await request(app).post('/api/tf/run').send({ command: 'show-plan', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(dir, '.show-log'), 'utf-8').trim()).toBe('show -no-color tf.plan')
    expect(res.body.output).toContain('will be created')
  })

  it('plan-file-destroy saves a destroy plan to tf.plan', async () => {
    const dir = tfDir('plan')
    fs.rmSync(path.join(dir, 'tf.plan'), { force: true })
    const res = await request(app).post('/api/tf/run').send({ command: 'plan-file-destroy', path: dir })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(fs.existsSync(path.join(dir, 'tf.plan'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.plan-args'), 'utf-8').trim()).toBe(
      'plan -input=false -no-color -destroy -out=tf.plan'
    )
    expect(res.body.output).toContain('1 to destroy')
  })

  it('import passes the address and existing ID as fixed args', async () => {
    const dir = tfDir('valid')
    fs.rmSync(path.join(dir, '.import-log'), { force: true })
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'import', path: dir, address: 'aws_s3_bucket.logs', importId: 'my-bucket-id' })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    expect(res.body.address).toBe('aws_s3_bucket.logs')
    expect(fs.readFileSync(path.join(dir, '.import-log'), 'utf-8').trim()).toBe(
      'import -input=false -no-color aws_s3_bucket.logs my-bucket-id'
    )
  })

  it('state-mv passes source and destination addresses', async () => {
    const dir = tfDir('valid')
    fs.rmSync(path.join(dir, '.state-mv-log'), { force: true })
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'state-mv', path: dir, srcAddress: 'aws_instance.web', destAddress: 'aws_instance.web2' })
    expect(res.status).toBe(200)
    expect(res.body.srcAddress).toBe('aws_instance.web')
    expect(res.body.destAddress).toBe('aws_instance.web2')
    expect(fs.readFileSync(path.join(dir, '.state-mv-log'), 'utf-8').trim()).toBe(
      'state mv -no-color aws_instance.web aws_instance.web2'
    )
  })

  it('state-rm removes with -force (no interactive prompt)', async () => {
    const dir = tfDir('valid')
    fs.rmSync(path.join(dir, '.state-rm-log'), { force: true })
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'state-rm', path: dir, address: 'aws_instance.web' })
    expect(res.status).toBe(200)
    expect(res.body.address).toBe('aws_instance.web')
    expect(fs.readFileSync(path.join(dir, '.state-rm-log'), 'utf-8').trim()).toBe(
      'state rm -input=false -no-color -force aws_instance.web'
    )
  })

  it('console-eval pipes the expression via stdin, never argv', async () => {
    const dir = tfDir('valid')
    fs.rmSync(path.join(dir, '.console-stdin'), { force: true })
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'console-eval', path: dir, expression: '1 + 1' })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)
    // The fake records stdin verbatim; the server appends a trailing newline.
    expect(fs.readFileSync(path.join(dir, '.console-stdin'), 'utf-8')).toBe('1 + 1\n')
    expect(res.body.output).toContain('2')
  })

  it('workspace-new and workspace-select pass the validated name', async () => {
    const dir = tfDir('valid')
    fs.rmSync(path.join(dir, '.ws-log'), { force: true })
    const created = await request(app)
      .post('/api/tf/run')
      .send({ command: 'workspace-new', path: dir, name: 'staging' })
    expect(created.status).toBe(200)
    expect(created.body.name).toBe('staging')
    const selected = await request(app)
      .post('/api/tf/run')
      .send({ command: 'workspace-select', path: dir, name: 'prod' })
    expect(selected.status).toBe(200)
    expect(selected.body.name).toBe('prod')
    // The fake overwrites the log per run; only the last invocation is recorded.
    expect(fs.readFileSync(path.join(dir, '.ws-log'), 'utf-8').trim()).toBe('workspace select -no-color prod')
  })

  it.each(['', 'a b', '../escape', 'name;rm -rf /', 'x'.repeat(256)])(
    'rejects an invalid workspace name (%s) with 400 without spawning terraform',
    async (name) => {
      const dir = tfDir('valid')
      fs.rmSync(path.join(dir, '.ws-log'), { force: true })
      const res = await request(app).post('/api/tf/run').send({ command: 'workspace-new', path: dir, name })
      expect(res.status).toBe(400)
    }
  )

  it('import rejects a missing or option-like resource ID with 400', async () => {
    const dir = tfDir('valid')
    for (const importId of ['', '-auto-approve']) {
      const res = await request(app)
        .post('/api/tf/run')
        .send({ command: 'import', path: dir, address: 'aws_s3_bucket.logs', importId })
      expect(res.status).toBe(400)
    }
  })

  it('state-mv rejects an invalid destination address with 400', async () => {
    const dir = tfDir('valid')
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'state-mv', path: dir, srcAddress: 'aws_instance.web', destAddress: '../etc/passwd' })
    expect(res.status).toBe(400)
  })

  it('console-eval rejects empty and oversized expressions with 400', async () => {
    const dir = tfDir('valid')
    for (const expression of ['', '   ', 'a'.repeat(4097)]) {
      const res = await request(app)
        .post('/api/tf/run')
        .send({ command: 'console-eval', path: dir, expression })
      expect(res.status).toBe(400)
    }
  })

  it('rejects var-file for commands that do not accept it with 400', async () => {
    const dir = tfDir('valid')
    fs.writeFileSync(path.join(dir, 'prod.tfvars'), 'env = "prod"\n')
    const res = await request(app).post('/api/tf/run').send({ command: 'output', path: dir, varFile: 'prod.tfvars' })
    expect(res.status).toBe(400)
  })

  it('plan passes an existing var-file and rejects a missing one with 400', async () => {
    const dir = tfDir('plan')
    fs.writeFileSync(path.join(dir, 'prod.tfvars'), 'env = "prod"\n')
    const ok = await request(app).post('/api/tf/run').send({ command: 'plan', path: dir, varFile: 'prod.tfvars' })
    expect(ok.status).toBe(200)
    expect(fs.readFileSync(path.join(dir, '.plan-args'), 'utf-8').trim()).toBe('plan -no-color -var-file=prod.tfvars')

    const missing = await request(app).post('/api/tf/run').send({ command: 'plan', path: dir, varFile: 'nope.tfvars' })
    expect(missing.status).toBe(400)
  })

  it('rejects a malformed var-file name (traversal) with 400', async () => {
    const dir = tfDir('plan')
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: dir, varFile: '../evil.tfvars' })
    expect(res.status).toBe(400)
  })

  it('rejects backend-config for non-init commands with 400', async () => {
    const dir = tfDir('plan')
    const res = await request(app)
      .post('/api/tf/run')
      .send({ command: 'plan', path: dir, backendConfig: [{ key: 'bucket', value: 'b' }] })
    expect(res.status).toBe(400)
  })

  it('rejects malformed backend-config pairs with 400', async () => {
    const dir = tfDir('plan')
    for (const backendConfig of [
      [{ key: '', value: 'b' }], // empty key
      [{ key: 'bad key', value: 'b' }], // space in key
      [{ key: 'k', value: 'x'.repeat(513) }], // oversized value
      { not: 'an array' }, // wrong shape
      'not-json{' // undecodable string form (the stream endpoint path)
    ]) {
      const res = await request(app).post('/api/tf/run').send({ command: 'init', path: dir, backendConfig })
      expect(res.status).toBe(400)
    }
  })

  it('run-stream validates the same way and streams new commands (version)', async () => {
    const dir = tfDir('valid')
    const res = await request(app).get('/api/tf/run-stream').query({ command: 'version', path: dir })
    expect(res.status).toBe(200)
    const events = res.text
      .split('\n\n')
      .map(e => e.replace(/^data:\s*/, ''))
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    const done = events.find(e => e.type === 'done')
    expect(done.status).toBe(200)
    expect(done.result.version).toBe('1.9.8')

    // Query-string form of backendConfig is rejected for non-init commands too.
    const bad = await request(app)
      .get('/api/tf/run-stream')
      .query({ command: 'plan', path: dir, backendConfig: JSON.stringify([{ key: 'bucket', value: 'b' }]) })
    expect(bad.status).toBe(400)
  })
})

describe('GET /api/tf/state-info', () => {
  const tfDir = (name) => path.join(root, 'tf', name)

  it('reports uninitialized when .terraform is missing', async () => {
    const dir = tfDir('invalid')
    fs.rmSync(path.join(dir, '.terraform'), { recursive: true, force: true })
    fs.rmSync(path.join(dir, 'terraform.tfstate'), { force: true })
    const res = await request(app).get('/api/tf/state-info').query({ path: dir })
    expect(res.status).toBe(200)
    expect(res.body.initialized).toBe(false)
    expect(res.body.backend).toBeNull()
    expect(res.body.localState).toBeNull()
  })

  it('reports the local backend and local state stats', async () => {
    const dir = tfDir('valid')
    fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.terraform', 'terraform.tfstate'),
      JSON.stringify({ backend: { type: 'local', config: {} } })
    )
    fs.writeFileSync(
      path.join(dir, 'terraform.tfstate'),
      JSON.stringify({ serial: 7, resources: [{}, {}, {}] })
    )
    const res = await request(app).get('/api/tf/state-info').query({ path: dir })
    expect(res.status).toBe(200)
    expect(res.body.initialized).toBe(true)
    expect(res.body.backend.type).toBe('local')
    expect(res.body.localState).toEqual({ exists: true, resources: 3, serial: 7 })
  })

  it('reports a remote backend with credential-looking values redacted', async () => {
    const dir = tfDir('plan')
    fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.terraform', 'terraform.tfstate'),
      JSON.stringify({
        backend: { type: 's3', config: { bucket: 'my-bucket', region: 'us-east-1', secret_key: 'SUPERSECRET' } }
      })
    )
    const res = await request(app).get('/api/tf/state-info').query({ path: dir })
    expect(res.status).toBe(200)
    expect(res.body.backend.type).toBe('s3')
    expect(res.body.backend.config.bucket).toBe('my-bucket')
    expect(res.body.backend.config.secret_key).toBe('(redacted)')
  })

  it('denies paths outside the root with 403', async () => {
    const res = await request(app).get('/api/tf/state-info').query({ path: '/etc' })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/tf/var-files', () => {
  it('lists top-level tfvars files and flags the auto-loaded ones', async () => {
    const dir = path.join(root, 'tf', 'varfiles')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'terraform.tfvars'), 'env = "prod"\n')
    fs.writeFileSync(path.join(dir, 'staging.auto.tfvars'), 'env = "staging"\n')
    fs.writeFileSync(path.join(dir, 'prod.tfvars'), 'env = "prod2"\n')
    fs.writeFileSync(path.join(dir, 'sub', 'inner.tfvars'), 'nested — must not appear\n')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a var file\n')

    const res = await request(app).get('/api/tf/var-files').query({ path: dir })
    expect(res.status).toBe(200)
    expect(res.body.files).toEqual([
      { name: 'prod.tfvars', autoLoaded: false },
      { name: 'staging.auto.tfvars', autoLoaded: true },
      { name: 'terraform.tfvars', autoLoaded: true }
    ])
  })

  it('returns an empty list when there are no tfvars files', async () => {
    const dir = path.join(root, 'tf', 'slow')
    const res = await request(app).get('/api/tf/var-files').query({ path: dir })
    expect(res.status).toBe(200)
    expect(res.body.files).toEqual([])
  })
})

describe('cloud credentials & login (/api/cloud/*)', () => {
  // The global store lives in TF_CODE_CRED_DIR (a fixture dir set in the top
  // beforeAll); fake aws/az/gcloud CLIs on PATH log to FAKE_CLI_LOG_DIR.
  const PASS = 'correct-horse-battery'
  const AWS_CREDS = {
    aws: { accessKeyId: 'AKIAEXAMPLE123', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCyEXAMPLEKEY', sessionToken: '', region: '' }
  }
  const AZURE_CREDS = { azure: { clientId: 'cid-1', clientSecret: 'sec-1', tenantId: 'ten-1', subscriptionId: 'sub-fake' } }
  const SA_JSON = JSON.stringify({ type: 'service_account', project_id: 'demo-project', private_key_id: 'pk-1', client_email: 'sa@demo-project.iam.gserviceaccount.com' })

  const storeFile = () => path.join(process.env.TF_CODE_CRED_DIR, 'credentials.enc')
  const cliLog = (name) => {
    try {
      return fs.readFileSync(path.join(process.env.FAKE_CLI_LOG_DIR, name), 'utf-8')
    } catch {
      return ''
    }
  }

  beforeAll(() => {
    fs.mkdirSync(path.join(root, 'tf', 'creds'), { recursive: true })
  })

  // The fake terraform records the credential env vars it was spawned with.
  const credEnv = () => {
    try {
      return fs.readFileSync(path.join(root, 'tf', 'creds', '.cred-env'), 'utf-8')
    } catch {
      return null
    }
  }

  it('reports no store and no sessions initially', async () => {
    const res = await request(app).get('/api/cloud/status')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ exists: false, providers: [], unlocked: false, sessions: {} })
  })

  it('rejects a short passphrase on create with 400', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: 'short', credentials: AWS_CREDS })
    expect(res.status).toBe(400)
  })

  it('rejects unknown provider fields with 400', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: PASS, credentials: { aws: { accessKeyId: 'x', bogusField: 'y' } } })
    expect(res.status).toBe(400)
  })

  it('rejects an empty credential payload with 400', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: PASS, credentials: {} })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid GCP service-account JSON with 400', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: PASS, credentials: { gcp: { serviceAccountJson: 'not-json' } } })
    expect(res.status).toBe(400)
  })

  it('creates the encrypted store and never echoes the secret back', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: PASS, credentials: AWS_CREDS })
    expect(res.status).toBe(200)
    expect(res.body.exists).toBe(true)
    expect(res.body.providers).toEqual(['aws'])
    expect(res.body.unlocked).toBe(false)
    // The response must not contain the secret.
    expect(JSON.stringify(res.body)).not.toContain('wJalrXUtnFEMI')

    const raw = fs.readFileSync(storeFile(), 'utf-8')
    // The on-disk store is ciphertext: no plaintext secret or passphrase anywhere.
    expect(raw).not.toContain('wJalrXUtnFEMI')
    expect(raw).not.toContain(PASS)
    const parsed = JSON.parse(raw)
    expect(parsed.v).toBe(1)
    expect(parsed.kdf.name).toBe('scrypt')
    // A .gitignore protects the store dir from accidental commits.
    expect(fs.readFileSync(path.join(process.env.TF_CODE_CRED_DIR, '.gitignore'), 'utf-8')).toContain('*')
  })

  it('rejects a second create with 409', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'create', passphrase: PASS, credentials: AWS_CREDS })
    expect(res.status).toBe(409)
  })

  it('login while locked without a passphrase fails (401)', async () => {
    const res = await request(app).post('/api/cloud/login').send({ provider: 'aws' })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('locked')
  })

  it('login with the passphrase unlocks and authenticates against AWS via the CLI', async () => {
    const res = await request(app).post('/api/cloud/login').send({ provider: 'aws', passphrase: PASS })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.session.identity).toContain('arn:aws:iam::123456789012:user/test')

    // The fake CLI saw the credentials via env (never argv).
    const log = cliLog('aws.log')
    expect(log).toContain('args: sts get-caller-identity')
    expect(log).toContain('AWS_ACCESS_KEY_ID=AKIAEXAMPLE123')

    const status = await request(app).get('/api/cloud/status')
    expect(status.body.unlocked).toBe(true)
    expect(Object.keys(status.body.sessions)).toEqual(['aws'])
  })

  it('rejects a login for an unregistered provider with 404', async () => {
    const res = await request(app).post('/api/cloud/login').send({ provider: 'azure' })
    expect(res.status).toBe(404)
  })

  it('registers azure and gcp, then logs in to both via their CLIs', async () => {
    const add = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'update', passphrase: PASS, credentials: { ...AZURE_CREDS, gcp: { serviceAccountJson: SA_JSON, projectId: '' } } })
    expect(add.status).toBe(200)
    expect([...add.body.providers].sort()).toEqual(['aws', 'azure', 'gcp'])

    const az = await request(app).post('/api/cloud/login').send({ provider: 'azure' })
    expect(az.status).toBe(200)
    expect(az.body.session.identity).toContain('fake-subscription')
    // az requires the service principal as explicit flags — assert they were passed.
    expect(cliLog('az.log')).toContain('args: login --service-principal --output json --username=cid-1 --password=sec-1 --tenant=ten-1')

    const gcp = await request(app).post('/api/cloud/login').send({ provider: 'gcp' })
    expect(gcp.status).toBe(200)
    expect(gcp.body.session.identity).toContain('sa@demo-project.iam.gserviceaccount.com')
    // The key file persists in the store dir for terraform runs to use.
    const keyFile = path.join(process.env.TF_CODE_CRED_DIR, 'gcp-key.json')
    expect(fs.readFileSync(keyFile, 'utf-8')).toBe(SA_JSON)
  })

  it('injects only session providers into terraform runs', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'version', path: path.join(root, 'tf', 'creds') })
    expect(res.status).toBe(200)
    const envText = credEnv() ?? ''
    expect(envText).toContain('AWS_ACCESS_KEY_ID=AKIAEXAMPLE123')
    expect(envText).toContain('ARM_CLIENT_ID=cid-1')
    expect(envText).toContain('AZURE_CLIENT_SECRET=sec-1')
    expect(envText).toContain(`GOOGLE_APPLICATION_CREDENTIALS=${path.join(process.env.TF_CODE_CRED_DIR, 'gcp-key.json')}`)
    // The key file content is what the provider would read.
    expect(fs.readFileSync(path.join(root, 'tf', 'creds', '.gcp-key-snapshot'), 'utf-8')).toBe(SA_JSON)
  })

  it('logout stops injecting that provider only', async () => {
    const res = await request(app).post('/api/cloud/logout').send({ provider: 'azure' })
    expect(res.status).toBe(200)

    await request(app).post('/api/tf/run').send({ command: 'version', path: path.join(root, 'tf', 'creds') })
    const envText = credEnv() ?? ''
    expect(envText).not.toContain('ARM_CLIENT_ID=cid-1')
    expect(envText).toContain('AWS_ACCESS_KEY_ID=AKIAEXAMPLE123')
  })

  it('lock stops all injection', async () => {
    const res = await request(app).post('/api/cloud/credentials').send({ action: 'lock' })
    expect(res.status).toBe(200)
    expect(res.body.unlocked).toBe(false)

    await request(app).post('/api/tf/run').send({ command: 'version', path: path.join(root, 'tf', 'creds') })
    const envText = credEnv() ?? ''
    expect(envText).not.toContain('AKIAEXAMPLE123')
  })

  it('login reports a rejected AWS key without echoing the secret', async () => {
    const upd = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'update', passphrase: PASS, credentials: { aws: { accessKeyId: 'AKIABADKEY0000', secretAccessKey: 'badsecretvalue99', sessionToken: '', region: '' } } })
    expect(upd.status).toBe(200)
    await request(app).post('/api/cloud/credentials').send({ action: 'unlock', passphrase: PASS })

    const res = await request(app).post('/api/cloud/login').send({ provider: 'aws' })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain('InvalidClientTokenId')
    expect(JSON.stringify(res.body)).not.toContain('badsecretvalue99')
  })

  it('reports a missing CLI with an install hint', async () => {
    process.env.CLOUD_AWS_BIN = 'definitely-missing-cli-xyz'
    try {
      const res = await request(app).post('/api/cloud/login').send({ provider: 'aws' })
      expect(res.status).toBe(401)
      expect(res.body.error).toContain('aws CLI not found')
    } finally {
      delete process.env.CLOUD_AWS_BIN
    }
  })

  it('update merges and removes providers on the global store', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'update', passphrase: PASS, credentials: {}, removeProviders: ['gcp'] })
    expect(res.status).toBe(200)
    expect([...res.body.providers].sort()).toEqual(['aws', 'azure'])

    // The stored values round-trip through a fresh unlock + run.
    await request(app).post('/api/cloud/credentials').send({ action: 'unlock', passphrase: PASS })
    await request(app).post('/api/tf/run').send({ command: 'version', path: path.join(root, 'tf', 'creds') })
    const envText = credEnv() ?? ''
    expect(envText).toContain('AWS_ACCESS_KEY_ID=AKIABADKEY0000')
  })

  it('rejects removing the last remaining provider with 400', async () => {
    const res = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'update', passphrase: PASS, credentials: {}, removeProviders: ['aws', 'azure'] })
    expect(res.status).toBe(400)
  })

  it('change-passphrase re-encrypts and the old passphrase stops working', async () => {
    const bad = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'change-passphrase', oldPassphrase: 'wrong-old-12345', newPassphrase: 'new-passphrase-9' })
    expect(bad.status).toBe(401)

    const ok = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'change-passphrase', oldPassphrase: PASS, newPassphrase: 'new-passphrase-9' })
    expect(ok.status).toBe(200)

    const stale = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'unlock', passphrase: PASS })
    expect(stale.status).toBe(401)
    const fresh = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'unlock', passphrase: 'new-passphrase-9' })
    expect(fresh.status).toBe(200)
  })

  it('delete requires the right passphrase, removes the store and clears sessions', async () => {
    const bad = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'delete', passphrase: 'wrong-pass-123' })
    expect(bad.status).toBe(401)

    const ok = await request(app)
      .post('/api/cloud/credentials')
      .send({ action: 'delete', passphrase: 'new-passphrase-9' })
    expect(ok.status).toBe(200)
    expect(ok.body.exists).toBe(false)
    expect(fs.existsSync(process.env.TF_CODE_CRED_DIR)).toBe(false)

    const status = await request(app).get('/api/cloud/status')
    expect(status.body).toEqual({ exists: false, providers: [], unlocked: false, sessions: {} })
  })
})

describe('allowed roots (/api/roots)', () => {
  // base is only known after the top-level beforeAll runs, so resolve lazily.
  const extra = () => path.join(base, 'extra')

  it('lists the configured root initially', async () => {
    const res = await request(app).get('/api/roots')
    expect(res.status).toBe(200)
    expect(res.body.roots).toContain(root)
  })

  it('denies a path in an unopened folder with 403', async () => {
    const res = await request(app).get('/api/files').query({ path: extra() })
    expect(res.status).toBe(403)
  })

  it('allows a new directory via POST and serves it afterwards', async () => {
    const res = await request(app).post('/api/roots').send({ path: extra() })
    expect(res.status).toBe(200)
    expect(res.body.roots).toContain(extra())

    const list = await request(app).get('/api/files').query({ path: extra() })
    expect(list.status).toBe(200)
    expect(list.body.map(e => e.name)).toContain('note.txt')

    const content = await request(app)
      .get('/api/file-content')
      .query({ path: path.join(extra(), 'note.txt') })
    expect(content.status).toBe(200)
    expect(content.body.content).toBe('extra repo file\n')
  })

  it('is idempotent for the same directory', async () => {
    const res = await request(app).post('/api/roots').send({ path: extra() })
    expect(res.status).toBe(200)
    expect(res.body.roots.filter(r => r === extra())).toHaveLength(1)
  })

  it('still blocks symlink escapes inside an allowed root', async () => {
    const res = await request(app)
      .get('/api/file-content')
      .query({ path: path.join(extra(), 'link-etc') })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('hostname')
  })

  it('refuses to delete a runtime-added root with 403', async () => {
    const res = await request(app).delete('/api/files').query({ path: extra() })
    expect(res.status).toBe(403)
    expect(fs.existsSync(extra())).toBe(true)
  })

  it('rejects a missing directory with 404', async () => {
    const res = await request(app).post('/api/roots').send({ path: path.join(base, 'nope') })
    expect(res.status).toBe(404)
  })

  it('rejects a file (not a directory) with 400', async () => {
    const res = await request(app).post('/api/roots').send({ path: path.join(base, 'outside.txt') })
    expect(res.status).toBe(400)
  })

  it('rejects a missing body path with 400', async () => {
    const res = await request(app).post('/api/roots').send({})
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/roots (remove runtime-added root)', () => {
  let removable = ''

  beforeAll(() => {
    removable = path.join(base, 'removable')
    fs.mkdirSync(removable)
    fs.writeFileSync(path.join(removable, 'inside.txt'), 'in removable\n')
  })

  it('lists runtime-added roots in removableRoots but not the default', async () => {
    await request(app).post('/api/roots').send({ path: removable })
    const res = await request(app).get('/api/roots')
    expect(res.status).toBe(200)
    expect(res.body.roots).toContain(removable)
    expect(res.body.removableRoots ?? []).toContain(removable)
    // The default (BASE_DIR) root is never removable.
    expect(res.body.removableRoots ?? []).not.toContain(root)
  })

  it('removes a runtime-added root and denies access afterwards', async () => {
    await request(app).post('/api/roots').send({ path: removable }) // ensure added
    const del = await request(app).delete('/api/roots').query({ path: removable })
    expect(del.status).toBe(200)
    expect(del.body.roots).not.toContain(removable)
    expect(del.body.removableRoots ?? []).not.toContain(removable)

    // Access is denied again after removal.
    const list = await request(app).get('/api/files').query({ path: removable })
    expect(list.status).toBe(403)
  })

  it('refuses to remove the default root with 400', async () => {
    const res = await request(app).delete('/api/roots').query({ path: root })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('runtime-added')
  })

  it('refuses to remove a directory that is not an allowed root with 400', async () => {
    const res = await request(app).delete('/api/roots').query({ path: path.join(root, 'sub') })
    expect(res.status).toBe(400)
  })

  it('rejects a missing path param with 400', async () => {
    const res = await request(app).delete('/api/roots')
    expect(res.status).toBe(400)
  })

  it('returns 404 for a non-existent root path', async () => {
    const res = await request(app).delete('/api/roots').query({ path: path.join(base, 'does-not-exist-xyz') })
    expect(res.status).toBe(404)
  })
})

describe('tfenv disabled (TFENV_DISABLE=1)', () => {
  it('reports tfenv unavailable and empty version info', async () => {
    const res = await request(app).get('/api/tf/versions').query({ path: root })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tfenvAvailable: false, installed: [], active: null })
  })

  it('refuses to pin a version while disabled', async () => {
    const res = await request(app).post('/api/tf/version').send({ path: root, version: '1.5.0' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('tfenv is not available')
  })
})

describe('tfenv integration', () => {
  // Fake tfenv bin dir (TFENV_BIN): a `tfenv` script emulating list /
  // version-name / install, and a `terraform` shim that reports which
  // .terraform-version it resolved from cwd — mirroring the real mechanism.
  let versionsFile = ''
  let globalFile = ''
  let workDir = ''

  beforeAll(() => {
    const binDir = path.join(base, 'tfenv-bin')
    fs.mkdirSync(binDir)
    versionsFile = path.join(base, 'fake-tfenv-versions.txt')
    globalFile = path.join(base, 'fake-tfenv-global.txt')
    fs.writeFileSync(versionsFile, '1.5.0\n1.9.8\n')
    fs.writeFileSync(globalFile, '1.5.0\n')

    const tfenvScript = `#!/bin/bash
case "$1" in
  list)
    cat "${versionsFile}" 2>/dev/null || true
    exit 0
    ;;
  version-name)
    d="$PWD"
    while [ -n "$d" ] && [ "$d" != "/" ]; do
      if [ -f "$d/.terraform-version" ]; then
        sed -e 's/#.*$//' -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' "$d/.terraform-version" | tr -d '\\r' | head -n 1
        exit 0
      fi
      d=$(dirname "$d")
    done
    cat "${globalFile}" 2>/dev/null || true
    exit 0
    ;;
  install)
    v="$2"
    echo "Installing fake terraform \${v}..." >&2
    if ! grep -qx '$v' "${versionsFile}" 2>/dev/null; then
      echo "$v" >> "${versionsFile}"
    fi
    exit 0
    ;;
esac
exit 2
`

    const tfShim = `#!/bin/bash
active=""
d="$PWD"
while [ -n "$d" ] && [ "$d" != "/" ]; do
  if [ -f "$d/.terraform-version" ]; then active=$(head -n1 "$d/.terraform-version"); break; fi
  d=$(dirname "$d")
done
[ -z "$active" ] && active="$(cat "${globalFile}" 2>/dev/null)"
case "$1" in
  fmt) exit 0 ;;
  validate) printf '{"format_version":"1.0","valid":true,"error_count":0,"warning_count":0,"diagnostics":[]}\\n' ;;
  plan) echo "FAKE-TF active: \${active}"; echo 'Plan: 1 to add, 0 to change, 0 to destroy.'; exit 0 ;;
esac
exit 2
`

    fs.writeFileSync(path.join(binDir, 'tfenv'), tfenvScript)
    fs.chmodSync(path.join(binDir, 'tfenv'), 0o755)
    fs.writeFileSync(path.join(binDir, 'terraform'), tfShim)
    fs.chmodSync(path.join(binDir, 'terraform'), 0o755)

    process.env.TFENV_DISABLE = ''
    process.env.TFENV_BIN = binDir

    workDir = path.join(root, 'tfenv-work')
    fs.mkdirSync(workDir)
  })

  afterAll(() => {
    delete process.env.TFENV_BIN
    process.env.TFENV_DISABLE = '1'
  })

  it('lists installed versions and the active default', async () => {
    const res = await request(app).get('/api/tf/versions').query({ path: workDir })
    expect(res.status).toBe(200)
    expect(res.body.tfenvAvailable).toBe(true)
    expect(res.body.installed).toEqual(['1.5.0', '1.9.8'])
    // No .terraform-version in workDir yet → global default applies.
    expect(res.body.active).toBe('1.5.0')
  })

  it('pins a version for a directory via .terraform-version', async () => {
    const res = await request(app).post('/api/tf/version').send({ path: workDir, version: '1.9.8' })
    expect(res.status).toBe(200)
    expect(res.body.version).toBe('1.9.8')
    expect(fs.readFileSync(path.join(workDir, '.terraform-version'), 'utf-8')).toBe('1.9.8\n')

    const after = await request(app).get('/api/tf/versions').query({ path: workDir })
    expect(after.body.active).toBe('1.9.8')
  })

  it('rejects an invalid version format with 400', async () => {
    for (const bad of ['abc', '1.5.0; rm -rf /', 'latest']) {
      const res = await request(app).post('/api/tf/version').send({ path: workDir, version: bad })
      expect(res.status).toBe(400)
    }
  })

  it('rejects a not-installed version with 400', async () => {
    const res = await request(app).post('/api/tf/version').send({ path: workDir, version: '2.0.0' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not installed')
  })

  it('installs a new version via tfenv install and then allows pinning it', async () => {
    const res = await request(app).post('/api/tf/install').send({ version: '1.10.0' })
    expect(res.status).toBe(200)
    expect(res.body.exitCode).toBe(0)

    const list = await request(app).get('/api/tf/versions').query({ path: workDir })
    expect(list.body.installed).toContain('1.10.0')

    const pin = await request(app).post('/api/tf/version').send({ path: workDir, version: '1.10.0' })
    expect(pin.status).toBe(200)
  })

  it('rejects an invalid install version with 400', async () => {
    const res = await request(app).post('/api/tf/install').send({ version: 'not-a-version' })
    expect(res.status).toBe(400)
  })

  it('runs terraform through the pinned version (shim resolution)', async () => {
    const res = await request(app).post('/api/tf/run').send({ command: 'plan', path: workDir })
    expect(res.status).toBe(200)
    expect(res.body.output).toContain('FAKE-TF active: 1.10.0')
  })

  it('denies pinning outside the allowed roots with 403', async () => {
    const res = await request(app).post('/api/tf/version').send({ path: '/etc', version: '1.5.0' })
    expect(res.status).toBe(403)
  })
})

describe('git operations', () => {
  let repo = '' // status + diff fixture (fake .git with canned outputs)
  let commitRepo = ''
  let cleanRepo = ''
  let filesRepo = ''

  beforeAll(() => {
    const mkRepo = (name, opts = {}) => {
      const dir = path.join(root, name)
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      if (opts.status !== undefined) {
        fs.writeFileSync(path.join(dir, '.git', 'status-fixture'), opts.status)
      }
      for (const [rel, content] of Object.entries(opts.heads ?? {})) {
        const f = path.join(dir, '.git', 'heads', rel)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, content)
      }
      for (const [rel, content] of Object.entries(opts.files ?? {})) {
        const f = path.join(dir, rel)
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, content)
      }
      if (opts.noopAdd) fs.writeFileSync(path.join(dir, '.git', 'noop-add'), '')
      return dir
    }

    // Porcelain -z fixture: worktree-modified, untracked file, staged rename
    // (new\0old record), staged deletion, collapsed untracked directory.
    repo = mkRepo('gitrepo', {
      status: ' M hello.txt\0?? newfile.txt\0R  renamed.txt\0oldname.txt\0D  deleted.txt\0?? sub/\0',
      heads: {
        'hello.txt': 'hello world\n',
        'deleted.txt': 'gone now\n',
        'bin.dat': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      },
      files: {
        'hello.txt': 'hello world changed\n',
        'newfile.txt': 'brand new\n',
      },
    })

    commitRepo = mkRepo('gitcommit', { files: { 'a.txt': 'one\n' } })
    cleanRepo = mkRepo('gitclean', { noopAdd: true, files: { 'c.txt': 'x\n' } })
    filesRepo = mkRepo('gitfiles', { files: { 'keep.txt': 'k\n', 'skip.txt': 's\n' } })
  })

  describe('GET /api/git/status', () => {
    it('reports isRepo:false for a non-repository directory', async () => {
      const res = await request(app).get('/api/git/status').query({ path: root })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ isRepo: false, entries: [] })
    })

    it('parses porcelain -z records including renames', async () => {
      const res = await request(app).get('/api/git/status').query({ path: repo })
      expect(res.status).toBe(200)
      expect(res.body.isRepo).toBe(true)
      expect(res.body.entries).toEqual([
        { index: ' ', worktree: 'M', path: 'hello.txt' },
        { index: '?', worktree: '?', path: 'newfile.txt' },
        { index: 'R', worktree: ' ', path: 'renamed.txt', origPath: 'oldname.txt' },
        { index: 'D', worktree: ' ', path: 'deleted.txt' },
        { index: '?', worktree: '?', path: 'sub/' },
      ])
    })

    it('rejects a missing path param with 400', async () => {
      const res = await request(app).get('/api/git/status')
      expect(res.status).toBe(400)
    })

    it('denies paths outside the root with 403', async () => {
      const res = await request(app).get('/api/git/status').query({ path: '/etc' })
      expect(res.status).toBe(403)
    })

    it('returns 404 for a missing directory', async () => {
      const res = await request(app).get('/api/git/status').query({ path: path.join(root, 'nope') })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/git/diff', () => {
    it('returns HEAD and worktree content for a modified file', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo, file: 'hello.txt' })
      expect(res.status).toBe(200)
      expect(res.body.oldContent).toBe('hello world\n')
      expect(res.body.newContent).toBe('hello world changed\n')
      expect(res.body.untracked).toBe(false)
    })

    it('marks untracked files with empty old content', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo, file: 'newfile.txt' })
      expect(res.status).toBe(200)
      expect(res.body.untracked).toBe(true)
      expect(res.body.oldContent).toBe('')
      expect(res.body.newContent).toBe('brand new\n')
    })

    it('returns empty worktree content for a deleted file', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo, file: 'deleted.txt' })
      expect(res.status).toBe(200)
      expect(res.body.untracked).toBe(false)
      expect(res.body.oldContent).toBe('gone now\n')
      expect(res.body.newContent).toBe('')
    })

    it('returns 404 for a file in neither HEAD nor worktree', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo, file: 'ghost.txt' })
      expect(res.status).toBe(404)
    })

    it('returns 415 for a binary file at HEAD', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo, file: 'bin.dat' })
      expect(res.status).toBe(415)
    })

    it('denies files that escape the allowed root with 403', async () => {
      const res = await request(app)
        .get('/api/git/diff')
        .query({ path: repo, file: '../../outside.txt' })
      expect(res.status).toBe(403)
    })

    it('returns 400 for a directory that is not a repository', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: root, file: 'hello.txt' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('not inside a git repository')
    })

    it('rejects a missing file param with 400', async () => {
      const res = await request(app).get('/api/git/diff').query({ path: repo })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/commit', () => {
    it('stages everything and commits, returning the short hash', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: commitRepo, message: 'first change' })
      expect(res.status).toBe(200)
      expect(res.body.committed).toBe(true)
      expect(res.body.hash).toBe('abc1234')
      expect(fs.readFileSync(path.join(commitRepo, '.git', 'last-commit-msg'), 'utf-8')).toBe('first change\n')
      const addLog = fs.readFileSync(path.join(commitRepo, '.git', 'add-log'), 'utf-8')
      expect(addLog).toContain('add -A')
    })

    it('reports nothing to commit when the tree is clean', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: cleanRepo, message: 'noop' })
      expect(res.status).toBe(200)
      expect(res.body.committed).toBe(false)
      expect(fs.existsSync(path.join(cleanRepo, '.git', 'last-commit-msg'))).toBe(false)
    })

    it('stages only the listed files when provided', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: filesRepo, message: 'partial', files: ['keep.txt'] })
      expect(res.status).toBe(200)
      expect(res.body.committed).toBe(true)
      const addLog = fs.readFileSync(path.join(filesRepo, '.git', 'add-log'), 'utf-8')
      expect(addLog.trim()).toBe('add -- keep.txt')
    })

    it('rejects an empty message with 400', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: commitRepo, message: '   ' })
      expect(res.status).toBe(400)
    })

    it('rejects a missing path with 400', async () => {
      const res = await request(app).post('/api/git/commit').send({ message: 'x' })
      expect(res.status).toBe(400)
    })

    it('rejects a NUL byte in the message with 400', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: commitRepo, message: 'bad\u0000msg' })
      expect(res.status).toBe(400)
    })

    it('denies file lists that escape the allowed root with 403', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: filesRepo, message: 'x', files: ['../../outside.txt'] })
      expect(res.status).toBe(403)
    })

    it('rejects an empty files list with 400', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: filesRepo, message: 'x', files: [] })
      expect(res.status).toBe(400)
    })

    it('fails with 400 outside a repository', async () => {
      const res = await request(app)
        .post('/api/git/commit')
        .send({ path: root, message: 'x' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('git add failed')
    })
  })
})

describe('git history (log + commit-diff)', () => {
  let histRepo = ''
  const HASH_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
  const SHORT_A = 'a1b2c3d'

  beforeAll(() => {
    histRepo = path.join(root, 'histrepo')
    fs.mkdirSync(path.join(histRepo, '.git'), { recursive: true })
    // List-mode log fixture: NUL-separated fields per record, newline records.
    fs.writeFileSync(
      path.join(histRepo, '.git', 'log-fixture'),
      `${HASH_A}\u0000${SHORT_A}\u0000Alice\u0000alice@example.com\u00002026-10-01T10:00:00Z\u0000Add feature\n` +
        `b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3\u0000b2c3d4e\u0000Bob\u0000bob@example.com\u00002026-10-02T11:30:00Z\u0000Fix bug\n`,
    )
    // Metadata-mode fixture (single record, short hash first) for HASH_A.
    fs.writeFileSync(
      path.join(histRepo, '.git', 'commit-meta'),
      `${SHORT_A}\u0000Alice\u0000alice@example.com\u00002026-10-01T10:00:00Z\u0000Add feature\n`,
    )
    // Changed files for HASH_A (tab-separated name-status, no header).
    fs.writeFileSync(
      path.join(histRepo, '.git', 'name-status'),
      `M\tsrc/app.js\nA\tnewfile.txt\nD\toldfile.txt\nR100\toldname.py\trenamed.py\n`,
    )
    // Commit blobs keyed by "<ref>" with "/" -> "_" (mirrors the fake git script).
    const blob = (ref, content) => {
      const f = path.join(histRepo, '.git', 'blobs', ref.replace(/\//g, '_'))
      fs.mkdirSync(path.dirname(f), { recursive: true })
      fs.writeFileSync(f, content)
    }
    blob(`${HASH_A}:src/app.js`, 'console.log("new")\n')
    blob(`${HASH_A}^:src/app.js`, 'console.log("old")\n')
    blob(`${HASH_A}:newfile.txt`, 'brand new\n')
    blob(`${HASH_A}^:oldfile.txt`, 'gone now\n')
    blob(`${HASH_A}:renamed.py`, 'print("renamed")\n')
    blob(`${HASH_A}^:oldname.py`, 'print("old name")\n')
  })

  describe('GET /api/git/log', () => {
    it('returns isRepo:false for a non-repository directory', async () => {
      const res = await request(app).get('/api/git/log').query({ path: root })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ isRepo: false, commits: [] })
    })

    it('parses NUL-separated commit records', async () => {
      const res = await request(app).get('/api/git/log').query({ path: histRepo })
      expect(res.status).toBe(200)
      expect(res.body.isRepo).toBe(true)
      expect(res.body.commits).toEqual([
        { hash: HASH_A, short: SHORT_A, author: 'Alice', email: 'alice@example.com', date: '2026-10-01T10:00:00Z', subject: 'Add feature' },
        { hash: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3', short: 'b2c3d4e', author: 'Bob', email: 'bob@example.com', date: '2026-10-02T11:30:00Z', subject: 'Fix bug' },
      ])
    })

    it('returns an empty list for a repo with no history', async () => {
      const dir = path.join(root, 'hist-empty')
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      const res = await request(app).get('/api/git/log').query({ path: dir })
      expect(res.status).toBe(200)
      expect(res.body.isRepo).toBe(true)
      expect(res.body.commits).toEqual([])
    })

    it('rejects a missing path param with 400', async () => {
      const res = await request(app).get('/api/git/log')
      expect(res.status).toBe(400)
    })

    it('denies paths outside the root with 403', async () => {
      const res = await request(app).get('/api/git/log').query({ path: '/etc' })
      expect(res.status).toBe(403)
    })

    it('returns 400 for a file (not a directory)', async () => {
      const res = await request(app).get('/api/git/log').query({ path: path.join(root, 'hello.txt') })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/git/commit-diff', () => {
    it('returns per-file old/new content for a commit', async () => {
      const res = await request(app).get('/api/git/commit-diff').query({ path: histRepo, hash: HASH_A })
      expect(res.status).toBe(200)
      expect(res.body.hash).toBe(HASH_A)
      expect(res.body.short).toBe(SHORT_A)
      expect(res.body.author).toBe('Alice')
      expect(res.body.email).toBe('alice@example.com')
      expect(res.body.date).toBe('2026-10-01T10:00:00Z')
      expect(res.body.subject).toBe('Add feature')
      expect(res.body.truncated).toBe(false)
      const byPath = Object.fromEntries(res.body.files.map(f => [f.path, f]))
      expect(byPath['src/app.js']).toEqual({ path: 'src/app.js', status: 'M', oldContent: 'console.log("old")\n', newContent: 'console.log("new")\n' })
      expect(byPath['newfile.txt']).toEqual({ path: 'newfile.txt', status: 'A', oldContent: '', newContent: 'brand new\n' })
      expect(byPath['oldfile.txt']).toEqual({ path: 'oldfile.txt', status: 'D', oldContent: 'gone now\n', newContent: '' })
      expect(byPath['renamed.py']).toEqual({ path: 'renamed.py', status: 'R', oldContent: 'print("old name")\n', newContent: 'print("renamed")\n' })
    })

    it('rejects an invalid hash with 400', async () => {
      const res = await request(app).get('/api/git/commit-diff').query({ path: histRepo, hash: 'nothex!' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid commit hash')
    })

    it('returns 400 for a non-repository directory', async () => {
      const res = await request(app).get('/api/git/commit-diff').query({ path: root, hash: HASH_A })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('not inside a git repository')
    })

    it('returns 404 when the commit is not found', async () => {
      const dir = path.join(root, 'hist-missing')
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(dir, '.git', 'commit-missing'), '')
      const res = await request(app).get('/api/git/commit-diff').query({ path: dir, hash: HASH_A })
      expect(res.status).toBe(404)
      expect(res.body.error).toContain('Commit not found')
    })

    it('rejects a missing path param with 400', async () => {
      const res = await request(app).get('/api/git/commit-diff').query({ hash: HASH_A })
      expect(res.status).toBe(400)
    })
  })
})

describe('git branch/remote/sync operations', () => {
  let branchRepo = ''
  let remoteRepo = ''
  let mergeOk = ''
  let mergeConflict = ''
  let rebaseOk = ''
  let rebaseConflict = ''
  let pushFail = ''
  let pullConflict = ''
  let alreadyRepo = ''
  let initTarget = '' // non-repo dir (no .git) for the git init test

  beforeAll(() => {
    const mk = (name, opts = {}) => {
      const dir = path.join(root, name)
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
      if (opts.currentBranch !== undefined) {
        fs.writeFileSync(path.join(dir, '.git', 'current-branch'), `${opts.currentBranch}\n`)
      }
      if (opts.branchesList !== undefined) {
        fs.writeFileSync(path.join(dir, '.git', 'branches-list'), opts.branchesList)
      }
      if (opts.remotes !== undefined) {
        fs.writeFileSync(path.join(dir, '.git', 'remotes-fixture'), opts.remotes)
      }
      for (const marker of opts.markers ?? []) {
        fs.writeFileSync(path.join(dir, '.git', marker), '')
      }
      return dir
    }

    branchRepo = mk('branchrepo', { currentBranch: 'main', branchesList: 'main\nfeature-x\ndev\n' })
    remoteRepo = mk('remoterepo', {
      remotes:
        'origin\thttps://github.com/owner/repo.git (fetch)\n' +
        'origin\thttps://github.com/owner/repo.git (push)\n' +
        'upstream\tgit@gitlab.com:group/proj.git (fetch)\n',
    })
    mergeOk = mk('mergeok', { currentBranch: 'main', branchesList: 'main\nfeature-x\n' })
    mergeConflict = mk('mergeconflict', { markers: ['merge-conflict'] })
    rebaseOk = mk('rebaseok', { currentBranch: 'main', branchesList: 'main\ndev\n' })
    rebaseConflict = mk('rebaseconflict', { markers: ['rebase-conflict'] })
    pushFail = mk('pushfail', { markers: ['push-fail'] })
    pullConflict = mk('pullconflict', { markers: ['pull-conflict'] })
    alreadyRepo = mk('alreadyrepo')

    initTarget = path.join(root, 'init-target')
    fs.mkdirSync(initTarget) // no .git -> not a repository yet
  })

  describe('GET /api/git/branches', () => {
    it('returns the current branch and the local branch list', async () => {
      const res = await request(app).get('/api/git/branches').query({ path: branchRepo })
      expect(res.status).toBe(200)
      expect(res.body.isRepo).toBe(true)
      expect(res.body.current).toBe('main')
      expect(res.body.branches).toEqual(['main', 'feature-x', 'dev'])
    })

    it('reports isRepo:false for a non-repository directory', async () => {
      const res = await request(app).get('/api/git/branches').query({ path: initTarget })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ isRepo: false, current: null, branches: [] })
    })

    it('denies paths outside the root with 403', async () => {
      const res = await request(app).get('/api/git/branches').query({ path: '/etc' })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /api/git/remotes', () => {
    it('lists remotes with platform detection and derived web URLs', async () => {
      const res = await request(app).get('/api/git/remotes').query({ path: remoteRepo })
      expect(res.status).toBe(200)
      expect(res.body.isRepo).toBe(true)
      expect(res.body.remotes.map(r => r.name)).toEqual(['origin', 'upstream'])

      const origin = res.body.remotes.find(r => r.name === 'origin')
      expect(origin.url).toBe('https://github.com/owner/repo.git')
      expect(origin.platform).toBe('github')
      expect(origin.webUrl).toBe('https://github.com/owner/repo')

      const upstream = res.body.remotes.find(r => r.name === 'upstream')
      expect(upstream.url).toBe('git@gitlab.com:group/proj.git')
      expect(upstream.platform).toBe('gitlab')
      expect(upstream.webUrl).toBe('https://gitlab.com/group/proj')
    })

    it('returns an empty list for a repo with no remotes', async () => {
      const res = await request(app).get('/api/git/remotes').query({ path: branchRepo })
      expect(res.status).toBe(200)
      expect(res.body.remotes).toEqual([])
    })

    it('reports isRepo:false for a non-repository directory', async () => {
      const res = await request(app).get('/api/git/remotes').query({ path: initTarget })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ isRepo: false, remotes: [] })
    })
  })

  describe('POST /api/git/branch', () => {
    it('creates a branch without switching (git branch)', async () => {
      const res = await request(app).post('/api/git/branch').send({ path: branchRepo, name: 'hotfix-1' })
      expect(res.status).toBe(200)
      expect(res.body.created).toBe('hotfix-1')
      expect(res.body.switched).toBe(false)
      const log = fs.readFileSync(path.join(branchRepo, '.git', 'op-log'), 'utf-8')
      expect(log.split('\n')).toContain('branch hotfix-1')
    })

    it('creates and switches when switch:true (git checkout -b)', async () => {
      const res = await request(app)
        .post('/api/git/branch')
        .send({ path: branchRepo, name: 'feature/y', switch: true })
      expect(res.status).toBe(200)
      expect(res.body.switched).toBe(true)
      const log = fs.readFileSync(path.join(branchRepo, '.git', 'op-log'), 'utf-8')
      expect(log.split('\n')).toContain('checkout -b feature/y')
    })

    it('rejects invalid branch names with 400', async () => {
      for (const bad of ['-evil', 'a..b', 'x.lock', 'has space', '', 'a/b/']) {
        const res = await request(app).post('/api/git/branch').send({ path: branchRepo, name: bad })
        expect(res.status).toBe(400)
      }
    })

    it('rejects a missing name with 400', async () => {
      const res = await request(app).post('/api/git/branch').send({ path: branchRepo })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/checkout', () => {
    it('switches to an existing branch', async () => {
      const res = await request(app).post('/api/git/checkout').send({ path: branchRepo, ref: 'feature-x' })
      expect(res.status).toBe(200)
      expect(res.body.checkedOut).toBe('feature-x')
      const log = fs.readFileSync(path.join(branchRepo, '.git', 'op-log'), 'utf-8')
      expect(log.split('\n')).toContain('checkout feature-x')
    })

    it('rejects an invalid ref with 400', async () => {
      const res = await request(app).post('/api/git/checkout').send({ path: branchRepo, ref: '-force' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/merge', () => {
    it('merges a branch into the current one', async () => {
      const res = await request(app).post('/api/git/merge').send({ path: mergeOk, branch: 'feature-x' })
      expect(res.status).toBe(200)
      expect(res.body.merged).toBe(true)
      expect(res.body.conflicted).toBe(false)
      expect(res.body.output).toContain('Merge made by')
    })

    it('reports a conflicted merge with the conflict output', async () => {
      const res = await request(app).post('/api/git/merge').send({ path: mergeConflict, branch: 'feature-x' })
      expect(res.status).toBe(200)
      expect(res.body.merged).toBe(false)
      expect(res.body.conflicted).toBe(true)
      expect(res.body.output).toContain('CONFLICT')
    })

    it('rejects an invalid (option-like) branch with 400', async () => {
      const res = await request(app).post('/api/git/merge').send({ path: mergeOk, branch: '--all' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/rebase', () => {
    it('rebases the current branch onto another', async () => {
      const res = await request(app).post('/api/git/rebase').send({ path: rebaseOk, branch: 'dev' })
      expect(res.status).toBe(200)
      expect(res.body.rebased).toBe(true)
      expect(res.body.output).toContain('Successfully rebased')
    })

    it('reports a conflicted rebase', async () => {
      const res = await request(app).post('/api/git/rebase').send({ path: rebaseConflict, branch: 'dev' })
      expect(res.status).toBe(200)
      expect(res.body.rebased).toBe(false)
      expect(res.body.conflicted).toBe(true)
      expect(res.body.output).toContain('CONFLICT')
    })

    it('rejects an invalid branch with 400', async () => {
      const res = await request(app).post('/api/git/rebase').send({ path: rebaseOk, branch: 'x..y' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/rebase-step', () => {
    it('runs abort/continue/skip and records each op', async () => {
      for (const action of ['abort', 'continue', 'skip']) {
        const res = await request(app).post('/api/git/rebase-step').send({ path: rebaseConflict, action })
        expect(res.status).toBe(200)
        expect(res.body.action).toBe(action)
      }
      const log = fs.readFileSync(path.join(rebaseConflict, '.git', 'op-log'), 'utf-8')
      for (const a of ['rebase --abort', 'rebase --continue', 'rebase --skip']) {
        expect(log.split('\n')).toContain(a)
      }
    })

    it('rejects an unknown action with 400', async () => {
      const res = await request(app).post('/api/git/rebase-step').send({ path: rebaseConflict, action: 'bogus' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/init', () => {
    it('initializes a non-repo folder and adds an origin remote', async () => {
      const res = await request(app)
        .post('/api/git/init')
        .send({ path: initTarget, remoteUrl: 'https://github.com/owner/new-repo.git', branch: 'main' })
      expect(res.status).toBe(200)
      expect(res.body.initialized).toBe(true)
      expect(res.body.remoteAdded).toBe(true)
      // .git now exists and the fake git recorded the origin url.
      expect(fs.existsSync(path.join(initTarget, '.git'))).toBe(true)
      const originUrl = fs.readFileSync(path.join(initTarget, '.git', 'origin-url'), 'utf-8').trim()
      expect(originUrl).toBe('https://github.com/owner/new-repo.git')
    })

    it('refuses to re-initialize an existing repository with 409', async () => {
      const res = await request(app).post('/api/git/init').send({ path: alreadyRepo })
      expect(res.status).toBe(409)
      expect(res.body.initialized).toBe(false)
    })

    it('rejects invalid remote URLs with 400', async () => {
      for (const bad of ['ftp://x/y', 'https://a b/c', 'rm -rf /', 'http://ok.com/x; rm -rf /']) {
        const res = await request(app).post('/api/git/init').send({ path: initTarget, remoteUrl: bad })
        expect(res.status).toBe(400)
      }
    })

    it('rejects an invalid branch name with 400', async () => {
      const res = await request(app).post('/api/git/init').send({ path: initTarget, branch: '-bad' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/push', () => {
    it('pushes the current branch to origin with -u', async () => {
      const res = await request(app).post('/api/git/push').send({ path: mergeOk })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const log = fs.readFileSync(path.join(mergeOk, '.git', 'op-log'), 'utf-8')
      expect(log.split('\n')).toContain('push -u origin')
    })

    it('reports an auth failure with success:false and the git output', async () => {
      const res = await request(app).post('/api/git/push').send({ path: pushFail })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(false)
      expect(res.body.output).toContain('could not read Username')
    })

    it('rejects an invalid branch with 400', async () => {
      const res = await request(app).post('/api/git/push').send({ path: mergeOk, branch: 'a..b' })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/git/pull', () => {
    it('pulls from origin (up to date)', async () => {
      const res = await request(app).post('/api/git/pull').send({ path: mergeOk })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.output).toContain('Already up to date')
    })

    it('reports a conflicted pull', async () => {
      const res = await request(app).post('/api/git/pull').send({ path: pullConflict })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(false)
      expect(res.body.conflicted).toBe(true)
    })
  })

  describe('POST /api/git/fetch', () => {
    it('fetches all remotes', async () => {
      const res = await request(app).post('/api/git/fetch').send({ path: remoteRepo })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.output).toContain('From github.com')
    })

    it('denies paths outside the root with 403', async () => {
      const res = await request(app).post('/api/git/fetch').send({ path: '/etc' })
      expect(res.status).toBe(403)
    })
  })
})

describe('file watching & live events', () => {
  let server = null
  let url = ''
  // base is only known after the top-level beforeAll runs, so resolve lazily.
  let lateRepo = '' // fresh dir: never added as a root before
  let lateFile = ''

  beforeAll(async () => {
    lateRepo = path.join(base, 'late-repo')
    lateFile = path.join(lateRepo, 'late.txt')
    fs.mkdirSync(lateRepo)
    // A real (ephemeral-port) HTTP server so SSE streams can be read end-to-end.
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve)
    })
    url = `http://127.0.0.1:${server.address().port}`
    startFileWatcher([root])
  })

  afterAll(async () => {
    stopFileWatcher()
    if (server !== null) await new Promise(resolve => server.close(resolve))
  })

  // Collect SSE data payloads for up to `ms` milliseconds. Resolves early when
  // the optional `until(payloads)` predicate returns true. Returns the response
  // headers plus every parsed JSON payload received in the window.
  function collectEvents(ms, until = null) {
    return new Promise(resolve => {
      const payloads = []
      let buffer = ''
      let done = false
      let headers = {}
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        req.destroy()
        resolve({ headers, payloads })
      }
      const timer = setTimeout(finish, ms)
      const req = http.get(`${url}/api/events`, res => {
        headers = res.headers
        res.setEncoding('utf8')
        res.on('data', chunk => {
          buffer += chunk
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue
              try {
                payloads.push(JSON.parse(line.slice(6)))
              } catch {
                // malformed frame; ignore it
              }
            }
          }
          if (until !== null && until(payloads)) finish()
        })
      })
    })
  }

  const sawChange = (payloads, p) =>
    payloads.some(e => e.type === 'fs-change' && Array.isArray(e.paths) && e.paths.includes(p))

  it('streams text/event-stream and sends an initial hello message', async () => {
    const { headers, payloads } = await collectEvents(500)
    expect(headers['content-type']).toContain('text/event-stream')
    expect(payloads.length).toBeGreaterThanOrEqual(1)
    expect(payloads[0]).toEqual({ type: 'hello' })
  })

  it('broadcasts fs-change events when a file is created on disk', async () => {
    const target = path.join(root, 'watched.txt')
    const pending = collectEvents(8000, ps => sawChange(ps, target))
    await new Promise(r => setTimeout(r, 300)) // let the stream connect first
    fs.writeFileSync(target, 'born\n')
    const { payloads } = await pending
    expect(sawChange(payloads, target)).toBe(true)
  })

  it('broadcasts fs-change events when a directory is created', async () => {
    const dir = path.join(root, 'watched-dir')
    const pending = collectEvents(8000, ps => sawChange(ps, dir))
    await new Promise(r => setTimeout(r, 300))
    fs.mkdirSync(dir)
    const { payloads } = await pending
    expect(sawChange(payloads, dir)).toBe(true)
  })

  it('does not echo changes made by the API itself', async () => {
    const target = path.join(root, 'selfwrite.txt')
    fs.writeFileSync(target, 'v1\n')
    await new Promise(r => setTimeout(r, 1500)) // let the initial add event settle

    const pending = collectEvents(900)
    const put = request(app).put('/api/file-content').send({ path: target, content: 'v2\n' })
    await new Promise(r => setTimeout(r, 150)) // PUT lands inside the collection window
    expect((await put).status).toBe(200)
    const { payloads } = await pending
    expect(sawChange(payloads, target)).toBe(false)
  })

  it('watches roots added at runtime via POST /api/roots', async () => {
    const pending = collectEvents(8000, ps => sawChange(ps, lateFile))
    await new Promise(r => setTimeout(r, 300))
    const res = await request(app).post('/api/roots').send({ path: lateRepo })
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 500)) // let chokidar start watching the new root
    fs.writeFileSync(lateFile, 'late\n')
    const { payloads } = await pending
    expect(sawChange(payloads, lateFile)).toBe(true)
  }, 12_000)

  it('ignores changes inside .git and node_modules', async () => {
    const gitFile = path.join(root, '.git', 'HEAD')
    fs.mkdirSync(path.dirname(gitFile), { recursive: true })
    const nmFile = path.join(root, 'node_modules', 'pkg.txt')
    fs.mkdirSync(path.dirname(nmFile), { recursive: true })

    const pending = collectEvents(1200)
    await new Promise(r => setTimeout(r, 300))
    fs.writeFileSync(gitFile, 'ref: refs/heads/main\n')
    fs.writeFileSync(nmFile, 'dep\n')
    const { payloads } = await pending
    expect(sawChange(payloads, gitFile)).toBe(false)
    expect(sawChange(payloads, nmFile)).toBe(false)
  })
})


describe('Terraform graph / drift / registry / cost', () => {
  // root is only known after the top-level beforeAll runs, so resolve lazily.
  const dir = (name) => path.join(root, 'tf', name)

  describe('POST /api/tf/run command=graph', () => {
    it('parses terraform graph DOT into nodes and edges', async () => {
      const d = dir('graph')
      fs.mkdirSync(d, { recursive: true })
      const res = await request(app).post('/api/tf/run').send({ command: 'graph', path: d })
      expect(res.status).toBe(200)
      expect(res.body.command).toBe('graph')
      expect(res.body.exitCode).toBe(0)
      const ids = res.body.nodes.map(n => n.id)
      expect(ids).toContain('[root]')
      expect(ids).toContain('aws_instance.web')
      expect(ids).toContain('provider["registry.terraform.io/hashicorp/aws"]')
      const edge = (a, b) => res.body.edges.some(e => e[0] === a && e[1] === b)
      expect(edge('[root]', 'aws_instance.web')).toBe(true)
      expect(edge('aws_instance.web', 'provider["registry.terraform.io/hashicorp/aws"]')).toBe(true)
    })

    it('rejects an unknown command with 400', async () => {
      const d = dir('graph')
      fs.mkdirSync(d, { recursive: true })
      const res = await request(app).post('/api/tf/run').send({ command: 'destroy-everything', path: d })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/tf/run command=drift', () => {
    it('reports drifted=true with a summary when the plan detects changes', async () => {
      const d = dir('drift')
      fs.mkdirSync(d, { recursive: true })
      const res = await request(app).post('/api/tf/run').send({ command: 'drift', path: d })
      expect(res.status).toBe(200)
      expect(res.body.command).toBe('drift')
      expect(res.body.exitCode).toBe(2)
      expect(res.body.drifted).toBe(true)
      expect(res.body.summary).toEqual({ add: 1, update: 1, replace: 1, destroy: 0 })
    })

    it('reports drifted=false when the plan detects no changes', async () => {
      const d = dir('drift-ok')
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, '.plan-nochanges'), '')
      const res = await request(app).post('/api/tf/run').send({ command: 'drift', path: d })
      expect(res.status).toBe(200)
      expect(res.body.exitCode).toBe(0)
      expect(res.body.drifted).toBe(false)
    })

    it('reports drifted=null when the check times out', async () => {
      const d = dir('drift-slow')
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, '.slow-plan'), '')
      const res = await request(app).post('/api/tf/run').send({ command: 'drift', path: d })
      expect(res.status).toBe(200)
      expect(res.body.timedOut).toBe(true)
      expect(res.body.exitCode).toBeNull()
      expect(res.body.drifted).toBeNull()
    })
  })

  describe('GET /api/tf/registry/module', () => {
    it('proxies the registry and sorts versions newest-first', async () => {
      const res = await request(app)
        .get('/api/tf/registry/module')
        .query({ ns: 'hashicorp', name: 'consul', provider: 'aws' })
      expect(res.status).toBe(200)
      expect(res.body.namespace).toBe('hashicorp')
      expect(res.body.source).toBe('registry.terraform.io/hashicorp/consul/aws')
      expect(res.body.versions.map(v => v.version)).toEqual(['1.2.3', '1.1.0', '1.0.0'])
    })

    it('normalizes object-form versions and passes through description + downloads', async () => {
      const res = await request(app)
        .get('/api/tf/registry/module')
        .query({ ns: 'acme', name: 'widget', provider: 'aws' })
      expect(res.status).toBe(200)
      expect(res.body.description).toBe('A fake widget module for tests')
      expect(res.body.downloads).toBe(123456)
      expect(res.body.versions.map(v => v.version)).toEqual(['2.0.0', '1.9.0'])
      expect(res.body.versions[0].publishedAt).toBe('2025-01-01T00:00:00Z')
    })

    it('rejects invalid identifiers with 400 before any upstream call', async () => {
      const res = await request(app)
        .get('/api/tf/registry/module')
        .query({ ns: '../etc', name: 'consul', provider: 'aws' })
      expect(res.status).toBe(400)
    })

    it('maps an upstream 404 to a clean 404', async () => {
      const res = await request(app)
        .get('/api/tf/registry/module')
        .query({ ns: 'hashicorp', name: 'nope', provider: 'aws' })
      expect(res.status).toBe(404)
    })
  })

  describe('cost estimation (infracost)', () => {
    it('reports availability when the binary is on PATH', async () => {
      const res = await request(app).get('/api/tf/cost-availability')
      expect(res.status).toBe(200)
      expect(res.body.available).toBe(true)
    })

    it('runs infracost breakdown and parses resources + total', async () => {
      const d = dir('cost')
      fs.mkdirSync(d, { recursive: true })
      const res = await request(app).post('/api/tf/cost').send({ path: d })
      expect(res.status).toBe(200)
      expect(res.body.exitCode).toBe(0)
      expect(res.body.currencySymbol).toBe('$')
      expect(res.body.totalMonthlyCost).toBeCloseTo(37.46)
      expect(res.body.resources.map(r => r.address)).toEqual(['aws_instance.web', 'aws_s3_bucket.logs'])
    })

    it('reports a failing infracost run with an empty estimate and raw output', async () => {
      const d = dir('cost-fail')
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, '.infracost-fail'), '')
      const res = await request(app).post('/api/tf/cost').send({ path: d })
      expect(res.status).toBe(200)
      expect(res.body.exitCode).toBe(1)
      expect(res.body.totalMonthlyCost).toBeNull()
      expect(res.body.resources).toEqual([])
      expect(res.body.output).toContain('fake infracost')
    })

    it('rejects a path outside the allowed roots', async () => {
      const res = await request(app).post('/api/tf/cost').send({ path: '/etc' })
      expect(res.status).toBe(403)
    })
  })
})