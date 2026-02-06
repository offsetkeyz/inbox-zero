import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import prisma from "@/utils/prisma";
import { Prisma } from "@/generated/prisma/client";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/fastmail/client");
vi.mock("@/utils/middleware", async () => {
  const actual = await vi.importActual("@/utils/middleware");
  return {
    ...actual,
    withAuth: (_name: string, handler: any) => handler,
  };
});

import { createFastmailClient } from "@/utils/fastmail/client";
import { POST } from "./route";

function createMockRequest(body: unknown): NextRequest & {
  logger: { info: () => void; warn: () => void; error: () => void };
  auth: { userId: string };
} {
  const req = new NextRequest(
    "https://example.com/api/fastmail/linking/token",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

  return Object.assign(req, {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      with: vi.fn().mockReturnThis(),
    },
    auth: {
      userId: "user-123",
    },
  });
}

describe("POST /api/fastmail/linking/token", () => {
  const mockSession = {
    username: "user@fastmail.com",
    accounts: {
      "account-id-789": {
        name: "Test Account",
        isPersonal: true,
        isReadOnly: false,
      },
    },
    primaryAccounts: {
      "urn:ietf:params:jmap:mail": "account-id-789",
    },
    apiUrl: "https://api.fastmail.com/jmap/",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    const mockClient = {
      getSession: vi.fn().mockResolvedValue(mockSession),
      getAccountId: vi.fn().mockResolvedValue("account-id-789"),
    };

    vi.mocked(createFastmailClient).mockReturnValue(mockClient as any);
  });

  it("creates new account with jmapAccountId set", async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.account.create).mockResolvedValue({
      id: "account-123",
    } as any);

    const req = createMockRequest({ token: "test-token-abc" });
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(prisma.account.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-123",
        provider: "fastmail",
        providerAccountId: "account-id-789",
        access_token: "test-token-abc",
        refresh_token: null,
        emailAccount: {
          create: expect.objectContaining({
            email: "user@fastmail.com",
            userId: "user-123",
            jmapAccountId: "account-id-789",
          }),
        },
      }),
    });
  });

  it("updates existing account with jmapAccountId on duplicate error", async () => {
    const duplicateError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint violation",
      {
        code: "P2002",
        clientVersion: "5.0.0",
      },
    );

    vi.mocked(prisma.account.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "account-123",
        userId: "user-123",
      } as any);

    vi.mocked(prisma.account.create).mockRejectedValueOnce(duplicateError);
    vi.mocked(prisma.account.update).mockResolvedValue({} as any);

    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      id: "email-account-123",
      jmapAccountId: null,
    } as any);
    vi.mocked(prisma.emailAccount.update).mockResolvedValue({} as any);

    const req = createMockRequest({ token: "test-token-abc" });
    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "account-123" },
      data: {
        access_token: "test-token-abc",
      },
    });
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "email-account-123" },
      data: { jmapAccountId: "account-id-789" },
    });
  });
});
