import type { FastmailClient } from "./client";
import type { Logger } from "@/utils/logger";
import type { EmailFilter } from "@/utils/email/types";
import {
  generateFilterId,
  parseManagedSection,
  validateManagedSection,
  generateSieveRule,
  insertFilterIntoSection,
  ensureManagedSection,
  resolveSieveFolder,
  regenerateManagedSection,
} from "./filter";
import { getSieveScript, setSieveScript } from "./sieve";

export async function createFilterOperation(options: {
  client: FastmailClient;
  accountId: string;
  logger: Logger;
  from: string;
  addLabelIds: string[];
  removeLabelIds: string[];
}): Promise<{ status: number }> {
  const { client, accountId, logger, from, addLabelIds, removeLabelIds } =
    options;

  const filterId = generateFilterId({
    from,
    addLabelIds,
    removeLabelIds,
  });

  logger.info("Creating Fastmail filter", { filterId, from });

  // Get current script (may be null if no script exists)
  const existingScript = await getSieveScript(client, accountId);

  // Ensure managed section exists — appends to existing script, never replaces
  const script = ensureManagedSection(existingScript);

  // Parse managed section
  const parsed = parseManagedSection(script);

  // Validate section
  validateManagedSection(parsed);

  // Check for duplicate
  const existingFilter = parsed.filters.find((f) => f.id === filterId);
  if (existingFilter) {
    logger.info("Filter already exists, returning existing ID", { filterId });
    return { status: 200 };
  }

  // Resolve label IDs to Sieve folder names
  const addFolders = await Promise.all(
    addLabelIds.map((labelId) =>
      resolveSieveFolder(labelId, client, accountId),
    ),
  );

  // For removeLabelIds containing "INBOX", we add "Archive" folder
  const sieveFolders = [...addFolders];
  if (removeLabelIds.includes("INBOX")) {
    sieveFolders.push("Archive");
  }

  // Generate Sieve rule with original label IDs in metadata and folder names in code
  const sieveRule = generateSieveRule({
    id: filterId,
    from,
    addLabelIds,
    removeLabelIds,
    sieveFolders,
  });

  // Insert into section
  const updatedScript = insertFilterIntoSection(script, sieveRule);

  // Upload updated script
  await setSieveScript(client, accountId, updatedScript);

  logger.info("Filter created successfully", { filterId });

  return { status: 200 };
}

export async function deleteFilterOperation(options: {
  client: FastmailClient;
  accountId: string;
  logger: Logger;
  id: string;
}): Promise<{ status: number }> {
  const { client, accountId, logger, id } = options;

  logger.info("Deleting Fastmail filter", { id });

  const existingScript = await getSieveScript(client, accountId);
  if (!existingScript) {
    logger.info("No Sieve script found, nothing to delete", { id });
    return { status: 200 };
  }

  const parsed = parseManagedSection(existingScript);

  validateManagedSection(parsed);

  const filterExists = parsed.filters.some((f) => f.id === id);
  if (!filterExists) {
    logger.info("Filter not found, nothing to delete", { id });
    return { status: 200 };
  }

  const remainingFilters = parsed.filters.filter((f) => f.id !== id);

  const updatedScript = regenerateManagedSection(
    existingScript,
    remainingFilters,
  );

  await setSieveScript(client, accountId, updatedScript);

  logger.info("Filter deleted successfully", { id });

  return { status: 200 };
}

export async function getFiltersListOperation(options: {
  client: FastmailClient;
  accountId: string;
  logger: Logger;
}): Promise<EmailFilter[]> {
  const { client, accountId, logger } = options;

  logger.trace("Fetching Fastmail filters list");

  const existingScript = await getSieveScript(client, accountId);
  if (!existingScript) {
    logger.info("No Sieve script found, returning empty list");
    return [];
  }

  // Parse existing script
  const parsed = parseManagedSection(existingScript);

  if (!parsed.found) {
    logger.info("Managed section not found, returning empty list");
    return [];
  }

  try {
    validateManagedSection(parsed);
  } catch (error) {
    logger.error("Failed to validate managed section", { error });
    return [];
  }

  const filters: EmailFilter[] = parsed.filters.map((filter) => ({
    id: filter.id,
    criteria: {
      from: filter.from,
    },
    action: {
      addLabelIds: filter.addLabelIds,
      removeLabelIds: filter.removeLabelIds,
    },
  }));

  logger.trace("Retrieved filters", { count: filters.length });

  return filters;
}
