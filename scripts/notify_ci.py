"""Email CI results using trusted workflow code and bounded JSON data only."""
import io
import json
import math
import os
import re
import smtplib
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from email.message import EmailMessage
from pathlib import Path

REPOSITORY = "paduartesre/terracode"
RECIPIENT = "pedroduarte@terracodeiac.com"
MAX_ZIP_BYTES = 262144
MAX_REPORT_BYTES = 65536


def safe_text(value, limit=180):
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value))[:limit]


def parse_report(data):
    if len(data) > MAX_ZIP_BYTES:
        raise ValueError("Report archive exceeds the size limit")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        matches = [entry for entry in archive.infolist() if entry.filename == "ci-report.json"]
        if len(matches) != 1 or matches[0].file_size > MAX_REPORT_BYTES:
            raise ValueError("Invalid report archive")
        report = json.loads(archive.read(matches[0]))
    if not isinstance(report, dict) or report.get("schemaVersion") != 1:
        raise ValueError("Unsupported report format")
    for name in ("frontend", "backend"):
        coverage = report.get("coverage", {}).get(name)
        if coverage is None:
            continue
        for metric in ("lines", "statements", "functions", "branches"):
            value = coverage.get(metric)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 100:
                raise ValueError("Invalid coverage percentage")
    return report


def make_message(run, jobs, report, sender):
    prs = run.get("pull_requests") or []
    number = prs[0].get("number") if prs else None
    reference = "PR #" + str(number) if isinstance(number, int) and number > 0 else "run #" + str(run["id"])
    message = EmailMessage()
    message["From"] = sender
    message["To"] = RECIPIENT
    message["Subject"] = "[TerraCode] " + reference + " - " + safe_text(run.get("conclusion", "unknown"), 30)
    body = [
        "Relatório de validação do TerraCode", "",
        "Resultado: " + safe_text(run.get("conclusion", "unknown")),
        "Commit: " + safe_text(run.get("head_sha", "")),
        "GitHub: https://github.com/" + REPOSITORY + "/actions/runs/" + str(run["id"]), "",
        "Validações:"
    ]
    for job in jobs[:50]:
        body.append("- " + safe_text(job.get("name")) + ": " + safe_text(job.get("conclusion", job.get("status"))))
        for step in job.get("steps", [])[:50]:
            if step.get("conclusion") == "failure":
                body.append("  Falha: " + safe_text(step.get("name")))
    if report:
        for name in ("frontend", "backend", "integration"):
            suite = report.get("suites", {}).get(name)
            if isinstance(suite, dict):
                body.append("\nTestes " + name + ": " + safe_text(suite.get("passed")) + " passaram; " + safe_text(suite.get("failed")) + " falharam.")
        for name in ("frontend", "backend"):
            data = report.get("coverage", {}).get(name)
            if isinstance(data, dict):
                body.append("\nCobertura " + name + ": " + "; ".join(metric + " " + str(data[metric]) + "%" for metric in ("lines", "statements", "functions", "branches")))
                for file in data.get("leastCovered", [])[:5]:
                    if isinstance(file, dict):
                        body.append("- Revisar cobertura: " + safe_text(file.get("file")) + " (" + safe_text(file.get("lines"), 12) + "% de linhas)")
    else:
        body.append("\nO relatório de cobertura não está disponível. Consulte os logs e os artefatos da execução.")
    body.extend(["", "Antes de aceitar a sugestão:", "- Revisar o comportamento proposto e os testes das linhas alteradas.",
                 "- Conferir erros, permissões, dependências e comandos de infraestrutura.",
                 "- Reproduzir mudanças relevantes de usabilidade. A pipeline não aprova nem faz merge automaticamente.",
                 "", "Os percentuais são informativos; confira os testes, o diff e os relatórios completos no GitHub."])
    message.set_content("\n".join(body))
    return message


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def api(path, token, binary=False):
    request = urllib.request.Request("https://api.github.com/repos/" + REPOSITORY + path,
                                    headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=30) as response:
            data = response.read(MAX_ZIP_BYTES + 1 if binary else 1048577)
    except urllib.error.HTTPError as error:
        if not binary or error.code != 302:
            raise
        location = error.headers.get("Location", "")
        parsed = urllib.parse.urlparse(location)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Invalid artifact redirect")
        # Never forward the GitHub credential to the artifact storage host.
        with urllib.request.urlopen(urllib.request.Request(location), timeout=30) as response:
            data = response.read(MAX_ZIP_BYTES + 1)
    if binary:
        return data
    if len(data) > 1048576:
        raise ValueError("API response exceeds the size limit")
    return json.loads(data)


def main():
    required = ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD")
    if any(not os.environ.get(key) for key in required):
        notice = "Email delivery is not configured. Add the SMTP secrets described in docs/MAINTAINER.md."
        print("::notice::" + notice)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf8") as output:
                output.write("## Email delivery pending\n\n" + notice + "\n")
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if event.get("repository", {}).get("full_name") != REPOSITORY:
        raise ValueError("Unexpected repository")
    run_id = event.get("workflow_run", {}).get("id")
    if isinstance(run_id, bool) or not isinstance(run_id, int) or run_id <= 0:
        raise ValueError("Invalid workflow run")
    token = os.environ["GH_TOKEN"]
    run = api("/actions/runs/" + str(run_id), token)
    if run.get("name") != "TerraCode CI" or run.get("event") not in ("pull_request", "push", "workflow_dispatch"):
        raise ValueError("Unexpected workflow")
    jobs = api("/actions/runs/" + str(run_id) + "/jobs?per_page=100", token).get("jobs", [])
    report = None
    artifacts = api("/actions/runs/" + str(run_id) + "/artifacts?per_page=100", token).get("artifacts", [])
    match = next((item for item in artifacts if item.get("name") == "validation-report" and not item.get("expired")), None)
    if match:
        report = parse_report(api("/actions/artifacts/" + str(int(match["id"])) + "/zip", token, binary=True))
    port = int(os.environ.get("SMTP_PORT") or "465")
    if port not in (465, 587):
        raise ValueError("SMTP must use implicit TLS on 465 or STARTTLS on 587")
    sender = os.environ["SMTP_USERNAME"]
    message = make_message(run, jobs, report, sender)
    context = ssl.create_default_context()
    if port == 465:
        connection = smtplib.SMTP_SSL(os.environ["SMTP_HOST"], port, timeout=30, context=context)
    else:
        connection = smtplib.SMTP(os.environ["SMTP_HOST"], port, timeout=30)
        connection.starttls(context=context)
    with connection:
        connection.login(sender, os.environ["SMTP_PASSWORD"])
        connection.send_message(message)
    print("CI report sent to the project maintainer.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not expose SMTP credentials, signed download URLs or tokens in logs.
        print("CI email delivery failed (" + type(error).__name__ + "). Review the SMTP configuration and workflow logs.", file=sys.stderr)
        sys.exit(1)

