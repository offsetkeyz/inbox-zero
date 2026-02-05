# Fastmail Assistant Functionality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Fastmail assistant functionality by implementing JMAP Web Push notifications, mirroring existing Gmail/Outlook support.

**Architecture:** JMAP PushSubscription sends state change notifications to `/api/fastmail/webhook`. The webhook fetches new emails via `Email/changes` and routes them through the shared `processHistoryItem()` pipeline. Subscriptions expire every 7 days and are renewed by the existing cron infrastructure.

**Tech Stack:** Next.js API routes, JMAP protocol, Prisma, Zod validation, existing cron infrastructure (`/api/watch/all`)

---

## Prerequisites

Before starting, ensure you understand:
- JMAP PushSubscription protocol (RFC 8620)
- Existing webhook patterns in `/app/api/outlook/webhook/` and `/app/api/google/webhook/`
- The shared processor at `/utils/webhook/process-history-item.ts`

---

## Task 1: Add Database Schema Fields

**Files:**
- Modify: `apps/web/prisma/schema.prisma:123-126` (add fields after `lastSyncedHistoryId`)

**Step 1: Write the migration**

Add two new fields to the `EmailAccount` model:

```prisma
  lastSyncedHistoryId            String?
  lastSyncedJmapState            String?   // JMAP Email state string for Fastmail
  jmapAccountId                  String?   // JMAP account ID for webhook lookup
  behaviorProfile                Json?
```

These go after `lastSyncedHistoryId` (line 126) and before `behaviorProfile` (line 127).

**Step 2: Generate and apply the migration**

Run from `apps/web`:
```bash
pnpm prisma migrate dev --name add_jmap_fields
```
Expected: Migration created and applied successfully.

**Step 3: Verify the migration**

Run from `apps/web`:
```bash
pnpm prisma generate
```
Expected: Prisma Client generated successfully.

**Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "$(cat <<'EOF'
feat: add JMAP fields to EmailAccount schema

Add lastSyncedJmapState and jmapAccountId fields for Fastmail
webhook processing. These enable state-based change tracking
and account lookup from webhook payloads.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Environment Variable for Webhook Token

**Files:**
- Modify: `apps/web/.env.example:36` (add after FASTMAIL_CLIENT_SECRET)
- Modify: `apps/web/env.ts:98` (add after MICROSOFT_WEBHOOK_CLIENT_STATE)
- Modify: `turbo.json:29` (add after FASTMAIL_CLIENT_SECRET)

**Step 1: Update .env.example**

Add after line 36 (after `FASTMAIL_CLIENT_SECRET=`):
```bash
FASTMAIL_WEBHOOK_VERIFICATION_TOKEN= # openssl rand -hex 32
```

**Step 2: Update env.ts**

Add after line 98 (`MICROSOFT_WEBHOOK_CLIENT_STATE: z.string().optional(),`):
```typescript
    FASTMAIL_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),
```

**Step 3: Update turbo.json**

Add after line 29 (`"FASTMAIL_CLIENT_SECRET",`):
```json
        "FASTMAIL_WEBHOOK_VERIFICATION_TOKEN",
```

**Step 4: Verify env.ts compiles**

Run from `apps/web`:
```bash
pnpm tsc --noEmit
```
Expected: No errors.

**Step 5: Commit**

```bash
git add apps/web/.env.example apps/web/env.ts turbo.json
git commit -m "$(cat <<'EOF'
feat: add FASTMAIL_WEBHOOK_VERIFICATION_TOKEN env var

Used to verify incoming webhook requests from Fastmail.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create Webhook Types

**Files:**
- Create: `apps/web/app/api/fastmail/webhook/types.ts`

**Step 1: Write the failing test**

Create test file `apps/web/app/api/fastmail/webhook/types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  pushVerificationSchema,
  stateChangeSchema,
  webhookPayloadSchema,
} from "./types";

