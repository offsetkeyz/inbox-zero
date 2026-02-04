import type { FastmailClient } from "@/utils/fastmail/client";
import type {
  JMAPIdentity,
  JMAPGetResponse,
  JMAPSetResponse,
} from "@/utils/fastmail/types";
import { getSentMailboxId, getDraftsMailboxId } from "@/utils/fastmail/mailbox";

export async function getIdentities(
  client: FastmailClient,
  options: {
    accountId: string;
  },
): Promise<JMAPGetResponse<JMAPIdentity>> {
  const { accountId } = options;

  const response = await client.makeRequest([
    {
      methodName: "Identity/get",
      args: {
        accountId,
      },
      id: "identity-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  return result as unknown as JMAPGetResponse<JMAPIdentity>;
}

export async function getPrimaryIdentity(
  client: FastmailClient,
  options: {
    accountId: string;
  },
): Promise<JMAPIdentity | null> {
  const identities = await getIdentities(client, options);
  return identities.list[0] || null;
}

export async function createEmailForSending(
  client: FastmailClient,
  options: {
    accountId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    textBody?: string;
    htmlBody?: string;
    inReplyTo?: string;
    references?: string;
    replyToMessageId?: string;
  },
): Promise<{ emailId: string; threadId?: string }> {
  const {
    accountId,
    to,
    cc,
    bcc,
    subject,
    textBody,
    htmlBody,
    inReplyTo,
    references,
  } = options;

  const identity = await getPrimaryIdentity(client, { accountId });
  if (!identity) {
    throw new Error("No identity found for sending email");
  }

  const sentMailboxId = await getSentMailboxId(client, accountId);
  if (!sentMailboxId) {
    throw new Error("Sent mailbox not found");
  }

  const bodyValue: Record<string, { value: string; charset: string }> = {};
  const bodyParts: Array<{ partId: string; type: string }> = [];

  if (textBody) {
    bodyValue["text"] = { value: textBody, charset: "utf-8" };
    bodyParts.push({ partId: "text", type: "text/plain" });
  }

  if (htmlBody) {
    bodyValue["html"] = { value: htmlBody, charset: "utf-8" };
    bodyParts.push({ partId: "html", type: "text/html" });
  }

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [sentMailboxId]: true },
    from: [{ email: identity.email, name: identity.name }],
    to: to.map((email) => ({ email })),
    subject,
    bodyValues: bodyValue,
    textBody: textBody ? [{ partId: "text", type: "text/plain" }] : undefined,
    htmlBody: htmlBody ? [{ partId: "html", type: "text/html" }] : undefined,
    keywords: { $seen: true },
  };

  if (cc && cc.length > 0) {
    emailCreate.cc = cc.map((email) => ({ email }));
  }

  if (bcc && bcc.length > 0) {
    emailCreate.bcc = bcc.map((email) => ({ email }));
  }

  if (inReplyTo) {
    emailCreate.inReplyTo = [inReplyTo];
  }

  if (references) {
    emailCreate.references = references.split(" ").filter(Boolean);
  }

  const response = await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        create: {
          draft: emailCreate,
        },
      },
      id: "email-create",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const setResponse = result as unknown as JMAPSetResponse;

  if (setResponse.notCreated?.draft) {
    throw new Error(
      `Failed to create email: ${setResponse.notCreated.draft.type}`,
    );
  }

  const created = setResponse.created as Record<
    string,
    { id: string; threadId?: string }
  >;
  const createdEmail = created?.draft;

  if (!createdEmail) {
    throw new Error("Email was not created");
  }

  return {
    emailId: createdEmail.id,
    threadId: createdEmail.threadId,
  };
}

