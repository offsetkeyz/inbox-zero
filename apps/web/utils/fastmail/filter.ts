import crypto from "node:crypto";

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
