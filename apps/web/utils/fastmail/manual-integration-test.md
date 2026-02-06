# Fastmail Filter Manual Integration Test

## Prerequisites
- Fastmail account with API access
- Valid API token in `.env`

## Test Steps

### 1. Create Filter
1. Navigate to Bulk Unsubscribe page
2. Select sender
3. Click "Label future emails"
4. Verify success message

### 2. Verify in Fastmail
1. Log into Fastmail web interface
2. Go to Settings → Rules
3. Verify Inbox Zero section exists
4. Verify filter is present with correct from address

### 3. Test Filter Works
1. Send test email from filtered address
2. Verify email gets labeled correctly

### 4. List Filters
1. Refresh Bulk Unsubscribe page
2. Verify filter shows in UI
3. Check filter ID matches

### 5. Delete Filter
1. Click "Remove label" or delete filter
2. Verify filter removed from Fastmail Settings → Rules

### 6. Idempotency Test
1. Create same filter twice
2. Verify no error
3. Verify only one filter exists in Sieve script

## Expected Behavior
- ✅ Filters create successfully
- ✅ Filters appear in Fastmail UI
- ✅ Filters work (email gets labeled)
- ✅ Filters can be listed
- ✅ Filters can be deleted
- ✅ Operations are idempotent
