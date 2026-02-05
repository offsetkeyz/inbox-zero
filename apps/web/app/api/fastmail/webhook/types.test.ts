import { describe, it, expect } from "vitest";
import {
  pushVerificationSchema,
  stateChangeSchema,
  webhookPayloadSchema,
} from "./types";

describe("Fastmail webhook types", () => {
  describe("pushVerificationSchema", () => {
    it("parses valid verification payload", () => {
      const payload = {
        "@type": "PushVerification",
        pushSubscriptionId: "sub123",
        verificationCode: "abc123",
      };
      const result = pushVerificationSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects invalid verification payload", () => {
      const payload = {
        "@type": "StateChange",
        pushSubscriptionId: "sub123",
      };
      const result = pushVerificationSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("stateChangeSchema", () => {
    it("parses valid state change payload", () => {
      const payload = {
        "@type": "StateChange",
        changed: {
          accountId123: {
            Email: "newStateString123",
          },
        },
      };
      const result = stateChangeSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects verification payload", () => {
      const payload = {
        "@type": "PushVerification",
        changed: {},
      };
      const result = stateChangeSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe("webhookPayloadSchema", () => {
    it("discriminates verification from state change", () => {
      const verification = {
        "@type": "PushVerification",
        pushSubscriptionId: "sub123",
        verificationCode: "abc123",
      };
      const stateChange = {
        "@type": "StateChange",
        changed: { acc1: { Email: "state1" } },
      };

      const verificationResult = webhookPayloadSchema.safeParse(verification);
      const stateChangeResult = webhookPayloadSchema.safeParse(stateChange);

      expect(verificationResult.success).toBe(true);
      expect(stateChangeResult.success).toBe(true);
    });
  });
});
