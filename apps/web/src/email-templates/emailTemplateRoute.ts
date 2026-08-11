const workspaceCommunicationsPattern =
  /^\/app\/([^/]+)\/communications\/templates\/?$/;

export function emailTemplateEventKey(pathname: string): string | null {
  if (pathname.startsWith("/fixtures/email-templates/")) {
    return "ai-engineer-summit";
  }
  const match = workspaceCommunicationsPattern.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
