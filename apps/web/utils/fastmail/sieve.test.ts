import { describe, it, expect, vi } from "vitest";
import { getSieveScript, setSieveScript, getCurrentScriptId } from "./sieve";
import type { SieveScript } from "./types";

describe("getSieveScript", () => {
  it("returns active script content", async () => {
    const mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-1",
                  name: "main",
                  content: 'require ["fileinto"];',
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const content = await getSieveScript(mockClient as any, "account-123");

    expect(content).toBe('require ["fileinto"];');
    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "SieveScript/get",
        args: {
          accountId: "account-123",
          ids: null,
        },
        id: "sieve-get",
      },
    ]);
  });

  it("returns null when no active script exists", async () => {
    const mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [],
            },
          ],
        ],
      }),
    };

    const content = await getSieveScript(mockClient as any, "account-123");

    expect(content).toBeNull();
  });

  it("prefers active script over inactive ones", async () => {
    const mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-1",
                  name: "old",
                  content: "# Old script",
                  isActive: false,
                },
                {
                  id: "script-2",
                  name: "main",
                  content: "# Active script",
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const content = await getSieveScript(mockClient as any, "account-123");

    expect(content).toBe("# Active script");
  });
});

describe("getCurrentScriptId", () => {
  it("returns active script ID", async () => {
    const mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [
                {
                  id: "script-123",
                  name: "main",
                  content: "test",
                  isActive: true,
                },
              ],
            },
          ],
        ],
      }),
    };

    const id = await getCurrentScriptId(mockClient as any, "account-123");

    expect(id).toBe("script-123");
  });

  it("returns null when no active script", async () => {
    const mockClient = {
      makeRequest: vi.fn().mockResolvedValue({
        methodResponses: [
          [
            "SieveScript/get",
            {
              list: [],
            },
          ],
        ],
      }),
    };

    const id = await getCurrentScriptId(mockClient as any, "account-123");

    expect(id).toBeNull();
  });
});

describe("setSieveScript", () => {
  it("updates existing active script", async () => {
    const mockClient = {
      makeRequest: vi
        .fn()
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/get",
              {
                list: [
                  {
                    id: "script-123",
                    name: "main",
                    content: "old content",
                    isActive: true,
                  },
                ],
              },
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/set",
              {
                updated: {
                  "script-123": null,
                },
              },
            ],
          ],
        }),
    };

    await setSieveScript(mockClient as any, "account-123", "new content");

    expect(mockClient.makeRequest).toHaveBeenCalledTimes(2);
    expect(mockClient.makeRequest).toHaveBeenLastCalledWith([
      {
        methodName: "SieveScript/set",
        args: {
          accountId: "account-123",
          update: {
            "script-123": { content: "new content" },
          },
        },
        id: "sieve-set",
      },
    ]);
  });

  it("creates new script when none exists", async () => {
    const mockClient = {
      makeRequest: vi
        .fn()
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/get",
              {
                list: [],
              },
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/set",
              {
                created: {
                  "new-1": { id: "script-new" },
                },
              },
            ],
          ],
        }),
    };

    await setSieveScript(mockClient as any, "account-123", "new content");

    expect(mockClient.makeRequest).toHaveBeenLastCalledWith([
      {
        methodName: "SieveScript/set",
        args: {
          accountId: "account-123",
          create: {
            "new-1": {
              name: "Inbox Zero",
              content: "new content",
              isActive: true,
            },
          },
        },
        id: "sieve-set",
      },
    ]);
  });

  it("throws error when update fails", async () => {
    const mockClient = {
      makeRequest: vi
        .fn()
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/get",
              {
                list: [
                  {
                    id: "script-123",
                    name: "main",
                    content: "old",
                    isActive: true,
                  },
                ],
              },
            ],
          ],
        })
        .mockResolvedValueOnce({
          methodResponses: [
            [
              "SieveScript/set",
              {
                notUpdated: {
                  "script-123": {
                    type: "invalidScript",
                    description: "Syntax error",
                  },
                },
              },
            ],
          ],
        }),
    };

    await expect(
      setSieveScript(mockClient as any, "account-123", "bad content"),
    ).rejects.toThrow(/invalidScript/);
  });
});
