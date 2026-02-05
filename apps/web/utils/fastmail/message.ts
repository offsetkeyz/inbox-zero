import type { FastmailClient } from "@/utils/fastmail/client";
import type {
  JMAPEmail,
  JMAPGetResponse,
  JMAPQueryResponse,
} from "@/utils/fastmail/types";
import type { ParsedMessage, ParsedMessageHeaders } from "@/utils/types";

const EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "headers",
];

const BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset"];

export async function queryEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    mailboxId?: string;
    limit?: number;
    position?: number;
    filter?: Record<string, unknown>;
    sort?: Array<{ property: string; isAscending: boolean }>;
  },
): Promise<JMAPQueryResponse> {
  const {
    accountId,
    mailboxId,
    limit = 50,
    position = 0,
    filter,
    sort,
  } = options;

  const queryFilter = mailboxId
    ? { inMailbox: mailboxId, ...filter }
    : filter || {};

  const response = await client.makeRequest([
    {
      methodName: "Email/query",
      args: {
        accountId,
        filter: queryFilter,
        sort: sort || [{ property: "receivedAt", isAscending: false }],
        position,
        limit,
        collapseThreads: true,
      },
      id: "email-query",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPQueryResponse;
}

export async function getEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    ids: string[];
  },
): Promise<JMAPGetResponse<JMAPEmail>> {
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
      methodName: "Email/get",
      args: {
        accountId,
        ids,
        properties: EMAIL_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 1024 * 1024,
        bodyProperties: BODY_PROPERTIES,
      },
      id: "email-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPGetResponse<JMAPEmail>;
}

export async function getEmail(
  client: FastmailClient,
  options: {
    accountId: string;
    id: string;
  },
): Promise<JMAPEmail | null> {
  const result = await getEmails(client, {
    accountId: options.accountId,
    ids: [options.id],
  });

  return result.list[0] || null;
}

export function parseJMAPEmail(email: JMAPEmail): ParsedMessage {
  const from = email.from?.[0];
  const to = email.to || [];
  const cc = email.cc || [];
  const bcc = email.bcc || [];
  const replyTo = email.replyTo?.[0];

  const formatAddress = (addr: { name: string | null; email: string }) =>
    addr.name ? `${addr.name} <${addr.email}>` : addr.email;

  const formatAddressList = (
    addrs: Array<{ name: string | null; email: string }>,
  ) => addrs.map(formatAddress).join(", ");

  let textPlain: string | undefined;
  let textHtml: string | undefined;

  if (email.bodyValues) {
    const textPartId = email.textBody?.[0]?.partId;
    const htmlPartId = email.htmlBody?.[0]?.partId;

    if (textPartId && email.bodyValues[textPartId]) {
      textPlain = email.bodyValues[textPartId].value;
    }
    if (htmlPartId && email.bodyValues[htmlPartId]) {
      textHtml = email.bodyValues[htmlPartId].value;
    }
  }

  const headers: ParsedMessageHeaders = {
    subject: email.subject || "",
    from: from ? formatAddress(from) : "",
    to: formatAddressList(to),
    cc: cc.length > 0 ? formatAddressList(cc) : undefined,
    bcc: bcc.length > 0 ? formatAddressList(bcc) : undefined,
    date: email.sentAt || email.receivedAt,
    "message-id": email.messageId?.[0],
    "reply-to": replyTo ? formatAddress(replyTo) : undefined,
    "in-reply-to": email.inReplyTo?.[0],
    references: email.references?.join(" "),
  };

  const attachments = (email.attachments || []).map((att) => ({
    filename: att.name || "attachment",
    mimeType: att.type,
    size: att.size,
    attachmentId: att.blobId,
    headers: {
      "content-type": att.type,
      "content-description": att.name || "",
      "content-transfer-encoding": "base64",
      "content-id": att.cid || "",
    },
  }));

  const labelIds = Object.keys(email.mailboxIds || {}).filter(
    (id) => email.mailboxIds[id],
  );

  const isRead = email.keywords?.$seen === true;
  if (!isRead) {
    labelIds.push("UNREAD");
  }

  return {
    id: email.id,
    threadId: email.threadId,
    labelIds,
    snippet: email.preview,
    historyId: "",
    attachments: attachments.length > 0 ? attachments : undefined,
    inline: [],
    headers,
    textPlain,
    textHtml,
    subject: email.subject || "",
    date: email.sentAt || email.receivedAt,
    internalDate: email.receivedAt
      ? new Date(email.receivedAt).getTime().toString()
      : null,
  };
}

export async function queryAndGetEmails(
  client: FastmailClient,
  options: {
    accountId: string;
    mailboxId?: string;
    limit?: number;
    position?: number;
    filter?: Record<string, unknown>;
    sort?: Array<{ property: string; isAscending: boolean }>;
  },
): Promise<ParsedMessage[]> {
  const queryResult = await queryEmails(client, options);

  if (queryResult.ids.length === 0) {
    return [];
  }

  const emailsResult = await getEmails(client, {
    accountId: options.accountId,
    ids: queryResult.ids,
  });

  return emailsResult.list.map(parseJMAPEmail);
}
