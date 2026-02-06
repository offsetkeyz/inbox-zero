# Fastmail Sieve Filter Implementation Design

**Issue:** #5 - Implement createFilter for Fastmail using JMAP Sieve filters
**Date:** 2026-02-06
**Status:** Design Approved

## Overview

Implement full filter management for Fastmail using JMAP's Sieve script capabilities. This provides feature parity with Gmail/Outlook filter operations: `createFilter()`, `deleteFilter()`, and `getFiltersList()`.

## Problem Statement

Currently, these methods throw "not yet implemented" errors, breaking the "Label future emails" feature on the Bulk Unsubscribe page. Fastmail uses RFC 5228 Sieve scripts rather than Gmail-style filter objects, requiring a fundamentally different implementation approach.

## Architecture

### Section-Based Management Pattern

All Inbox Zero filters live within a clearly marked section of the user's Sieve script:

```sieve
# User's existing Sieve rules here...

# === BEGIN INBOX ZERO MANAGED FILTERS ===
# DO NOT MANUALLY EDIT THIS SECTION
# Filters managed by Inbox Zero - changes may be overwritten
# Last updated: 2026-02-06T10:30:00Z

# Filter ID: a3f5b8c9d2e1f4a7b6c8d9e0f1a2b3c4
# From: newsletter@example.com
# Add labels: ["mailbox-uuid-123"]
# Remove labels: ["INBOX"]
if address :is "from" "newsletter@example.com" {
  fileinto "mailbox-uuid-123";
}

# === END INBOX ZERO MANAGED FILTERS ===

# More user rules...
```

### Key Design Principles

1. **Isolation**: Managed section bounded by clear BEGIN/END markers with warnings
2. **Self-documenting**: Each filter includes metadata comments (ID, from address, label operations)
3. **Idempotent**: Hash-based IDs ensure same filter criteria always generate same ID
4. **Validation-first**: Strict validation of script structure, detect tampering

## Sieve Rule Structure

### RFC 5228 Compliance

Fastmail supports standard Sieve (RFC 5228) plus extensions:
- **Base Sieve**: `if`, `address`, `fileinto`, `stop`
- **Extensions**: `fileinto` (RFC 5228), `imap4flags` (for flag manipulation)

### Rule Generation Patterns

**Pattern 1: Add label only**
```sieve
# Filter ID: hash-of-criteria
if address :is "from" "sender@example.com" {
  fileinto "mailbox-uuid-123";
}
```

**Pattern 2: Archive (remove INBOX)**
```sieve
# Filter ID: hash-of-criteria
if address :is "from" "sender@example.com" {
  fileinto "Archive";
}
```

**Pattern 3: Add label + Archive**
```sieve
# Filter ID: hash-of-criteria
if address :is "from" "sender@example.com" {
  fileinto ["mailbox-uuid-123", "Archive"];
}
```

### Label ID Mapping

Gmail uses string IDs (`INBOX`, `SPAM`, `SENT`), Fastmail uses JMAP mailbox UUIDs.

**Runtime resolution approach:**
1. Detect Gmail special strings in `addLabelIds`/`removeLabelIds`
2. Call existing helpers: `getInboxMailboxId()`, `getArchiveMailboxId()`, etc.
3. Resolve to actual Fastmail mailbox UUID
4. Use UUID in generated Sieve script

```typescript
async function resolveMailboxId(labelId: string, client, accountId) {
  if (labelId === "INBOX") return await getInboxMailboxId(client, accountId);
  if (labelId === GmailLabel.SPAM) return await getJunkMailboxId(client, accountId);
  if (labelId === GmailLabel.TRASH) return await getTrashMailboxId(client, accountId);
  // Otherwise it's already a Fastmail UUID
  return labelId;
}
```

**Why runtime resolution:**
- Mailbox UUIDs are account-specific
- Existing helpers already query JMAP with role filters
- Leverage existing code, no static mapping needed

### Supported Actions (Gmail-Compatible Subset)

Support the specific combinations used in the codebase:
- Adding labels (fileinto)
- Removing INBOX (archive behavior)
- Auto-archive pattern (`createAutoArchiveFilter`)

## Filter ID Generation

### Hash-Based IDs

Generate filter IDs using SHA-256 of normalized criteria:

```typescript
function generateFilterId(criteria: {
  from: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): string {
  // Normalize: lowercase email, sort arrays
  const normalized = {
    from: criteria.from.toLowerCase().trim(),
    addLabelIds: (criteria.addLabelIds || []).sort(),
    removeLabelIds: (criteria.removeLabelIds || []).sort(),
  };

  const payload = JSON.stringify(normalized);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');

  return hash.substring(0, 32); // 128-bit entropy
}
```

### Benefits

1. **Natural deduplication**: Same criteria → same hash → prevents duplicates
2. **Stateless**: No database tracking, ID derived from filter itself
3. **Portable**: IDs remain consistent if users export/import scripts
4. **Collision-resistant**: SHA-256 provides strong guarantees

