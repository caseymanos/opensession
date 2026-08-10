export function workspaceEventSlug(pathname: string) {
  const match = /^\/app\/([^/]+)\/agenda\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
