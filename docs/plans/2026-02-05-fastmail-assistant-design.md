# Fastmail Assistant Functionality Design

## Overview

Enable Fastmail assistant functionality by implementing JMAP Web Push notifications, mirroring the existing Gmail/Outlook assistant support.

## Architecture

```
┌─────────────────┐     POST      ┌─────────────────────────┐
│   Fastmail      │ ───────────> │ /api/fastmail/webhook   │
│   JMAP Server   │              │     route.ts            │
└─────────────────┘              └───────────┬─────────────┘
                                             │
                                             ▼
                                 ┌─────────────────────────┐
                                 │   process-history.ts    │
                                 │   (Fastmail-specific)   │
                                 └───────────┬─────────────┘
                                             │
                                             ▼
                                 ┌─────────────────────────┐
                                 │ processHistoryItem()    │
                                 │ (Shared processor)      │
                                 └─────────────────────────┘
```

**Key components:**
1. `FastmailProvider.watchEmails()` - Register JMAP PushSubscription
2. `FastmailProvider.unwatchEmails()` - Remove subscription
3. `/api/fastmail/webhook/route.ts` - Receive push notifications
4. `process-history.ts` - Fastmail-specific processing that routes to shared processor

## JMAP PushSubscription

### Registration (watchEmails)

```typescript
// JMAP PushSubscription/set request
{
  "methodName": "PushSubscription/set",
  "args": {
    "create": {
      "sub1": {
        "deviceClientId": "inbox-zero-{emailAccountId}",
        "url": "https://yourdomain.com/api/fastmail/webhook?token={secret}",
        "types": ["Email"],
        "expires": "2024-01-15T00:00:00Z"  // ~7 days from now
      }
    }
  }
}
```

**Key details:**
- `deviceClientId`: Unique per email account, allows updating existing subscription
- `url`: Webhook endpoint with verification token in query string
- `types`: Only subscribe to `Email` changes
- `expires`: JMAP subscriptions expire, renewed by cron every 6 hours

### Webhook Payloads

**Verification request:**
```json
{
  "@type": "PushVerification",
  "pushSubscriptionId": "sub123",
  "verificationCode": "abc123"
}
```

**State change notification:**
```json
{
  "@type": "StateChange",
  "changed": {
    "accountId123": {
      "Email": "newStateString123"
    }
  }
}
```

## Database Schema Changes

Add to `EmailAccount` model:

```prisma
model EmailAccount {
  // ... existing fields ...

  // NEW: JMAP-specific fields for Fastmail
  lastSyncedJmapState  String?  // JMAP Email state string
  jmapAccountId        String?  // JMAP account ID for webhook lookup
}
```

**Rationale for separate fields:**
- Gmail uses numeric history IDs with ordering semantics (`>` comparison)
- JMAP uses opaque state strings (equality checks only)
- Need JMAP accountId to look up email account from webhook payload

## Webhook Implementation

### Route Handler

```typescript
// /api/fastmail/webhook/route.ts
export const POST = withError("fastmail/webhook", async (request) => {
  // 1. Verify token
  const token = new URL(request.url).searchParams.get("token");
  if (token !== env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const body = await request.json();

  // 2. Handle verification request
  if (body["@type"] === "PushVerification") {
    return NextResponse.json({ verificationCode: body.verificationCode });
  }

  // 3. Handle state change
  if (body["@type"] === "StateChange") {
    after(() => processStateChange(body, logger));
  }

  return NextResponse.json({ ok: true });
});
```

### State Change Processing

```typescript
async function processStateChange(body: StateChangePayload, logger: Logger) {
  for (const [accountId, changes] of Object.entries(body.changed)) {
    const newEmailState = changes.Email;
    if (!newEmailState) continue;

    // Look up email account by JMAP accountId
    const emailAccount = await getWebhookEmailAccount({ jmapAccountId: accountId });

    // Get emails since last state
    const newEmails = await queryEmailsSinceState(emailAccount, newEmailState);

    // Process each through shared processor
    for (const email of newEmails) {
      await processHistoryItem(
        { messageId: email.id, threadId: email.threadId, message: email },
        { provider, emailAccount, ... }
      );
    }

    // Update state
    await updateLastSyncedJmapState(emailAccount.id, newEmailState);
  }
}
```

## FastmailProvider Changes

### watchEmails()

```typescript
async watchEmails(): Promise<{ expirationDate: Date; subscriptionId?: string } | null> {
  const accountId = await this.getAccountId();
  const webhookUrl = `${env.NEXT_PUBLIC_BASE_URL}/api/fastmail/webhook?token=${env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN}`;

  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const response = await this.client.makeRequest([{
    methodName: "PushSubscription/set",
    args: {
      create: {
        "inbox-zero": {
          deviceClientId: `inbox-zero-${this.emailAccountId}`,
          url: webhookUrl,
          types: ["Email"],
          expires: expires.toISOString(),
        }
      }
    },
    id: "push-create"
  }]);

  const created = response.methodResponses[0][1].created?.["inbox-zero"];
  if (!created) {
    throw new Error("Failed to create push subscription");
  }

  return {
    expirationDate: new Date(created.expires),
    subscriptionId: created.id,
  };
}
```

### unwatchEmails()

```typescript
async unwatchEmails(subscriptionId?: string): Promise<void> {
  if (!subscriptionId) return;

  await this.client.makeRequest([{
    methodName: "PushSubscription/set",
    args: {
      destroy: [subscriptionId]
    },
    id: "push-destroy"
  }]);
}
```

## Environment Variables

Add to configuration:

```bash
FASTMAIL_WEBHOOK_VERIFICATION_TOKEN=your-secret-token
```

Files to update:
- `.env.example`
- `env.ts`
- `turbo.json`

## Implementation Plan

### New Files

| File | Purpose |
|------|---------|
| `apps/web/app/api/fastmail/webhook/route.ts` | Webhook endpoint |
| `apps/web/app/api/fastmail/webhook/process-history.ts` | Fastmail-specific processing |
| `apps/web/app/api/fastmail/webhook/types.ts` | JMAP push payload types |
| `prisma/migrations/xxx_add_jmap_state.sql` | Schema migration |

### Files to Modify

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `lastSyncedJmapState`, `jmapAccountId` fields |
| `apps/web/utils/email/fastmail.ts` | Implement `watchEmails()`, `unwatchEmails()` |
| `apps/web/utils/webhook/validate-webhook-account.ts` | Add lookup by `jmapAccountId` |
| `apps/web/.env.example` | Add `FASTMAIL_WEBHOOK_VERIFICATION_TOKEN` |
| `apps/web/env.ts` | Add env var to schema |
| `turbo.json` | Add env var passthrough |

### Implementation Order

1. Schema migration (add fields)
2. Environment variables
3. `watchEmails()` / `unwatchEmails()` in FastmailProvider
4. Webhook route and processing
5. Account lookup by JMAP accountId
6. Testing

## Out of Scope

These features are not needed for assistant functionality:
- Filters/rules (`createFilter`, etc.)
- Attachments (`getAttachment`)
- Signatures (`getSignatures`)

## Infrastructure Notes

- Uses existing cron infrastructure (`/api/watch/all` every 6 hours)
- Supports QStash, Docker cron container, or manual cron
- No additional infrastructure required beyond webhook endpoint
