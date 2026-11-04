import fs from 'node:fs';
import path from 'node:path';

const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const metrics = ['lines', 'statements', 'functions', 'branches'];
const report = { schemaVersion: 1, commit: process.env.GITHUB_SHA || null, checks: {}, suites: {}, coverage: {} };
for (const name of ['install', 'build', 'lint', 'frontend', 'backend', 'integration', 'automation']) {
  report.checks[name] = process.env[name.toUpperCase() + '_RESULT'] || 'not_run';
}
for (const name of ['frontend', 'backend', 'integration']) {
  const data = read('.reports/' + name + '.json');
  report.suites[name] = data ? {
    total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests, skipped: data.numPendingTests,
    failures: (data.testResults || []).flatMap(suite => (suite.assertionResults || []).filter(test => test.status === 'failed').map(test => test.fullName)).slice(0, 10)
  } : null;
}
for (const name of ['frontend', 'backend']) {
  const data = read('coverage/' + name + '/coverage-summary.json');
  report.coverage[name] = data ? {
    ...Object.fromEntries(metrics.map(metric => [metric, data.total[metric].pct])),
    leastCovered: Object.entries(data).filter(([file]) => file !== 'total').map(([file, info]) => ({
      file: path.relative(process.cwd(), file), lines: info.lines.pct, uncovered: info.lines.total - info.lines.covered
    })).filter(file => file.uncovered > 0).sort((a, b) => b.uncovered - a.uncovered).slice(0, 5)
  } : null;
}
fs.mkdirSync('.reports', { recursive: true });
fs.writeFileSync('.reports/ci-report.json', JSON.stringify(report, null, 2) + '\n');
const lines = ['## TerraCode review report', '', '| Check | Result |', '| --- | --- |'];
for (const [name, result] of Object.entries(report.checks)) lines.push('| ' + name + ' | ' + result + ' |');
lines.push('', '| Suite | Passed | Failed | Skipped |', '| --- | ---: | ---: | ---: |');
for (const [name, suite] of Object.entries(report.suites)) lines.push('| ' + name + ' | ' + (suite ? [suite.passed, suite.failed, suite.skipped].join(' | ') : 'not produced | — | —') + ' |');
lines.push('', '| Coverage | Lines | Statements | Functions | Branches |', '| --- | ---: | ---: | ---: | ---: |');
for (const [name, data] of Object.entries(report.coverage)) {
  lines.push('| ' + name + ' | ' + (data ? metrics.map(metric => data[metric] + '%').join(' | ') : 'not produced | — | — | —') + ' |');
}
for (const [name, data] of Object.entries(report.coverage)) {
  if (!data) continue;
  lines.push('', '### Coverage to review: ' + name);
  for (const file of data.leastCovered) lines.push('- ' + file.file + ': ' + file.lines + '% lines; ' + file.uncovered + ' uncovered lines.');
}
lines.push('', 'Download **coverage-and-tests** for HTML coverage, LCOV, test results and JUnit reports.',
  '', '### Maintainer review',
  '- Confirm the proposed behavior and scope match the issue.',
  '- Check tests exercise the change, including error paths and permissions.',
  '- Inspect uncovered lines in changed files; passing coverage thresholds is not automatic approval.',
  '- Review workflow, dependency, credential and Terraform execution changes carefully.',
  '- Reproduce relevant usability changes locally before merging.');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
console.log(lines.join('\n'));

