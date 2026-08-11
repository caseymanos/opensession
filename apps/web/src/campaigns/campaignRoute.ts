const workspaceCampaignPattern = /^\/app\/([^/]+)\/communications\/?$/;

export function campaignEventKey(pathname: string): string | null {
  if (pathname.startsWith("/fixtures/campaigns/")) {
    return "ai-engineer-summit";
  }
  const match = workspaceCampaignPattern.exec(pathname);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
