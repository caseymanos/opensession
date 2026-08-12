export function reviewWorkspaceEventKey(pathname: string): string | null {
  const value = /^\/app\/([^/]+)\/reviews\/?$/.exec(pathname)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
