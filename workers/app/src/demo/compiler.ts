import type {
  CompiledDemoSeed,
  DemoAirtableCellValue,
  DemoAirtableTableKey,
  DemoEntityReference,
  DemoSeedEntity,
  DemoSeedFieldValue,
  DemoSeedOperation,
  DemoSeedSource,
} from "./types";

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const syntheticEmailPattern = /^[^@\s]+@[^@\s]+\.invalid$/i;
const requiredSubmissionStatuses = new Set([
  "accepted",
  "declined",
  "draft",
  "in_review",
  "submitted",
  "waitlisted",
  "withdrawn",
]);
const requiredTemplateNames = new Set([
  "Acceptance",
  "Decline",
  "Schedule update",
  "Submission receipt",
  "Task reminder",
]);

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const linkTargets: Partial<
  Record<DemoAirtableTableKey, Readonly<Record<string, DemoAirtableTableKey>>>
> = {
  campaigns: { Event: "events", Template: "email_templates" },
  contacts: { Organization: "organizations" },
  criteria: { Rubric: "rubrics" },
  email_templates: { Event: "events" },
  event_contacts: { Contact: "contacts", Event: "events" },
  events: { Organization: "organizations" },
  external_mappings: { Integration: "integrations" },
  form_fields: { Form: "forms" },
  form_rules: {
    Form: "forms",
    "Source field": "form_fields",
    "Target field": "form_fields",
  },
  forms: { Event: "events" },
  formats: { Event: "events" },
  integrations: { Event: "events" },
  messages: { Campaign: "campaigns", Contact: "contacts" },
  resources: { Event: "events" },
  review_scores: { Criterion: "criteria", Review: "reviews" },
  reviews: {
    "Reviewer membership": "event_contacts",
    Submission: "submissions",
  },
  rooms: { Event: "events" },
  rubrics: { Event: "events" },
  schedule_slots: {
    Event: "events",
    Room: "rooms",
    Session: "sessions",
  },
  session_participants: { Contact: "contacts", Session: "sessions" },
  sessions: {
    Event: "events",
    Format: "formats",
    "Source submission": "submissions",
    Track: "tracks",
  },
  submission_answers: { Submission: "submissions" },
  submission_participants: {
    Contact: "contacts",
    Submission: "submissions",
  },
  submissions: {
    Event: "events",
    Form: "forms",
    "Submitter contact": "contacts",
    Track: "tracks",
  },
  sync_runs: { Integration: "integrations" },
  task_assignments: {
    "Approved by": "event_contacts",
    Contact: "contacts",
    Definition: "task_definitions",
    Event: "events",
    Session: "sessions",
  },
  task_definitions: { Event: "events" },
  tracks: { Event: "events" },
};

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Demo seed must contain only finite JSON values.");
}

async function digest(value: unknown): Promise<string> {
  return digestBytes(new TextEncoder().encode(canonicalJson(value)));
}

async function digestBytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new TypeError("Demo asset content must use canonical base64.");
  }
  if (!value || btoa(decoded) !== value) {
    throw new TypeError("Demo asset content must use canonical base64.");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function isReference(value: unknown): value is DemoEntityReference {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "entity_reference" &&
    "entityId" in value &&
    typeof value.entityId === "string"
  );
}

