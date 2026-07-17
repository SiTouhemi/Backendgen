import type { Issue } from "@backend-compiler/common";
import type { BackendIR } from "@backend-compiler/compiler";
import type { FeaturePack } from "@backend-compiler/feature-sdk";
import type { GenerationReport } from "@backend-compiler/generator-runtime";
import type { TargetAdapter } from "@backend-compiler/target-sdk";
import type { ValidationIssue } from "@backend-compiler/specification";

export function formatIssues(issues: ReadonlyArray<Issue | ValidationIssue>): string {
  return issues.map((item) => `- [${item.code}] ${item.path}: ${item.message}`).join("\n");
}

export function formatSummary(ir: BackendIR): string {
  const lines = [
    `Project: ${ir.project.name}`,
    `Target: ${ir.target.id} (${ir.target.database})`,
    `Entities: ${ir.entities.length}`,
    `Features: ${ir.features.map((feature) => `${feature.name}@${feature.version}`).join(", ") || "none"}`,
    `Endpoints: ${ir.endpoints.length}`,
    `Events: ${ir.events.length}`,
    `Secrets: ${ir.secrets.map((secret) => secret.name).join(", ") || "none"}`,
    `Infrastructure: ${ir.infrastructure.map((item) => item.name).join(", ")}`,
    "",
    "Entity summary:",
  ];

  for (const entity of ir.entities) {
    const flags = [
      entity.origin === "feature" ? `owned by ${entity.ownerFeature}` : "from specification",
      entity.crud ? "crud" : null,
      entity.softDelete ? "soft delete" : null,
      entity.ownership ? `owned by ${entity.ownership.entity}` : null,
      entity.tenant ? `scoped to ${entity.tenant.entity}` : null,
    ].filter((flag): flag is string => flag !== null);

    lines.push(
      `- ${entity.name}: ${entity.fields.length} fields, ${entity.relations.length} relations, ${entity.indexes.length} indexes (${flags.join("; ")})`,
    );
  }

  if (ir.customizationPoints.length > 0) {
    lines.push("", "Customization points:");
    for (const point of ir.customizationPoints) {
      lines.push(`- ${point.path} implements ${point.contract}`);
    }
  }

  return lines.join("\n");
}

export function formatTargets(targets: readonly TargetAdapter[]): string {
  return targets
    .map(
      (target) =>
        `${target.id}@${target.version}\n  ${target.description}\n  databases: ${target.supportedDatabases.join(", ")}\n  capabilities: ${target.capabilities.join(", ")}`,
    )
    .join("\n\n");
}

export function formatTarget(target: TargetAdapter): string {
  return [
    `Target: ${target.id}@${target.version}`,
    target.description,
    "",
    `Databases: ${target.supportedDatabases.join(", ")}`,
    `Capabilities: ${target.capabilities.join(", ")}`,
    "",
    "Commands inside a generated project:",
    `  install:     ${target.commands.install}`,
    `  build:       ${target.commands.build}`,
    `  test:        ${target.commands.test}`,
    `  integration: ${target.commands.testIntegration}`,
    `  migrate:     ${target.commands.migrate}`,
  ].join("\n");
}

export function formatFeatures(features: readonly FeaturePack[]): string {
  return features
    .map((feature) => {
      const requires =
        feature.dependsOn.length > 0 ? ` (requires ${feature.dependsOn.join(", ")})` : "";
      return `${feature.name}@${feature.version}${requires}\n  ${feature.description}`;
    })
    .join("\n\n");
}

export function formatFeature(feature: FeaturePack): string {
  const lines = [
    `Feature: ${feature.name}@${feature.version}`,
    feature.description,
    "",
    feature.agentSummary,
    "",
    `Depends on: ${feature.dependsOn.join(", ") || "nothing"}`,
    `Conflicts with: ${feature.conflictsWith.join(", ") || "nothing"}`,
    `Supported targets: ${feature.supportedTargets.join(", ")}`,
    "",
    "Configuration schema:",
    JSON.stringify(feature.configSchema, null, 2),
    "",
    "Examples:",
  ];

  for (const example of feature.examples) {
    lines.push(`  ${example.name}: ${JSON.stringify(example.config)}`);
  }

  return lines.join("\n");
}

export function formatReport(report: GenerationReport): string {
  const lines = [
    report.dryRun ? "Dry run: nothing was written." : "Generation complete.",
    `Output: ${report.outputPath}`,
    `Target: ${report.target.id}@${report.target.version}`,
    `Features: ${report.features.map((feature) => `${feature.name}@${feature.version}`).join(", ") || "none"}`,
    `Files: ${report.generatedFiles} (created ${report.changes.create}, updated ${report.changes.update}, unchanged ${report.changes.unchanged}, deleted ${report.changes.delete}, preserved ${report.changes.preserve})`,
    `Entities: ${report.entities}  Endpoints: ${report.endpoints}`,
  ];

  if (report.conflicts.length > 0) {
    lines.push("", "Conflicts (generation would refuse):");
    for (const conflict of report.conflicts) {
      lines.push(`- ${conflict.path} [${conflict.reason}]: ${conflict.message}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (report.migrationSql.length > 0) {
    lines.push("", "Migration SQL:");
    for (const migration of report.migrationSql) {
      lines.push(
        `--- ${migration.path}${migration.destructive ? " [DESTRUCTIVE]" : ""} ---`,
        migration.sql.trimEnd(),
      );
    }
  }

  if (report.customizationPoints.length > 0) {
    lines.push("", "Customization points:");
    for (const point of report.customizationPoints) {
      lines.push(`- ${point}`);
    }
  }

  if (!report.dryRun && report.success) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`  cd ${report.outputPath} && ${step}`);
    }
  }

  return lines.join("\n");
}
