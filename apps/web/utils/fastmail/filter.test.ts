import { describe, it, expect } from "vitest";
import {
  generateFilterId,
  generateSieveRule,
  parseManagedSection,
} from "./filter";
import {
  SIEVE_MANAGED_SECTION_BEGIN,
  SIEVE_MANAGED_SECTION_END,
} from "./constants";

describe("generateFilterId", () => {
  it("generates consistent 32-character hash for same criteria", () => {
    const criteria = {
      from: "test@example.com",
      addLabelIds: ["label1"],
      removeLabelIds: ["INBOX"],
    };

    const id1 = generateFilterId(criteria);
    const id2 = generateFilterId(criteria);

    expect(id1).toBe(id2);
    expect(id1).toHaveLength(32);
    expect(id1).toMatch(/^[a-f0-9]{32}$/);
  });

  it("normalizes email to lowercase", () => {
    const criteria1 = { from: "Test@Example.COM" };
    const criteria2 = { from: "test@example.com" };

    expect(generateFilterId(criteria1)).toBe(generateFilterId(criteria2));
  });

  it("sorts array fields for consistency", () => {
    const criteria1 = {
      from: "test@example.com",
      addLabelIds: ["label2", "label1"],
    };
    const criteria2 = {
      from: "test@example.com",
      addLabelIds: ["label1", "label2"],
    };

    expect(generateFilterId(criteria1)).toBe(generateFilterId(criteria2));
  });

  it("generates different IDs for different criteria", () => {
    const criteria1 = { from: "test1@example.com" };
    const criteria2 = { from: "test2@example.com" };

    expect(generateFilterId(criteria1)).not.toBe(generateFilterId(criteria2));
  });

  it("trims whitespace from email", () => {
    const criteria1 = { from: "  test@example.com  " };
    const criteria2 = { from: "test@example.com" };

    expect(generateFilterId(criteria1)).toBe(generateFilterId(criteria2));
  });
});

