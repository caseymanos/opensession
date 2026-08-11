const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export interface OrganizerSubmissionRoute {
  eventKey: string;
  submissionId: string | null;
}

export function organizerSubmissionRoute(
  pathname: string,
): OrganizerSubmissionRoute | null {
  if (pathname.startsWith("/fixtures/")) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length < 3 ||
    segments.length > 4 ||
    segments[0] !== "app" ||
    segments[2] !== "submissions"
  ) {
    return null;
  }
  const eventKey = segments[1];
  const submissionId = segments[3] ?? null;
  if (
    !eventKey ||
    !identifierPattern.test(eventKey) ||
    (submissionId !== null && !identifierPattern.test(submissionId))
  ) {
    return null;
  }
  return { eventKey, submissionId };
}
