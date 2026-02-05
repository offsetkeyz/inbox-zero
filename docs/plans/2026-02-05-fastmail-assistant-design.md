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
        "deviceClientId": "inbox-zero-{userEmail}",  // Use email for stability
        "url": "https://yourdomain.com/api/fastmail/webhook?token={secret}",
        "types": ["Email"],
        "expires": "2024-01-15T00:00:00Z"  // ~7 days from now
      }
    }
  }
}
```

**Key details:**
- `deviceClientId`: Use `inbox-zero-{userEmail}` for stability across database migrations
- `url`: Webhook endpoint with verification token in query string (security approach TBD - see Security section)
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
  jmapAccountId        String?  // JMAP account ID for webhook lookup (captured during OAuth)
}
```

**Rationale for separate fields:**
- Gmail uses numeric history IDs with ordering semantics (`>` comparison)
- JMAP uses opaque state strings (equality checks only)
- Need JMAP accountId to look up email account from webhook payload
- `jmapAccountId` is captured during OAuth callback via JMAP session discovery

## State Change Handling

### Fetching New Emails

JMAP doesn't have a "since state" query. Use `Email/changes` with the old state to get created/updated/destroyed IDs.

**Hybrid approach for state gaps:**
1. First, try `Email/changes` with `lastSyncedJmapState`
2. If Fastmail returns `cannotCalculateChanges` (state too old), fall back to full resync
3. Full resync queries emails from the **last 7 days** (matches subscription expiry window)

### What to Process

