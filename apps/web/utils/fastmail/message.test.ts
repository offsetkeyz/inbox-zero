import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseJMAPEmail, queryEmails, getEmails } from "./message";
import type { JMAPEmail } from "./types";
import type { FastmailClient } from "./client";

const mockClient = {
  makeRequest: vi.fn(),
} as unknown as FastmailClient;

const mockJMAPEmail: JMAPEmail = {
  id: "email-123",
  blobId: "blob-123",
  threadId: "thread-123",
  mailboxIds: { "mailbox-inbox": true },
  keywords: { $seen: true },
  size: 1024,
  receivedAt: "2024-01-15T10:30:00Z",
  messageId: ["<abc@example.com>"],
  inReplyTo: null,
  references: null,
  sender: null,
  from: [{ name: "John Doe", email: "john@example.com" }],
  to: [{ name: "Jane Doe", email: "jane@example.com" }],
  cc: null,
  bcc: null,
  replyTo: null,
  subject: "Test Subject",
  sentAt: "2024-01-15T10:30:00Z",
  hasAttachment: false,
  preview: "This is a preview of the email content...",
  bodyValues: {
    "1": { value: "Plain text body", isEncodingProblem: false, isTruncated: false },
    "2": { value: "<p>HTML body</p>", isEncodingProblem: false, isTruncated: false },
  },
  textBody: [{ partId: "1", blobId: "b1", size: 100, name: null, type: "text/plain", charset: "utf-8", disposition: null, cid: null, location: null }],
  htmlBody: [{ partId: "2", blobId: "b2", size: 200, name: null, type: "text/html", charset: "utf-8", disposition: null, cid: null, location: null }],
  attachments: [],
};

describe("parseJMAPEmail", () => {
  it("parses email addresses correctly", () => {
    const parsed = parseJMAPEmail(mockJMAPEmail);

    expect(parsed.headers.from).toBe("John Doe <john@example.com>");
    expect(parsed.headers.to).toBe("Jane Doe <jane@example.com>");
  });

  it("extracts subject and preview", () => {
    const parsed = parseJMAPEmail(mockJMAPEmail);

    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.snippet).toBe("This is a preview of the email content...");
  });

  it("extracts body content", () => {
    const parsed = parseJMAPEmail(mockJMAPEmail);

    expect(parsed.textPlain).toBe("Plain text body");
    expect(parsed.textHtml).toBe("<p>HTML body</p>");
  });

  it("preserves IDs", () => {
    const parsed = parseJMAPEmail(mockJMAPEmail);

    expect(parsed.id).toBe("email-123");
    expect(parsed.threadId).toBe("thread-123");
  });

  it("adds UNREAD to labelIds when email is not seen", () => {
    const unreadEmail = { ...mockJMAPEmail, keywords: {} };
    const parsed = parseJMAPEmail(unreadEmail);

    expect(parsed.labelIds).toContain("UNREAD");
  });

  it("includes mailbox IDs in labelIds", () => {
    const parsed = parseJMAPEmail(mockJMAPEmail);

    expect(parsed.labelIds).toContain("mailbox-inbox");
  });
});

describe("queryEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends correct JMAP request", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [["Email/query", { ids: ["email-1", "email-2"], position: 0, total: 2 }, "email-query"]],
      sessionState: "state-1",
    });

    const result = await queryEmails(mockClient, {
      accountId: "account-123",
      mailboxId: "mailbox-inbox",
      limit: 10,
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      expect.objectContaining({
        methodName: "Email/query",
        args: expect.objectContaining({
          accountId: "account-123",
          filter: { inMailbox: "mailbox-inbox" },
          limit: 10,
        }),
      }),
    ]);

    expect(result.ids).toEqual(["email-1", "email-2"]);
  });
});

describe("getEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result for empty ids", async () => {
    const result = await getEmails(mockClient, {
      accountId: "account-123",
      ids: [],
    });

    expect(result.list).toEqual([]);
    expect(mockClient.makeRequest).not.toHaveBeenCalled();
  });

  it("fetches emails by ID", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [["Email/get", { list: [mockJMAPEmail], notFound: [] }, "email-get"]],
      sessionState: "state-1",
    });

    const result = await getEmails(mockClient, {
      accountId: "account-123",
      ids: ["email-123"],
    });

    expect(result.list).toHaveLength(1);
    expect(result.list[0].id).toBe("email-123");
  });
});
