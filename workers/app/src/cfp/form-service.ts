import {
  organizerCfpFormReadResponseSchema,
  type CfpFormDiagnostic,
  type OrganizerCfpForm,
  type OrganizerCfpFormField,
  type OrganizerCfpFormSaveRequest,
} from "@sessionbox-killer/contracts";
import {
  assertCfpFormTransition,
  nextCfpDraftVersion,
  resolveCfpTrackRoute,
  validateCfpForm,
} from "@sessionbox-killer/domain";

import { hashAuthorityValue } from "../authority/types.js";
import type {
  CfpFormPlanFieldValue,
  CfpFormPlanInput,
  CfpFormPlanItem,
  CfpFormPlanMode,
  CfpFormPlanReceipt,
} from "./form-authority.js";

interface CfpFormAuthorityPort {
  executeCfpFormPlan(input: unknown): Promise<CfpFormPlanReceipt>;
  inspectCfpFormPlan(
    organizationId: string,
    planId: string,
  ): { state: string } | null | Promise<{ state: string } | null>;
  resumeCfpFormPlan(
    organizationId: string,
    planId: string,
    requestHash: string,
  ): Promise<CfpFormPlanReceipt | null>;
}

interface EventRow {
  cfp_closes_at: string | null;
  id: string;
  name: string;
  organization_id: string;
  slug: string;
  source_record_id: string;
  timezone: string;
}

interface FormRow {
  edit_after_close: number;
  id: string;
  name: string;
  published_at: string | null;
  source_record_id: string;
  source_version: number;
  status: "archived" | "closed" | "draft" | "published";
  submission_limit: number | null;
  version: number;
  welcome_content: string | null;
}

interface FieldRow {
  block_type:
    | "checkbox"
    | "file"
    | "multiselect"
    | "participant"
    | "section"
    | "select"
    | "text"
    | "textarea"
    | "url";
  help_text: string | null;
  id: string;
  label: string;
  options_json: string;
  required: number;
  sort_order: number;
  stable_key: string;
  validation_json: string;
}

interface RuleRow {
  effect: "require" | "show";
  id: string;
  operator: string;
  sort_order: number;
  source_field_id: string;
  target_field_id: string;
  value_json: string;
}

interface TrackOptionRow {
  cfp_aliases_json: string;
  cfp_selection: string | null;
  default_reviewer_group_id: string | null;
  route_key: string | null;
  submission_track: string | null;
}

interface FormatOptionRow {
  name: string;
}

interface FormState {
  event: EventRow;
  forms: FormRow[];
  selected: FormRow;
}

export class CfpFormNotFoundError extends Error {
  constructor() {
    super("The requested CFP form does not exist.");
    this.name = "CfpFormNotFoundError";
  }
}

export class CfpFormVersionConflictError extends Error {
  readonly actualFormId: string;
  readonly actualSourceVersion: number;

  constructor(form: Pick<FormRow, "id" | "source_version">) {
    super("The CFP form changed elsewhere. Refresh before saving again.");
    this.name = "CfpFormVersionConflictError";
    this.actualFormId = form.id;
    this.actualSourceVersion = form.source_version;
  }
}

export class CfpFormStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfpFormStateError";
  }
}

export class CfpFormValidationError extends Error {
  readonly diagnostics: readonly CfpFormDiagnostic[];

  constructor(diagnostics: readonly CfpFormDiagnostic[]) {
    super("Resolve the CFP form diagnostics before saving or publishing.");
    this.name = "CfpFormValidationError";
    this.diagnostics = diagnostics;
  }
}

export class CfpFormProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfpFormProjectionError";
  }
}

function parsedJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CfpFormProjectionError(`${label} is not valid JSON.`);
  }
}

function fieldType(row: FieldRow): OrganizerCfpFormField["type"] {
  const types: Record<FieldRow["block_type"], OrganizerCfpFormField["type"]> = {
    checkbox: "checkbox",
    file: "file",
    multiselect: "multi_select",
    participant: "participant",
    section: "section",
    select: "single_select",
    text: "short_text",
    textarea: "long_text",
    url: "url",
  };
  return types[row.block_type];
}

