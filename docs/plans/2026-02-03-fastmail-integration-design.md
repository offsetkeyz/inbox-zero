# Fastmail Integration Design

## Overview

Add Fastmail as a third email provider alongside Gmail and Outlook, using Fastmail's native JMAP API.

## Goals

- Personal use first, but production-ready for public release
- Core features only in v1 (read, organize, send)
- OAuth primary authentication, API tokens as fallback

## Infrastructure

### Database: Supabase

Using Supabase (cloud-hosted PostgreSQL) for data persistence:
- Allows data to persist across machines and Docker container restarts
- Connection pooling via Supabase's transaction pooler (port 6543) and session pooler (port 5432)
- No local PostgreSQL required

**Environment Variables:**
```
DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
```

### Local Services (Docker)

Redis still runs locally via Docker for caching:
```bash
docker compose -f docker-compose.dev.yml up -d redis serverless-redis-http
```

## Authentication Strategy

### OAuth 2.0 (Primary)

- Register Inbox Zero as an OAuth application with Fastmail
- Follows existing pattern: `/api/fastmail/linking/auth-url` and `/api/fastmail/linking/callback`
- Stores tokens in the existing `Account` model with `provider: "fastmail"`
- Token refresh handled automatically like Gmail/Outlook

### API Tokens (Fallback)

