import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { withError } from "@/utils/middleware";
import { webhookPayloadSchema } from "@/app/api/fastmail/webhook/types";
import { processStateChange } from "@/app/api/fastmail/webhook/process-history";

export const maxDuration = 300;

export const POST = withError("fastmail/webhook", async (request) => {
  const logger = request.logger;

  // Verify token
  const token = new URL(request.url).searchParams.get("token");
  if (token !== env.FASTMAIL_WEBHOOK_VERIFICATION_TOKEN) {
    logger.warn("Invalid webhook token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const rawBody = await request.json();

  // Validate payload
  const parseResult = webhookPayloadSchema.safeParse(rawBody);

  if (!parseResult.success) {
    logger.error("Invalid webhook payload", {
      body: rawBody,
      errors: parseResult.error.errors,
    });
    return NextResponse.json(
      {
        error: "Invalid webhook payload",
        details: parseResult.error.errors,
      },
      { status: 400 },
    );
  }

  const body = parseResult.data;

  // Handle verification request
  if (body["@type"] === "PushVerification") {
    logger.info("Received push verification request", {
      pushSubscriptionId: body.pushSubscriptionId,
    });
    return NextResponse.json({ verificationCode: body.verificationCode });
  }

  // Handle state change
  if (body["@type"] === "StateChange") {
    logger.info("Received state change notification", {
      accountCount: Object.keys(body.changed).length,
    });

    // Process asynchronously to respond quickly
    after(() => processStateChange(body, logger));
  }

  return NextResponse.json({ ok: true });
});
