import type { FastmailClient } from "@/utils/fastmail/client";
import type { ParsedMessage } from "@/utils/types";
import type { InboxZeroLabel } from "@/utils/label";
import type { ThreadsQuery } from "@/app/api/threads/validation";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type {
  EmailProvider,
  EmailThread,
  EmailLabel,
  EmailFilter,
  EmailSignature,
} from "@/utils/email/types";
import { createScopedLogger, type Logger } from "@/utils/logger";
import {
  queryEmails,
  getEmail,
  getEmails,
  parseJMAPEmail,
  queryAndGetEmails,
} from "@/utils/fastmail/message";
import {
  getThreadWithMessages,
  getThreadsWithMessages,
} from "@/utils/fastmail/thread";
import {
  getMailboxes,
  getMailboxById,
  getMailboxByName,
  getInboxMailboxId,
  getSentMailboxId,
  getDraftsMailboxId,
  parseMailboxToLabel,
} from "@/utils/fastmail/mailbox";
import {
  archiveThread as archiveThreadAction,
  archiveEmails,
  trashThread as trashThreadAction,
  markThreadRead,
  markThreadAsSpam,
  labelEmail,
  removeThreadFromMailbox,
  removeThreadFromMailboxes,
} from "@/utils/fastmail/actions";

export class FastmailProvider implements EmailProvider {
  readonly name = "fastmail" as const;
  private readonly client: FastmailClient;
  private readonly logger: Logger;
  private accountId: string | null = null;

  constructor(client: FastmailClient, logger?: Logger) {
    this.client = client;
    this.logger = (logger || createScopedLogger("fastmail-provider")).with({
      provider: "fastmail",
    });
  }

  toJSON() {
    return { name: this.name, type: "FastmailProvider" };
  }

  private async getAccountId(): Promise<string> {
    if (this.accountId) {
      return this.accountId;
    }
    this.accountId = await this.client.getAccountId();
    return this.accountId;
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const accountId = await this.getAccountId();
    const mailboxId = folderId || (await getInboxMailboxId(this.client, accountId));

    if (!mailboxId) {
      this.logger.warn("No mailbox ID found for getThreads");
      return [];
    }

    const emails = await queryAndGetEmails(this.client, {
      accountId,
      mailboxId,
      limit: 50,
    });

    const threadIds = [...new Set(emails.map((e) => e.threadId))];
    return getThreadsWithMessages(this.client, { accountId, threadIds });
  }

  async getThread(threadId: string): Promise<EmailThread> {
    const accountId = await this.getAccountId();
    const thread = await getThreadWithMessages(this.client, { accountId, threadId });

    if (!thread) {
      return { id: threadId, messages: [], snippet: "" };
    }

    return thread;
  }

  async getLabels(): Promise<EmailLabel[]> {
    const accountId = await this.getAccountId();
    const mailboxes = await getMailboxes(this.client, { accountId });

    return mailboxes.list
      .filter((m) => !m.role || m.role !== "trash")
      .map(parseMailboxToLabel);
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const accountId = await this.getAccountId();
    const mailbox = await getMailboxById(this.client, { accountId, mailboxId: labelId });

    if (!mailbox) return null;
    return parseMailboxToLabel(mailbox);
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const accountId = await this.getAccountId();
    const mailbox = await getMailboxByName(this.client, { accountId, name });

    if (!mailbox) return null;
    return parseMailboxToLabel(mailbox);
  }

  async getFolders(): Promise<OutlookFolder[]> {
    this.logger.warn("getFolders not fully implemented for Fastmail");
    return [];
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const accountId = await this.getAccountId();
    const email = await getEmail(this.client, { accountId, id: messageId });

    if (!email) {
      throw new Error(`Message not found: ${messageId}`);
    }

    return parseJMAPEmail(email);
  }

  async getMessageByRfc822MessageId(rfc822MessageId: string): Promise<ParsedMessage | null> {
    const accountId = await this.getAccountId();

    const queryResult = await queryEmails(this.client, {
      accountId,
      filter: { header: ["Message-ID", rfc822MessageId] },
      limit: 1,
    });

    if (queryResult.ids.length === 0) {
      return null;
    }

    return this.getMessage(queryResult.ids[0]);
  }

  async getSentMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const sentMailboxId = await getSentMailboxId(this.client, accountId);

    if (!sentMailboxId) {
      this.logger.warn("Sent mailbox not found");
      return [];
    }

