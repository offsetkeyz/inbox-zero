import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getIdentities,
  getPrimaryIdentity,
  sendEmail,
  createDraft,
  deleteDraft,
} from "./mail";
import type { FastmailClient } from "./client";

const mockClient = {
  makeRequest: vi.fn(),
} as unknown as FastmailClient;

vi.mock("./mailbox", () => ({
  getSentMailboxId: vi.fn().mockResolvedValue("mailbox-sent"),
  getDraftsMailboxId: vi.fn().mockResolvedValue("mailbox-drafts"),
}));

const mockIdentity = {
  id: "identity-1",
  name: "Test User",
  email: "test@fastmail.com",
  replyTo: null,
  bcc: null,
  textSignature: "",
  htmlSignature: "",
  mayDelete: false,
};

describe("getIdentities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches identities from JMAP", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Identity/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockIdentity],
            notFound: [],
          },
          "identity-get",
        ],
      ],
      sessionState: "session-1",
    });

    const result = await getIdentities(mockClient, { accountId: "account-123" });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Identity/get",
        args: { accountId: "account-123" },
        id: "identity-get",
      },
    ]);

    expect(result.list).toHaveLength(1);
    expect(result.list[0].email).toBe("test@fastmail.com");
  });
});

describe("getPrimaryIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the first identity", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Identity/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockIdentity],
            notFound: [],
          },
          "identity-get",
        ],
      ],
      sessionState: "session-1",
    });

    const identity = await getPrimaryIdentity(mockClient, { accountId: "account-123" });

    expect(identity?.id).toBe("identity-1");
    expect(identity?.email).toBe("test@fastmail.com");
  });

  it("returns null when no identities", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Identity/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [],
            notFound: [],
          },
          "identity-get",
        ],
      ],
      sessionState: "session-1",
    });

    const identity = await getPrimaryIdentity(mockClient, { accountId: "account-123" });

    expect(identity).toBeNull();
  });
});

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates email and submits it", async () => {
    const identityResponse = {
      methodResponses: [
        [
          "Identity/get",
          {
            accountId: "account-123",
            state: "state-1",
            list: [mockIdentity],
            notFound: [],
          },
          "identity-get",
        ],
      ],
      sessionState: "session-1",
    };

    vi.mocked(mockClient.makeRequest)
      .mockResolvedValueOnce(identityResponse)
      .mockResolvedValueOnce(identityResponse)
      .mockResolvedValueOnce({
        methodResponses: [
          [
            "Email/set",
            {
              accountId: "account-123",
              oldState: "state-1",
              newState: "state-2",
              created: {
                draft: { id: "email-new", threadId: "thread-new" },
              },
              updated: null,
              destroyed: null,
              notCreated: null,
              notUpdated: null,
              notDestroyed: null,
            },
            "email-create",
          ],
        ],
        sessionState: "session-1",
      })
      .mockResolvedValueOnce({
        methodResponses: [
          [
            "EmailSubmission/set",
            {
              accountId: "account-123",
              oldState: "state-1",
              newState: "state-2",
              created: { submission: { id: "submission-1" } },
              updated: null,
              destroyed: null,
              notCreated: null,
              notUpdated: null,
              notDestroyed: null,
            },
            "submission-set",
          ],
        ],
        sessionState: "session-1",
      });

    const result = await sendEmail(mockClient, {
      accountId: "account-123",
      to: "recipient@example.com",
      subject: "Test Subject",
      textBody: "Hello, World!",
    });

    expect(result.messageId).toBe("email-new");
    expect(result.threadId).toBe("thread-new");
    expect(mockClient.makeRequest).toHaveBeenCalledTimes(4);
  });
});

describe("createDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a draft email", async () => {
    vi.mocked(mockClient.makeRequest)
      .mockResolvedValueOnce({
        methodResponses: [
          [
            "Identity/get",
            {
              accountId: "account-123",
              state: "state-1",
              list: [mockIdentity],
              notFound: [],
            },
            "identity-get",
          ],
        ],
        sessionState: "session-1",
      })
      .mockResolvedValueOnce({
        methodResponses: [
          [
            "Email/set",
            {
              accountId: "account-123",
              oldState: "state-1",
              newState: "state-2",
              created: {
                draft: { id: "draft-123" },
              },
              updated: null,
              destroyed: null,
              notCreated: null,
              notUpdated: null,
              notDestroyed: null,
            },
            "draft-create",
          ],
        ],
        sessionState: "session-1",
      });

    const result = await createDraft(mockClient, {
      accountId: "account-123",
      to: "recipient@example.com",
      subject: "Draft Subject",
      htmlBody: "<p>Draft content</p>",
    });

    expect(result.draftId).toBe("draft-123");
  });
});

describe("deleteDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a draft", async () => {
    vi.mocked(mockClient.makeRequest).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            accountId: "account-123",
            oldState: "state-1",
            newState: "state-2",
            created: null,
            updated: null,
            destroyed: ["draft-123"],
            notCreated: null,
            notUpdated: null,
            notDestroyed: null,
          },
          "draft-delete",
        ],
      ],
      sessionState: "session-1",
    });

    await deleteDraft(mockClient, {
      accountId: "account-123",
      draftId: "draft-123",
    });

    expect(mockClient.makeRequest).toHaveBeenCalledWith([
      {
        methodName: "Email/set",
        args: {
          accountId: "account-123",
          destroy: ["draft-123"],
        },
        id: "draft-delete",
      },
    ]);
  });
});