function references(value: DemoSeedFieldValue): DemoEntityReference[] {
  if (isReference(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter(isReference);
  }
  return [];
}

function assertStableId(value: string, label: string): void {
  if (!stableIdPattern.test(value)) {
    throw new TypeError(`${label} is not a stable identifier.`);
  }
}

function validateFields(
  entity: DemoSeedEntity,
  ids: Map<string, DemoSeedEntity>,
) {
  const tableLinks = linkTargets[entity.table] ?? {};
  for (const [name, value] of Object.entries(entity.fields)) {
    const linkedTable = tableLinks[name];
    const fieldReferences = references(value);
    if (!linkedTable && fieldReferences.length > 0) {
      throw new TypeError(
        `${entity.table}.${name} cannot contain entity links.`,
      );
    }
    if (linkedTable) {
      if (!Array.isArray(value) || fieldReferences.length !== value.length) {
        throw new TypeError(`${entity.table}.${name} requires entity links.`);
      }
      for (const reference of fieldReferences) {
        const target = ids.get(reference.entityId);
        if (!target) {
          throw new TypeError(
            `${entity.table}.${name} references missing ${reference.entityId}.`,
          );
        }
        if (target.table !== linkedTable) {
          throw new TypeError(
            `${entity.table}.${name} must reference ${linkedTable}.`,
          );
        }
      }
    }
  }
}

function fieldString(entity: DemoSeedEntity, name: string): string | null {
  const value = entity.fields[name];
  return typeof value === "string" ? value : null;
}

function fieldReferences(entity: DemoSeedEntity, name: string): string[] {
  const value = entity.fields[name];
  return value ? references(value).map(({ entityId }) => entityId) : [];
}

function assertSourceScope(
  source: DemoSeedSource,
  ids: ReadonlyMap<string, DemoSeedEntity>,
): void {
  const organizations = source.entities.filter(
    ({ table }) => table === "organizations",
  );
  const events = source.entities.filter(({ table }) => table === "events");
  const organization = ids.get(source.organizationId);
  const event = ids.get(source.eventId);
  const eventOrganizations = event
    ? fieldReferences(event, "Organization")
    : [];
  if (
    organizations.length !== 1 ||
    organization?.table !== "organizations" ||
    events.length !== 1 ||
    event?.table !== "events" ||
    eventOrganizations.length !== 1 ||
    eventOrganizations[0] !== source.organizationId
  ) {
    throw new TypeError(
      "Demo seed must contain exactly one target organization and event root.",
    );
  }

  const reaches = (startId: string, targetId: string): boolean => {
    const pending = [startId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const currentId = pending.pop();
      if (!currentId || visited.has(currentId)) continue;
      if (currentId === targetId) return true;
      visited.add(currentId);
      const current = ids.get(currentId);
      if (current) {
        pending.push(
          ...Object.values(current.fields)
            .flatMap(references)
            .map(({ entityId }) => entityId),
        );
      }
    }
    return false;
  };

  for (const entity of source.entities) {
    const targetId =
      entity.table === "organizations" || entity.table === "contacts"
        ? source.organizationId
        : source.eventId;
    if (!reaches(entity.entityId, targetId)) {
      throw new TypeError(
        `Demo entity ${entity.entityId} is outside the guarded demo root.`,
      );
    }
  }

  const memberships = source.entities.filter(
    ({ table }) => table === "event_contacts",
  );
  for (const contact of source.entities.filter(
    ({ table }) => table === "contacts",
  )) {
    const exactMemberships = memberships.filter(
      (membership) =>
        fieldReferences(membership, "Event").length === 1 &&
        fieldReferences(membership, "Event")[0] === source.eventId &&
        fieldReferences(membership, "Contact").length === 1 &&
        fieldReferences(membership, "Contact")[0] === contact.entityId,
    );
    if (exactMemberships.length !== 1) {
      throw new TypeError(
        `Demo contact ${contact.entityId} requires one exact target-event membership.`,
      );
    }
  }
}

function assertSyntheticDelivery(source: DemoSeedSource): void {
  if (source.delivery.mode === "sink" && source.delivery.allowlist.length > 0) {
    throw new TypeError("Sink delivery cannot declare an allowlist.");
  }
  for (const address of source.delivery.allowlist) {
    if (!syntheticEmailPattern.test(address)) {
      throw new TypeError(
        "Demo email allowlists must contain synthetic addresses.",
      );
    }
  }
  const emailFields = new Set([
    "Email normalized",
    "Recipient email",
    "Reply to",
    "Sender email",
  ]);
  for (const entity of source.entities) {
    for (const [name, value] of Object.entries(entity.fields)) {
      if (
        emailFields.has(name) &&
        (typeof value !== "string" || !syntheticEmailPattern.test(value))
      ) {
        throw new TypeError(
          `${entity.entityId}.${name} must use a non-deliverable .invalid address.`,
        );
      }
    }
  }
}

function assertIntentionalConflict(entities: readonly DemoSeedEntity[]): void {
  const slots = entities.filter(({ table }) => table === "schedule_slots");
  const participants = entities.filter(
    ({ table }) => table === "session_participants",
  );
  const contactsBySession = new Map<string, Set<string>>();
  for (const participant of participants) {
    const sessionId = fieldReferences(participant, "Session")[0];
    const contactId = fieldReferences(participant, "Contact")[0];
    if (sessionId && contactId) {
      const contacts = contactsBySession.get(sessionId) ?? new Set<string>();
      contacts.add(contactId);
      contactsBySession.set(sessionId, contacts);
    }
  }

  for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
    const left = slots[leftIndex];
    if (!left) continue;
    const leftStart = Date.parse(fieldString(left, "Start UTC") ?? "");
    const leftEnd = Date.parse(fieldString(left, "End UTC") ?? "");
    const leftSession = fieldReferences(left, "Session")[0];
    if (!leftSession) continue;

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < slots.length;
      rightIndex += 1
    ) {
      const right = slots[rightIndex];
      if (!right) continue;
      const rightStart = Date.parse(fieldString(right, "Start UTC") ?? "");
      const rightEnd = Date.parse(fieldString(right, "End UTC") ?? "");
      const rightSession = fieldReferences(right, "Session")[0];
      if (!rightSession || leftStart >= rightEnd || rightStart >= leftEnd) {
        continue;
      }
      const rightContacts = contactsBySession.get(rightSession) ?? new Set();
      if (
        [...(contactsBySession.get(leftSession) ?? [])].some((contactId) =>
          rightContacts.has(contactId),
        )
      ) {
        return;
      }
    }
  }
  throw new TypeError(
    "Demo seed must contain an intentional speaker conflict.",
  );
}

