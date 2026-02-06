import crypto from "node:crypto";
import type { ParsedManagedSection } from "./types";

export function generateFilterId(criteria: {
  from: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): string {
  const normalized = {
    from: criteria.from.toLowerCase().trim(),
    addLabelIds: (criteria.addLabelIds || []).sort(),
    removeLabelIds: (criteria.removeLabelIds || []).sort(),
  };

  const payload = JSON.stringify(normalized);
  const hash = crypto.createHash("sha256").update(payload).digest("hex");

  return hash.substring(0, 32);
}

export function generateSieveRule(options: {
  id: string;
  from: string;
  addLabelIds: string[];
  removeLabelIds: string[];
  sieveFolders: string[];
}): string {
  const { id, from, addLabelIds, removeLabelIds, sieveFolders } = options;

  const escapedFrom = from.replace(/"/g, '\\"');

  // Generate one fileinto per folder (RFC 5228 compliant)
  const fileintoStatements = sieveFolders
    .map((folder) => `  fileinto "${folder}";`)
    .join("\n");

  const timestamp = new Date().toISOString();

  return `# Filter ID: ${id}
# From: ${from}
# Add labels: ${JSON.stringify(addLabelIds)}
# Remove labels: ${JSON.stringify(removeLabelIds)}
# Created: ${timestamp}
if address :is "from" "${escapedFrom}" {
${fileintoStatements || "  # No action"}
}`;
}

export function parseManagedSection(script: string): ParsedManagedSection {
  throw new Error("Not implemented");
}
