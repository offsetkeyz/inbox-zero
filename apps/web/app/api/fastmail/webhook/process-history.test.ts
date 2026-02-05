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
import { processStateChange } from "./process-history";
import type { StateChange } from "./types";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  with: vi.fn().mockReturnThis(),
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
