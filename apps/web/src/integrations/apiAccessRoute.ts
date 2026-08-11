const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const workspacePattern = /^\/app\/([^/]+)\/integrations\/?$/;

export function apiAccessEventKey(pathname: string): string | null {
  if (pathname === "/fixtures/api-access/default") {
    return "ai-engineer-summit";
  }
  const match = workspacePattern.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const eventKey = decodeURIComponent(match[1]);
    return identifierPattern.test(eventKey) ? eventKey : null;
  } catch {
    return null;
  }
}