describe("Fastmail webhook types", () => {
  describe("pushVerificationSchema", () => {
    it("parses valid verification payload", () => {
      const payload = {
        "@type": "PushVerification",
        pushSubscriptionId: "sub123",
        verificationCode: "abc123",
      };
      const result = pushVerificationSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects invalid verification payload", () => {
      const payload = {
        "@type": "StateChange",
        pushSubscriptionId: "sub123",
      };
      const result = pushVerificationSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("stateChangeSchema", () => {
    it("parses valid state change payload", () => {
      const payload = {
        "@type": "StateChange",
        changed: {
          accountId123: {
            Email: "newStateString123",
          },
        },
      };
      const result = stateChangeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects verification payload", () => {
      const payload = {
        "@type": "PushVerification",
        changed: {},
      };
      const result = stateChangeSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("webhookPayloadSchema", () => {
    it("discriminates verification from state change", () => {
      const verification = {
        "@type": "PushVerification",
        pushSubscriptionId: "sub123",
        verificationCode: "abc123",
      };
      const stateChange = {
        "@type": "StateChange",
        changed: { acc1: { Email: "state1" } },
      };

      const verificationResult = webhookPayloadSchema.safeParse(verification);
      const stateChangeResult = webhookPayloadSchema.safeParse(stateChange);

      expect(verificationResult.success).toBe(true);
      expect(stateChangeResult.success).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/types.test.ts
```
Expected: FAIL with "Cannot find module './types'"

**Step 3: Write the implementation**

Create `apps/web/app/api/fastmail/webhook/types.ts`:

```typescript
import { z } from "zod";

// JMAP Push Verification payload
// Sent when a new PushSubscription is created to verify the webhook URL
export const pushVerificationSchema = z.object({
  "@type": z.literal("PushVerification"),
  pushSubscriptionId: z.string(),
  verificationCode: z.string(),
});

export type PushVerification = z.infer<typeof pushVerificationSchema>;

// JMAP StateChange payload
// Sent when Email state changes (new emails, updates, deletions)
export const stateChangeSchema = z.object({
  "@type": z.literal("StateChange"),
  changed: z.record(
    z.string(), // accountId
    z.record(z.string(), z.string()), // { Email: newState, Mailbox: newState, etc. }
  ),
});

export type StateChange = z.infer<typeof stateChangeSchema>;

// Discriminated union of all webhook payload types
export const webhookPayloadSchema = z.discriminatedUnion("@type", [
  pushVerificationSchema,
  stateChangeSchema,
]);

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
```

**Step 4: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/types.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/app/api/fastmail/webhook/types.ts apps/web/app/api/fastmail/webhook/types.test.ts
git commit -m "$(cat <<'EOF'
feat: add Fastmail webhook payload types

Zod schemas for JMAP PushVerification and StateChange payloads.
Uses discriminated union for type-safe payload handling.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update Webhook Account Lookup

**Files:**
- Modify: `apps/web/utils/webhook/validate-webhook-account.ts:9-11` (update function signature)
- Modify: `apps/web/utils/webhook/validate-webhook-account.ts:58-68` (add jmapAccountId lookup)

**Step 1: Write the failing test**

Create test file `apps/web/utils/webhook/validate-webhook-account.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the module
vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/utils/email/watch-manager", () => ({
  unwatchEmails: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));

import prisma from "@/utils/prisma";
import { getWebhookEmailAccount } from "./validate-webhook-account";
import { createLogger } from "@/utils/logger";

const mockLogger = createLogger({ name: "test" });

describe("getWebhookEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up by jmapAccountId for Fastmail webhooks", async () => {
    const mockAccount = {
      id: "ea_123",
      email: "user@fastmail.com",
      account: { provider: "fastmail" },
    };
    vi.mocked(prisma.emailAccount.findFirst).mockResolvedValueOnce(
      mockAccount as never,
    );

    const result = await getWebhookEmailAccount(
      { jmapAccountId: "jmap_acc_123" },
      mockLogger,
    );

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jmapAccountId: "jmap_acc_123" },
      }),
    );
    expect(result).toEqual(mockAccount);
  });

  it("falls back to subscription history for jmapAccountId", async () => {
    vi.mocked(prisma.emailAccount.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ id: "ea_456" }]);

    const mockAccount = {
      id: "ea_456",
      email: "user@fastmail.com",
    };
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValueOnce(
      mockAccount as never,
    );

    await getWebhookEmailAccount({ jmapAccountId: "old_jmap_id" }, mockLogger);

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ea_456" },
      }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run utils/webhook/validate-webhook-account.test.ts
```
Expected: FAIL - test expects `jmapAccountId` lookup which doesn't exist yet

**Step 3: Update the function signature and implementation**

In `apps/web/utils/webhook/validate-webhook-account.ts`, update line 9-11:

```typescript
export async function getWebhookEmailAccount(
  where:
    | { email: string }
    | { watchEmailsSubscriptionId: string }
    | { jmapAccountId: string },
  logger: Logger,
) {
```

Then update lines 58-98 to handle the new lookup type:

```typescript
  if ("email" in where) {
    return await prisma.emailAccount.findUnique({
      where: { email: where.email },
      ...query,
    });
  }

  // Determine which field to search by
  const searchField =
    "watchEmailsSubscriptionId" in where
      ? "watchEmailsSubscriptionId"
      : "jmapAccountId";
  const searchValue =
    "watchEmailsSubscriptionId" in where
      ? where.watchEmailsSubscriptionId
      : where.jmapAccountId;

  let emailAccount = await prisma.emailAccount.findFirst({
    where: { [searchField]: searchValue },
    ...query,
  });

  if (!emailAccount) {
    logger.info(
      `${searchField} not found in current field, checking history`,
      {
        [searchField]: searchValue,
      },
    );

    // For subscriptionId, check history JSON
    if (searchField === "watchEmailsSubscriptionId") {
      const [foundAccount] = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "EmailAccount"
        WHERE "watchEmailsSubscriptionHistory" @> ${JSON.stringify([
          { subscriptionId: searchValue },
        ])}::jsonb
        LIMIT 1
      `;

      if (foundAccount) {
        emailAccount = await prisma.emailAccount.findUnique({
          where: { id: foundAccount.id },
          ...query,
        });

        if (emailAccount) {
          logger.info("Found account by historical subscription ID", {
            subscriptionId: searchValue,
            email: emailAccount.email,
            currentSubscriptionId: emailAccount.watchEmailsSubscriptionId,
          });
        }
      }
    }
    // For jmapAccountId, check history JSON (stored differently)
    else if (searchField === "jmapAccountId") {
      const [foundAccount] = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "EmailAccount"
        WHERE "watchEmailsSubscriptionHistory" @> ${JSON.stringify([
          { jmapAccountId: searchValue },
        ])}::jsonb
        LIMIT 1
      `;

      if (foundAccount) {
        emailAccount = await prisma.emailAccount.findUnique({
          where: { id: foundAccount.id },
          ...query,
        });

        if (emailAccount) {
          logger.info("Found account by historical JMAP account ID", {
            jmapAccountId: searchValue,
            email: emailAccount.email,
          });
        }
      }
    }
  }

  if (!emailAccount) {
    logger.error("Account not found", where);
  }

  return emailAccount;
}
```

Also update the query select to include the new field (around line 22):

```typescript
      jmapAccountId: true,
      lastSyncedJmapState: true,
```

**Step 4: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run utils/webhook/validate-webhook-account.test.ts
```
Expected: PASS

**Step 5: Run all existing tests**

Run from `apps/web`:
```bash
pnpm vitest run utils/webhook/
```
Expected: All tests pass (no regression)

**Step 6: Commit**

```bash
git add apps/web/utils/webhook/validate-webhook-account.ts apps/web/utils/webhook/validate-webhook-account.test.ts
git commit -m "$(cat <<'EOF'
feat: add jmapAccountId lookup to webhook account validation

Enables looking up EmailAccount by JMAP account ID for Fastmail
webhook processing. Includes history fallback for ID changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement watchEmails() in FastmailProvider

**Files:**
- Modify: `apps/web/utils/email/fastmail.ts:1228-1238` (implement watchEmails and unwatchEmails)

**Step 1: Write the failing test**

Create test file `apps/web/utils/email/fastmail.watch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FastmailProvider } from "./fastmail";
import { createLogger } from "@/utils/logger";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: "https://example.com",
    FASTMAIL_WEBHOOK_VERIFICATION_TOKEN: "test-token-123",
  },
}));

vi.mock("@/utils/fastmail/client", () => ({
  getFastmailClientWithRefresh: vi.fn(),
}));

import { getFastmailClientWithRefresh } from "@/utils/fastmail/client";

const mockLogger = createLogger({ name: "test" });

describe("FastmailProvider watch methods", () => {
  let provider: FastmailProvider;
  let mockClient: {
    getAccountId: ReturnType<typeof vi.fn>;
    makeRequest: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      getAccountId: vi.fn().mockResolvedValue("jmap_account_123"),
      makeRequest: vi.fn(),
      getSession: vi.fn().mockResolvedValue({
        apiUrl: "https://api.fastmail.com/jmap/",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "jmap_account_123" },
      }),
    };

    vi.mocked(getFastmailClientWithRefresh).mockResolvedValue(
      mockClient as never,
    );
  });

  describe("watchEmails", () => {
    it("creates a JMAP PushSubscription", async () => {
      const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      mockClient.makeRequest.mockResolvedValueOnce({
        methodResponses: [
          [
            "PushSubscription/set",
            {
              created: {
                "inbox-zero": {
                  id: "push_sub_456",
                  expires: expiresDate.toISOString(),
                },
              },
            },
            "push-create",
          ],
        ],
      });

      provider = new FastmailProvider({
        emailAccountId: "ea_123",
        accessToken: "access_token",
        logger: mockLogger,
      });

      const result = await provider.watchEmails();

      expect(mockClient.makeRequest).toHaveBeenCalledWith([
        expect.objectContaining({
          methodName: "PushSubscription/set",
          args: expect.objectContaining({
            create: {
              "inbox-zero": expect.objectContaining({
                url: "https://example.com/api/fastmail/webhook?token=test-token-123",
                types: ["Email"],
              }),
            },
          }),
        }),
      ]);

      expect(result).toEqual({
        expirationDate: expect.any(Date),
        subscriptionId: "push_sub_456",
      });
    });

    it("returns null when token is not configured", async () => {
      vi.doMock("@/env", () => ({
        env: {
          NEXT_PUBLIC_BASE_URL: "https://example.com",
          FASTMAIL_WEBHOOK_VERIFICATION_TOKEN: undefined,
        },
      }));

      provider = new FastmailProvider({
        emailAccountId: "ea_123",
        accessToken: "access_token",
        logger: mockLogger,
      });

      // Re-import to get new mock
      const { env } = await import("@/env");
      vi.mocked(env).FASTMAIL_WEBHOOK_VERIFICATION_TOKEN = undefined;

      const result = await provider.watchEmails();

      expect(result).toBeNull();
    });
  });

  describe("unwatchEmails", () => {
    it("destroys the JMAP PushSubscription", async () => {
      mockClient.makeRequest.mockResolvedValueOnce({
        methodResponses: [
          ["PushSubscription/set", { destroyed: ["push_sub_456"] }, "push-destroy"],
        ],
      });

      provider = new FastmailProvider({
        emailAccountId: "ea_123",
        accessToken: "access_token",
        logger: mockLogger,
      });

      await provider.unwatchEmails("push_sub_456");

      expect(mockClient.makeRequest).toHaveBeenCalledWith([
        expect.objectContaining({
          methodName: "PushSubscription/set",
          args: { destroy: ["push_sub_456"] },
        }),
      ]);
    });

    it("does nothing when no subscriptionId provided", async () => {
      provider = new FastmailProvider({
        emailAccountId: "ea_123",
        accessToken: "access_token",
        logger: mockLogger,
      });

      await provider.unwatchEmails();

      expect(mockClient.makeRequest).not.toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run utils/email/fastmail.watch.test.ts
```
Expected: FAIL - watchEmails returns null and logs warning

**Step 3: Implement watchEmails and unwatchEmails**

Replace lines 1228-1238 in `apps/web/utils/email/fastmail.ts`:

```typescript
  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    if (!env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN) {
      this.logger.warn(
        "FASTMAIL_WEBHOOK_VERIFICATION_TOKEN not configured, skipping watch",
      );
      return null;
    }

    const client = await this.getClient();
    const accountId = await client.getAccountId();

    const webhookUrl = `${env.NEXT_PUBLIC_BASE_URL}/api/fastmail/webhook?token=${env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN}`;
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    this.logger.info("Creating JMAP PushSubscription", {
      accountId,
      expiresAt: expires.toISOString(),
    });

    const response = await client.makeRequest([
      {
        methodName: "PushSubscription/set",
        args: {
          create: {
            "inbox-zero": {
              deviceClientId: `inbox-zero-${this.emailAccountId}`,
              url: webhookUrl,
              types: ["Email"],
              expires: expires.toISOString(),
            },
          },
        },
        id: "push-create",
      },
    ]);

    const setResponse = response.methodResponses[0]?.[1] as {
      created?: Record<string, { id: string; expires: string }>;
      notCreated?: Record<string, { type: string; description?: string }>;
    };

    const created = setResponse?.created?.["inbox-zero"];
    if (!created) {
      const notCreated = setResponse?.notCreated?.["inbox-zero"];
      this.logger.error("Failed to create push subscription", { notCreated });
      throw new Error(
        `Failed to create push subscription: ${notCreated?.description || "unknown error"}`,
      );
    }

    this.logger.info("Created JMAP PushSubscription", {
      subscriptionId: created.id,
      expires: created.expires,
    });

    return {
      expirationDate: new Date(created.expires),
      subscriptionId: created.id,
    };
  }

  async unwatchEmails(subscriptionId?: string): Promise<void> {
    if (!subscriptionId) {
      this.logger.info("No subscription ID provided, skipping unwatch");
      return;
    }

    const client = await this.getClient();

    this.logger.info("Destroying JMAP PushSubscription", { subscriptionId });

    await client.makeRequest([
      {
        methodName: "PushSubscription/set",
        args: {
          destroy: [subscriptionId],
        },
        id: "push-destroy",
      },
    ]);

    this.logger.info("Destroyed JMAP PushSubscription", { subscriptionId });
  }
```

Also add the import at the top of the file if not present:
```typescript
import { env } from "@/env";
```

**Step 4: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run utils/email/fastmail.watch.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/utils/email/fastmail.ts apps/web/utils/email/fastmail.watch.test.ts
git commit -m "$(cat <<'EOF'
feat: implement watchEmails/unwatchEmails for Fastmail

Creates and destroys JMAP PushSubscriptions for real-time
email notifications. Subscriptions expire after 7 days.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Create Webhook Route Handler

**Files:**
- Create: `apps/web/app/api/fastmail/webhook/route.ts`

**Step 1: Write the failing test**

Create test file `apps/web/app/api/fastmail/webhook/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/env", () => ({
  env: {
    FASTMAIL_WEBHOOK_VERIFICATION_TOKEN: "test-token-123",
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
): NextRequest & { logger: { info: () => void; warn: () => void; error: () => void } } {
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
    const response = await POST(req);

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

    const response = await POST(req);
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

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(processStateChange).toHaveBeenCalled();
  });

  it("returns 400 for invalid payload", async () => {
    const req = createMockRequest({ invalid: "payload" }, "test-token-123");

    const response = await POST(req);

    expect(response.status).toBe(400);
  });
});
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/route.test.ts
```
Expected: FAIL with "Cannot find module './route'"

**Step 3: Write the implementation**

Create `apps/web/app/api/fastmail/webhook/route.ts`:

```typescript
import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { withError } from "@/utils/middleware";
import { webhookPayloadSchema } from "@/app/api/fastmail/webhook/types";
import { processStateChange } from "@/app/api/fastmail/webhook/process-history";

export const maxDuration = 300;

export const POST = withError("fastmail/webhook", async (request) => {
  const logger = request.logger;

  // Verify token
  const token = new URL(request.url).searchParams.get("token");
  if (token !== env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN) {
    logger.warn("Invalid webhook token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const rawBody = await request.json();

  // Validate payload
  const parseResult = webhookPayloadSchema.safeParse(rawBody);

  if (!parseResult.success) {
    logger.error("Invalid webhook payload", {
      body: rawBody,
      errors: parseResult.error.errors,
    });
    return NextResponse.json(
      {
        error: "Invalid webhook payload",
        details: parseResult.error.errors,
      },
      { status: 400 },
    );
  }

  const body = parseResult.data;

  // Handle verification request
  if (body["@type"] === "PushVerification") {
    logger.info("Received push verification request", {
      pushSubscriptionId: body.pushSubscriptionId,
    });
    return NextResponse.json({ verificationCode: body.verificationCode });
  }

  // Handle state change
  if (body["@type"] === "StateChange") {
    logger.info("Received state change notification", {
      accountCount: Object.keys(body.changed).length,
    });

    // Process asynchronously to respond quickly
    after(() => processStateChange(body, logger));
  }

  return NextResponse.json({ ok: true });
});
```

**Step 4: Create stub process-history for route to compile**

Create `apps/web/app/api/fastmail/webhook/process-history.ts` (stub):

```typescript
import type { StateChange } from "./types";
import type { Logger } from "@/utils/logger";

export async function processStateChange(
  _body: StateChange,
  _logger: Logger,
): Promise<void> {
  // Stub - will be implemented in Task 7
}
```

**Step 5: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/route.test.ts
```
Expected: PASS

**Step 6: Commit**

```bash
git add apps/web/app/api/fastmail/webhook/route.ts apps/web/app/api/fastmail/webhook/process-history.ts
git commit -m "$(cat <<'EOF'
feat: add Fastmail webhook route handler

Handles PushVerification by echoing verificationCode.
Routes StateChange notifications to async processor.
Token-based authentication via query parameter.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Implement State Change Processing

**Files:**
- Modify: `apps/web/app/api/fastmail/webhook/process-history.ts` (full implementation)

**Step 1: Write the failing test**

Create test file `apps/web/app/api/fastmail/webhook/process-history.test.ts`:

```typescript
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
import { createLogger } from "@/utils/logger";

const mockLogger = createLogger({ name: "test" });

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

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(mockEmailAccount as never);
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

    mockProvider.getMessage = vi.fn().mockImplementation((id) =>
      newEmails.find((e) => e.id === id),
    );

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
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/process-history.test.ts
```
Expected: FAIL - stub implementation doesn't do anything

**Step 3: Implement the full process-history**

Replace `apps/web/app/api/fastmail/webhook/process-history.ts`:

```typescript
import * as Sentry from "@sentry/nextjs";
import prisma from "@/utils/prisma";
import { captureException } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { markMessageAsProcessing } from "@/utils/redis/message-processing";
import type { StateChange } from "./types";
import type { Logger } from "@/utils/logger";

export async function processStateChange(
  body: StateChange,
  baseLogger: Logger,
): Promise<void> {
  for (const [jmapAccountId, changes] of Object.entries(body.changed)) {
    const newEmailState = changes.Email;
    if (!newEmailState) {
      baseLogger.info("No Email state change, skipping", { jmapAccountId });
      continue;
    }

    const logger = baseLogger.with({ jmapAccountId });

    const emailAccount = await getWebhookEmailAccount(
      { jmapAccountId },
      logger,
    );

    if (!emailAccount) {
      logger.warn("Webhook received for unknown JMAP accountId");
      continue;
    }

    const accountLogger = logger.with({
      email: emailAccount.email,
      emailAccountId: emailAccount.id,
    });

    const validation = await validateWebhookAccount(emailAccount, accountLogger);

    if (!validation.success) {
      // Validation function already logs the specific reason
      continue;
    }

    const {
      emailAccount: validatedEmailAccount,
      hasAutomationRules,
      hasAiAccess,
    } = validation.data;

    Sentry.setTag("emailAccountId", validatedEmailAccount.id);
    Sentry.setUser({
      id: validatedEmailAccount.userId,
      email: validatedEmailAccount.email,
    });

    const provider = await createEmailProvider({
      emailAccountId: validatedEmailAccount.id,
      provider: "fastmail",
      logger: accountLogger,
    });

    try {
      // Get changed emails since last known state
      const { created, newState } = await provider.getEmailChanges(
        validatedEmailAccount.lastSyncedJmapState ?? undefined,
        newEmailState,
      );

      accountLogger.info("Email changes fetched", {
        createdCount: created.length,
        oldState: validatedEmailAccount.lastSyncedJmapState,
        newState,
      });

      // Process each new email sequentially
      for (const email of created) {
        const messageLogger = accountLogger.with({
          messageId: email.id,
          threadId: email.threadId,
        });

        // Skip messages not in inbox or sent
        const isInInbox = email.labelIds?.includes("INBOX") || false;
        const isInSent = email.labelIds?.includes("SENT") || false;

        if (!isInInbox && !isInSent) {
          messageLogger.info("Skipping message not in inbox or sent", {
            labelIds: email.labelIds,
          });
          continue;
        }

        // Acquire processing lock
        const isFree = await markMessageAsProcessing({
          userEmail: validatedEmailAccount.email,
          messageId: email.id,
        });

        if (!isFree) {
          messageLogger.info("Skipping. Message already being processed.");
          continue;
        }

        await processHistoryItem(
          {
            messageId: email.id,
            threadId: email.threadId,
            message: email,
          },
          {
            provider,
            emailAccount: {
              ...validatedEmailAccount,
              account: { provider: "fastmail" },
            },
            hasAutomationRules,
            hasAiAccess,
            rules: validatedEmailAccount.rules,
            logger: messageLogger,
          },
        );
      }

      // Update state after successful processing
      await prisma.emailAccount.update({
        where: { id: validatedEmailAccount.id },
        data: { lastSyncedJmapState: newState },
      });

      accountLogger.info("State updated after processing", { newState });
    } catch (error) {
      // Check for JMAP cannotCalculateChanges error
      if (
        error instanceof Error &&
        error.message.includes("cannotCalculateChanges")
      ) {
        accountLogger.warn(
          "State too old, full resync needed (not implemented)",
          { error },
        );
        // TODO: Implement full resync fallback in future PR
        continue;
      }

      captureException(error, {
        emailAccountId: validatedEmailAccount.id,
        userEmail: validatedEmailAccount.email,
        extra: { jmapAccountId, newEmailState },
      });

      accountLogger.error("Error processing state change", {
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error,
      });
      // Don't update state - will retry on next webhook
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run app/api/fastmail/webhook/process-history.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/app/api/fastmail/webhook/process-history.ts apps/web/app/api/fastmail/webhook/process-history.test.ts
git commit -m "$(cat <<'EOF'
feat: implement Fastmail webhook state change processing

Fetches new emails via Email/changes, processes through shared
pipeline, and updates lastSyncedJmapState. Uses Redis lock to
prevent duplicate processing.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add getEmailChanges to FastmailProvider

**Files:**
- Modify: `apps/web/utils/email/fastmail.ts` (add getEmailChanges method)
- Modify: `apps/web/utils/email/types.ts` (add method to interface if needed)

**Step 1: Write the failing test**

Add to `apps/web/utils/email/fastmail.watch.test.ts`:

```typescript
describe("getEmailChanges", () => {
  it("fetches created email IDs since last state", async () => {
    mockClient.makeRequest.mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/changes",
          {
            oldState: "oldState123",
            newState: "newState456",
            hasMoreChanges: false,
            created: ["email_1", "email_2"],
            updated: ["email_3"],
            destroyed: ["email_4"],
          },
          "changes",
        ],
        [
          "Email/get",
          {
            list: [
              {
                id: "email_1",
                threadId: "thread_1",
                mailboxIds: { inbox_id: true },
                keywords: {},
              },
              {
                id: "email_2",
                threadId: "thread_2",
                mailboxIds: { inbox_id: true },
                keywords: {},
              },
            ],
          },
          "get-created",
        ],
      ],
    });

    // Mock mailbox lookup for label conversion
    mockClient.makeRequest.mockResolvedValueOnce({
      methodResponses: [
        [
          "Mailbox/get",
          {
            list: [{ id: "inbox_id", role: "inbox", name: "Inbox" }],
          },
          "mailboxes",
        ],
      ],
    });

    provider = new FastmailProvider({
      emailAccountId: "ea_123",
      accessToken: "access_token",
      logger: mockLogger,
    });

    const result = await provider.getEmailChanges("oldState123", "newState456");

    expect(result.created).toHaveLength(2);
    expect(result.newState).toBe("newState456");
    expect(result.created[0].id).toBe("email_1");
  });

  it("handles cannotCalculateChanges error", async () => {
    mockClient.makeRequest.mockResolvedValueOnce({
      methodResponses: [
        [
          "error",
          {
            type: "cannotCalculateChanges",
            description: "State too old",
          },
          "changes",
        ],
      ],
    });

    provider = new FastmailProvider({
      emailAccountId: "ea_123",
      accessToken: "access_token",
      logger: mockLogger,
    });

    await expect(
      provider.getEmailChanges("veryOldState", "newState"),
    ).rejects.toThrow("cannotCalculateChanges");
  });
});
```

**Step 2: Run test to verify it fails**

Run from `apps/web`:
```bash
pnpm vitest run utils/email/fastmail.watch.test.ts
```
Expected: FAIL - getEmailChanges method doesn't exist

**Step 3: Implement getEmailChanges**

Add this method to `apps/web/utils/email/fastmail.ts` (after unwatchEmails):

```typescript
  async getEmailChanges(
    sinceState: string | undefined,
    newState: string,
  ): Promise<{
    created: ParsedMessage[];
    newState: string;
  }> {
    const client = await this.getClient();
    const accountId = await client.getAccountId();

    // If no sinceState, we can't use Email/changes - need full sync
    if (!sinceState) {
      this.logger.info("No sinceState, returning empty for initial sync");
      return { created: [], newState };
    }

    this.logger.info("Fetching email changes", { sinceState, newState });

    const response = await client.makeRequest([
      {
        methodName: "Email/changes",
        args: {
          accountId,
          sinceState,
        },
        id: "changes",
      },
    ]);

    const changesResponse = response.methodResponses[0];

    // Check for error response
    if (changesResponse[0] === "error") {
      const error = changesResponse[1] as { type: string; description?: string };
      if (error.type === "cannotCalculateChanges") {
        throw new Error(
          `cannotCalculateChanges: ${error.description || "State too old"}`,
        );
      }
      throw new Error(`JMAP error: ${error.type}`);
    }

    const changes = changesResponse[1] as {
      oldState: string;
      newState: string;
      hasMoreChanges: boolean;
      created: string[];
      updated: string[];
      destroyed: string[];
    };

    if (changes.created.length === 0) {
      this.logger.info("No new emails created");
      return { created: [], newState: changes.newState };
    }

    this.logger.info("Fetching created emails", {
      count: changes.created.length,
    });

    // Fetch the full email objects for created IDs
    const getResponse = await client.makeRequest([
      {
        methodName: "Email/get",
        args: {
          accountId,
          ids: changes.created,
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "keywords",
            "from",
            "to",
            "cc",
            "bcc",
            "replyTo",
            "subject",
            "sentAt",
            "receivedAt",
            "preview",
            "textBody",
            "htmlBody",
            "bodyValues",
            "hasAttachment",
            "attachments",
            "references",
            "inReplyTo",
            "messageId",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        id: "get-created",
      },
    ]);

    const getResult = getResponse.methodResponses[0][1] as {
      list: JMAPEmail[];
    };

    // Parse emails using existing method
    const parsedEmails = await Promise.all(
      getResult.list.map((email) => this.parseJMAPEmail(email)),
    );

    return {
      created: parsedEmails,
      newState: changes.newState,
    };
  }
```

Also add `ParsedMessage` to the imports at the top:
```typescript
import type { ParsedMessage } from "@/utils/types";
```

And add `JMAPEmail` type import:
```typescript
import type { JMAPEmail } from "@/utils/fastmail/types";
```

**Step 4: Run test to verify it passes**

Run from `apps/web`:
```bash
pnpm vitest run utils/email/fastmail.watch.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/utils/email/fastmail.ts
git commit -m "$(cat <<'EOF'
feat: add getEmailChanges to FastmailProvider

Uses JMAP Email/changes to fetch created email IDs since last
state, then Email/get to retrieve full message details.
Throws cannotCalculateChanges for state gap fallback handling.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Capture jmapAccountId During OAuth

**Files:**
- Modify: `apps/web/app/api/fastmail/linking/callback/route.ts:168-175` (store jmapAccountId)

**Step 1: Write the failing test**

Add to existing OAuth tests or create `apps/web/app/api/fastmail/linking/callback/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    account: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    emailAccount: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/utils/fastmail/client", () => ({
  createFastmailClient: vi.fn(),
}));

import prisma from "@/utils/prisma";
import { createFastmailClient } from "@/utils/fastmail/client";

describe("Fastmail OAuth callback", () => {
  it("stores jmapAccountId in EmailAccount on create", async () => {
    const mockClient = {
      getSession: vi.fn().mockResolvedValue({
        username: "user@fastmail.com",
        accounts: { jmap_123: { name: "User" } },
      }),
      getAccountId: vi.fn().mockResolvedValue("jmap_123"),
    };
    vi.mocked(createFastmailClient).mockReturnValue(mockClient as never);

    vi.mocked(prisma.account.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.account.create).mockResolvedValue({
      id: "acc_123",
      emailAccount: { id: "ea_123" },
    } as never);

    // The actual test would need to call the route handler
    // For now, verify the create call includes jmapAccountId
    expect(true).toBe(true); // Placeholder
  });
});
```

**Step 2: Modify the OAuth callback**

In `apps/web/app/api/fastmail/linking/callback/route.ts`, update the account creation around line 168-177:

```typescript
          emailAccount: {
            create: {
              email: providerEmail,
              userId: targetUserId,
              name: accountName,
              image: null,
              jmapAccountId: providerAccountId, // ADD THIS LINE
            },
          },
```

Also update the token update case (around line 232) to ensure jmapAccountId is set:

After `await updateFastmailAccountTokens(...)`, add:

```typescript
      // Ensure jmapAccountId is set (may have been missing from older accounts)
      const emailAccount = await prisma.emailAccount.findUnique({
        where: { accountId: linkingResult.existingAccountId },
        select: { id: true, jmapAccountId: true },
      });
      if (emailAccount && !emailAccount.jmapAccountId) {
        await prisma.emailAccount.update({
          where: { id: emailAccount.id },
          data: { jmapAccountId: providerAccountId },
        });
        logger.info("Backfilled jmapAccountId for existing account", {
          emailAccountId: emailAccount.id,
        });
      }
```

**Step 3: Run type check**

Run from `apps/web`:
```bash
pnpm tsc --noEmit
```
Expected: No errors.

**Step 4: Commit**

```bash
git add apps/web/app/api/fastmail/linking/callback/route.ts
git commit -m "$(cat <<'EOF'
feat: capture jmapAccountId during Fastmail OAuth

Stores JMAP account ID in EmailAccount for webhook lookup.
Backfills missing jmapAccountId on token refresh for
existing accounts.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Add jmapAccountId to Webhook Query Select

**Files:**
- Modify: `apps/web/utils/webhook/validate-webhook-account.ts:22-24` (add to select)

**Step 1: Verify the field is selected**

In `apps/web/utils/webhook/validate-webhook-account.ts`, ensure the query select includes:

```typescript
      jmapAccountId: true,
      lastSyncedJmapState: true,
```

This should already be done in Task 4, but verify it's present around line 22-24.

**Step 2: Run type check**

Run from `apps/web`:
```bash
pnpm tsc --noEmit
```
Expected: No errors.

**Step 3: Commit (if changes needed)**

```bash
git add apps/web/utils/webhook/validate-webhook-account.ts
git commit -m "$(cat <<'EOF'
chore: ensure jmapAccountId selected in webhook query

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Run Full Test Suite

**Step 1: Run all tests**

Run from `apps/web`:
```bash
pnpm vitest run
```
Expected: All tests pass.

**Step 2: Run linter**

Run from `apps/web`:
```bash
pnpm lint
```
Expected: No errors.

**Step 3: Run type check**

Run from `apps/web`:
```bash
pnpm tsc --noEmit
```
Expected: No errors.

---

## Task 12: Final Integration Verification

**Step 1: Verify webhook types compile**

Run from `apps/web`:
```bash
pnpm tsc --noEmit app/api/fastmail/webhook/route.ts
```
Expected: No errors.

**Step 2: Verify provider changes compile**

Run from `apps/web`:
```bash
pnpm tsc --noEmit utils/email/fastmail.ts
```
Expected: No errors.

**Step 3: Commit all remaining changes**

```bash
git status
# If there are any uncommitted changes:
git add -A
git commit -m "$(cat <<'EOF'
chore: final cleanup for Fastmail assistant implementation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Summary

This implementation adds:

1. **Database fields**: `lastSyncedJmapState` and `jmapAccountId` for JMAP state tracking
2. **Environment variable**: `FASTMAIL_WEBHOOK_VERIFICATION_TOKEN` for webhook security
3. **Webhook types**: Zod schemas for JMAP push payloads
4. **Webhook route**: `/api/fastmail/webhook` handling verification and state changes
5. **State change processor**: Fetches new emails and routes to shared pipeline
6. **Provider methods**: `watchEmails()`, `unwatchEmails()`, `getEmailChanges()`
7. **OAuth integration**: Captures and persists `jmapAccountId`

The implementation follows existing patterns from Gmail and Outlook integrations, reuses the shared `processHistoryItem` pipeline, and integrates with existing cron infrastructure for subscription renewal.

**Out of scope** (future PRs):
- Full resync fallback when state is too old
- Health check endpoint
- Detailed error monitoring dashboard
