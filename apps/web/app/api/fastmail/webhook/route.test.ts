import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/env", () => ({
  env: {
    FASTMAIL_WEBHOOK_VERIFICATION_TOKEN: "test-token-123",
    EMAIL_ENCRYPT_SECRET: "test-secret",
    EMAIL_ENCRYPT_SALT: "test-salt",
  },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn) => fn()), // Execute immediately for testing
  };
});

vi.mock("./process-history", () => ({
  processStateChange: vi.fn(),
}));

import { POST } from "./route";
import { processStateChange } from "./process-history";

function createMockRequest(
  body: unknown,
  token?: string,
): NextRequest & {
  logger: { info: () => void; warn: () => void; error: () => void };
} {
  const url = token
    ? `https://example.com/api/fastmail/webhook?token=${token}`
    : "https://example.com/api/fastmail/webhook";

  const req = new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return Object.assign(req, {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      with: vi.fn().mockReturnThis(),
    },
  });
}

describe("POST /api/fastmail/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests with invalid token", async () => {
    const req = createMockRequest({ "@type": "StateChange" }, "wrong-token");
    const response = await POST(req, { params: Promise.resolve({}) });

    expect(response.status).toBe(403);
  });

  it("handles PushVerification by echoing verificationCode", async () => {
    const req = createMockRequest(
      {
        "@type": "PushVerification",
        pushSubscriptionId: "sub123",
        verificationCode: "verify-me-123",
      },
      "test-token-123",
    );

    const response = await POST(req, { params: Promise.resolve({}) });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.verificationCode).toBe("verify-me-123");
  });

  it("handles StateChange by calling processStateChange", async () => {
    const stateChange = {
      "@type": "StateChange",
      changed: {
        accountId123: { Email: "newState456" },
      },
    };
    const req = createMockRequest(stateChange, "test-token-123");

    const response = await POST(req, { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    expect(processStateChange).toHaveBeenCalled();
  });

  it("returns 400 for invalid payload", async () => {
    const req = createMockRequest({ invalid: "payload" }, "test-token-123");

    const response = await POST(req, { params: Promise.resolve({}) });

    expect(response.status).toBe(400);
  });
});