export async function submitEmail(
  client: FastmailClient,
  options: {
    accountId: string;
    emailId: string;
    identityId: string;
  },
): Promise<void> {
  const { accountId, emailId, identityId } = options;

  const response = await client.makeRequest([
    {
      methodName: "EmailSubmission/set",
      args: {
        accountId,
        create: {
          submission: {
            emailId,
            identityId,
          },
        },
      },
      id: "submission-set",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const setResponse = result as unknown as JMAPSetResponse;

  if (setResponse.notCreated?.submission) {
    throw new Error(
      `Failed to submit email: ${setResponse.notCreated.submission.type}`,
    );
  }
}

export async function sendEmail(
  client: FastmailClient,
  options: {
    accountId: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
  },
): Promise<{ messageId: string; threadId: string }> {
  const { accountId, to, cc, bcc, subject, textBody, htmlBody } = options;

  const identity = await getPrimaryIdentity(client, { accountId });
  if (!identity) {
    throw new Error("No identity found for sending email");
  }

  const toAddresses = to.split(",").map((e) => e.trim()).filter(Boolean);
  const ccAddresses = cc?.split(",").map((e) => e.trim()).filter(Boolean);
  const bccAddresses = bcc?.split(",").map((e) => e.trim()).filter(Boolean);

  const { emailId, threadId } = await createEmailForSending(client, {
    accountId,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    subject,
    textBody,
    htmlBody,
  });

  await submitEmail(client, {
    accountId,
    emailId,
    identityId: identity.id,
  });

  return {
    messageId: emailId,
    threadId: threadId || emailId,
  };
}

export async function sendReply(
  client: FastmailClient,
  options: {
    accountId: string;
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    textBody?: string;
    htmlBody?: string;
    inReplyTo: string;
    references?: string;
  },
): Promise<{ messageId: string; threadId: string }> {
  const {
    accountId,
    to,
    cc,
    bcc,
    subject,
    textBody,
    htmlBody,
    inReplyTo,
    references,
  } = options;

  const identity = await getPrimaryIdentity(client, { accountId });
  if (!identity) {
    throw new Error("No identity found for sending email");
  }

  const toAddresses = to.split(",").map((e) => e.trim()).filter(Boolean);
  const ccAddresses = cc?.split(",").map((e) => e.trim()).filter(Boolean);
  const bccAddresses = bcc?.split(",").map((e) => e.trim()).filter(Boolean);

  const { emailId, threadId } = await createEmailForSending(client, {
    accountId,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    subject,
    textBody,
    htmlBody,
    inReplyTo,
    references,
  });

  await submitEmail(client, {
    accountId,
    emailId,
    identityId: identity.id,
  });

  return {
    messageId: emailId,
    threadId: threadId || emailId,
  };
}

export async function createDraft(
  client: FastmailClient,
  options: {
    accountId: string;
    to: string;
    subject: string;
    htmlBody: string;
    inReplyTo?: string;
    references?: string;
  },
): Promise<{ draftId: string }> {
  const { accountId, to, subject, htmlBody, inReplyTo, references } = options;

  const identity = await getPrimaryIdentity(client, { accountId });
  if (!identity) {
    throw new Error("No identity found");
  }

  const draftsMailboxId = await getDraftsMailboxId(client, accountId);
  if (!draftsMailboxId) {
    throw new Error("Drafts mailbox not found");
  }

  const toAddresses = to.split(",").map((e) => e.trim()).filter(Boolean);

  const emailCreate: Record<string, unknown> = {
    mailboxIds: { [draftsMailboxId]: true },
    from: [{ email: identity.email, name: identity.name }],
    to: toAddresses.map((email) => ({ email })),
    subject,
    bodyValues: {
      html: { value: htmlBody, charset: "utf-8" },
    },
    htmlBody: [{ partId: "html", type: "text/html" }],
    keywords: { $draft: true },
  };

  if (inReplyTo) {
    emailCreate.inReplyTo = [inReplyTo];
  }

  if (references) {
    emailCreate.references = references.split(" ").filter(Boolean);
  }

  const response = await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        create: {
          draft: emailCreate,
        },
      },
      id: "draft-create",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const setResponse = result as unknown as JMAPSetResponse;

  if (setResponse.notCreated?.draft) {
    throw new Error(
      `Failed to create draft: ${setResponse.notCreated.draft.type}`,
    );
  }

  const created = setResponse.created as Record<string, { id: string }>;
  const createdDraft = created?.draft;

  if (!createdDraft) {
    throw new Error("Draft was not created");
  }

  return { draftId: createdDraft.id };
}

export async function updateDraft(
  client: FastmailClient,
  options: {
    accountId: string;
    draftId: string;
    htmlBody?: string;
    subject?: string;
  },
): Promise<void> {
  const { accountId, draftId, htmlBody, subject } = options;

  const updates: Record<string, unknown> = {};

  if (htmlBody !== undefined) {
    updates.bodyValues = {
      html: { value: htmlBody, charset: "utf-8" },
    };
    updates.htmlBody = [{ partId: "html", type: "text/html" }];
  }

  if (subject !== undefined) {
    updates.subject = subject;
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  const response = await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        update: {
          [draftId]: updates,
        },
      },
      id: "draft-update",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const setResponse = result as unknown as JMAPSetResponse;

  if (setResponse.notUpdated?.[draftId]) {
    throw new Error(
      `Failed to update draft: ${setResponse.notUpdated[draftId].type}`,
    );
  }
}

export async function deleteDraft(
  client: FastmailClient,
  options: {
    accountId: string;
    draftId: string;
  },
): Promise<void> {
  const { accountId, draftId } = options;

  await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        destroy: [draftId],
      },
      id: "draft-delete",
    },
  ]);
}

export async function sendDraft(
  client: FastmailClient,
  options: {
    accountId: string;
    draftId: string;
  },
): Promise<{ messageId: string; threadId: string }> {
  const { accountId, draftId } = options;

  const identity = await getPrimaryIdentity(client, { accountId });
  if (!identity) {
    throw new Error("No identity found for sending email");
  }

  const sentMailboxId = await getSentMailboxId(client, accountId);
  const draftsMailboxId = await getDraftsMailboxId(client, accountId);

  if (!sentMailboxId) {
    throw new Error("Sent mailbox not found");
  }

  const mailboxUpdate: Record<string, boolean | null> = {
    [`mailboxIds/${sentMailboxId}`]: true,
  };
  if (draftsMailboxId) {
    mailboxUpdate[`mailboxIds/${draftsMailboxId}`] = null;
  }

  await client.makeRequest([
    {
      methodName: "Email/set",
      args: {
        accountId,
        update: {
          [draftId]: {
            ...mailboxUpdate,
            "keywords/$draft": null,
            "keywords/$seen": true,
          },
        },
      },
      id: "draft-move",
    },
  ]);

  await submitEmail(client, {
    accountId,
    emailId: draftId,
    identityId: identity.id,
  });

  return {
    messageId: draftId,
    threadId: draftId,
  };
}
