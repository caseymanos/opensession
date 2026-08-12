export interface WorkerDeployment {
  createdOn: string;
  id: string;
  versions: { percentage: number; versionId: string }[];
}

const ansiEscapePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export function parseDeploymentList(value: string): WorkerDeployment[] {
  const parsed: unknown = JSON.parse(value.replaceAll(ansiEscapePattern, ""));

  if (!Array.isArray(parsed)) {
    throw new Error(
      "Wrangler returned an unexpected deployment list response.",
    );
  }

  return parsed.map((deployment) => parseDeployment(deployment));
}

function parseDeployment(value: unknown): WorkerDeployment {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.created_on !== "string" ||
    !Array.isArray(value.versions)
  ) {
    throw new Error("Wrangler returned an invalid deployment entry.");
  }

  const versions = value.versions.map((version) => {
    if (
      !isRecord(version) ||
      typeof version.version_id !== "string" ||
      typeof version.percentage !== "number"
    ) {
      throw new Error("Wrangler returned an invalid deployment version.");
    }

    return {
      percentage: version.percentage,
      versionId: version.version_id,
    };
  });

  if (versions.length === 0) {
    throw new Error("Wrangler returned a deployment without versions.");
  }

  return { createdOn: value.created_on, id: value.id, versions };
}

export function getActiveVersionId(
  deployments: WorkerDeployment[],
): string | null {
  if (deployments.length === 0) {
    return null;
  }

  const latest = deployments.reduce((candidate, deployment) =>
    deployment.createdOn > candidate.createdOn ? deployment : candidate,
  );

  if (latest.versions.length !== 1 || latest.versions[0]?.percentage !== 100) {
    throw new Error(
      "The active Worker uses a split deployment; finish or roll back the gradual deployment before using release automation.",
    );
  }

  return latest.versions[0].versionId;
}

export function extractDeploymentVersionId(value: string): string | null {
  return (
    value
      .replaceAll(ansiEscapePattern, "")
      .match(
        /Current Version ID:\s*([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})/i,
      )?.[1] ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
