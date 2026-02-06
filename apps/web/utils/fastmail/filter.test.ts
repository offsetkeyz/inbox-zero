import { describe, it, expect } from "vitest";
import { generateFilterId } from "./filter";

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