    return queryAndGetEmails(this.client, {
      accountId,
      mailboxId: sentMailboxId,
      limit: maxResults,
    });
  }

  async getInboxMessages(maxResults = 20): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const inboxMailboxId = await getInboxMailboxId(this.client, accountId);

    if (!inboxMailboxId) {
      this.logger.warn("Inbox mailbox not found");
      return [];
    }

    return queryAndGetEmails(this.client, {
      accountId,
      mailboxId: inboxMailboxId,
      limit: maxResults,
    });
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
  }): Promise<{ id: string; threadId: string }[]> {
    const accountId = await this.getAccountId();
    const sentMailboxId = await getSentMailboxId(this.client, accountId);

    if (!sentMailboxId) {
      return [];
    }

    const filter: Record<string, unknown> = {};
    if (options.after) {
      filter.after = options.after.toISOString();
    }
    if (options.before) {
      filter.before = options.before.toISOString();
    }

    const queryResult = await queryEmails(this.client, {
      accountId,
      mailboxId: sentMailboxId,
      limit: options.maxResults,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    return emailsResult.list.map((email) => ({
      id: email.id,
      threadId: email.threadId,
    }));
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { maxResults = 100 } = options;
    const accountId = await this.getAccountId();
    const sentMailboxId = await getSentMailboxId(this.client, accountId);

    if (!sentMailboxId) {
      return [];
    }

    const messages = await queryAndGetEmails(this.client, {
      accountId,
      mailboxId: sentMailboxId,
      limit: maxResults,
    });

    const filtered = messages.filter((msg) => {
      const to = msg.headers.to?.toLowerCase() || "";
      const from = msg.headers.from?.toLowerCase() || "";

      for (const email of options.excludeToEmails || []) {
        if (to.includes(email.toLowerCase())) return false;
      }
      for (const email of options.excludeFromEmails || []) {
        if (from.includes(email.toLowerCase())) return false;
      }
      return true;
    });

    const threadIds = [...new Set(filtered.map((m) => m.threadId))];
    return getThreadsWithMessages(this.client, { accountId, threadIds });
  }

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const draftsMailboxId = await getDraftsMailboxId(this.client, accountId);

    if (!draftsMailboxId) {
      this.logger.warn("Drafts mailbox not found");
      return [];
    }

    return queryAndGetEmails(this.client, {
      accountId,
      mailboxId: draftsMailboxId,
      limit: options?.maxResults || 50,
    });
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    const thread = await this.getThread(threadId);
    return thread.messages;
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const inboxMailboxId = await getInboxMailboxId(this.client, accountId);

    const thread = await this.getThread(threadId);
    if (!inboxMailboxId) return thread.messages;

    return thread.messages.filter((msg) => msg.labelIds?.includes(inboxMailboxId));
  }

  async getPreviousConversationMessages(messageIds: string[]): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const result = await getEmails(this.client, { accountId, ids: messageIds });
    return result.list.map(parseJMAPEmail);
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const accountId = await this.getAccountId();
    const position = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 20;

    const filter: Record<string, unknown> = {};
    if (options.after) {
      filter.after = options.after.toISOString();
    }
    if (options.before) {
      filter.before = options.before.toISOString();
    }
    if (options.query) {
      filter.text = options.query;
    }

    const queryResult = await queryEmails(this.client, {
      accountId,
      limit,
      position,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const hasMore = queryResult.ids.length === limit;
    const nextPageToken = hasMore ? String(position + limit) : undefined;

    return {
      messages: emailsResult.list.map(parseJMAPEmail),
      nextPageToken,
    };
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const accountId = await this.getAccountId();
    const position = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 20;

    const queryResult = await queryEmails(this.client, {
      accountId,
      limit,
      position,
      filter: { hasAttachment: true },
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const hasMore = queryResult.ids.length === limit;
    const nextPageToken = hasMore ? String(position + limit) : undefined;

    return {
      messages: emailsResult.list.map(parseJMAPEmail),
      nextPageToken,
    };
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const accountId = await this.getAccountId();
    const position = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 20;

    const filter: Record<string, unknown> = {
      from: options.senderEmail,
    };
    if (options.after) {
      filter.after = options.after.toISOString();
    }
    if (options.before) {
      filter.before = options.before.toISOString();
    }

    const queryResult = await queryEmails(this.client, {
      accountId,
      limit,
      position,
      filter,
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const hasMore = queryResult.ids.length === limit;
    const nextPageToken = hasMore ? String(position + limit) : undefined;

    return {
      messages: emailsResult.list.map(parseJMAPEmail),
      nextPageToken,
    };
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    const { participantEmail, maxThreads = 5 } = options;
    const accountId = await this.getAccountId();

    const queryResult = await queryEmails(this.client, {
      accountId,
      limit: maxThreads * 3,
      filter: {
        operator: "OR",
        conditions: [{ from: participantEmail }, { to: participantEmail }],
      },
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const threadIds = [...new Set(emailsResult.list.map((e) => e.threadId))].slice(
      0,
      maxThreads,
    );

    return getThreadsWithMessages(this.client, { accountId, threadIds });
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const accountId = await this.getAccountId();

    const emails = await queryAndGetEmails(this.client, {
      accountId,
      mailboxId: options.labelId,
      limit: options.maxResults || 50,
    });

    const threadIds = [...new Set(emails.map((e) => e.threadId))];
    return getThreadsWithMessages(this.client, { accountId, threadIds });
  }

  async getLatestMessageInThread(threadId: string): Promise<ParsedMessage | null> {
    const thread = await this.getThread(threadId);
    if (!thread.messages.length) return null;

    const sorted = [...thread.messages].sort((a, b) => {
      const aDate = Number(a.internalDate) || 0;
      const bDate = Number(b.internalDate) || 0;
      return bDate - aDate;
    });

    return sorted[0];
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const accountId = await this.getAccountId();
    const result = await getEmails(this.client, { accountId, ids: messageIds });
    return result.list.map(parseJMAPEmail);
  }

  getAccessToken(): string {
    return this.client.getAccessToken();
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const accountId = await this.getAccountId();
    const position = options.pageToken ? parseInt(options.pageToken, 10) : 0;
    const limit = options.maxResults || 50;

    const { fromEmail, after, before, isUnread, type, labelId } = options.query || {};

    const filter: Record<string, unknown> = {};

    if (fromEmail) {
      filter.from = fromEmail;
    }
    if (after) {
      filter.after = after.toISOString();
    }
    if (before) {
      filter.before = before.toISOString();
    }
    if (isUnread) {
      filter.notKeyword = "$seen";
    }

    let mailboxId: string | null = null;
    if (labelId) {
      mailboxId = labelId;
    } else if (type) {
      const mailbox = await getMailboxByName(this.client, { accountId, name: type });
      mailboxId = mailbox?.id || null;
    }

    if (!mailboxId && !type) {
      mailboxId = await getInboxMailboxId(this.client, accountId);
    }

    const queryResult = await queryEmails(this.client, {
      accountId,
      mailboxId: mailboxId || undefined,
      limit,
      position,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const threadIds = [...new Set(emailsResult.list.map((e) => e.threadId))];
    const threads = await getThreadsWithMessages(this.client, { accountId, threadIds });

    const hasMore = queryResult.ids.length === limit;
    const nextPageToken = hasMore ? String(position + limit) : undefined;

    return { threads, nextPageToken };
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    const accountId = await this.getAccountId();
    const sentMailboxId = await getSentMailboxId(this.client, accountId);

    if (!sentMailboxId) {
      return true;
    }

    const queryResult = await queryEmails(this.client, {
      accountId,
      mailboxId: sentMailboxId,
      filter: { to: senderEmail },
      limit: 1,
    });

    return queryResult.ids.length > 0;
  }

  async countReceivedMessages(senderEmail: string, threshold: number): Promise<number> {
    const accountId = await this.getAccountId();

    const queryResult = await queryEmails(this.client, {
      accountId,
      filter: { from: senderEmail },
      limit: threshold,
    });

    return queryResult.ids.length;
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    this.logger.warn("getAttachment not yet implemented for Fastmail");
    return { data: "", size: 0 };
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const accountId = await this.getAccountId();
    const sentMailboxId = await getSentMailboxId(this.client, accountId);

    if (!sentMailboxId) {
      return false;
    }

    const email = options.from.includes("<")
      ? options.from.match(/<([^>]+)>/)?.[1] || options.from
      : options.from;
    const domain = email.split("@")[1];

    const toSenderQuery = await queryEmails(this.client, {
      accountId,
      mailboxId: sentMailboxId,
      filter: { to: email, before: options.date.toISOString() },
      limit: 1,
    });

    if (toSenderQuery.ids.length > 0) {
      return true;
    }

    if (domain) {
      const toDomainQuery = await queryEmails(this.client, {
        accountId,
        mailboxId: sentMailboxId,
        filter: { to: `@${domain}`, before: options.date.toISOString() },
        limit: 1,
      });

      if (toDomainQuery.ids.length > 0) {
        return true;
      }
    }

    return false;
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const accountId = await this.getAccountId();

    const queryResult = await queryEmails(this.client, {
      accountId,
      filter: { from: sender },
      limit,
    });

    const emailsResult = await getEmails(this.client, {
      accountId,
      ids: queryResult.ids,
    });

    const threadMap = new Map<string, { id: string; snippet: string; subject: string }>();
    for (const email of emailsResult.list) {
      if (!threadMap.has(email.threadId)) {
        threadMap.set(email.threadId, {
          id: email.threadId,
          snippet: email.preview,
          subject: email.subject || "",
        });
      }
    }

    return Array.from(threadMap.values()).slice(0, limit);
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return !!message.headers?.["in-reply-to"];
  }

  isSentMessage(message: ParsedMessage): boolean {
    return message.labelIds?.some((id) => id.toLowerCase().includes("sent")) || false;
  }

  // ============================================
  // Phase 3: Email Actions
  // ============================================

  async archiveThread(threadId: string, _ownerEmail: string): Promise<void> {
    const accountId = await this.getAccountId();
    await archiveThreadAction(this.client, { accountId, threadId });
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    const accountId = await this.getAccountId();
    await archiveThreadAction(this.client, { accountId, threadId });
    if (labelId) {
      const thread = await this.getThread(threadId);
      for (const message of thread.messages) {
        await labelEmail(this.client, { accountId, emailId: message.id, mailboxId: labelId });
      }
    }
  }

  async archiveMessage(messageId: string): Promise<void> {
    const accountId = await this.getAccountId();
    await archiveEmails(this.client, { accountId, emailIds: [messageId] });
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const accountId = await this.getAccountId();
    const inboxMailboxId = await getInboxMailboxId(this.client, accountId);

    if (!inboxMailboxId) {
      this.logger.warn("Inbox mailbox not found for bulk archive");
      return;
    }

    for (const sender of fromEmails) {
      const emails = await queryAndGetEmails(this.client, {
        accountId,
        mailboxId: inboxMailboxId,
        filter: { from: sender },
        limit: 500,
      });

      if (emails.length > 0) {
        await archiveEmails(this.client, {
          accountId,
          emailIds: emails.map((e) => e.id),
        });
      }
    }
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const accountId = await this.getAccountId();

    for (const sender of fromEmails) {
      const emails = await queryAndGetEmails(this.client, {
        accountId,
        filter: { from: sender },
        limit: 500,
      });

      if (emails.length > 0) {
        const { trashEmails } = await import("@/utils/fastmail/actions");
        await trashEmails(this.client, {
          accountId,
          emailIds: emails.map((e) => e.id),
        });
      }
    }
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    const accountId = await this.getAccountId();
    await trashThreadAction(this.client, { accountId, threadId });
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const accountId = await this.getAccountId();
    await labelEmail(this.client, {
      accountId,
      emailId: options.messageId,
      mailboxId: options.labelId,
    });
    return {};
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    const accountId = await this.getAccountId();
    await removeThreadFromMailbox(this.client, { accountId, threadId, mailboxId: labelId });
  }

  async removeThreadLabels(threadId: string, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return;
    const accountId = await this.getAccountId();
    await removeThreadFromMailboxes(this.client, { accountId, threadId, mailboxIds: labelIds });
  }

  async markSpam(threadId: string): Promise<void> {
    const accountId = await this.getAccountId();
    await markThreadAsSpam(this.client, { accountId, threadId });
  }

  async markRead(threadId: string): Promise<void> {
    const accountId = await this.getAccountId();
    await markThreadRead(this.client, { accountId, threadId, read: true });
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    const accountId = await this.getAccountId();
    await markThreadRead(this.client, { accountId, threadId, read });
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    const accountId = await this.getAccountId();
    await archiveEmails(this.client, { accountId, emailIds: [messageId] });
  }

  async createLabel(name: string, _description?: string): Promise<EmailLabel> {
    const accountId = await this.getAccountId();

    const response = await this.client.makeRequest([
      {
        methodName: "Mailbox/set",
        args: {
          accountId,
          create: {
            newMailbox: { name },
          },
        },
        id: "mailbox-create",
      },
    ]);

    const [, result] = response.methodResponses[0];
    const created = (result as { created: Record<string, { id: string }> }).created;
    const newMailbox = created?.newMailbox;

    if (!newMailbox) {
      throw new Error("Failed to create mailbox");
    }

    return {
      id: newMailbox.id,
      name,
      type: "user",
    };
  }

  async deleteLabel(labelId: string): Promise<void> {
    const accountId = await this.getAccountId();

    await this.client.makeRequest([
      {
        methodName: "Mailbox/set",
        args: {
          accountId,
          destroy: [labelId],
        },
        id: "mailbox-delete",
      },
    ]);
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    const accountId = await this.getAccountId();
    const labelName = `Inbox Zero/${key}`;

    const existingMailbox = await getMailboxByName(this.client, { accountId, name: labelName });
    if (existingMailbox) {
      return parseMailboxToLabel(existingMailbox);
    }

    return this.createLabel(labelName);
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const accountId = await this.getAccountId();
    const mailbox = await getMailboxByName(this.client, { accountId, name: folderName });

    if (!mailbox) {
      throw new Error(`Folder not found: ${folderName}`);
    }

    const thread = await this.getThread(threadId);
    for (const message of thread.messages) {
      await labelEmail(this.client, { accountId, emailId: message.id, mailboxId: mailbox.id });
    }
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    const accountId = await this.getAccountId();
    const mailbox = await getMailboxByName(this.client, { accountId, name: folderName });

    if (mailbox) {
      return mailbox.id;
    }

    const newLabel = await this.createLabel(folderName);
    return newLabel.id;
  }

  // ============================================
  // Phase 4: Send Email (not yet implemented)
  // ============================================

  async draftEmail(
    _email: ParsedMessage,
    _args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
    },
    _userEmail: string,
    _executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    throw new Error("draftEmail not yet implemented for Fastmail");
  }

  async replyToEmail(_email: ParsedMessage, _content: string): Promise<void> {
    throw new Error("replyToEmail not yet implemented for Fastmail");
  }

  async sendEmail(_args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
  }): Promise<void> {
    throw new Error("sendEmail not yet implemented for Fastmail");
  }

  async sendEmailWithHtml(_body: {
    replyToEmail?: {
      threadId: string;
      headerMessageId: string;
      references?: string;
      messageId?: string;
    };
    to: string;
    cc?: string;
    bcc?: string;
    replyTo?: string;
    subject: string;
    messageHtml: string;
    attachments?: Array<{
      filename: string;
      content: string;
      contentType: string;
    }>;
  }): Promise<{ messageId: string; threadId: string }> {
    throw new Error("sendEmailWithHtml not yet implemented for Fastmail");
  }

  async forwardEmail(
    _email: ParsedMessage,
    _args: { to: string; cc?: string; bcc?: string; content?: string },
  ): Promise<void> {
    throw new Error("forwardEmail not yet implemented for Fastmail");
  }

  async getDraft(_draftId: string): Promise<ParsedMessage | null> {
    throw new Error("getDraft not yet implemented for Fastmail");
  }

  async deleteDraft(_draftId: string): Promise<void> {
    throw new Error("deleteDraft not yet implemented for Fastmail");
  }

  async sendDraft(_draftId: string): Promise<{ messageId: string; threadId: string }> {
    throw new Error("sendDraft not yet implemented for Fastmail");
  }

  async createDraft(_params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    throw new Error("createDraft not yet implemented for Fastmail");
  }

  async updateDraft(
    _draftId: string,
    _params: { messageHtml?: string; subject?: string },
  ): Promise<void> {
    throw new Error("updateDraft not yet implemented for Fastmail");
  }

  // ============================================
  // Filters (not yet implemented)
  // ============================================

  async getFiltersList(): Promise<EmailFilter[]> {
    this.logger.warn("getFiltersList not supported for Fastmail");
    return [];
  }

  async createFilter(_options: {
    from: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }): Promise<{ status: number }> {
    throw new Error("createFilter not yet implemented for Fastmail");
  }

  async deleteFilter(_id: string): Promise<{ status: number }> {
    throw new Error("deleteFilter not yet implemented for Fastmail");
  }

  async createAutoArchiveFilter(_options: {
    from: string;
    gmailLabelId?: string;
    labelName?: string;
  }): Promise<{ status: number }> {
    throw new Error("createAutoArchiveFilter not yet implemented for Fastmail");
  }

  // ============================================
  // Watch/Push notifications (not yet implemented)
  // ============================================

  async processHistory(_options: {
    emailAddress: string;
    historyId?: number;
    startHistoryId?: number;
    subscriptionId?: string;
    resourceData?: { id: string; conversationId?: string };
    logger?: Logger;
  }): Promise<void> {
    this.logger.warn("processHistory not supported for Fastmail");
  }

  async watchEmails(): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
  } | null> {
    this.logger.warn("watchEmails not supported for Fastmail");
    return null;
  }

  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    this.logger.warn("unwatchEmails not supported for Fastmail");
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessageByRfc822MessageId(originalMessageId);
  }

  async getSignatures(): Promise<EmailSignature[]> {
    this.logger.warn("getSignatures not yet implemented for Fastmail");
    return [];
  }
}
