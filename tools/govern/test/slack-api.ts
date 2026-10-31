// Fake Web API wire contract, shared by injected transports and loopback servers.
export function slackBody(method: string, contentType: string, raw: string): Record<string, unknown> | undefined {
  const json = contentType.startsWith("application/json");
  if (json && ["conversations.replies", "files.getUploadURLExternal"].includes(method)) return undefined;
  return json ? JSON.parse(raw) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(raw));
}