describe("generateSieveRule", () => {
  it("generates RFC 5228 compliant rule for single folder", () => {
    const rule = generateSieveRule({
      id: "abc123",
      from: "newsletter@example.com",
      addLabelIds: ["label-1"],
      removeLabelIds: [],
      sieveFolders: ["Newsletter"],
    });

    expect(rule).toContain("# Filter ID: abc123");
    expect(rule).toContain("# From: newsletter@example.com");
    expect(rule).toContain('# Add labels: ["label-1"]');
    expect(rule).toContain("# Remove labels: []");
    expect(rule).toContain('if address :is "from" "newsletter@example.com"');
    expect(rule).toContain('  fileinto "Newsletter";');
    expect(rule).toContain("}");
  });

  it("generates multiple fileinto statements for multiple folders", () => {
    const rule = generateSieveRule({
      id: "def456",
      from: "test@example.com",
      addLabelIds: ["label-1", "label-2"],
      removeLabelIds: [],
      sieveFolders: ["Projects", "Important"],
    });

    expect(rule).toContain('  fileinto "Projects";');
    expect(rule).toContain('  fileinto "Important";');
  });

  it("handles archive pattern (remove INBOX)", () => {
    const rule = generateSieveRule({
      id: "ghi789",
      from: "archive@example.com",
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
      sieveFolders: ["Archive"],
    });

    expect(rule).toContain('# Remove labels: ["INBOX"]');
    expect(rule).toContain('  fileinto "Archive";');
  });

  it("handles add label + archive", () => {
    const rule = generateSieveRule({
      id: "jkl012",
      from: "both@example.com",
      addLabelIds: ["custom-label"],
      removeLabelIds: ["INBOX"],
      sieveFolders: ["CustomFolder", "Archive"],
    });

    expect(rule).toContain('  fileinto "CustomFolder";');
    expect(rule).toContain('  fileinto "Archive";');
  });

  it("escapes special characters in email addresses", () => {
    const rule = generateSieveRule({
      id: "mno345",
      from: 'test"quote@example.com',
      addLabelIds: ["label-1"],
      removeLabelIds: [],
      sieveFolders: ["Folder1"],
    });

    expect(rule).toContain('if address :is "from" "test\\"quote@example.com"');
  });

  it("includes created timestamp", () => {
    const before = new Date().toISOString();
    const rule = generateSieveRule({
      id: "pqr678",
      from: "test@example.com",
      addLabelIds: ["label-1"],
      removeLabelIds: [],
      sieveFolders: ["Folder1"],
    });
    const after = new Date().toISOString();

    expect(rule).toMatch(
      /# Created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
    );
    const match = rule.match(/# Created: (.+)/);
    expect(match).toBeTruthy();
    const timestamp = match![1];
    expect(timestamp >= before && timestamp <= after).toBe(true);
  });
});

describe("parseManagedSection", () => {
  it("returns not found for script without managed section", () => {
    const script = `require ["fileinto"];

if address :is "from" "test@example.com" {
  fileinto "Archive";
}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(false);
    expect(result.filters).toEqual([]);
  });

  it("parses empty managed section", () => {
    const script = `require ["fileinto"];

${SIEVE_MANAGED_SECTION_BEGIN}
# DO NOT MANUALLY EDIT THIS SECTION
# Last updated: 2026-02-06T10:00:00Z
${SIEVE_MANAGED_SECTION_END}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(true);
    expect(result.filters).toEqual([]);
    expect(result.lastUpdated).toBe("2026-02-06T10:00:00Z");
  });

  it("parses single filter from comments", () => {
    const script = `${SIEVE_MANAGED_SECTION_BEGIN}
# Filter ID: abc123
# From: test@example.com
# Add labels: ["label-1"]
# Remove labels: []
if address :is "from" "test@example.com" {
  fileinto "Folder1";
}
${SIEVE_MANAGED_SECTION_END}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(true);
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0]).toEqual({
      id: "abc123",
      from: "test@example.com",
      addLabelIds: ["label-1"],
      removeLabelIds: [],
      sieveCode: expect.stringContaining('if address :is "from"'),
    });
  });

  it("parses multiple filters", () => {
    const script = `${SIEVE_MANAGED_SECTION_BEGIN}
# Filter ID: abc123
# From: test1@example.com
# Add labels: ["label-1"]
# Remove labels: []
if address :is "from" "test1@example.com" {
  fileinto "Folder1";
}

# Filter ID: def456
# From: test2@example.com
# Add labels: ["label-2"]
# Remove labels: ["INBOX"]
if address :is "from" "test2@example.com" {
  fileinto "Folder2";
  fileinto "Archive";
}
${SIEVE_MANAGED_SECTION_END}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(true);
    expect(result.filters).toHaveLength(2);
    expect(result.filters[0].id).toBe("abc123");
    expect(result.filters[1].id).toBe("def456");
  });

  it("detects corrupted BEGIN marker", () => {
    const script = `# === CORRUPTED BEGIN ===
# Filter ID: abc123
${SIEVE_MANAGED_SECTION_END}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(false);
    expect(result.hasCorruptedMarkers).toBe(true);
  });

  it("detects corrupted END marker", () => {
    const script = `${SIEVE_MANAGED_SECTION_BEGIN}
# Filter ID: abc123
# === CORRUPTED END ===`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(false);
    expect(result.hasCorruptedMarkers).toBe(true);
  });

  it("detects malformed filter comments", () => {
    const script = `${SIEVE_MANAGED_SECTION_BEGIN}
# Filter ID: abc123
# From: missing@example.com
# Missing Add labels comment
if address :is "from" "missing@example.com" {
  fileinto "mailbox";
}
${SIEVE_MANAGED_SECTION_END}`;

    const result = parseManagedSection(script);

    expect(result.found).toBe(true);
    expect(result.hasMalformedComments).toBe(true);
  });
});
