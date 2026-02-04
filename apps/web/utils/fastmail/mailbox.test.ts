import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMailboxes,
  getMailboxByRole,
  parseMailboxToLabel,
  getInboxMailboxId,
} from "./mailbox";
import type { JMAPMailbox } from "./types";
import type { FastmailClient } from "./client";

const mockClient = {
  makeRequest: vi.fn(),
} as unknown as FastmailClient;

const mockInboxMailbox: JMAPMailbox = {
  id: "mailbox-inbox",
  name: "Inbox",
  parentId: null,
  role: "inbox",
  sortOrder: 1,
  totalEmails: 150,
  unreadEmails: 5,
  totalThreads: 100,
  unreadThreads: 3,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: false,
    mayDelete: false,
    maySubmit: true,
  },
  isSubscribed: true,
};

const mockArchiveMailbox: JMAPMailbox = {
  id: "mailbox-archive",
  name: "Archive",
  parentId: null,
  role: "archive",
  sortOrder: 2,
  totalEmails: 500,
  unreadEmails: 0,
  totalThreads: 400,
  unreadThreads: 0,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: false,
    mayDelete: false,
    maySubmit: false,
  },
  isSubscribed: true,
};

const mockUserMailbox: JMAPMailbox = {
  id: "mailbox-projects",
  name: "Projects",
  parentId: null,
  role: null,
  sortOrder: 10,
  totalEmails: 25,
  unreadEmails: 2,
  totalThreads: 20,
  unreadThreads: 1,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: true,
    maySubmit: false,
  },
  isSubscribed: true,
};

describe("parseMailboxToLabel", () => {
  it("converts system mailbox to EmailLabel", () => {
    const label = parseMailboxToLabel(mockInboxMailbox);

    expect(label.id).toBe("mailbox-inbox");
    expect(label.name).toBe("Inbox");
    expect(label.type).toBe("system");
    expect(label.threadsTotal).toBe(100);
  });

  it("converts user mailbox to EmailLabel with type user", () => {
    const label = parseMailboxToLabel(mockUserMailbox);

    expect(label.id).toBe("mailbox-projects");
    expect(label.name).toBe("Projects");
    expect(label.type).toBe("user");
    expect(label.threadsTotal).toBe(20);
  });
});

describe("getMailboxes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches all mailboxes", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Mailbox/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockInboxMailbox, mockArchiveMailbox, mockUserMailbox],
            notFound: [],
          },
          "mailbox-get",
        ],
      ],
      sessionState: "state-1",
    });

    const result = await getMailboxes(mockClient, { accountId: "account-123" });

    expect(result.list).toHaveLength(3);
    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      expect.objectContaining({
        methodName: "Mailbox/get",
        args: { accountId: "account-123" },
      }),
    ]);
  });
});

describe("getMailboxByRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds mailbox by role", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Mailbox/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockInboxMailbox, mockArchiveMailbox],
            notFound: [],
          },
          "mailbox-get",
        ],
      ],
      sessionState: "state-1",
    });

    const result = await getMailboxByRole(mockClient, {
      accountId: "account-123",
      role: "archive",
    });

    expect(result?.id).toBe("mailbox-archive");
    expect(result?.role).toBe("archive");
  });

  it("returns null when role not found", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Mailbox/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockInboxMailbox],
            notFound: [],
          },
          "mailbox-get",
        ],
      ],
      sessionState: "state-1",
    });

    const result = await getMailboxByRole(mockClient, {
      accountId: "account-123",
      role: "junk",
    });

    expect(result).toBeNull();
  });
});

describe("getInboxMailboxId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns inbox mailbox ID", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Mailbox/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockInboxMailbox, mockArchiveMailbox],
            notFound: [],
          },
          "mailbox-get",
        ],
      ],
      sessionState: "state-1",
    });

    const result = await getInboxMailboxId(mockClient, "account-123");

    expect(result).toBe("mailbox-inbox");
  });
});
