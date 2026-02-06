import crypto from "node:crypto";
import {
  SIEVE_MANAGED_SECTION_BEGIN,
  SIEVE_MANAGED_SECTION_END,
} from "./constants";
import type { ParsedManagedSection, ParsedFilter } from "./types";

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
  const beginIndex = script.indexOf(SIEVE_MANAGED_SECTION_BEGIN);
  const endIndex = script.indexOf(SIEVE_MANAGED_SECTION_END);

  // Check for corrupted markers
  const hasBegin = script.includes("BEGIN INBOX ZERO");
  const hasEnd = script.includes("END INBOX ZERO");
  const hasCorruptedMarkers =
    (hasBegin || hasEnd) && (beginIndex === -1 || endIndex === -1);

  if (beginIndex === -1 || endIndex === -1) {
    return {
      found: false,
      filters: [],
      hasCorruptedMarkers,
    };
  }

  const section = script.substring(
    beginIndex,
    endIndex + SIEVE_MANAGED_SECTION_END.length,
  );

  // Extract last updated timestamp
  const lastUpdatedMatch = section.match(/# Last updated: (.+)/);
  const lastUpdated = lastUpdatedMatch?.[1];

  // Parse filters by splitting on "# Filter ID:"
  const filterBlocks = section.split(/# Filter ID: /).slice(1); // Skip first empty element

  const filters: ParsedFilter[] = [];
  let hasMalformedComments = false;

  for (const block of filterBlocks) {
    const lines = block.split("\n");
    const id = lines[0]?.trim();

    const fromMatch = block.match(/# From: (.+)/);
    const addLabelsMatch = block.match(/# Add labels: (\[.*\])/);
    const removeLabelsMatch = block.match(/# Remove labels: (\[.*\])/);

    // Extract Sieve code (everything after metadata comments)
    const sieveCodeMatch = block.match(/if address.+?\}/s);

    if (
      !id ||
      !fromMatch ||
      !addLabelsMatch ||
      !removeLabelsMatch ||
      !sieveCodeMatch
    ) {
      hasMalformedComments = true;
      continue;
    }

    try {
      filters.push({
        id,
        from: fromMatch[1],
        addLabelIds: JSON.parse(addLabelsMatch[1]),
        removeLabelIds: JSON.parse(removeLabelsMatch[1]),
        sieveCode: sieveCodeMatch[0],
      });
    } catch {
      hasMalformedComments = true;
    }
  }

  return {
    found: true,
    filters,
    lastUpdated,
    hasMalformedComments,
  };
}
