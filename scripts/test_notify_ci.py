import io
import json
import unittest
import zipfile
from notify_ci import MAX_REPORT_BYTES, RECIPIENT, make_message, parse_report


def archive(content, name="ci-report.json"):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as result:
        result.writestr(name, content)
    return output.getvalue()


class NotificationSafetyTests(unittest.TestCase):
    def test_reads_json_without_extracting_or_executing_files(self):
        self.assertEqual(parse_report(archive(json.dumps({"schemaVersion": 1})))["schemaVersion"], 1)

    def test_rejects_path_traversal_and_unexpected_files(self):
        with self.assertRaises(ValueError):
            parse_report(archive('{"schemaVersion":1}', "../../ci-report.json"))

    def test_rejects_compressed_oversized_reports(self):
        with self.assertRaises(ValueError):
            parse_report(archive(" " * (MAX_REPORT_BYTES + 1)))

    def test_rejects_invalid_coverage_numbers(self):
        for value in (-1, 101, True, "100", float("nan")):
            report = {"schemaVersion": 1, "coverage": {"frontend": dict.fromkeys(("lines", "statements", "functions", "branches"), value)}}
            with self.assertRaises(ValueError):
                parse_report(archive(json.dumps(report)))

    def test_recipient_cannot_be_overridden_by_pull_request_data(self):
        run = {"id": 12, "head_sha": "a" * 40, "conclusion": "failure\nBcc: attacker@example.invalid", "pull_requests": [{"number": 8}]}
        message = make_message(run, [], {"schemaVersion": 1, "recipient": "attacker@example.invalid"}, "pedroduarte@terracodeiac.com")
        self.assertEqual(message["To"], RECIPIENT)
        self.assertIsNone(message["Bcc"])
        self.assertIn("PR #8", message["Subject"])
        self.assertIn("https://github.com/paduartesre/terracode/actions/runs/12", message.get_content())


if __name__ == "__main__":
    unittest.main()

