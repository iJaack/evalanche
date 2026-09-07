#!/usr/bin/env node

import path from 'node:path';
import {
  DEFAULT_ROOT,
  latestAuditSummary,
  maybeWriteJson,
  packagesBySeverity,
  parseArgs,
  readJson,
} from './release-helpers.mjs';

export async function checkAuditRegressions({
  rootDir = DEFAULT_ROOT,
  auditFile,
  baselineFile = 'docs/security/audit-baseline.json',
  out,
} = {}) {
  const auditData = await readJson(path.resolve(rootDir, auditFile));
  if (auditData.error || !auditData.metadata?.vulnerabilities || !auditData.vulnerabilities) {
    throw new Error('Invalid audit report: audit request failed or vulnerability metadata is missing');
  }
  const baseline = await readJson(path.resolve(rootDir, baselineFile));
  const currentCounts = latestAuditSummary(auditData);
  const currentHighPackages = packagesBySeverity(auditData, 'high');
  const currentCriticalPackages = packagesBySeverity(auditData, 'critical');

  const extraCritical = currentCriticalPackages.filter((pkg) => !(baseline.criticalPackages ?? []).includes(pkg));
  const extraHigh = currentHighPackages.filter((pkg) => !(baseline.highPackages ?? []).includes(pkg) && !(baseline.allowlistedHighPackages ?? []).includes(pkg));
  const issues = [];

  const highCriticalAdvisories = [...new Set(Object.values(auditData.vulnerabilities)
    .flatMap((details) => (details.via ?? []).filter((via) => typeof via === 'object' && ['high', 'critical'].includes(via.severity))
      .map((via) => `${via.name}:${via.source}`)))].sort();
  const extraAdvisories = baseline.highCriticalAdvisories
    ? highCriticalAdvisories.filter((id) => !baseline.highCriticalAdvisories.includes(id)) : [];
  if (extraAdvisories.length > 0) issues.push('new high or critical advisories');

  if (currentCounts.critical > (baseline.counts?.critical ?? 0) || extraCritical.length > 0) {
    issues.push('critical vulnerabilities regressed');
  }
  if (currentCounts.high > (baseline.counts?.high ?? 0) || extraHigh.length > 0) {
    issues.push('high vulnerabilities regressed');
  }

  const result = {
    ok: issues.length === 0,
    baselineVersion: baseline.version,
    currentCounts,
    baselineCounts: baseline.counts,
    currentHighPackages,
    currentCriticalPackages,
    extraHigh,
    extraCritical,
    highCriticalAdvisories,
    extraAdvisories,
    issues,
  };

  if (issues.length > 0) {
    await maybeWriteJson(out, result);
    throw new Error(issues.join('; '));
  }

  return maybeWriteJson(out, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await checkAuditRegressions({
    auditFile: args.audit,
    baselineFile: args.baseline,
    out: args.out,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
