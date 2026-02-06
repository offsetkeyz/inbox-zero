import type { FastmailClient } from "./client";
import type { SieveScript, SieveScriptSetResponse } from "./types";

export async function getSieveScript(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const response = await client.makeRequest([
    {
      methodName: "SieveScript/get",
      args: {
        accountId,
        ids: null,
      },
      id: "sieve-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const scripts = (result as { list: SieveScript[] }).list;

  const activeScript = scripts.find((s) => s.isActive);

  return activeScript?.content ?? null;
}

export async function setSieveScript(
  client: FastmailClient,
  accountId: string,
  content: string,
): Promise<void> {
  const currentScriptId = await getCurrentScriptId(client, accountId);

  if (currentScriptId) {
    // Update existing script
    const response = await client.makeRequest([
      {
        methodName: "SieveScript/set",
        args: {
          accountId,
          update: {
            [currentScriptId]: { content },
          },
        },
        id: "sieve-set",
      },
    ]);

    const [, result] = response.methodResponses[0];
    const setResult = result as SieveScriptSetResponse;

    if (setResult.notUpdated) {
      const error = setResult.notUpdated[currentScriptId];
      throw new Error(
        `Failed to update Sieve script: ${error.type}${error.description ? ` - ${error.description}` : ""}`,
      );
    }
  } else {
    // Create new script
    const response = await client.makeRequest([
      {
        methodName: "SieveScript/set",
        args: {
          accountId,
          create: {
            "new-1": {
              name: "Inbox Zero",
              content,
              isActive: true,
            },
          },
        },
        id: "sieve-set",
      },
    ]);

    const [, result] = response.methodResponses[0];
    const setResult = result as SieveScriptSetResponse;

    if (setResult.notCreated?.["new-1"]) {
      const error = setResult.notCreated["new-1"];
      throw new Error(
        `Failed to create Sieve script: ${error.type}${error.description ? ` - ${error.description}` : ""}`,
      );
    }
  }
}

export async function getCurrentScriptId(
  client: FastmailClient,
  accountId: string,
): Promise<string | null> {
  const response = await client.makeRequest([
    {
      methodName: "SieveScript/get",
      args: {
        accountId,
        ids: null,
      },
      id: "sieve-get",
    },
  ]);

  const [, result] = response.methodResponses[0];
  const scripts = (result as { list: SieveScript[] }).list;

  const activeScript = scripts.find((s) => s.isActive);

  return activeScript?.id || null;
}
