import { z } from "zod";

export const connectFastmailTokenBody = z.object({
  token: z.string().min(1, "API token is required"),
});
export type ConnectFastmailTokenBody = z.infer<typeof connectFastmailTokenBody>;
