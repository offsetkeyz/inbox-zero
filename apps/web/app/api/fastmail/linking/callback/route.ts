import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import {
  FASTMAIL_LINKING_STATE_COOKIE_NAME,
  FASTMAIL_OAUTH_TOKEN_URL,
} from "@/utils/fastmail/constants";
import { withError } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { validateOAuthCallback } from "@/utils/oauth/callback-validation";
import { handleAccountLinking } from "@/utils/oauth/account-linking";
import { mergeAccount } from "@/utils/user/merge-account";
import { handleOAuthCallbackError } from "@/utils/oauth/error-handler";
import {
  acquireOAuthCodeLock,
  getOAuthCodeResult,
  setOAuthCodeResult,
  clearOAuthCode,
} from "@/utils/redis/oauth-code";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { createFastmailClient } from "@/utils/fastmail/client";

export const GET = withError("fastmail/linking/callback", async (request) => {
  const logger = request.logger;

  if (!env.FASTMAIL_CLIENT_ID || !env.FASTMAIL_CLIENT_SECRET) {
    throw new SafeError("Fastmail OAuth not enabled");
  }

  const searchParams = request.nextUrl.searchParams;
  const storedState = request.cookies.get(
    FASTMAIL_LINKING_STATE_COOKIE_NAME,
  )?.value;

  const validation = validateOAuthCallback({
    code: searchParams.get("code"),
    receivedState: searchParams.get("state"),
    storedState,
    stateCookieName: FASTMAIL_LINKING_STATE_COOKIE_NAME,
    logger,
  });

  if (!validation.success) {
    return validation.response;
  }

  const { targetUserId, code } = validation;

  const cachedResult = await getOAuthCodeResult(code);
  if (cachedResult) {
    logger.info("OAuth code already processed, returning cached result", {
      targetUserId,
    });
    const redirectUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
    for (const [key, value] of Object.entries(cachedResult.params)) {
      redirectUrl.searchParams.set(key, value);
    }
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);
    return response;
  }

  const acquiredLock = await acquireOAuthCodeLock(code);
  if (!acquiredLock) {
    logger.info("OAuth code is being processed by another request", {
      targetUserId,
    });
    const redirectUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);
    return response;
  }

  try {
    const tokenResponse = await fetch(FASTMAIL_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.FASTMAIL_CLIENT_ID,
        client_secret: env.FASTMAIL_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: `${env.NEXT_PUBLIC_BASE_URL}/api/fastmail/linking/callback`,
      }),
    });

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) {
      logger.error("Failed to exchange code for tokens", {
        error: tokens.error_description || tokens.error,
      });
      throw new Error(
        tokens.error_description ||
          tokens.error ||
          "Failed to exchange code for tokens",
      );
    }

    const client = createFastmailClient(tokens.access_token, logger);
    const session = await client.getSession();
    const providerAccountId = await client.getAccountId();
    const providerEmail = session.username;

    if (!providerAccountId || !providerEmail) {
      throw new Error("Session missing required account ID or email");
    }

    const accountName = session.accounts[providerAccountId]?.name || null;

    const existingAccount = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: "fastmail",
          providerAccountId,
        },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { name: true, email: true } },
        emailAccount: true,
      },
    });

    const linkingResult = await handleAccountLinking({
      existingAccountId: existingAccount?.id || null,
      hasEmailAccount: !!existingAccount?.emailAccount,
      existingUserId: existingAccount?.userId || null,
      targetUserId,
      provider: "fastmail",
      providerEmail,
      logger,
    });

    if (linkingResult.type === "redirect") {
      linkingResult.response.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);
      return linkingResult.response;
    }

    if (linkingResult.type === "continue_create") {
      logger.info("Creating new Fastmail account and linking to current user", {
        email: providerEmail,
        targetUserId,
      });

      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;

      try {
        const newAccount = await prisma.account.create({
          data: {
            userId: targetUserId,
            type: "oidc",
            provider: "fastmail",
            providerAccountId,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || null,
            expires_at: expiresAt,
            scope: tokens.scope || null,
            token_type: tokens.token_type || "Bearer",
            emailAccount: {
              create: {
                email: providerEmail,
                userId: targetUserId,
                name: accountName,
                image: null,
                jmapAccountId: providerAccountId,
              },
            },
          },
        });

        logger.info("Successfully created and linked new Fastmail account", {
          email: providerEmail,
          targetUserId,
          accountId: newAccount.id,
        });
      } catch (createError: unknown) {
        if (isDuplicateError(createError)) {
          const accountNow = await prisma.account.findUnique({
            where: {
              provider_providerAccountId: {
                provider: "fastmail",
                providerAccountId,
              },
            },
            select: { id: true, userId: true },
          });

          if (accountNow?.userId === targetUserId) {
            logger.info(
              "Account already exists for same user, updating tokens",
              {
                targetUserId,
                providerAccountId,
                accountId: accountNow.id,
              },
            );

            await updateFastmailAccountTokens(accountNow.id, tokens);

            // Ensure jmapAccountId is set (may have been missing from older accounts)
            const emailAccount = await prisma.emailAccount.findUnique({
              where: { accountId: accountNow.id },
              select: { id: true, jmapAccountId: true },
            });
            if (emailAccount && !emailAccount.jmapAccountId) {
              await prisma.emailAccount.update({
                where: { id: emailAccount.id },
                data: { jmapAccountId: providerAccountId },
              });
              logger.info("Backfilled jmapAccountId for existing account", {
                emailAccountId: emailAccount.id,
              });
            }
          } else {
            throw createError;
          }
        } else {
          throw createError;
        }
      }

      await setOAuthCodeResult(code, { success: "account_created_and_linked" });

      const successUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
      successUrl.searchParams.set("success", "account_created_and_linked");
      const successResponse = NextResponse.redirect(successUrl);
      successResponse.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);

      return successResponse;
    }

    if (linkingResult.type === "update_tokens") {
      logger.info("Updating tokens for existing Fastmail account", {
        email: providerEmail,
        targetUserId,
        accountId: linkingResult.existingAccountId,
      });

      await updateFastmailAccountTokens(
        linkingResult.existingAccountId,
        tokens,
      );

      // Ensure jmapAccountId is set (may have been missing from older accounts)
      const emailAccount = await prisma.emailAccount.findUnique({
        where: { accountId: linkingResult.existingAccountId },
        select: { id: true, jmapAccountId: true },
      });
      if (emailAccount && !emailAccount.jmapAccountId) {
        await prisma.emailAccount.update({
          where: { id: emailAccount.id },
          data: { jmapAccountId: providerAccountId },
        });
        logger.info("Backfilled jmapAccountId for existing account", {
          emailAccountId: emailAccount.id,
        });
      }

      logger.info("Successfully updated tokens for Fastmail account", {
        email: providerEmail,
        targetUserId,
        accountId: linkingResult.existingAccountId,
      });

      await setOAuthCodeResult(code, { success: "tokens_updated" });

      const successUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
      successUrl.searchParams.set("success", "tokens_updated");
      const successResponse = NextResponse.redirect(successUrl);
      successResponse.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);

      return successResponse;
    }

    logger.info("Merging Fastmail account (user confirmed).", {
      email: providerEmail,
      targetUserId,
    });

    const mergeType = await mergeAccount({
      sourceAccountId: linkingResult.sourceAccountId,
      sourceUserId: linkingResult.sourceUserId,
      targetUserId,
      email: providerEmail,
      name: existingAccount?.user.name || null,
      logger,
    });

    const successMessage =
      mergeType === "full_merge"
        ? "account_merged"
        : "account_created_and_linked";

    logger.info("Account re-assigned to user.", {
      email: providerEmail,
      targetUserId,
      sourceUserId: linkingResult.sourceUserId,
      mergeType,
    });

    await setOAuthCodeResult(code, { success: successMessage });

    const successUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
    successUrl.searchParams.set("success", successMessage);
    const successResponse = NextResponse.redirect(successUrl);
    successResponse.cookies.delete(FASTMAIL_LINKING_STATE_COOKIE_NAME);

    return successResponse;
  } catch (error) {
    await clearOAuthCode(code);

    const errorUrl = new URL("/accounts", env.NEXT_PUBLIC_BASE_URL);
    return handleOAuthCallbackError({
      error,
      redirectUrl: errorUrl,
      stateCookieName: FASTMAIL_LINKING_STATE_COOKIE_NAME,
      logger,
    });
  }
});

interface FastmailTokens {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
  scope?: string | null;
  token_type?: string | null;
}

async function updateFastmailAccountTokens(
  accountId: string,
  tokens: FastmailTokens,
) {
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

  await prisma.account.update({
    where: { id: accountId },
    data: {
      access_token: tokens.access_token,
      ...(tokens.refresh_token != null && {
        refresh_token: tokens.refresh_token,
      }),
      expires_at: expiresAt,
      scope: tokens.scope,
      token_type: tokens.token_type,
    },
  });
}
