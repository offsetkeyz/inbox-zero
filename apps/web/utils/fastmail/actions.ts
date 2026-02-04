import type { FastmailClient } from "@/utils/fastmail/client";
import type { JMAPSetResponse } from "@/utils/fastmail/types";
import {
  getInboxMailboxId,
  getArchiveMailboxId,
  getTrashMailboxId,
  getJunkMailboxId,
} from "@/utils/fastmail/mailbox";
import { getEmails } from "@/utils/fastmail/message";

export async function updateEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    updates: Record<string, Record<string, unknown>>;
  },
): Promise<JMAPSetResponse> {
  const { accountId, updates } = options;

  const response = await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        update: updates,
      },
      id: "email-set",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPSetResponse;
}

export async function markEmailsRead(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
    read: boolean;
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds, read } = options;

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    updates[id] = {
      [`keywords/$seen`]: read ? true : null,
    };
  }

  return updateEmails(client, { accountId, updates });
}

export async function moveEmailsToMailbox(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
    fromMailboxId?: string;
    toMailboxId: string;
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds, fromMailboxId, toMailboxId } = options;

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    const mailboxUpdate: Record<string, boolean | null> = {
      [`mailboxIds/${toMailboxId}`]: true,
    };
    if (fromMailboxId) {
      mailboxUpdate[`mailboxIds/${fromMailboxId}`] = null;
    }
    updates[id] = mailboxUpdate;
  }

  return updateEmails(client, { accountId, updates });
}

export async function addEmailsToMailbox(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
    mailboxId: string;
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds, mailboxId } = options;

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    updates[id] = {
      [`mailboxIds/${mailboxId}`]: true,
    };
  }

  return updateEmails(client, { accountId, updates });
}

export async function removeEmailsFromMailbox(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
    mailboxId: string;
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds, mailboxId } = options;

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    updates[id] = {
      [`mailboxIds/${mailboxId}`]: null,
    };
  }

  return updateEmails(client, { accountId, updates });
}

export async function archiveEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds } = options;

  const [inboxId, archiveId] = await Promise.all([
    getInboxMailboxId(client, accountId),
    getArchiveMailboxId(client, accountId),
  ]);

  if (!archiveId) {
    throw new Error("Archive mailbox not found");
  }

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    const mailboxUpdate: Record<string, boolean | null> = {
      [`mailboxIds/${archiveId}`]: true,
    };
    if (inboxId) {
      mailboxUpdate[`mailboxIds/${inboxId}`] = null;
    }
    updates[id] = mailboxUpdate;
  }

  return updateEmails(client, { accountId, updates });
}

export async function trashEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds } = options;

  const trashId = await getTrashMailboxId(client, accountId);

  if (!trashId) {
    throw new Error("Trash mailbox not found");
  }

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    updates[id] = {
      mailboxIds: { [trashId]: true },
    };
  }

  return updateEmails(client, { accountId, updates });
}

export async function markEmailsAsSpam(
  client: FastmailClient,
  options: {
    accountId: string;
    emailIds: string[];
  },
): Promise<JMAPSetResponse> {
  const { accountId, emailIds } = options;

  const junkId = await getJunkMailboxId(client, accountId);

  if (!junkId) {
    throw new Error("Junk mailbox not found");
  }

  const updates: Record<string, Record<string, unknown>> = {};
  for (const id of emailIds) {
    updates[id] = {
      mailboxIds: { [junkId]: true },
    };
  }

  return updateEmails(client, { accountId, updates });
}

export async function getThreadEmailIds(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
  },
): Promise<string[]> {
  const { accountId, threadId } = options;

  const response = await client.makeRequest([
    {
      methodName: "Thread/get",
      args: {
        accountId,
        ids: [threadId],
      },
      id: "thread-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const threads = (result as { list: Array<{ emailIds: string[] }> }).list;

  if (threads.length === 0) {
    return [];
  }

  return threads[0].emailIds;
}

export async function archiveThread(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
  },
): Promise<void> {
  const { accountId, threadId } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  await archiveEmails(client, { accountId, emailIds });
}

export async function trashThread(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
  },
): Promise<void> {
  const { accountId, threadId } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  await trashEmails(client, { accountId, emailIds });
}

export async function markThreadRead(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
    read: boolean;
  },
): Promise<void> {
  const { accountId, threadId, read } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  await markEmailsRead(client, { accountId, emailIds, read });
}

export async function markThreadAsSpam(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
  },
): Promise<void> {
  const { accountId, threadId } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  await markEmailsAsSpam(client, { accountId, emailIds });
}

export async function labelEmail(
  client: FastmailClient,
  options: {
    accountId: string;
    emailId: string;
    mailboxId: string;
  },
): Promise<void> {
  const { accountId, emailId, mailboxId } = options;

  await addEmailsToMailbox(client, {
    accountId,
    emailIds: [emailId],
    mailboxId,
  });
}

export async function removeThreadFromMailbox(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
    mailboxId: string;
  },
): Promise<void> {
  const { accountId, threadId, mailboxId } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  await removeEmailsFromMailbox(client, { accountId, emailIds, mailboxId });
}

export async function removeThreadFromMailboxes(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
    mailboxIds: string[];
  },
): Promise<void> {
  const { accountId, threadId, mailboxIds } = options;

  const emailIds = await getThreadEmailIds(client, { accountId, threadId });
  if (emailIds.length === 0) return;

  const updates: Record<string, Record<string, unknown>> = {};
  for (const emailId of emailIds) {
    const mailboxUpdate: Record<string, null> = {};
    for (const mailboxId of mailboxIds) {
      mailboxUpdate[`mailboxIds/${mailboxId}`] = null;
    }
    updates[emailId] = mailboxUpdate;
  }

  await updateEmails(client, { accountId, updates });
}
