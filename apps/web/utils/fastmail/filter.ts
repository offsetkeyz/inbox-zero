import crypto from "node:crypto";
import {
  SIEVE_MANAGED_SECTION_BEGIN,
  SIEVE_MANAGED_SECTION_END,
  SIEVE_SECTION_WARNING,
  SIEVE_SECTION_DESCRIPTION,
} from "./constants";
import type { ParsedManagedSection, ParsedFilter } from "./types";
import type { FastmailClient } from "./client";
import { SafeError } from "@/utils/error";
import { getMailboxByRole, getMailboxById } from "./mailbox";

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

  // RFC 5228 Sieve string escaping: backslashes first, then quotes
  const escapedFrom = from.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

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
    const sieveCodeMatch = block.match(/if address[\s\S]+?\}/);

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

export function validateManagedSection(parsed: ParsedManagedSection): void {
  if (parsed.hasCorruptedMarkers) {
    throw new SafeError(
      "Filter section markers corrupted. Please reset filters in Fastmail settings or contact support.",
    );
  }

  if (!parsed.found) {
    throw new SafeError(
      "Inbox Zero filter section not found. Please contact support to reinitialize.",
    );
  }

  if (parsed.hasMalformedComments) {
    throw new SafeError(
      "Filter metadata is malformed. Manual editing detected. Please contact support.",
    );
  }
}

export function createManagedSectionBlock(): string {
  const timestamp = new Date().toISOString();

  return `${SIEVE_MANAGED_SECTION_BEGIN}
${SIEVE_SECTION_WARNING}
${SIEVE_SECTION_DESCRIPTION}
# Last updated: ${timestamp}
${SIEVE_MANAGED_SECTION_END}`;
}

export function ensureManagedSection(existingScript: string | null): string {
  if (!existingScript) {
    return `require ["fileinto"];\n\n${createManagedSectionBlock()}\n`;
  }

  // If section already exists, return as-is
  if (
    existingScript.includes(SIEVE_MANAGED_SECTION_BEGIN) &&
    existingScript.includes(SIEVE_MANAGED_SECTION_END)
  ) {
    return existingScript;
  }

  // Merge "fileinto" into existing require directive if needed
  let script = existingScript;
  const requireMatch = script.match(/require\s*\[([^\]]+)\]/);
  if (requireMatch) {
    const existingRequires = requireMatch[1];
    if (!existingRequires.includes("fileinto")) {
      const newRequires = `${existingRequires.trimEnd()}, "fileinto"`;
      script = script.replace(requireMatch[0], `require [${newRequires}]`);
    }
  } else {
    // No require directive at all — prepend one
    script = `require ["fileinto"];\n\n${script}`;
  }

  // Append managed section
  const trimmed = script.trimEnd();
  return `${trimmed}\n\n${createManagedSectionBlock()}\n`;
}

export function insertFilterIntoSection(
  script: string,
  filterRule: string,
): string {
  const endIndex = script.indexOf(SIEVE_MANAGED_SECTION_END);

  if (endIndex === -1) {
    throw new Error("Managed section END marker not found");
  }

  // Update timestamp
  const newTimestamp = new Date().toISOString();
  const updatedScript = script.replace(
    /# Last updated: .+/,
    `# Last updated: ${newTimestamp}`,
  );

  // Insert filter before END marker, ensuring clean spacing
  const updatedEndIndex = updatedScript.indexOf(SIEVE_MANAGED_SECTION_END);
  const beforeEnd = updatedScript.substring(0, updatedEndIndex).trimEnd();
  const afterEnd = updatedScript.substring(updatedEndIndex);

  return `${beforeEnd}\n\n${filterRule}\n${afterEnd}`;
}

export function regenerateManagedSection(
  script: string,
  filters: ParsedFilter[],
): string {
  const beginIndex = script.indexOf(SIEVE_MANAGED_SECTION_BEGIN);
  const endIndex = script.indexOf(SIEVE_MANAGED_SECTION_END);

  if (beginIndex === -1 || endIndex === -1) {
    throw new Error("Managed section markers not found");
  }

  // Extract content before and after managed section
  const beforeSection = script.substring(0, beginIndex);
  const afterSection = script.substring(
    endIndex + SIEVE_MANAGED_SECTION_END.length,
  );

  // Build new managed section
  const timestamp = new Date().toISOString();
  let newSection = `${SIEVE_MANAGED_SECTION_BEGIN}\n`;
  newSection += `${SIEVE_SECTION_WARNING}\n`;
  newSection += `${SIEVE_SECTION_DESCRIPTION}\n`;
  newSection += `# Last updated: ${timestamp}\n`;

  for (const filter of filters) {
    // Re-use stored sieveCode since folder names were already resolved
    newSection += `\n# Filter ID: ${filter.id}\n`;
    newSection += `# From: ${filter.from}\n`;
    newSection += `# Add labels: ${JSON.stringify(filter.addLabelIds)}\n`;
    newSection += `# Remove labels: ${JSON.stringify(filter.removeLabelIds)}\n`;
    newSection += `${filter.sieveCode}\n`;
  }

  newSection += `${SIEVE_MANAGED_SECTION_END}`;

  return beforeSection + newSection + afterSection;
}

const GMAIL_LABEL_TO_SIEVE_ROLE: Record<string, string> = {
  INBOX: "inbox",
  SPAM: "junk",
  TRASH: "trash",
};

export async function resolveSieveFolder(
  labelId: string,
  client: FastmailClient,
  accountId: string,
): Promise<string> {
  const role = GMAIL_LABEL_TO_SIEVE_ROLE[labelId];
  if (role) {
    const mailbox = await getMailboxByRole(client, {
      accountId,
      role: role as any,
    });
    if (!mailbox) {
      throw new SafeError(`Mailbox with role "${role}" not found`);
    }
    return mailbox.name;
  }

  const mailbox = await getMailboxById(client, {
    accountId,
    mailboxId: labelId,
  });
  if (!mailbox) {
    throw new SafeError(
      `Mailbox "${labelId}" not found. The label may have been deleted.`,
    );
  }
  return mailbox.name;
}
