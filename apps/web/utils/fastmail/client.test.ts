import { describe, it, expect, vi, beforeEach } from "vitest";
import { FastmailClient, createFastmailClient } from "./client";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const mockSession = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  accounts: {
    "account-123": {
      name: "Test User",
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {},
    },
  },
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "account-123",
  },
  username: "test@fastmail.com",
  capabilities: {},
  state: "test-state",
};

describe("FastmailClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  describe("constructor", () => {
    it("throws SafeError when no access token provided", () => {
      expect(() => createFastmailClient("", mockLogger as any)).toThrow(
        "No access token provided",
      );
    });

    it("creates client with valid access token", () => {
      const client = createFastmailClient("valid-token", mockLogger as any);
      expect(client).toBeInstanceOf(FastmailClient);
    });
  });

  describe("getAccessToken", () => {
    it("returns the access token", () => {
      const client = createFastmailClient("my-token", mockLogger as any);
      expect(client.getAccessToken()).toBe("my-token");
    });
  });

  describe("getSession", () => {
    it("fetches session from JMAP endpoint", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const client = createFastmailClient("valid-token", mockLogger as any);
      const session = await client.getSession();

      expect(fetch).toHaveBeenCalledWith(
        "https://api.fastmail.com/.well-known/jmap",
        expect.objectContaining({
          method: "GET",
          headers: {
            Authorization: "Bearer valid-token",
            "Content-Type": "application/json",
          },
        }),
      );
      expect(session.username).toBe("test@fastmail.com");
    });

    it("caches session on subsequent calls", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const client = createFastmailClient("valid-token", mockLogger as any);
      await client.getSession();
      await client.getSession();

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws SafeError on auth failure", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const client = createFastmailClient("invalid-token", mockLogger as any);
      await expect(client.getSession()).rejects.toThrow(
        "Failed to authenticate with Fastmail",
      );
    });
  });

  describe("getAccountId", () => {
    it("returns primary mail account ID", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const client = createFastmailClient("valid-token", mockLogger as any);
      const accountId = await client.getAccountId();

      expect(accountId).toBe("account-123");
    });

    it("throws SafeError when no mail account found", async () => {
      const sessionWithoutMail = {
        ...mockSession,
        primaryAccounts: {},
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(sessionWithoutMail),
      });

      const client = createFastmailClient("valid-token", mockLogger as any);
      await expect(client.getAccountId()).rejects.toThrow(
        "No mail account found in JMAP session",
      );
    });

    it("caches account ID on subsequent calls", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSession),
      });

      const client = createFastmailClient("valid-token", mockLogger as any);
      await client.getAccountId();
      await client.getAccountId();

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("makeRequest", () => {
    it("sends JMAP method calls to API", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockSession),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              methodResponses: [["Email/get", { list: [] }, "call-1"]],
              sessionState: "state-1",
            }),
        });

      const client = createFastmailClient("valid-token", mockLogger as any);
      const response = await client.makeRequest([
        {
          methodName: "Email/get",
          args: { accountId: "account-123", ids: ["email-1"] },
          id: "call-1",
        },
      ]);

      expect(response.methodResponses).toHaveLength(1);
      expect(response.methodResponses[0][0]).toBe("Email/get");
    });

    it("throws SafeError on 401 response", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockSession),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: () => Promise.resolve("Unauthorized"),
        });

      const client = createFastmailClient("valid-token", mockLogger as any);
      await expect(
        client.makeRequest([
          { methodName: "Email/get", args: {}, id: "call-1" },
        ]),
      ).rejects.toThrow(
        "Authentication failed. Please reconnect your Fastmail account.",
      );
    });

    it("throws SafeError on other errors", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockSession),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Server error"),
        });

      const client = createFastmailClient("valid-token", mockLogger as any);
      await expect(
        client.makeRequest([
          { methodName: "Email/get", args: {}, id: "call-1" },
        ]),
      ).rejects.toThrow("Failed to communicate with Fastmail");
    });
  });
});