- Fastmail allows creating API tokens at `Settings → Privacy & Security → API tokens`
- Users paste their token into a form (no OAuth dance)
- Token stored in `Account.access_token` with no refresh needed (tokens don't expire unless revoked)
- Simpler for self-hosted users who don't want to register an OAuth app

## JMAP API Integration

### What is JMAP?

- JSON-based API that Fastmail created as a modern replacement for IMAP
- Single HTTP endpoint with batched method calls
- Built-in support for push notifications via EventSource

### JMAP Session Discovery

- Authenticate → GET `https://api.fastmail.com/.well-known/jmap`
- Returns session object with API endpoint URLs and account capabilities

### Mapping JMAP to EmailProvider Interface

| EmailProvider Method | JMAP Method |
|---------------------|-------------|
| `getThreads()` | `Email/query` + `Thread/get` |
| `getThread()` | `Thread/get` + `Email/get` |
| `getMessage()` | `Email/get` |
| `getLabels()` | `Mailbox/get` (returns user's mailboxes, works in both label/folder mode) |
| `labelMessage()` | `Email/set` (update mailboxIds - adds to mailbox(es)) |
| `archiveThread()` | `Email/set` (move to Archive mailbox) |
| `markRead()` | `Email/set` (update keywords) |
| `sendEmail()` | `EmailSubmission/set` |

### Key Differences from Gmail/Outlook

- JMAP uses "mailboxes" as the organizational primitive
- Standard mailboxes: Inbox, Archive, Drafts, Sent, Trash, Junk

### Labels vs Folders (Agnostic Approach)

Fastmail allows users to configure their account for either "folder mode" or "label mode":

- **Folder mode**: Traditional folders, one location per email
- **Label mode**: Gmail-style labels, multiple can be applied to an email

**Key insight**: At the JMAP API level, both modes use the same `mailboxIds` property on emails. The difference is:
- Folder mode: Fastmail enforces single user-mailbox per email
- Label mode: Fastmail allows multiple user-mailboxes per email

**Our approach**: Implement against the JMAP mailbox API without assuming either mode. This means:
- Always use `Email/set` with `mailboxIds` for organization
- Support applying multiple mailboxes (works in both modes)
- Let Fastmail enforce the user's preference server-side
- If a user has folder mode and we try to add multiple, Fastmail handles it gracefully

**Benefits**:
- Works for all Fastmail users regardless of their settings
- No need to detect or require a specific configuration
- Users who prefer labels get label behavior automatically
- Users who prefer folders get folder behavior automatically
- Single code path, simpler implementation

## File Structure

### New Files

```
apps/web/utils/fastmail/
├── client.ts           # JMAP session management, auth, token refresh
├── scopes.ts           # JMAP capabilities (urn:ietf:params:jmap:mail, etc.)
├── message.ts          # Email/get, Email/query operations
├── thread.ts           # Thread/get operations
├── mailbox.ts          # Mailbox/get, Mailbox/set (labels equivalent)
├── mail.ts             # EmailSubmission/set (sending)
├── types.ts            # JMAP response types

apps/web/utils/email/
├── fastmail.ts         # FastmailProvider class implementing EmailProvider

apps/web/app/api/fastmail/
├── linking/
│   ├── auth-url/route.ts
│   ├── callback/route.ts
│   └── token/route.ts   # Manual API token entry
```

### Updates to Existing Files

| File | Change |
|------|--------|
| `utils/email/provider-types.ts` | Add `isFastmailProvider()` |
| `utils/email/provider.ts` | Add Fastmail case to factory |
| `utils/auth.ts` | Add Fastmail OAuth config |
| `env.ts` | Add `FASTMAIL_CLIENT_ID`, `FASTMAIL_CLIENT_SECRET` |
| `.env.example` | Document new env vars |

No database schema changes needed - the existing `Account` model handles everything.

## Core Features (v1 Scope)

### Included

| Feature | Implementation |
|---------|----------------|
| Read threads/messages | `Email/query`, `Thread/get`, `Email/get` |
| List mailboxes | `Mailbox/get` - returns Inbox, Archive, Sent, etc. |
| Move to mailbox | `Email/set` with updated `mailboxIds` |
| Archive | Move to Archive mailbox |
| Trash | Move to Trash mailbox |
| Mark read/unread | `Email/set` with `$seen` keyword |
| Mark spam | Move to Junk mailbox |
| Send email | `Email/set` + `EmailSubmission/set` |
| Reply/Forward | Same as send, with `In-Reply-To` header |

### Deferred

| Feature | Reason |
|---------|--------|
| Webhooks/Push | JMAP EventSource requires persistent connection; add when needed |
| Drafts | Nice-to-have, not core workflow |
| Attachments | `Blob/get` - add based on user demand |
| Filters/Rules | Fastmail has its own rules system via Sieve |
| Contacts | Separate JMAP capability, not essential |

## UI Changes

### Connect Account Flow

Add third option to onboarding/settings:

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Google    │  │  Microsoft  │  │  Fastmail   │
│   Gmail     │  │   Outlook   │  │             │
└─────────────┘  └─────────────┘  └─────────────┘
```

### Fastmail Connection Paths

1. **OAuth button** - "Connect with Fastmail" → standard OAuth flow
2. **API token option** - Link below: "Or use an API token" → opens modal with:
   - Instructions to create token in Fastmail settings
   - Text input for pasting token
   - Submit button

### Files to Update

| File | Change |
|------|--------|
| `apps/web/app/(app)/onboarding/OnboardingForm.tsx` | Add Fastmail option |
| `apps/web/app/(app)/settings/AccountsSection.tsx` | Add Fastmail to linked accounts |
| `apps/web/components/ConnectProvider.tsx` (or similar) | Fastmail OAuth + token modal |

No changes needed to email list views, thread views, or AI features (all provider-agnostic).

### Label/Folder UI Terminology

For Fastmail accounts, use agnostic terminology in the UI:
- Label picker → "Organize" or "Move to..."
- This avoids confusion for users in either folder or label mode
- The underlying functionality works identically regardless of terminology

## Error Handling

JMAP returns structured errors in a consistent format:

```typescript
type JMAPError = {
  type: string;        // "unauthorized", "serverFail", "limit", etc.
  description?: string;
};
```

Create `apps/web/utils/fastmail/retry.ts` following the Gmail/Outlook pattern:
- Handle `401` → trigger token refresh
- Handle `429` → rate limiting, exponential backoff
- Handle `serverFail` → retry with backoff

## Implementation Phases

Build incrementally with user testing at each UI checkpoint.

### Phase 0: Documentation Setup

Update documentation before starting implementation.

**Documentation:**
- [ ] Update README with Supabase setup instructions:
  - How to create a Supabase project
  - How to get connection strings (transaction pooler + session pooler)
  - Environment variable configuration
  - Running Prisma migrations against Supabase
- [ ] Update `.env.example` with Supabase placeholder URLs
- [ ] Document that local PostgreSQL (Docker) is optional if using Supabase

**🧪 Checkpoint 0: Verify setup docs**
- Follow README instructions from scratch
- Confirm Supabase connection works
- Confirm migrations run successfully

---

### Phase 1: API Token Connection (No OAuth)

Start with the simpler auth path to get end-to-end working faster.

**Backend:**
- [ ] Create `utils/fastmail/client.ts` - JMAP session discovery
- [ ] Create `utils/fastmail/types.ts` - JMAP response types
- [ ] Create `app/api/fastmail/linking/token/route.ts` - API token validation endpoint

**Frontend:**
- [ ] Add Fastmail button to onboarding (disabled state initially)
- [ ] Create API token modal with instructions and input field
- [ ] Wire up token submission to backend

**🧪 Checkpoint 1: Test API token connection**
- User pastes Fastmail API token
- Token is validated against JMAP session endpoint
- Account appears in account switcher
- (Emails won't load yet - that's Phase 2)

---

### Phase 2: Read Emails

**Backend:**
- [ ] Create `utils/fastmail/message.ts` - Email/get, Email/query
- [ ] Create `utils/fastmail/thread.ts` - Thread/get
- [ ] Create `utils/fastmail/mailbox.ts` - Mailbox/get
- [ ] Create `utils/email/fastmail.ts` - FastmailProvider (read methods only)
- [ ] Wire FastmailProvider into provider factory

**Frontend:**
- No changes needed - existing inbox UI works with provider interface

**🧪 Checkpoint 2: Test email reading**
- Select Fastmail account in switcher
- Inbox loads with threads
- Click thread to view messages
- Verify message content displays correctly

---

### Phase 3: Email Actions

**Backend:**
- [ ] Add archive/trash/spam methods to FastmailProvider
- [ ] Add mark read/unread methods
- [ ] Add label/move to mailbox methods

**Frontend:**
- No changes needed - existing action buttons work with provider interface

**🧪 Checkpoint 3: Test email actions**
- Archive an email → verify it moves to Archive in Fastmail
- Mark as read/unread → verify status changes
- Apply a mailbox/label → verify organization works
- Move to trash → verify email is trashed

---

### Phase 4: Send Email

**Backend:**
- [ ] Create `utils/fastmail/mail.ts` - EmailSubmission/set
- [ ] Add sendEmail method to FastmailProvider
- [ ] Add reply/forward support

**Frontend:**
- No changes needed - existing compose UI works with provider interface

**🧪 Checkpoint 4: Test sending**
- Compose and send a new email
- Reply to an existing thread
- Forward an email
- Verify emails appear in Fastmail Sent folder

---

### Phase 5: OAuth (Optional Enhancement)

Only if API tokens aren't sufficient for your use case.

**Backend:**
- [ ] Register OAuth app with Fastmail
- [ ] Add Fastmail OAuth config to auth.ts
- [ ] Create auth-url and callback routes
- [ ] Add env vars for client ID/secret

**Frontend:**
- [ ] Enable "Connect with Fastmail" OAuth button
- [ ] Keep API token as fallback option

**🧪 Checkpoint 5: Test OAuth flow**
- Click "Connect with Fastmail"
- Complete OAuth authorization
- Account connects successfully

---

### Phase 6: Polish & AI Features

**Testing:**
- [ ] AI categorization works with Fastmail emails
- [ ] Rules apply correctly
- [ ] Bulk actions work
- [ ] Error states display properly

**🧪 Checkpoint 6: Full integration test**
- Run through complete workflow with Fastmail account
- Test alongside Gmail account (multi-account)
- Verify all AI features work

## Testing Strategy

| Type | Approach |
|------|----------|
| Unit tests | Mock JMAP responses, test `FastmailProvider` methods |
| Integration tests | Use personal Fastmail account with API token |
| AI tests | Existing AI test suite should work once provider is wired up |

### Test Files

```
apps/web/utils/fastmail/client.test.ts
apps/web/utils/email/fastmail.test.ts
```

### Manual QA Checklist

- [ ] OAuth flow connects successfully
- [ ] API token flow connects successfully
- [ ] Threads load in inbox
- [ ] Open thread shows messages
- [ ] Archive moves to Archive mailbox
- [ ] Mark read/unread works
- [ ] Send email works
- [ ] Apply mailbox/label works (test in user's configured mode)
- [ ] AI categorization works with Fastmail emails
- [ ] Rules apply correctly to Fastmail emails
