import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFilterOperation,
  deleteFilterOperation,
  getFiltersListOperation,
} from "./filter-operations";
import { parseManagedSection } from "./filter";

describe("createFilterOperation", () => {
  let mockClient: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
  });

  it("creates filter in new managed section", async () => {
    let storedScript = "";

    mockClient = {
      makeRequest: vi.fn().mockImplementation(async (calls) => {
        const method = calls[0].methodName;

        if (method === "SieveScript/get") {
          return {
            methodResponses: [["SieveScript/get", { list: [] }]],
          };
        }

        if (method === "Mailbox/get") {
          return {
            methodResponses: [
              [
                "Mailbox/get",
                {
                  list: [{ id: "mailbox-uuid", name: "Inbox", role: "inbox" }],
                },
              ],
            ],
          };
        }

        if (method === "SieveScript/set") {
          storedScript = calls[0].args.create["new-1"].content;
          return {
            methodResponses: [
              [
                "SieveScript/set",
                {
                  created: { "new-1": { id: "script-new" } },
                },
              ],
            ],
          };
        }
      }),
    };

    const result = await createFilterOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
      from: "test@example.com",
      addLabelIds: ["INBOX"],
      removeLabelIds: [],
    });

    expect(result.status).toBe(200);
    expect(storedScript).toContain("test@example.com");

    const parsed = parseManagedSection(storedScript);
    expect(parsed.found).toBe(true);
    expect(parsed.filters).toHaveLength(1);
    expect(parsed.filters[0].from).toBe("test@example.com");
  });

  it("appends filter to existing section", async () => {
    const initialScript = `require ["fileinto"];

# === BEGIN INBOX ZERO MANAGED FILTERS ===
# DO NOT MANUALLY EDIT THIS SECTION
# Last updated: 2026-02-06T10:00:00Z

# Filter ID: existing123
# From: existing@example.com
# Add labels: ["mailbox-1"]
# Remove labels: []
if address :is "from" "existing@example.com" {
  fileinto "mailbox-1";
}

# === END INBOX ZERO MANAGED FILTERS ===`;

    let storedScript = "";

    mockClient = {
      makeRequest: vi.fn().mockImplementation(async (calls) => {
        const method = calls[0].methodName;

        if (method === "SieveScript/get") {
          return {
            methodResponses: [
              [
                "SieveScript/get",
                {
                  list: [
                    {
                      id: "script-123",
                      name: "main",
                      content: initialScript,
                      isActive: true,
                    },
                  ],
                },
              ],
            ],
          };
        }

        if (method === "Mailbox/get") {
          return {
            methodResponses: [
              [
                "Mailbox/get",
                {
                  list: [{ id: "mailbox-uuid", name: "Inbox", role: "inbox" }],
                },
              ],
            ],
          };
        }

        if (method === "SieveScript/set") {
          storedScript = calls[0].args.update["script-123"].content;
          return {
            methodResponses: [
              [
                "SieveScript/set",
                {
                  updated: { "script-123": null },
                },
              ],
            ],
          };
        }
      }),
    };

    await createFilterOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
      from: "new@example.com",
      addLabelIds: ["INBOX"],
      removeLabelIds: [],
    });

    const parsed = parseManagedSection(storedScript);
    expect(parsed.filters).toHaveLength(2);
    expect(parsed.filters[0].from).toBe("existing@example.com");
    expect(parsed.filters[1].from).toBe("new@example.com");
  });

  it("is idempotent - returns existing filter if duplicate", async () => {
    const scriptWithFilter = `require ["fileinto"];

# === BEGIN INBOX ZERO MANAGED FILTERS ===
# Filter ID: 874a39c35b912bcd0c075d9c9b39eff9
# From: test@example.com
# Add labels: ["INBOX"]
# Remove labels: []
if address :is "from" "test@example.com" {
  fileinto "INBOX";
}
# === END INBOX ZERO MANAGED FILTERS ===`;

    mockClient = {
      makeRequest: vi.fn().mockImplementation(async (calls) => {
        const method = calls[0].methodName;

        if (method === "SieveScript/get") {
          return {
            methodResponses: [
              [
                "SieveScript/get",
                {
                  list: [
                    {
                      id: "script-123",
                      name: "main",
                      content: scriptWithFilter,
                      isActive: true,
                    },
                  ],
                },
              ],
            ],
          };
        }

        if (method === "Mailbox/get") {
          return {
            methodResponses: [
              [
                "Mailbox/get",
                {
                  list: [{ id: "INBOX", name: "Inbox", role: "inbox" }],
                },
              ],
            ],
          };
        }
      }),
    };

    const result = await createFilterOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
      from: "test@example.com",
      addLabelIds: ["INBOX"],
      removeLabelIds: [],
    });

    // Should not call SieveScript/set
    const setCalls = mockClient.makeRequest.mock.calls.filter(
      (call: any) => call[0][0]?.methodName === "SieveScript/set",
    );
    expect(setCalls).toHaveLength(0);

    expect(result.status).toBe(200);
  });
});