### ID Embedding

Each filter includes metadata comments:

```sieve
# Filter ID: a3f5b8c9d2e1f4a7b6c8d9e0f1a2b3c4
# From: newsletter@example.com
# Created: 2026-02-06T10:30:00Z
if address :is "from" "newsletter@example.com" {
  fileinto "mailbox-uuid";
}
```

## Implementation Details

### createFilter

**Flow:**
1. Generate filter ID from criteria
2. Fetch current Sieve script via JMAP
3. Parse and validate managed section
4. Check for duplicate (same ID exists) → return success if found
5. Resolve label IDs to mailbox UUIDs
6. Generate Sieve rule
7. Insert into managed section
8. Upload updated script via JMAP

**Key helpers:**
- `getSieveScript()`: JMAP fetch
- `setSieveScript()`: JMAP update
- `parseManagedSection()`: Extract structured data
- `validateManagedSection()`: Check integrity
- `generateSieveRule()`: Create RFC-compliant code
- `insertFilterIntoSection()`: Append before END marker

### deleteFilter

**Flow:**
1. Fetch current Sieve script
2. Parse and validate managed section
3. Find filter by ID
4. If not found → return success (idempotent)
5. Regenerate managed section without deleted filter
6. Upload updated script

**Strategy:**
Use regeneration (not line-based removal):
- More robust against formatting variations
- Automatically fixes minor corruption
- Updates "Last updated" timestamp
- Easier to test

### getFiltersList

**Flow:**
1. Fetch current Sieve script
2. Parse managed section
3. Validate structure (strict)
4. Convert to `EmailFilter[]` format

**Parsing strategy:**
Extract from comment metadata, not Sieve code:
- Simpler (no full Sieve parser needed)
- Reliable (comments are source of truth)
- Extensible (easy to add metadata fields)
- Faster (string matching vs AST parsing)

**Data structures:**
```typescript
interface ParsedFilter {
  id: string;              // From "# Filter ID: ..."
  from: string;            // From "# From: ..."
  addMailboxIds: string[]; // From "# Add labels: [...]"
  removeMailboxIds: string[]; // From "# Remove labels: [...]"
  sieveCode: string;       // Actual Sieve rule
}

interface ParsedManagedSection {
  found: boolean;          // Found BEGIN/END markers?
  filters: ParsedFilter[];
  lastUpdated?: string;    // From "# Last updated: ..."
}
```

## Error Handling

### Strict Validation Rules

**1. Managed Section Integrity**
```typescript
function validateManagedSection(parsed: ParsedManagedSection): void {
  if (!parsed.found) {
    throw new SafeError(
      "Inbox Zero filter section not found. Please contact support to reinitialize."
    );
  }

  if (parsed.hasCorruptedMarkers) {
    throw new SafeError(
      "Filter section markers corrupted. Please reset filters in Fastmail settings or contact support."
    );
  }

  if (parsed.hasMalformedComments) {
    throw new SafeError(
      "Filter metadata is malformed. Manual editing detected. Please contact support."
    );
  }
}
```

**2. Sieve Syntax Validation**

Before uploading any script, validate syntax using a Sieve parser or rely on Fastmail's API error response.

**3. JMAP API Error Handling**

Map JMAP errors to user-friendly messages:
- `forbidden` → "Permission denied. Verify API token has mail:write scope."
- `accountNotFound` → "Fastmail account not found. Please reconnect."

**4. First-Time Initialization**

When markers don't exist, auto-create on first `createFilter`:
```typescript
if (!parsed.found) {
  this.logger.info("Initializing Inbox Zero filter section");
  const scriptWithSection = initializeManagedSection(currentScript);
  await this.setSieveScript(scriptWithSection);
  return this.createFilter(options); // Retry
}
```

## JMAP API Integration

### Get Active Sieve Script

```typescript
async getSieveScript(): Promise<string> {
  const response = await this.client.makeRequest([
    {
      methodName: "SieveScript/get",
      args: {
        accountId: this.accountId,
        ids: null, // Get all scripts
      },
      id: "sieve-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const scripts = (result as { list: SieveScript[] }).list;

  const activeScript = scripts.find(s => s.isActive);

  if (!activeScript) {
    return createInitialScript(); // Empty template with managed section
  }

  return activeScript.content;
}
```

### Set Sieve Script

```typescript
async setSieveScript(content: string): Promise<void> {
  await validateSieveSyntax(content);

  const currentScript = await this.getCurrentScriptId();

  const response = await this.client.makeRequest([
    {
      methodName: "SieveScript/set",
      args: {
        accountId: this.accountId,
        update: {
          [currentScript.id]: { content },
        },
      },
      id: "sieve-set",
    },
  ]);

  const [, result] = response.methodResponses[0];

  if (result.notUpdated) {
    const error = result.notUpdated[currentScript.id];
    throw new Error(`Failed to update Sieve script: ${error.type}`);
  }
}
```