function providerFieldType(type: OrganizerCfpFormField["type"]): string {
  const types: Record<OrganizerCfpFormField["type"], string> = {
    checkbox: "checkbox",
    file: "file",
    long_text: "textarea",
    multi_select: "multiselect",
    participant: "participant",
    section: "section",
    short_text: "text",
    single_select: "select",
    url: "url",
  };
  return types[type];
}

function providerReference(recordId: string): CfpFormPlanFieldValue {
  return { kind: "provider_record", recordId };
}

function itemReference(itemKey: string): CfpFormPlanFieldValue {
  return { itemKey, kind: "plan_item_record" };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value is not serializable.");
  return encoded;
}

async function derivedId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await hashAuthorityValue(value)).slice(0, 32)}`;
}

function formMatches(
  form: FormRow,
  expectedFormId: string,
  expectedSourceVersion: number,
): boolean {
  return (
    form.id === expectedFormId && form.source_version === expectedSourceVersion
  );
}

function assertCurrentForm(
  state: FormState,
  expectedFormId: string,
  expectedSourceVersion: number,
): void {
  if (!formMatches(state.selected, expectedFormId, expectedSourceVersion)) {
    throw new CfpFormVersionConflictError(state.selected);
  }
}

function activeForm(forms: readonly FormRow[]): FormRow | null {
  const drafts = forms.filter((form) => form.status === "draft");
  const published = forms.filter((form) => form.status === "published");
  if (drafts.length > 1 || published.length > 1) {
    throw new CfpFormProjectionError(
      "The event has conflicting active CFP form records.",
    );
  }
  return (
    drafts[0] ??
    published[0] ??
    forms
      .filter((form) => form.status === "closed")
      .sort((left, right) => right.version - left.version)[0] ??
    null
  );
}

export class D1OrganizerCfpFormRepository {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async state(eventId: string): Promise<FormState> {
    const event = await this.#database
      .prepare(
        `SELECT event.id, event.organization_id, event.name, event.slug,
                event.timezone, event.cfp_closes_at, event.source_record_id
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.id = ?1 AND event.source_deleted_at IS NULL`,
      )
      .bind(eventId)
      .first<EventRow>();
    if (!event) throw new CfpFormNotFoundError();
    const forms = (
      await this.#database
        .prepare(
          `SELECT id, name, status, version, welcome_content, submission_limit,
                  edit_after_close, published_at, source_record_id,
                  source_version
           FROM p_forms
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY version DESC, source_version DESC, id
           LIMIT 257`,
        )
        .bind(event.organization_id, event.id)
        .all<FormRow>()
    ).results;
    if (forms.length > 256) {
      throw new CfpFormProjectionError(
        "The event has too many CFP form records.",
      );
    }
    const selected = activeForm(forms);
    if (!selected) throw new CfpFormNotFoundError();
    return { event, forms, selected };
  }

  async form(
    state: FormState,
    target: FormRow = state.selected,
  ): Promise<OrganizerCfpForm> {
    const [fieldResult, ruleResult] = await Promise.all([
      this.#database
        .prepare(
          `SELECT id, stable_key, sort_order, block_type, label, help_text,
                  required, options_json, validation_json
           FROM p_form_fields
           WHERE organization_id = ?1 AND event_id = ?2 AND form_id = ?3
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id
           LIMIT 129`,
        )
        .bind(state.event.organization_id, state.event.id, target.id)
        .all<FieldRow>(),
      this.#database
        .prepare(
          `SELECT id, target_field_id, source_field_id, effect, operator,
                  value_json, sort_order
           FROM p_form_rules
           WHERE organization_id = ?1 AND event_id = ?2 AND form_id = ?3
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id
           LIMIT 257`,
        )
        .bind(state.event.organization_id, state.event.id, target.id)
        .all<RuleRow>(),
    ]);
    if (fieldResult.results.length > 128 || ruleResult.results.length > 256) {
      throw new CfpFormProjectionError(
        "The CFP form exceeds its field limits.",
      );
    }
    const keyById = new Map(
      fieldResult.results.map((field) => [field.id, field.stable_key]),
    );
    const rulesByTarget = new Map<string, OrganizerCfpFormField["rules"]>();
    for (const rule of ruleResult.results) {
      const sourceKey = keyById.get(rule.source_field_id);
      if (!sourceKey || !keyById.has(rule.target_field_id)) {
        throw new CfpFormProjectionError(
          "The CFP form has a rule with a missing field reference.",
        );
      }
      const operator =
        rule.operator === "equals"
          ? "equals"
          : rule.operator === "contains"
            ? "includes"
            : null;
      if (!operator) {
        throw new CfpFormProjectionError(
          "The CFP form has an unsupported rule operator.",
        );
      }
      const value = parsedJson<unknown>(rule.value_json, "CFP rule value");
      if (typeof value !== "string") {
        throw new CfpFormProjectionError(
          "The CFP form rule value must be a string.",
        );
      }
      const current = rulesByTarget.get(rule.target_field_id) ?? [];
      rulesByTarget.set(rule.target_field_id, [
        ...current,
        {
          effect: rule.effect,
          id: rule.id,
          operator,
          sourceKey,
          value,
        },
      ]);
    }
    const fields: OrganizerCfpFormField[] = fieldResult.results.map(
      (field) => ({
        helpText: field.help_text ?? "",
        id: field.id,
        key: field.stable_key,
        label: field.label,
        options: parsedJson<string[]>(field.options_json, "CFP field options"),
        order: field.sort_order,
        required: field.required === 1,
        rules: [...(rulesByTarget.get(field.id) ?? [])],
        type: fieldType(field),
        validation: parsedJson<OrganizerCfpFormField["validation"]>(
          field.validation_json,
          "CFP field validation",
        ),
      }),
    );
    return {
      editAfterClose: target.edit_after_close === 1,
      fields,
      id: target.id,
      name: target.name,
      publishedAt: target.published_at,
      sourceVersion: target.source_version,
      status: target.status === "archived" ? "closed" : target.status,
      submissionLimit: target.submission_limit,
      version: target.version,
      welcomeContent: target.welcome_content ?? "",
    };
  }

  async response(state: FormState) {
    const form = await this.form(state);
    const diagnostics = [
      ...(form.status === "draft"
        ? await this.publicationDiagnostics(state, form)
        : []),
      ...validateCfpForm(form.fields),
    ].slice(0, 512);
    const publishedVersion =
      state.forms
        .filter(
          (candidate) =>
            candidate.status === "published" || candidate.status === "closed",
        )
        .sort((left, right) => right.version - left.version)[0]?.version ??
      null;
    if (!state.event.cfp_closes_at) {
      throw new CfpFormProjectionError("The CFP event has no close time.");
    }
    return organizerCfpFormReadResponseSchema.parse({
      diagnostics,
      event: {
        cfpClosesAt: state.event.cfp_closes_at,
        id: state.event.id,
        name: state.event.name,
        slug: state.event.slug,
        timezone: state.event.timezone,
      },
      form,
      publicUrl: `/e/${encodeURIComponent(state.event.slug)}/cfp`,
      publishedVersion,
      publishable: form.status === "draft" && diagnostics.length === 0,
    });
  }

  async publicationDiagnostics(
    state: FormState,
    form: OrganizerCfpForm,
  ): Promise<CfpFormDiagnostic[]> {
    const diagnostics: CfpFormDiagnostic[] = [];
    for (const field of form.fields.filter(
      (candidate) => candidate.type === "file",
    )) {
      diagnostics.push({
        code: "unsupported_public_field",
        fieldId: field.id,
        fieldKey: field.key,
        message:
          "File uploads are not available on the public CFP yet. Remove this field before publishing.",
        path: `fields.${field.id}.type`,
      });
    }
    const reservedAlias = form.fields.find(
      (field) => field.key === "workshopPrerequisites",
    );
    if (reservedAlias) {
      diagnostics.push({
        code: "unsupported_public_field",
        fieldId: reservedAlias.id,
        fieldKey: reservedAlias.key,
        message:
          "Use workshop_prerequisites as the stable key; workshopPrerequisites is reserved by the applicant runtime.",
        path: `fields.${reservedAlias.id}.key`,
      });
    }
    for (const requirement of [
      {
        code: "missing_title_field" as const,
        key: "title",
        label: "session title",
        type: "short_text" as const,
      },
      {
        code: "missing_abstract_field" as const,
        key: "abstract",
        label: "abstract",
        type: "long_text" as const,
      },
      {
        code: "missing_outcomes_field" as const,
        key: "outcomes",
        label: "attendee outcomes",
        type: "long_text" as const,
      },
    ]) {
      const field = form.fields.find(
        (candidate) => candidate.key === requirement.key,
      );
      if (field?.type === requirement.type && field.required) continue;
      diagnostics.push({
        code: requirement.code,
        ...(field ? { fieldId: field.id, fieldKey: field.key } : {}),
        message: `Add a required ${requirement.label} field before publishing.`,
        path: field ? `fields.${field.id}` : `fields.${requirement.key}`,
      });
    }
    const track = form.fields.find((field) => field.key === "track");
    const format = form.fields.find((field) => field.key === "format");
    if (
      track?.type !== "single_select" ||
      !track.required ||
      track.options.length === 0
    ) {
      diagnostics.push({
        code: "missing_track_field",
        ...(track ? { fieldId: track.id, fieldKey: track.key } : {}),
        message: "Add a single-choice track field before publishing.",
        path: track ? `fields.${track.id}` : "fields.track",
      });
    }
    if (
      format?.type !== "single_select" ||
      !format.required ||
      format.options.length === 0
    ) {
      diagnostics.push({
        code: "missing_format_field",
        ...(format ? { fieldId: format.id, fieldKey: format.key } : {}),
        message: "Add a single-choice format field before publishing.",
        path: format ? `fields.${format.id}` : "fields.format",
      });
    }
    const [trackRows, formatRows] = await Promise.all([
      this.#database
        .prepare(
          `SELECT cfp_selection, cfp_aliases_json, route_key, submission_track,
                  default_reviewer_group_id
           FROM p_tracks
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id
           LIMIT 65`,
        )
        .bind(state.event.organization_id, state.event.id)
        .all<TrackOptionRow>(),
      this.#database
        .prepare(
          `SELECT name FROM p_formats
           WHERE organization_id = ?1 AND event_id = ?2
             AND source_deleted_at IS NULL
           ORDER BY sort_order, id
           LIMIT 65`,
        )
        .bind(state.event.organization_id, state.event.id)
        .all<FormatOptionRow>(),
    ]);
    if (trackRows.results.length > 64) {
      diagnostics.push({
        code: "too_many_tracks",
        message: "The event track catalog exceeds the 64-track CFP limit.",
        path: "event.tracks",
      });
    }
    if (formatRows.results.length > 64) {
      diagnostics.push({
        code: "too_many_formats",
        message: "The event format catalog exceeds the 64-format CFP limit.",
        path: "event.formats",
      });
    }
    const routes = trackRows.results.slice(0, 64).flatMap((row) => {
      let aliases: string[];
      try {
        const parsed: unknown = JSON.parse(row.cfp_aliases_json);
        if (
          !Array.isArray(parsed) ||
          parsed.length > 64 ||
          parsed.some(
            (alias) =>
              typeof alias !== "string" || !alias.trim() || alias.length > 240,
          )
        ) {
          throw new TypeError("invalid aliases");
        }
        aliases = parsed;
      } catch {
        diagnostics.push({
          code: "invalid_track_catalog",
          message: "A track has invalid CFP aliases and cannot be published.",
          path: "event.tracks",
        });
        return [];
      }
      if (
        !row.cfp_selection?.trim() ||
        !row.route_key?.trim() ||
        !row.submission_track?.trim() ||
        !row.default_reviewer_group_id?.trim()
      ) {
        diagnostics.push({
          code: "invalid_track_catalog",
          message:
            "Every event track needs a CFP selection, route key, submission track, and reviewer group.",
          path: "event.tracks",
        });
        return [];
      }
      return [
        {
          aliases,
          defaultReviewerGroupId: row.default_reviewer_group_id,
          routeKey: row.route_key,
          selection: row.cfp_selection,
          submissionTrack: row.submission_track,
        },
      ];
    });
    const routeCandidates = new Set<string>();
    for (const route of routes) {
      for (const candidate of [route.selection, ...(route.aliases ?? [])]) {
        const normalized = candidate.trim().toLocaleLowerCase("en-US");
        if (routeCandidates.has(normalized)) {
          diagnostics.push({
            code: "invalid_track_catalog",
            message:
              "Track selections and aliases must be unique before publishing.",
            path: "event.tracks",
          });
          break;
        }
        routeCandidates.add(normalized);
      }
    }
    if (
      track &&
      (track.options.length !== routes.length ||
        track.options.some(
          (option) => resolveCfpTrackRoute(routes, option) === null,
        ))
    ) {
      diagnostics.push({
        code: "unroutable_track_option",
        fieldId: track.id,
        fieldKey: track.key,
        message:
          "Every track choice must map one-to-one to a canonical reviewer route.",
        path: `fields.${track.id}.options`,
      });
    }
    const canonicalFormats = new Set(
      formatRows.results
        .slice(0, 64)
        .map((row) => row.name.trim().toLocaleLowerCase("en-US")),
    );
    if (
      canonicalFormats.size !== formatRows.results.slice(0, 64).length ||
      canonicalFormats.has("")
    ) {
      diagnostics.push({
        code: "invalid_format_catalog",
        message: "Event format names must be non-empty and unique.",
        path: "event.formats",
      });
    }
    if (
      format &&
      format.options.some(
        (option) =>
          !canonicalFormats.has(option.trim().toLocaleLowerCase("en-US")),
      )
    ) {
      diagnostics.push({
        code: "unsupported_format_option",
        fieldId: format.id,
        fieldKey: format.key,
        message: "Every format choice must exist in the event format catalog.",
        path: `fields.${format.id}.options`,
      });
    }
    return diagnostics;
  }
}

interface CfpFormServiceOptions {
  actorId: string;
  authority: CfpFormAuthorityPort;
  database: D1Database;
}

export class CfpFormService {
  readonly #actorId: string;
  readonly #authority: CfpFormAuthorityPort;
  readonly #repository: D1OrganizerCfpFormRepository;

  constructor(options: CfpFormServiceOptions) {
    this.#actorId = options.actorId;
    this.#authority = options.authority;
    this.#repository = new D1OrganizerCfpFormRepository(options.database);
  }

  async read(eventId: string) {
    return this.#repository.response(await this.#repository.state(eventId));
  }

  async save(eventId: string, request: OrganizerCfpFormSaveRequest) {
    const state = await this.#repository.state(eventId);
    const requestHash = await hashAuthorityValue({ eventId, request });
    const replay = await this.replay(state, request.commandId, requestHash);
    if (replay) return replay;
    assertCurrentForm(
      state,
      request.expectedFormId,
      request.expectedSourceVersion,
    );
    const diagnostics = validateCfpForm(request.form.fields);
    if (diagnostics.length > 0) throw new CfpFormValidationError(diagnostics);
    const version =
      state.selected.status === "draft"
        ? state.selected.version
        : nextCfpDraftVersion(
            state.forms
              .filter(
                (
                  form,
                ): form is FormRow & {
                  status: "closed" | "draft" | "published";
                } => form.status !== "archived",
              )
              .map((form) => ({ status: form.status, version: form.version })),
          );
    const formId = await derivedId(
      "form",
      `${state.event.organization_id}\u0000${eventId}\u0000${version}\u0000${request.commandId}`,
    );
    const items: CfpFormPlanItem[] = [];
    if (state.selected.status === "draft") {
      assertCfpFormTransition("draft", "archived");
      items.push({
        entityId: state.selected.id,
        expectedVersion: state.selected.source_version,
        fields: { Status: "archived" },
        itemKey: "archive_prior_draft",
        table: "forms",
      });
    }
    items.push({
      entityId: formId,
      expectedVersion: 0,
      fields: {
        "Edit after close": request.form.editAfterClose,
        Event: providerReference(state.event.source_record_id),
        Name: request.form.name,
        "Published at": null,
        Status: "draft",
        "Submission limit": request.form.submissionLimit,
        Version: version,
        "Welcome content": request.form.welcomeContent,
      },
      itemKey: "form_snapshot",
      table: "forms",
    });

    const sortedFields = [...request.form.fields].sort(
      (left, right) => left.order - right.order,
    );
    const itemKeyByFieldId = new Map(
      sortedFields.map((field, index) => [
        field.id,
        `field_${String(index + 1).padStart(3, "0")}`,
      ]),
    );
    for (const field of sortedFields) {
      const entityId = await derivedId("field", `${formId}\u0000${field.id}`);
      items.push({
        entityId,
        expectedVersion: 0,
        fields: {
          "Block type": providerFieldType(field.type),
          Form: itemReference("form_snapshot"),
          Help: field.helpText || null,
          Label: field.label,
          "Options JSON": canonicalJson(field.options),
          Order: field.order,
          Required: field.required,
          "Stable key": field.key,
          "Validation JSON": canonicalJson(field.validation),
        },
        itemKey: itemKeyByFieldId.get(field.id) as string,
        table: "form_fields",
      });
    }

    const fieldByKey = new Map(
      request.form.fields.map((field) => [field.key, field]),
    );
    let ruleOrder = 0;
    for (const field of sortedFields) {
      for (const rule of field.rules) {
        const source = fieldByKey.get(rule.sourceKey);
        if (!source) continue;
        ruleOrder += 1;
        items.push({
          entityId: await derivedId("rule", `${formId}\u0000${rule.id}`),
          expectedVersion: 0,
          fields: {
            Effect: rule.effect,
            Form: itemReference("form_snapshot"),
            Operator: rule.operator === "includes" ? "contains" : "equals",
            Order: ruleOrder,
            "Source field": itemReference(
              itemKeyByFieldId.get(source.id) as string,
            ),
            "Target field": itemReference(
              itemKeyByFieldId.get(field.id) as string,
            ),
            "Value JSON": canonicalJson(rule.value),
          },
          itemKey: `rule_${String(ruleOrder).padStart(3, "0")}`,
          table: "form_rules",
        });
      }
    }

    const receipt = await this.executePlan({
      commandId: request.commandId,
      eventId,
      expectedFormId: state.selected.id,
      expectedSourceVersion: state.selected.source_version,
      formId,
      items,
      mode: "save",
      organizationId: state.event.organization_id,
      requestHash,
    });
    const result = await this.#repository.response(
      await this.#repository.state(eventId),
    );
    if (result.form.id !== formId || result.form.status !== "draft") {
      throw new CfpFormProjectionError(
        "The saved CFP draft is not the active projection.",
      );
    }
    return { outcome: receipt.outcome, result } as const;
  }

  async publish(
    eventId: string,
    request: {
      commandId: string;
      expectedFormId: string;
      expectedSourceVersion: number;
    },
    at = new Date(),
  ) {
    const state = await this.#repository.state(eventId);
    const requestHash = await hashAuthorityValue({ eventId, request });
    const replay = await this.replay(state, request.commandId, requestHash);
    if (replay) return replay;
    assertCurrentForm(
      state,
      request.expectedFormId,
      request.expectedSourceVersion,
    );
    if (state.selected.status !== "draft") {
      throw new CfpFormStateError("Only a draft CFP form can be published.");
    }
    assertCfpFormTransition("draft", "published");
    const form = await this.#repository.form(state);
    const diagnostics = [
      ...(await this.#repository.publicationDiagnostics(state, form)),
      ...validateCfpForm(form.fields),
    ].slice(0, 512);
    if (diagnostics.length > 0) throw new CfpFormValidationError(diagnostics);
    const prior = state.forms.find(
      (candidate) => candidate.status === "published",
    );
    const latestPublicationVersion = Math.max(
      0,
      ...state.forms
        .filter(
          (candidate) =>
            candidate.status === "published" || candidate.status === "closed",
        )
        .map((candidate) => candidate.version),
    );
    if (state.selected.version !== latestPublicationVersion + 1) {
      throw new CfpFormStateError(
        "The draft version does not follow the latest publication.",
      );
    }
    const items: CfpFormPlanItem[] = [];
    if (prior) {
      assertCfpFormTransition("published", "closed");
      items.push({
        entityId: prior.id,
        expectedVersion: prior.source_version,
        fields: { Status: "closed" },
        itemKey: "close_prior_publication",
        table: "forms",
      });
    }
    items.push({
      entityId: state.selected.id,
      expectedVersion: state.selected.source_version,
      fields: { "Published at": at.toISOString(), Status: "published" },
      itemKey: "publish_form_snapshot",
      table: "forms",
    });
    const receipt = await this.executePlan({
      commandId: request.commandId,
      eventId,
      expectedFormId: state.selected.id,
      expectedSourceVersion: state.selected.source_version,
      formId: state.selected.id,
      items,
      mode: "publish",
      organizationId: state.event.organization_id,
      requestHash,
    });
    const result = await this.#repository.response(
      await this.#repository.state(eventId),
    );
    if (
      result.form.id !== state.selected.id ||
      result.form.status !== "published"
    ) {
      throw new CfpFormProjectionError(
        "The published CFP snapshot is not the active projection.",
      );
    }
    return { outcome: receipt.outcome, result } as const;
  }

  async close(
    eventId: string,
    request: {
      commandId: string;
      expectedFormId: string;
      expectedSourceVersion: number;
    },
  ) {
    const state = await this.#repository.state(eventId);
    const requestHash = await hashAuthorityValue({ eventId, request });
    const replay = await this.replay(state, request.commandId, requestHash);
    if (replay) return replay;
    assertCurrentForm(
      state,
      request.expectedFormId,
      request.expectedSourceVersion,
    );
    if (state.selected.status !== "published") {
      throw new CfpFormStateError("Only a published CFP form can be closed.");
    }
    assertCfpFormTransition("published", "closed");
    const receipt = await this.executePlan({
      commandId: request.commandId,
      eventId,
      expectedFormId: state.selected.id,
      expectedSourceVersion: state.selected.source_version,
      formId: state.selected.id,
      items: [
        {
          entityId: state.selected.id,
          expectedVersion: state.selected.source_version,
          fields: { Status: "closed" },
          itemKey: "close_form",
          table: "forms",
        },
      ],
      mode: "close",
      organizationId: state.event.organization_id,
      requestHash,
    });
    const result = await this.#repository.response(
      await this.#repository.state(eventId),
    );
    return { outcome: receipt.outcome, result } as const;
  }

  async executePlan(options: {
    commandId: string;
    eventId: string;
    expectedFormId: string;
    expectedSourceVersion: number;
    formId: string;
    items: readonly CfpFormPlanItem[];
    mode: CfpFormPlanMode;
    organizationId: string;
    requestHash: string;
  }): Promise<CfpFormPlanReceipt> {
    const planIdentity = await hashAuthorityValue({
      commandId: options.commandId,
      eventId: options.eventId,
    });
    const plan: CfpFormPlanInput = {
      actorId: this.#actorId,
      eventId: options.eventId,
      expectedFormId: options.expectedFormId,
      expectedSourceVersion: options.expectedSourceVersion,
      formId: options.formId,
      items: options.items,
      mode: options.mode,
      operation: "cfp.form.persist",
      organizationId: options.organizationId,
      planId: `cfp_form_plan_${planIdentity.slice(0, 32)}`,
      requestHash: options.requestHash,
    };
    return this.#authority.executeCfpFormPlan(plan);
  }

  async replay(state: FormState, commandId: string, requestHash: string) {
    const planIdentity = await hashAuthorityValue({
      commandId,
      eventId: state.event.id,
    });
    const planId = `cfp_form_plan_${planIdentity.slice(0, 32)}`;
    const inspection = await this.#authority.inspectCfpFormPlan(
      state.event.organization_id,
      planId,
    );
    if (!inspection) return null;
    const receipt = await this.#authority.resumeCfpFormPlan(
      state.event.organization_id,
      planId,
      requestHash,
    );
    if (!receipt) return null;
    return {
      outcome: receipt.outcome,
      result: await this.#repository.response(
        await this.#repository.state(state.event.id),
      ),
    } as const;
  }
}
