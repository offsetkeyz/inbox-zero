import * as Sentry from "@sentry/nextjs";
import prisma from "@/utils/prisma";
import { captureException } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { markMessageAsProcessing } from "@/utils/redis/message-processing";
import type { StateChange } from "./types";
import type { Logger } from "@/utils/logger";

export async function processStateChange(
  body: StateChange,
  baseLogger: Logger,
): Promise<void> {
  for (const [jmapAccountId, changes] of Object.entries(body.changed)) {
    const newEmailState = changes.Email;
    if (!newEmailState) {
      baseLogger.info("No Email state change, skipping", { jmapAccountId });
      continue;
    }

    const logger = baseLogger.with({ jmapAccountId });

    const emailAccount = await getWebhookEmailAccount(
      { jmapAccountId },
      logger,
    );

    if (!emailAccount) {
      logger.warn("Webhook received for unknown JMAP accountId");
      continue;
    }

    const accountLogger = logger.with({
      email: emailAccount.email,
      emailAccountId: emailAccount.id,
    });

    const validation = await validateWebhookAccount(
      emailAccount,
      accountLogger,
    );

    if (!validation.success) {
      // Validation function already logs the specific reason
      continue;
    }

    const {
      emailAccount: validatedEmailAccount,
      hasAutomationRules,
      hasAiAccess,
    } = validation.data;

    Sentry.setTag("emailAccountId", validatedEmailAccount.id);
    Sentry.setUser({
      id: validatedEmailAccount.userId,
      email: validatedEmailAccount.email,
    });

    const provider = await createEmailProvider({
      emailAccountId: validatedEmailAccount.id,
      provider: "fastmail",
      logger: accountLogger,
    });

    try {
      // Get changed emails since last known state
      const { created, newState } = await provider.getEmailChanges(
        validatedEmailAccount.lastSyncedJmapState ?? undefined,
        newEmailState,
      );

      accountLogger.info("Email changes fetched", {
        createdCount: created.length,
        oldState: validatedEmailAccount.lastSyncedJmapState,
        newState,
      });

      // Process each new email sequentially
      for (const email of created) {
        const messageLogger = accountLogger.with({
          messageId: email.id,
          threadId: email.threadId,
        });

        // Skip messages not in inbox or sent
        const isInInbox = email.labelIds?.includes("INBOX") || false;
        const isInSent = email.labelIds?.includes("SENT") || false;

        if (!isInInbox && !isInSent) {
          messageLogger.info("Skipping message not in inbox or sent", {
            labelIds: email.labelIds,
          });
          continue;
        }

        // Acquire processing lock
        const isFree = await markMessageAsProcessing({
          userEmail: validatedEmailAccount.email,
          messageId: email.id,
        });

        if (!isFree) {
          messageLogger.info("Skipping. Message already being processed.");
          continue;
        }

        await processHistoryItem(
          {
            messageId: email.id,
            threadId: email.threadId,
            message: email,
          },
          {
            provider,
            emailAccount: {
              ...validatedEmailAccount,
              account: { provider: "fastmail" },
            },
            hasAutomationRules,
            hasAiAccess,
            rules: validatedEmailAccount.rules,
            logger: messageLogger,
          },
        );
      }

      // Update state after successful processing
      await prisma.emailAccount.update({
        where: { id: validatedEmailAccount.id },
        data: { lastSyncedJmapState: newState },
      });

      accountLogger.info("State updated after processing", { newState });
    } catch (error) {
      // Check for JMAP cannotCalculateChanges error
      if (
        error instanceof Error &&
        error.message.includes("cannotCalculateChanges")
      ) {
        accountLogger.warn(
          "State too old, full resync needed (not implemented)",
          { error },
        );
        // TODO: Implement full resync fallback in future PR
        continue;
      }

      captureException(error, {
        emailAccountId: validatedEmailAccount.id,
        userEmail: validatedEmailAccount.email,
        extra: { jmapAccountId, newEmailState },
      });

      accountLogger.error("Error processing state change", {
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error,
      });
      // Don't update state - will retry on next webhook
    }
  }
}