### JMAP Types

```typescript
interface SieveScript {
  id: string;
  name: string;
  content: string;
  isActive: boolean;
}

interface SieveScriptSetResponse {
  updated?: Record<string, null>;
  notUpdated?: Record<string, {
    type: string;
    description?: string;
  }>;
}
```

### Initial Script Template

```typescript
function createInitialScript(): string {
  return `require ["fileinto"];

# === BEGIN INBOX ZERO MANAGED FILTERS ===
# DO NOT MANUALLY EDIT THIS SECTION
# Filters managed by Inbox Zero - changes may be overwritten
# Last updated: ${new Date().toISOString()}
# === END INBOX ZERO MANAGED FILTERS ===
`;
}
```

### Required Scopes

Ensure API token/OAuth includes:
- `https://www.fastmail.com/dev/sieve` (Sieve script management)

Add to `apps/web/utils/fastmail/scopes.ts`:
```typescript
export const FASTMAIL_SIEVE_SCOPE = "https://www.fastmail.com/dev/sieve";
```

## Testing Strategy

### TDD with RFC Compliance

**1. Sieve Generation Tests**
```typescript
describe("generateSieveRule", () => {
  it("generates RFC 5228 compliant rule for single mailbox");
  it("generates rule with multiple mailboxes using array syntax");
  it("handles special characters in email addresses");
});
```

**2. Hash Generation Tests**
```typescript
describe("generateFilterId", () => {
  it("generates same ID for identical criteria");
  it("normalizes email case");
  it("sorts arrays for consistency");
});
```

**3. Parser Tests**
```typescript
describe("parseManagedSection", () => {
  it("parses empty managed section");
  it("extracts filter metadata from comments");
  it("detects corrupted markers");
  it("handles multiple filters");
});
```

**4. Integration Tests**
- Mock JMAP responses
- Test full createFilter → getFiltersList → deleteFilter flow
- Test error scenarios (missing section, malformed script, API failures)

### Implementation Order (TDD)

1. Write tests for `generateFilterId` → Implement
2. Write tests for `generateSieveRule` → Implement
3. Write tests for `parseManagedSection` → Implement
4. Write tests for JMAP interactions (mocked) → Implement
5. Write tests for createFilter/deleteFilter/getFiltersList → Implement
6. Integration test against real Fastmail account

## File Structure

### New Files

- `apps/web/utils/fastmail/filter.ts` - Core implementation
  - `generateFilterId()`
  - `generateSieveRule()`
  - `parseManagedSection()`
  - `validateManagedSection()`
  - `insertFilterIntoSection()`
  - `regenerateManagedSection()`

- `apps/web/utils/fastmail/filter.test.ts` - Test suite

- `apps/web/utils/fastmail/sieve.ts` - JMAP Sieve helpers
  - `getSieveScript()`
  - `setSieveScript()`
  - `getCurrentScriptId()`
  - `createInitialScript()`
  - `validateSieveSyntax()`
  - JMAP types

### Modified Files

- `apps/web/utils/email/fastmail.ts` - Update filter methods to call new implementation
- `apps/web/utils/fastmail/scopes.ts` - Add Sieve scope

## Integration Points

1. **Mailbox resolution**: Use existing helpers
   - `getInboxMailboxId()`
   - `getArchiveMailboxId()`
   - `getTrashMailboxId()`
   - `getJunkMailboxId()`

2. **Label mapping**: Map Gmail constants at runtime

3. **Error handling**: Use existing `SafeError` for user-facing errors

4. **Logging**: Use `this.logger` pattern throughout

## Edge Cases Covered

✓ No active Sieve script (create initial template)
✓ Duplicate filter creation (idempotent via hash)
✓ Filter doesn't exist on delete (idempotent)
✓ Managed section missing (auto-initialize)
✓ Manual tampering (strict validation, clear errors)
✓ JMAP API failures (error propagation with context)
✓ Special characters in email addresses
✓ Multiple mailboxes per filter
✓ Case-insensitive email matching

## Success Criteria

1. ✅ All three filter methods implemented
2. ✅ "Label future emails" feature works for Fastmail users
3. ✅ RFC 5228 compliant Sieve script generation
4. ✅ Comprehensive test coverage (unit + integration)
5. ✅ Strict validation prevents data corruption
6. ✅ Clear error messages for users
7. ✅ No database schema changes required
8. ✅ Feature parity with Gmail/Outlook filter operations

## Future Considerations

- Support for additional Sieve criteria (subject, to, cc)
- Support for additional actions (mark as read, star, forward)
- UI for editing filters directly in Inbox Zero
- Import existing user Sieve rules into managed section
- Sieve script syntax highlighting/validation in UI
