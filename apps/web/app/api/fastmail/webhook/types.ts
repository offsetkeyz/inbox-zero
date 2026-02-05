import { z } from "zod";

// JMAP Push Verification payload
// Sent when a new PushSubscription is created to verify the webhook URL
export const pushVerificationSchema = z.object({
  "@type": z.literal("PushVerification"),
  pushSubscriptionId: z.string(),
  verificationCode: z.string(),
});

export type PushVerification = z.infer<typeof pushVerificationSchema>;

// JMAP StateChange payload
// Sent when Email state changes (new emails, updates, deletions)
export const stateChangeSchema = z.object({
  "@type": z.literal("StateChange"),
  changed: z.record(
    z.string(), // accountId
    z.record(z.string(), z.string()), // { Email: newState, Mailbox: newState, etc. }
  ),
});

export type StateChange = z.infer<typeof stateChangeSchema>;

// Discriminated union of all webhook payload types
export const webhookPayloadSchema = z.discriminatedUnion("@type", [
  pushVerificationSchema,
  stateChangeSchema,
]);

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
