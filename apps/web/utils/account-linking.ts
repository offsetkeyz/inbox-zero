import type { GetAuthLinkUrlResponse } from "@/app/api/google/linking/auth-url/route";
import type { GetOutlookAuthLinkUrlResponse } from "@/app/api/outlook/linking/auth-url/route";
import type { GetFastmailAuthLinkUrlResponse } from "@/app/api/fastmail/linking/auth-url/route";
import { isGoogleProvider, isFastmailProvider } from "@/utils/email/provider-types";

/**
 * Initiates the OAuth account linking flow for Google, Microsoft, or Fastmail.
 * Returns the OAuth URL to redirect the user to.
 * @throws Error if the request fails
 */
export async function getAccountLinkingUrl(
  provider: "google" | "microsoft" | "fastmail",
): Promise<string> {
  let apiProvider: string;
  if (provider === "microsoft") {
    apiProvider = "outlook";
  } else if (provider === "fastmail") {
    apiProvider = "fastmail";
  } else {
    apiProvider = "google";
  }

  const response = await fetch(`/api/${apiProvider}/linking/auth-url`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    let providerName: string;
    if (isGoogleProvider(provider)) {
      providerName = "Google";
    } else if (isFastmailProvider(provider)) {
      providerName = "Fastmail";
    } else {
      providerName = "Microsoft";
    }
    throw new Error(`Failed to initiate ${providerName} account linking`);
  }

  const data:
    | GetAuthLinkUrlResponse
    | GetOutlookAuthLinkUrlResponse
    | GetFastmailAuthLinkUrlResponse = await response.json();

  return data.url;
}
