import type { FastmailClient } from "@/utils/fastmail/client";
import type { JMAPMailbox, JMAPGetResponse } from "@/utils/fastmail/types";
import type { EmailLabel } from "@/utils/email/types";

export const FASTMAIL_MAILBOX_ROLES = {
  inbox: "inbox",
  archive: "archive",
  drafts: "drafts",
  sent: "sent",
  trash: "trash",
  junk: "junk",
} as const;

export type FastmailMailboxRole = keyof typeof FASTMAIL_MAILBOX_ROLES;

export async function getMailboxes(
  client: FastmailClient,
  options: {
    accountId: string;
  },
): Promise<JMAPGetResponse<JMAPMailbox>> {
  const { accountId } = options;

  const response = await client.makeRequest([
    {
      methodName: "Mailbox/get",
      args: {
        accountId,
      },
      id: "mailbox-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPGetResponse<JMAPMailbox>;
}

export async function getMailboxByRole(
  client: FastmailClient,
  options: {
    accountId: string;
    role: FastmailMailboxRole;
  },
): Promise<JMAPMailbox | null> {
  const mailboxes = await getMailboxes(client, { accountId: options.accountId });
  return mailboxes.list.find((m) => m.role === options.role) || null;
}

export async function getMailboxById(
  client: FastmailClient,
  options: {
    accountId: string;
    mailboxId: string;
  },
): Promise<JMAPMailbox | null> {
  const mailboxes = await getMailboxes(client, { accountId: options.accountId });
  return mailboxes.list.find((m) => m.id === options.mailboxId) || null;
}

export async function getMailboxByName(
  client: FastmailClient,
  options: {
    accountId: string;
    name: string;
  },
): Promise<JMAPMailbox | null> {
  const mailboxes = await getMailboxes(client, { accountId: options.accountId });
  const lowerName = options.name.toLowerCase();
  return (
    mailboxes.list.find((m) => m.name.toLowerCase() === lowerName) || null
  );
}

export function parseMailboxToLabel(mailbox: JMAPMailbox): EmailLabel {
  return {
    id: mailbox.id,
    name: mailbox.name,
    type: mailbox.role ? "system" : "user",
    threadsTotal: mailbox.totalThreads,
  };
}

export async function getLabelsFromMailboxes(
  client: FastmailClient,
  options: {
    accountId: string;
  },
): Promise<EmailLabel[]> {
  const mailboxes = await getMailboxes(client, options);

  return mailboxes.list
    .filter((m) => !m.role || m.role !== "trash")
    .map(parseMailboxToLabel);
}

export async function getInboxMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const inbox = await getMailboxByRole(client, {
    accountId,
    role: "inbox",
  });
  return inbox?.id || null;
}

export async function getArchiveMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const archive = await getMailboxByRole(client, {
    accountId,
    role: "archive",
  });
  return archive?.id || null;
}

export async function getTrashMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const trash = await getMailboxByRole(client, {
    accountId,
    role: "trash",
  });
  return trash?.id || null;
}

export async function getJunkMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const junk = await getMailboxByRole(client, {
    accountId,
    role: "junk",
  });
  return junk?.id || null;
}

export async function getSentMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const sent = await getMailboxByRole(client, {
    accountId,
    role: "sent",
  });
  return sent?.id || null;
}

export async function getDraftsMailboxId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const drafts = await getMailboxByRole(client, {
    accountId,
    role: "drafts",
  });
  return drafts?.id || null;
}
