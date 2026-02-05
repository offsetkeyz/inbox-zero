import { env } from "@/env";
import { JMAP_SCOPES } from "@/utils/fastmail/scopes";
import { FASTMAIL_OAUTH_AUTHORIZE_URL } from "@/utils/fastmail/constants";

export function getFastmailOAuthUrl(state: string): string {
  if (!env.FASTMAIL_CLIENT_ID) {
    throw new Error("FASTMAIL_CLIENT_ID is not configured");
  }

  const params = new URLSearchParams({
    client_id: env.FASTMAIL_CLIENT_ID,
    redirect_uri: `${env.NEXT_PUBLIC_BASE_URL}/api/fastmail/linking/callback`,
    response_type: "code",
    scope: JMAP_SCOPES.join(" "),
    state,
  });

  return `${FASTMAIL_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}
