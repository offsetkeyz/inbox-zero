import type { FastmailClient } from "@/utils/fastmail/client";
import type {
  JMAPThread,
  JMAPGetResponse,
  JMAPEmail,
} from "@/utils/fastmail/types";
import { getEmails, parseJMAPEmail } from "@/utils/fastmail/message";
import type { EmailThread } from "@/utils/email/types";

export async function getThreads(
  client: FastmailClient,
  options: {
    accountId: string;
    ids: string[];
  },
): Promise<JMAPGetResponse<JMAPThread>> {
  const { accountId, ids } = options;

  if (ids.length === 0) {
    return {
      accountId,
      state: "",
      list: [],
      notFound: [],
    };
  }

  const response = await client.makeRequest([
    {
      methodName: "Thread/get",
      args: {
        accountId,
        ids,
      },
      id: "thread-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPGetResponse<JMAPThread>;
}

export async function getThread(
  client: FastmailClient,
  options: {
    accountId: string;
    id: string;
  },
): Promise<JMAPThread | null> {
  const result = await getThreads(client, {
    accountId: options.accountId,
    ids: [options.id],
  });

  return result.list[0] || null;
}

export async function getThreadWithMessages(
  client: FastmailClient,
  options: {
    accountId: string;
    threadId: string;
  },
): Promise<EmailThread | null> {
  const { accountId, threadId } = options;

  const thread = await getThread(client, { accountId, id: threadId });
  if (!thread) {
    return null;
  }

  const emailsResult = await getEmails(client, {
    accountId,
    ids: thread.emailIds,
  });

  const sortedEmails = emailsResult.list.sort((a, b) => {
    const dateA = new Date(a.receivedAt).getTime();
    const dateB = new Date(b.receivedAt).getTime();
    return dateA - dateB;
  });

  const messages = sortedEmails.map(parseJMAPEmail);

  const latestMessage = sortedEmails[sortedEmails.length - 1];
  const snippet = latestMessage?.preview || "";

  return {
    id: threadId,
    messages,
    snippet,
  };
}

export async function getThreadsWithMessages(
  client: FastmailClient,
  options: {
    accountId: string;
    threadIds: string[];
  },
): Promise<EmailThread[]> {
  const { accountId, threadIds } = options;

  if (threadIds.length === 0) {
    return [];
  }

  const threadsResult = await getThreads(client, { accountId, ids: threadIds });

  const allEmailIds = threadsResult.list.flatMap((thread) => thread.emailIds);

  if (allEmailIds.length === 0) {
    return [];
  }

  const emailsResult = await getEmails(client, {
    accountId,
    ids: allEmailIds,
  });

  const emailsByThread = new Map<string, JMAPEmail[]>();
  for (const email of emailsResult.list) {
    const existing = emailsByThread.get(email.threadId) || [];
    existing.push(email);
    emailsByThread.set(email.threadId, existing);
  }

  return threadsResult.list.map((thread) => {
    const threadEmails = emailsByThread.get(thread.id) || [];
    const sortedEmails = threadEmails.sort((a, b) => {
      const dateA = new Date(a.receivedAt).getTime();
      const dateB = new Date(b.receivedAt).getTime();
      return dateA - dateB;
    });

    const messages = sortedEmails.map(parseJMAPEmail);
    const latestMessage = sortedEmails[sortedEmails.length - 1];
    const snippet = latestMessage?.preview || "";

    return {
      id: thread.id,
      messages,
      snippet,
    };
  });
}