describe("deleteFilterOperation", () => {
  let mockClient: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
  });

  it("removes filter from managed section", async () => {
    const scriptWithFilters = `# === BEGIN INBOX ZERO MANAGED FILTERS ===
# Filter ID: abc123
# From: test1@example.com
# Add labels: ["mailbox-1"]
# Remove labels: []
if address :is "from" "test1@example.com" {
  fileinto "mailbox-1";
}

# Filter ID: def456
# From: test2@example.com
# Add labels: ["mailbox-2"]
# Remove labels: []
if address :is "from" "test2@example.com" {
  fileinto "mailbox-2";
}
# === END INBOX ZERO MANAGED FILTERS ===`;

    let storedScript = "";

    mockClient = {
      makeRequest: vi.fn().mockImplementation(async (calls) => {
        const method = calls[0].methodName;

        if (method === "SieveScript/get") {
          return {
            methodResponses: [
              [
                "SieveScript/get",
                {
                  list: [
                    {
                      id: "script-123",
                      name: "main",
                      content: scriptWithFilters,
                      isActive: true,
                    },
                  ],
                },
              ],
            ],
          };
        }

        if (method === "SieveScript/set") {
          storedScript = calls[0].args.update["script-123"].content;
          return {
            methodResponses: [
              [
                "SieveScript/set",
                {
                  updated: { "script-123": null },
                },
              ],
            ],
          };
        }
      }),
    };

    await deleteFilterOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
      id: "abc123",
    });

    const parsed = parseManagedSection(storedScript);
    expect(parsed.filters).toHaveLength(1);
    expect(parsed.filters[0].id).toBe("def456");
  });

  it("is idempotent - succeeds when filter not found", async () => {
    const scriptWithFilter = `# === BEGIN INBOX ZERO MANAGED FILTERS ===
# Filter ID: def456
# From: test@example.com
# Add labels: ["mailbox-1"]
# Remove labels: []
if address :is "from" "test@example.com" {
  fileinto "mailbox-1";
}
# === END INBOX ZERO MANAGED FILTERS ===`;

    mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-123",
                  name: "main",
                  content: scriptWithFilter,
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    // Should not throw
    await deleteFilterOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
      id: "nonexistent123",
    });

    // Should not call SieveScript/set
    const setCalls = mockClient.makeRequest.mock.calls.filter(
      (call: any) => call[0].methodName === "SieveScript/set",
    );
    expect(setCalls).toHaveLength(0);
  });
});

describe("getFiltersListOperation", () => {
  let mockClient: any;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    };
  });

  it("returns empty array when no filters exist", async () => {
    const emptyScript = `# === BEGIN INBOX ZERO MANAGED FILTERS ===
# Last updated: 2026-02-06T10:00:00Z
# === END INBOX ZERO MANAGED FILTERS ===`;

    mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-123",
                  name: "main",
                  content: emptyScript,
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const filters = await getFiltersListOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
    });

    expect(filters).toEqual([]);
  });

  it("returns list of filters in EmailFilter format", async () => {
    const scriptWithFilters = `# === BEGIN INBOX ZERO MANAGED FILTERS ===
# Filter ID: abc123
# From: test1@example.com
# Add labels: ["mailbox-1"]
# Remove labels: []
if address :is "from" "test1@example.com" {
  fileinto "mailbox-1";
}

# Filter ID: def456
# From: test2@example.com
# Add labels: ["mailbox-2"]
# Remove labels: ["INBOX"]
if address :is "from" "test2@example.com" {
  fileinto "mailbox-2";
  fileinto "Archive";
}
# === END INBOX ZERO MANAGED FILTERS ===`;

    mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-123",
                  name: "main",
                  content: scriptWithFilters,
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const filters = await getFiltersListOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
    });

    expect(filters).toHaveLength(2);

    expect(filters[0]).toEqual({
      id: "abc123",
      criteria: {
        from: "test1@example.com",
      },
      action: {
        addLabelIds: ["mailbox-1"],
        removeLabelIds: [],
      },
    });

    expect(filters[1]).toEqual({
      id: "def456",
      criteria: {
        from: "test2@example.com",
      },
      action: {
        addLabelIds: ["mailbox-2"],
        removeLabelIds: ["INBOX"],
      },
    });
  });

  it("returns empty array when managed section not found", async () => {
    const scriptWithoutSection = `require ["fileinto"];

if address :is "from" "user@example.com" {
  fileinto "Custom";
}`;

    mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-123",
                  name: "main",
                  content: scriptWithoutSection,
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const filters = await getFiltersListOperation({
      client: mockClient,
      accountId: "account-123",
      logger: mockLogger,
    });

    expect(filters).toEqual([]);
  });
});
