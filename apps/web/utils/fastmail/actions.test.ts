import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  updateEmails,
  markEmailsRead,
  archiveEmails,
  trashEmails,
  markEmailsAsSpam,
  getThreadEmailIds,
} from "./actions";
import type { FastmailClient } from "./client";

const mockClient = {
  makeRequest: vi.fn(),
} as unknown as FastmailClient;

vi.mock("./mailbox", () => ({
  getInboxMailboxId: vi.fn().mockResolvedValue("mailbox-inbox"),
  getArchiveMailboxId: vi.fn().mockResolvedValue("mailbox-archive"),
  getTrashMailboxId: vi.fn().mockResolvedValue("mailbox-trash"),
  getJunkMailboxId: vi.fn().mockResolvedValue("mailbox-junk"),
}));

describe("updateEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Email/set request with updates", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    const result = await updateEmails(mockClient, {
      accountId: "account-123",
      updates: {
        "email-1": { "keywords/$seen": true },
      },
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": { "keywords/$seen": true },
          },
        },
        id: "email-set",
      },
    ]);

    expect(result.updated).toEqual({ "email-1": null });
  });
});

describe("markEmailsRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks emails as read", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null, "email-2": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    await markEmailsRead(mockClient, {
      accountId: "account-123",
      emailIds: ["email-1", "email-2"],
      read: true,
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": { "keywords/$seen": true },
            "email-2": { "keywords/$seen": true },
          },
        },
        id: "email-set",
      },
    ]);
  });

  it("marks emails as unread with null", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    await markEmailsRead(mockClient, {
      accountId: "account-123",
      emailIds: ["email-1"],
      read: false,
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": { "keywords/$seen": null },
          },
        },
        id: "email-set",
      },
    ]);
  });
});

describe("archiveEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves emails to archive mailbox", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    await archiveEmails(mockClient, {
      accountId: "account-123",
      emailIds: ["email-1"],
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": {
              "mailboxIds/mailbox-archive": true,
              "mailboxIds/mailbox-inbox": null,
            },
          },
        },
        id: "email-set",
      },
    ]);
  });
});

describe("trashEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves emails to trash mailbox", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    await trashEmails(mockClient, {
      accountId: "account-123",
      emailIds: ["email-1"],
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": {
              mailboxIds: { "mailbox-trash": true },
            },
          },
        },
        id: "email-set",
      },
    ]);
  });
});

describe("markEmailsAsSpam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves emails to junk mailbox", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            updated: { "email-1": null },
            created: null,
            destroyed: null,
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "email-set",
        ],
      ],
      sessionState: "session-1",
    });

    await markEmailsAsSpam(mockClient, {
      accountId: "account-123",
      emailIds: ["email-1"],
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          update: {
            "email-1": {
              mailboxIds: { "mailbox-junk": true },
            },
          },
        },
        id: "email-set",
      },
    ]);
  });
});

describe("getThreadEmailIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns email IDs from thread", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Thread/get",
          {
            list: [
              { id: "thread-1", emailIds: ["email-1", "email-2", "email-3"] },
            ],
            notFound: [],
          },
          "thread-get",
        ],
      ],
      sessionState: "session-1",
    });

    const emailIds = await getThreadEmailIds(mockClient, {
      accountId: "account-123",
      threadId: "thread-1",
    });

    expect(emailIds).toEqual(["email-1", "email-2", "email-3"]);
  });

  it("returns empty array for non-existent thread", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Thread/get",
          {
            list: [],
            notFound: ["thread-999"],
          },
          "thread-get",
        ],
      ],
      sessionState: "session-1",
    });

    const emailIds = await getThreadEmailIds(mockClient, {
      accountId: "account-123",
      threadId: "thread-999",
    });

    expect(emailIds).toEqual([]);
  });
});
