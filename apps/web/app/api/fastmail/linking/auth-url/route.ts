import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getFastmailOAuthUrl } from "@/utils/fastmail/oauth";
import { FASTMAIL_LINKING_STATE_COOKIE_NAME } from "@/utils/fastmail/constants";
import {
  generateOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";

export type GetFastmailAuthLinkUrlResponse = { url: string };

const getAuthUrl = ({ userId }: { userId: string }) => {
  const state = generateOAuthState({ userId });
  const url = getFastmailOAuthUrl(state);

  return { url, state };
};

export const GET = withAuth("fastmail/linking/auth-url", async (request) => {
  const userId = request.auth.userId;
  const { url: authUrl, state } = getAuthUrl({ userId });

  const response = NextResponse.json({ url: authUrl });

  response.cookies.set(
    FASTMAIL_LINKING_STATE_COOKIE_NAME,
    state,
    oauthStateCookieOptions,
  );

  return response;
});