function assertAcceptanceCoverage(source: DemoSeedSource): void {
  const byTable = new Map<DemoAirtableTableKey, DemoSeedEntity[]>();
  for (const entity of source.entities) {
    const entries = byTable.get(entity.table) ?? [];
    entries.push(entity);
    byTable.set(entity.table, entries);
  }
  const count = (table: DemoAirtableTableKey) =>
    byTable.get(table)?.length ?? 0;
  if (count("rooms") < 3 || count("tracks") < 4 || count("formats") < 3) {
    throw new TypeError(
      "Demo event requires three rooms, four tracks, and three formats.",
    );
  }
  if (count("submissions") < 12) {
    throw new TypeError("Demo seed requires at least twelve submissions.");
  }
  const submissionStatuses = new Set(
    (byTable.get("submissions") ?? []).map((entity) =>
      fieldString(entity, "Status"),
    ),
  );
  if (
    [...requiredSubmissionStatuses].some(
      (status) => !submissionStatuses.has(status),
    )
  ) {
    throw new TypeError("Demo submissions must cover every lifecycle status.");
  }
  const eventContacts = byTable.get("event_contacts") ?? [];
  const reviewerCount = eventContacts.filter((entity) => {
    const roles = entity.fields.Roles;
    return Array.isArray(roles) && roles.includes("reviewer");
  }).length;
  const speakerStates = new Set(
    eventContacts
      .map((entity) => fieldString(entity, "Readiness projection JSON"))
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as { state?: unknown })
      .map(({ state }) => state),
  );
  if (
    reviewerCount < 3 ||
    count("sessions") < 6 ||
    !speakerStates.has("ready") ||
    !speakerStates.has("outstanding") ||
    !speakerStates.has("overdue")
  ) {
    throw new TypeError(
      "Demo roles, sessions, and readiness states are incomplete.",
    );
  }
  const scheduledSessionIds = new Set(
    (byTable.get("schedule_slots") ?? []).flatMap((entity) =>
      fieldReferences(entity, "Session"),
    ),
  );
  const unscheduled = (byTable.get("sessions") ?? []).filter(
    ({ entityId }) => !scheduledSessionIds.has(entityId),
  );
  if (unscheduled.length < 2) {
    throw new TypeError(
      "Demo seed requires two unscheduled accepted sessions.",
    );
  }
  const participantRoles = new Set(
    (byTable.get("session_participants") ?? []).map((entity) =>
      fieldString(entity, "Role"),
    ),
  );
  if (
    ["speaker", "moderator", "chair"].some(
      (role) => !participantRoles.has(role),
    )
  ) {
    throw new TypeError(
      "Demo session participants must cover every conflict-bearing role.",
    );
  }
  const event = (byTable.get("events") ?? [])[0];
  if (!event) {
    throw new TypeError("Demo seed requires one event.");
  }
  const scheduleDays = fieldString(event, "Schedule days JSON");
  let parsedScheduleDays: unknown;
  try {
    parsedScheduleDays = scheduleDays ? JSON.parse(scheduleDays) : null;
  } catch {
    parsedScheduleDays = null;
  }
  if (
    !Array.isArray(parsedScheduleDays) ||
    parsedScheduleDays.length !== 2 ||
    event.fields["Schedule snap minutes"] !== 15 ||
    event.fields["Schedule version"] !== 3
  ) {
    throw new TypeError(
      "Demo event requires two configured schedule days and versioned snap settings.",
    );
  }
  const templateNames = new Set(
    (byTable.get("email_templates") ?? []).map((entity) =>
      fieldString(entity, "Name"),
    ),
  );
  if ([...requiredTemplateNames].some((name) => !templateNames.has(name))) {
    throw new TypeError("Demo email templates are incomplete.");
  }
  const failedSync = (byTable.get("sync_runs") ?? []).some(
    (entity) => fieldString(entity, "Status") === "failed",
  );
  if (!failedSync) {
    throw new TypeError("Demo seed requires a failed retryable sync run.");
  }
  const assetKinds = new Set(source.assets.map(({ kind }) => kind));
  if (!assetKinds.has("headshot") || !assetKinds.has("slides")) {
    throw new TypeError("Demo seed requires headshot and slide fixtures.");
  }
  assertIntentionalConflict(source.entities);
}