- **Created emails**: Process through assistant/rules pipeline
- **Updated emails**: Ignore (read status, flag changes don't trigger processing)
- **Destroyed emails**: Ignore

### Shared Mailboxes

Only process emails from the user's **primary account**. Shared mailboxes are ignored to avoid permission complexities.

## Webhook Implementation

### Route Handler

```typescript
// /api/fastmail/webhook/route.ts
export const POST = withError("fastmail/webhook", async (request) => {
  // 1. Verify token (security approach TBD - research Fastmail's supported methods)
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

    if (!emailAccount) {
      // Orphaned subscription - log warning but return 200 to prevent retries
      logger.warn("Webhook received for unknown JMAP accountId", { accountId });
      continue;
    }

    try {
      // Try Email/changes first
      const newEmails = await getEmailChanges(emailAccount, newEmailState);

      // Process each through shared processor (sequential)
      for (const email of newEmails) {
        await processHistoryItem(
          { messageId: email.id, threadId: email.threadId, message: email },
          { provider, emailAccount, ... }
        );
      }

      // Update state after successful processing
      await updateLastSyncedJmapState(emailAccount.id, newEmailState);
    } catch (error) {
      if (isCannotCalculateChangesError(error)) {
        // Fall back to full resync (last 7 days)
        await fullResyncEmails(emailAccount, newEmailState, logger);
      } else {
        // Log error, don't update state (will retry on next webhook)
        logger.error("Error processing state change", { error, accountId });
      }
    }
  }
}
```

### Error Handling & Retries

- Sequential processing is acceptable since webhook returns immediately via `after()`
- If processing fails mid-batch, state is not updated - emails will be reprocessed on next webhook
- Duplicate processing is acceptable - side effects like labeling are idempotent
- The `executedRule` check in `processHistoryItem` prevents duplicate rule execution

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
          deviceClientId: `inbox-zero-${this.userEmail}`,  // Use email for stability
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

## OAuth Flow Changes

During OAuth callback, capture the JMAP accountId:

```typescript
// In OAuth callback handler
const session = await discoverJmapSession(accessToken);
const primaryAccountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];

await prisma.emailAccount.update({
  where: { id: emailAccountId },
  data: { jmapAccountId: primaryAccountId }
});
```

**On reconnection** (user re-authenticates): Automatically call `watchEmails()` to restore subscription.

## Label Detection

The shared `processHistoryItem` checks `isInboxOrSentMessage()` using Gmail-style labels ('INBOX', 'SENT').

**Solution**: Verify that `FastmailProvider` normalizes mailbox roles to standard label IDs in `parseJMAPEmail()`. The provider already maps mailbox roles - ensure 'INBOX' and 'SENT' are included in `labelIds`.

## Security Considerations

### Webhook Verification

Current design uses query parameter token (`?token=xxx`). This appears in:
- Server logs
- Fastmail's logs (potentially)
- URL bars (if ever visited directly)

**Action Required**: Research what verification methods Fastmail supports:
- HMAC signature verification
- Custom headers
- IP allowlisting (if Fastmail publishes IP ranges)

Update implementation based on findings. For MVP, query parameter is acceptable with HTTPS.

### Plus Addressing

Assume Fastmail supports `+assistant` suffix like Gmail (`user+assistant@domain.com`). Verify during testing.

## Monitoring & Observability

1. **Existing error handling**: Use Sentry and existing logging infrastructure
2. **Health endpoint**: Add `/api/fastmail/health` to check subscription status for all Fastmail accounts
3. **User-visible status**: Show Fastmail connection health in UI (similar to Gmail/Outlook status indicators)

## Environment Variables

Add to configuration:

```bash
FASTMAIL_WEBHOOK_VERIFICATION_TOKEN=your-secret-token
```

Files to update:
- `.env.example`
- `env.ts`
- `turbo.json`

## Requirements & Limitations

### Fastmail Plan Requirements

Document that Fastmail assistant functionality requires a Fastmail plan that supports JMAP push subscriptions. If a user's plan doesn't support it, show an appropriate error message rather than silently failing.

### Rate Limits

Trust Fastmail's rate limits and handle errors reactively. No proactive rate limiting needed - let Fastmail return errors and handle them in the error path.

## Implementation Plan

### New Files

| File | Purpose |
|------|---------|
| `apps/web/app/api/fastmail/webhook/route.ts` | Webhook endpoint |
| `apps/web/app/api/fastmail/webhook/process-history.ts` | Fastmail-specific processing |
| `apps/web/app/api/fastmail/webhook/types.ts` | JMAP push payload types |
| `apps/web/app/api/fastmail/health/route.ts` | Health check endpoint |
| `prisma/migrations/xxx_add_jmap_fields.sql` | Schema migration |

### Files to Modify

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `lastSyncedJmapState`, `jmapAccountId` fields |
| `apps/web/utils/email/fastmail.ts` | Implement `watchEmails()`, `unwatchEmails()` |
| `apps/web/utils/webhook/validate-webhook-account.ts` | Add lookup by `jmapAccountId` |
| `apps/web/utils/fastmail/oauth.ts` | Capture `jmapAccountId` during OAuth, auto-resubscribe on reconnect |
| `apps/web/.env.example` | Add `FASTMAIL_WEBHOOK_VERIFICATION_TOKEN` |
| `apps/web/env.ts` | Add env var to schema |
| `turbo.json` | Add env var passthrough |

### Implementation Order

1. Schema migration (add fields)
2. Environment variables
3. OAuth changes (capture jmapAccountId, auto-resubscribe)
4. `watchEmails()` / `unwatchEmails()` in FastmailProvider
5. Webhook route and processing (including hybrid state change handling)
6. Account lookup by JMAP accountId
7. Health endpoint
8. Testing (unit tests with mocks)

**No pause needed** - implement all steps continuously, validate at the end.

## Testing Strategy

**Unit tests with mocks**: Mock the JMAP client and test business logic:
- `watchEmails()` creates correct subscription
- `unwatchEmails()` destroys subscription
- Webhook handler routes to correct processor
- State change processing handles `cannotCalculateChanges` fallback
- Orphan webhook handling

## Out of Scope

These features are not needed for assistant functionality:
- Filters/rules (`createFilter`, etc.)
- Attachments (`getAttachment`)
- Signatures (`getSignatures`)
- Shared mailbox support
- Email update tracking (only new emails)

## Infrastructure Notes

- Uses existing cron infrastructure (`/api/watch/all` every 6 hours)
- Supports QStash, Docker cron container, or manual cron
- No additional infrastructure required beyond webhook endpoint
- Local development: Use Cloudflare tunnel or similar to expose localhost

## Open Questions

1. **Webhook security**: What verification methods does Fastmail support beyond query parameter tokens?
2. **Plus addressing**: Verify Fastmail's `+` addressing behavior matches Gmail's
3. **Plan detection**: How to detect if a user's Fastmail plan supports push subscriptions?
