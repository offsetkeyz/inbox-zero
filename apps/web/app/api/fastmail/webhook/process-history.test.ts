import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(),
  validateWebhookAccount: vi.fn(),
}));

vi.mock("@/utils/premium", () => ({
  isPremium: vi.fn(),
  hasAiAccess: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));

vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: vi.fn(),
}));

vi.mock("@/utils/redis/message-processing", () => ({
  markMessageAsProcessing: vi.fn().mockResolvedValue(true),
}));

import prisma from "@/utils/prisma";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { createEmailProvider } from "@/utils/email/provider";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { isPremium, hasAiAccess } from "@/utils/premium";
import { processStateChange } from "./process-history";
import { createScopedLogger } from "@/utils/logger";
import type { StateChange } from "./types";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  with: vi.fn().mockReturnThis(),
  flush: vi.fn().mockResolvedValue(undefined),
};

describe("processStateChange", () => {
  const mockEmailAccount = {
    id: "ea_123",
    email: "user@fastmail.com",
    userId: "user_123",
    lastSyncedJmapState: "oldState123",
    account: { provider: "fastmail" },
    rules: [],
  };

  const mockProvider = {
    getMessage: vi.fn(),
    getEmailChanges: vi.fn(),
    isSentMessage: vi.fn().mockReturnValue(false),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(
      mockEmailAccount as never,
    );
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: mockEmailAccount,
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as never);
    vi.mocked(createEmailProvider).mockResolvedValue(mockProvider as never);
  });

  it("processes created emails through shared processor", async () => {
    const newEmails = [
      { id: "email_1", threadId: "thread_1", labelIds: ["INBOX"] },
      { id: "email_2", threadId: "thread_2", labelIds: ["INBOX"] },
    ];

    mockProvider.getEmailChanges = vi.fn().mockResolvedValue({
      created: newEmails,
      newState: "newState456",
    });

    mockProvider.getMessage = vi
      .fn()
      .mockImplementation((id) => newEmails.find((e) => e.id === id));

    const stateChange: StateChange = {
      "@type": "StateChange",
      changed: {
        jmap_account_123: { Email: "newState456" },
      },
    };

    await processStateChange(stateChange, mockLogger);

    expect(getWebhookEmailAccount).toHaveBeenCalledWith(
      { jmapAccountId: "jmap_account_123" },
      expect.anything(),
    );
    expect(processHistoryItem).toHaveBeenCalledTimes(2);
  });

  it("updates lastSyncedJmapState after processing", async () => {
    mockProvider.getEmailChanges = vi.fn().mockResolvedValue({
      created: [{ id: "email_1", threadId: "thread_1", labelIds: ["INBOX"] }],
      newState: "newState456",
    });

    const stateChange: StateChange = {
      "@type": "StateChange",
      changed: {
        jmap_account_123: { Email: "newState456" },
      },
    };

    await processStateChange(stateChange, mockLogger);

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "ea_123" },
      data: { lastSyncedJmapState: "newState456" },
    });
  });

  it("skips orphaned accounts gracefully", async () => {
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(null);

    const stateChange: StateChange = {
      "@type": "StateChange",
      changed: {
        unknown_account: { Email: "newState456" },
      },
    };

    await processStateChange(stateChange, mockLogger);

    expect(processHistoryItem).not.toHaveBeenCalled();
  });

  it("ignores non-Email type changes", async () => {
    const stateChange: StateChange = {
      "@type": "StateChange",
      changed: {
        jmap_account_123: { Mailbox: "newMailboxState" }, // Not Email
      },
    };

    await processStateChange(stateChange, mockLogger);

    expect(processHistoryItem).not.toHaveBeenCalled();
  });
});

describe("processStateChange with token-authenticated account", () => {
  it("processes state change for account without refresh_token", async () => {
    const jmapAccountId = "jmap-account-token-auth";
    const userId = "user-token-auth";

    const mockEmailAccount = {
      id: "email-account-token-auth",
      email: "tokenuser@fastmail.com",
      userId,
      jmapAccountId,
      lastSyncedJmapState: "oldState123",
      account: {
        provider: "fastmail",
        access_token: "fastmail-api-token-xyz",
        refresh_token: null,
        expires_at: null,
        disconnectedAt: null,
      },
      rules: [
        {
          id: "rule-1",
          name: "Test Rule",
          instructions: "Archive newsletters",
          actions: [],
          enabled: true,
          automate: true,
        },
      ],
      user: {
        aiProvider: null,
        aiModel: null,
        aiApiKey: "test-api-key",
        premium: {
          tier: "PRO_MONTHLY",
          lemonSqueezyRenewsAt: new Date(Date.now() + 86_400_000),
          stripeSubscriptionStatus: "active",
        },
      },
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(
      mockEmailAccount as any,
    );
    vi.mocked(isPremium).mockReturnValue(true);
    vi.mocked(hasAiAccess).mockReturnValue(true);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: mockEmailAccount,
        hasAutomationRules: true,
        hasAiAccess: true,
      },
    } as any);

    const mockProvider = {
      getEmailChanges: vi.fn().mockResolvedValue({
        created: [
          {
            id: "email-1",
            threadId: "thread-1",
            subject: "Test Email",
            from: "sender@example.com",
            labelIds: ["INBOX"],
          },
        ],
        updated: [],
        destroyed: [],
        newState: "newState456",
      }),
    };

    vi.mocked(createEmailProvider).mockResolvedValue(mockProvider as any);

    const stateChange = {
      "@type": "StateChange" as const,
      changed: {
        [jmapAccountId]: { Email: "newState456" },
      },
    };

    const logger = createScopedLogger("test-token-auth");
    await processStateChange(stateChange, logger);

    expect(createEmailProvider).toHaveBeenCalledWith({
      emailAccountId: "email-account-token-auth",
      provider: "fastmail",
      logger: expect.any(Object),
    });

    expect(mockProvider.getEmailChanges).toHaveBeenCalledWith(
      "oldState123",
      "newState456",
    );

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "email-account-token-auth" },
      data: { lastSyncedJmapState: "newState456" },
    });
  });
});