function topologicalEntities(
  entities: readonly DemoSeedEntity[],
): DemoSeedEntity[] {
  const pending = new Map(entities.map((entity) => [entity.entityId, entity]));
  const emitted = new Set<string>();
  const ordered: DemoSeedEntity[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((entity) =>
        Object.values(entity.fields)
          .flatMap(references)
          .every(({ entityId }) => emitted.has(entityId)),
      )
      .sort((left, right) =>
        compareCanonicalStrings(left.entityId, right.entityId),
      );
    if (ready.length === 0) {
      throw new TypeError("Demo seed entity links contain a dependency cycle.");
    }
    for (const entity of ready) {
      pending.delete(entity.entityId);
      emitted.add(entity.entityId);
      ordered.push(entity);
    }
  }
  return ordered;
}

export async function compileDemoSeed(
  source: DemoSeedSource,
): Promise<CompiledDemoSeed> {
  assertStableId(source.organizationId, "Demo organization ID");
  assertStableId(source.eventId, "Demo event ID");
  if (source.seedVersion < 1 || !Number.isInteger(source.seedVersion)) {
    throw new TypeError("Demo seed version must be a positive integer.");
  }
  const ids = new Map<string, DemoSeedEntity>();
  for (const entity of source.entities) {
    assertStableId(entity.entityId, "Demo entity ID");
    if (ids.has(entity.entityId)) {
      throw new TypeError(`Duplicate demo entity ID ${entity.entityId}.`);
    }
    ids.set(entity.entityId, entity);
  }
  for (const entity of source.entities) {
    validateFields(entity, ids);
  }
  assertSourceScope(source, ids);
  const event = ids.get(source.eventId);
  if (
    event?.table !== "events" ||
    event.fields["Is demo"] !== true ||
    fieldString(event, "Name") !== "AI Engineer Summit 2026"
  ) {
    throw new TypeError("Demo event identity or Is demo guard is invalid.");
  }
  if (
    source.resetPhrase !==
    `RESET ${fieldString(event, "Name")?.toLocaleUpperCase("en-US")}`
  ) {
    throw new TypeError("Demo reset phrase must exactly name the demo event.");
  }
  assertSyntheticDelivery(source);
  assertAcceptanceCoverage(source);
  const assetIds = new Set<string>();
  const assetObjectKeys = new Set<string>();
  const assetsById = new Map<string, DemoSeedSource["assets"][number]>();
  const assetsByObjectKey = new Map<string, DemoSeedSource["assets"][number]>();
  for (const asset of source.assets) {
    assertStableId(asset.assetId, "Demo asset ID");
    const owner = ids.get(asset.ownerContactId);
    if (
      assetIds.has(asset.assetId) ||
      assetObjectKeys.has(asset.objectKey) ||
      !asset.synthetic ||
      asset.license !== "CC0-1.0" ||
      !asset.objectKey.startsWith(`demo/${source.eventId}/`) ||
      owner?.table !== "contacts"
    ) {
      throw new TypeError(`Demo asset ${asset.assetId} is not safely scoped.`);
    }
    assetIds.add(asset.assetId);
    assetObjectKeys.add(asset.objectKey);
    assetsById.set(asset.assetId, asset);
    assetsByObjectKey.set(asset.objectKey, asset);
  }
  const referencedAssetIds = new Set<string>();
  for (const entity of source.entities) {
    if (entity.table === "contacts") {
      const objectKey = fieldString(entity, "Headshot object key");
      const asset = objectKey ? assetsByObjectKey.get(objectKey) : undefined;
      if (
        objectKey &&
        (asset?.kind !== "headshot" || asset.ownerContactId !== entity.entityId)
      ) {
        throw new TypeError(
          `Demo contact ${entity.entityId} references an invalid headshot asset.`,
        );
      }
    }
    if (entity.table === "task_assignments") {
      const encodedIds = fieldString(entity, "File object IDs JSON");
      const assignmentContacts = fieldReferences(entity, "Contact");
      let fileIds: unknown;
      try {
        fileIds = encodedIds === null ? [] : JSON.parse(encodedIds);
      } catch {
        throw new TypeError(
          `Demo task ${entity.entityId} has invalid file asset references.`,
        );
      }
      if (
        !Array.isArray(fileIds) ||
        fileIds.some(
          (assetId) =>
            typeof assetId !== "string" ||
            assetsById.get(assetId)?.kind !== "slides" ||
            assignmentContacts.length !== 1 ||
            assetsById.get(assetId)?.ownerContactId !== assignmentContacts[0],
        )
      ) {
        throw new TypeError(
          `Demo task ${entity.entityId} has invalid file asset references.`,
        );
      }
      fileIds.forEach((assetId) => referencedAssetIds.add(assetId as string));
    }
  }
  for (const asset of source.assets) {
    const owner = ids.get(asset.ownerContactId);
    if (
      (asset.kind === "headshot" &&
        (!owner ||
          fieldString(owner, "Headshot object key") !== asset.objectKey)) ||
      (asset.kind === "slides" && !referencedAssetIds.has(asset.assetId))
    ) {
      throw new TypeError(`Demo asset ${asset.assetId} is not referenced.`);
    }
  }

  const canonicalAssets = [...source.assets].sort((left, right) =>
    compareCanonicalStrings(left.assetId, right.assetId),
  );
  const compiledAssets = await Promise.all(
    canonicalAssets.map(async (asset) => {
      const content = decodeCanonicalBase64(asset.contentBase64);
      const isPng =
        content.length >= 8 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every(
          (byte, index) => content[index] === byte,
        );
      const isPdf = new TextDecoder()
        .decode(content.slice(0, 5))
        .startsWith("%PDF-");
      if (
        content.length > 2_000_000 ||
        (asset.kind === "headshot" &&
          (asset.contentType !== "image/png" ||
            !asset.objectKey.endsWith(".png") ||
            !isPng)) ||
        (asset.kind === "slides" &&
          (asset.contentType !== "application/pdf" ||
            !asset.objectKey.endsWith(".pdf") ||
            !isPdf))
      ) {
        throw new TypeError(
          `Demo asset ${asset.assetId} content is not materializable.`,
        );
      }
      return {
        ...asset,
        contentDigest: await digestBytes(content),
        sizeBytes: content.byteLength,
      };
    }),
  );
  const canonicalDelivery = {
    ...source.delivery,
    allowlist: [...source.delivery.allowlist].sort(compareCanonicalStrings),
  };
  const sourceDigest = await digest({
    ...source,
    assets: canonicalAssets,
    delivery: canonicalDelivery,
    entities: [...source.entities].sort((left, right) =>
      compareCanonicalStrings(left.entityId, right.entityId),
    ),
  });
  const ordered = topologicalEntities(source.entities);
  const operations: DemoSeedOperation[] = ordered.map((entity, index) => ({
    ...entity,
    dependencies: Object.values(entity.fields)
      .flatMap(references)
      .map(({ entityId }) => entityId)
      .sort(compareCanonicalStrings),
    operation: "demo.seed.upsert",
    templateOperationId: `demo_template_${sourceDigest.slice(0, 16)}_${String(index + 1).padStart(3, "0")}`,
  }));

  return {
    assets: compiledAssets,
    delivery: canonicalDelivery,
    digest: sourceDigest,
    eventId: source.eventId,
    operations,
    organizationId: source.organizationId,
    resetPhrase: source.resetPhrase,
    seedVersion: source.seedVersion,
    snapshotId: `snapshot_${sourceDigest.slice(0, 24)}`,
  };
}

export function resolveDemoSeedFields(
  fields: Readonly<Record<string, DemoSeedFieldValue>>,
  recordIds: ReadonlyMap<string, string>,
): Readonly<Record<string, DemoAirtableCellValue>> {
  const resolveReference = ({ entityId }: DemoEntityReference): string => {
    const recordId = recordIds.get(entityId);
    if (!recordId) {
      throw new TypeError(`Missing Airtable record ID for ${entityId}.`);
    }
    return recordId;
  };
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => {
      if (isReference(value)) {
        return [name, resolveReference(value)];
      }
      if (Array.isArray(value) && value.every(isReference)) {
        return [name, value.map(resolveReference)];
      }
      return [name, value as DemoAirtableCellValue];
    }),
  );
}
