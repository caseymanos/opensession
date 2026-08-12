import {
  publicCfpConfigurationResponseSchema,
  type PublicCfpConfigurationResponse,
} from "@sessionbox-killer/contracts";

import type { D1QueryExecutor } from "../database.js";
import {
  resolveCfpTrackRoute,
  validateCfpRules,
  type CfpConditionalRule,
  type CfpRuleField,
  type CfpRuleFieldType,
  type CfpTrackRoute,
} from "@sessionbox-killer/domain";

interface EventRow {
  cfp_closes_at: string | null;
  cfp_opens_at: string | null;
  ends_at: string | null;
  id: string;
  name: string;
  organization_id: string;
  organization_source_record_id: string;
  slug: string;
  starts_at: string | null;
  status: "closed" | "open" | "published";
  source_record_id: string;
  timezone: string;
  venue: string | null;
}

interface FormRow {
  edit_after_close: number;
  id: string;
  name: string;
  source_record_id: string;
  status: "closed" | "published";
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
  stable_key: string;
  validation_json: string;
}

interface RuleRow {
  effect: "require" | "show";
  id: string;
  operator: string;
  source_field_id: string;
  target_field_id: string;
  value_json: string;
}

interface TrackRow {
  cfp_aliases_json: string;
  cfp_selection: string | null;
  default_reviewer_group_id: string | null;
  description: string | null;
  id: string;
  route_key: string | null;
  source_record_id: string;
  submission_track: string | null;
}

interface FormatRow {
  name: string;
}

export interface PublicCfpPolicy {
  readonly acceptingSubmissions: boolean;
  readonly authority: {
    readonly eventRecordId: string;
    readonly formRecordId: string;
    readonly organizationRecordId: string;
    readonly tracks: readonly {
      readonly entityId: string;
      readonly providerRecordId: string;
      readonly route: CfpTrackRoute;
    }[];
  };
  readonly eventId: string;
  readonly formId: string;
  readonly formVersion: number;
  readonly organizationId: string;
  readonly publicConfiguration: PublicCfpConfigurationResponse;
  readonly routes: readonly CfpTrackRoute[];
}

export class PublicCfpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicCfpConfigurationError";
  }
}

function parsedStringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PublicCfpConfigurationError(`${label} is not valid JSON.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new PublicCfpConfigurationError(
      `${label} must contain only non-empty strings.`,
    );
  }
  return parsed;
}

function parsedRuleValue(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PublicCfpConfigurationError(
      "A conditional rule value is not valid JSON.",
    );
  }
  if (typeof parsed !== "string") {
    throw new PublicCfpConfigurationError(
      "Published CFP conditions require a string choice value.",
    );
  }
  return parsed;
}

function parsedValidation(value: string): {
  maxLength?: number;
  minLength?: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PublicCfpConfigurationError(
      "A published field validation is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PublicCfpConfigurationError(
      "A published field validation must be an object.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "maxLength" && key !== "minLength",
    ) ||
    [record.maxLength, record.minLength].some(
      (item) =>
        item !== undefined &&
        (!Number.isInteger(item) || Number(item) < 0 || Number(item) > 20_000),
    )
  ) {
    throw new PublicCfpConfigurationError(
      "A published field uses an unsupported validation constraint.",
    );
  }
  return {
    ...(typeof record.maxLength === "number"
      ? { maxLength: record.maxLength }
      : {}),
    ...(typeof record.minLength === "number"
      ? { minLength: record.minLength }
      : {}),
  };
}

function publicFieldType(blockType: FieldRow["block_type"]): CfpRuleFieldType {
  const types: Record<FieldRow["block_type"], CfpRuleFieldType> = {
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
  return types[blockType];
}

function conditionalRule(
  row: RuleRow,
  fieldKeyById: ReadonlyMap<string, string>,
): CfpConditionalRule {
  const sourceKey = fieldKeyById.get(row.source_field_id);
  if (!sourceKey || !fieldKeyById.has(row.target_field_id)) {
    throw new PublicCfpConfigurationError(
      "A published CFP rule references a missing field.",
    );
  }
  const operator =
    row.operator === "equals"
      ? "equals"
      : row.operator === "contains"
        ? "includes"
        : null;
  if (!operator) {
    throw new PublicCfpConfigurationError(
      "A published CFP rule uses an unsupported operator.",
    );
  }
  return {
    effect: row.effect,
    id: row.id,
    operator,
    sourceKey,
    value: parsedRuleValue(row.value_json),
  };
}

function validDate(value: string | null, label: string): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new PublicCfpConfigurationError(`${label} is not a valid date.`);
  }
  return timestamp;
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new PublicCfpConfigurationError(
      "The published CFP timezone is invalid.",
    );
  }
}

export class D1PublicCfpPolicyReader {
  readonly #database: D1QueryExecutor;

  constructor(database: D1QueryExecutor) {
    this.#database = database;
  }

  async readBySlug(
    slug: string,
    at = new Date(),
    formVersion?: number,
  ): Promise<PublicCfpPolicy | null> {
    if (
      formVersion !== undefined &&
      (!Number.isSafeInteger(formVersion) || formVersion < 1)
    ) {
      throw new PublicCfpConfigurationError(
        "The requested CFP form version is invalid.",
      );
    }
    const eventResult = await this.#database
      .prepare(
        `SELECT event.id, event.organization_id, event.name, event.slug,
                event.timezone, event.starts_at, event.ends_at, event.venue,
                event.cfp_opens_at, event.cfp_closes_at, event.status,
                event.source_record_id, tenant.source_record_id AS organization_source_record_id
         FROM p_events AS event
         JOIN tenant_registry AS tenant
           ON tenant.organization_id = event.organization_id
          AND tenant.status = 'active'
          AND tenant.authority_ready_at IS NOT NULL
         WHERE event.slug = ?1
           AND event.status IN ('open', 'published', 'closed')
           AND event.source_deleted_at IS NULL
         ORDER BY event.organization_id, event.id
         LIMIT 2`,
      )
      .bind(slug)
      .all<EventRow>();
    const event = eventResult.results[0];
    if (!event) return null;
    if (eventResult.results.length > 1) {
      throw new PublicCfpConfigurationError(
        "The public CFP slug resolves to multiple organizations.",
      );
    }

    const formResult = await this.#database
      .prepare(
        `SELECT id, name, status, version, welcome_content, submission_limit,
                edit_after_close, source_record_id
         FROM p_forms
         WHERE organization_id = ?1 AND event_id = ?2
           AND status IN ('published', 'closed')
           AND (?3 IS NULL OR version = ?3)
           AND source_deleted_at IS NULL
         ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, version DESC, id
         LIMIT 3`,
      )
      .bind(event.organization_id, event.id, formVersion ?? null)
      .all<FormRow>();
    const publishedForms = formResult.results.filter(
      (form) => form.status === "published",
    );
    if (
      (formVersion === undefined && publishedForms.length > 1) ||
      (formVersion !== undefined && formResult.results.length > 1)
    ) {
      throw new PublicCfpConfigurationError(
        formVersion === undefined
          ? "The event has more than one published CFP form."
          : "The event has more than one CFP form for the requested version.",
      );
    }
    const form =
      formVersion === undefined
        ? (publishedForms[0] ?? formResult.results[0])
        : formResult.results[0];
    if (!form) return null;

    const [fieldResult, ruleResult, trackResult, formatResult] =
      await Promise.all([
        this.#database
          .prepare(
            `SELECT id, stable_key, block_type, label, help_text, required,
                    options_json, validation_json
             FROM p_form_fields
             WHERE organization_id = ?1 AND event_id = ?2 AND form_id = ?3
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 129`,
          )
          .bind(event.organization_id, event.id, form.id)
          .all<FieldRow>(),
        this.#database
          .prepare(
            `SELECT id, target_field_id, source_field_id, effect, operator,
                    value_json
             FROM p_form_rules
             WHERE organization_id = ?1 AND event_id = ?2 AND form_id = ?3
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 257`,
          )
          .bind(event.organization_id, event.id, form.id)
          .all<RuleRow>(),
        this.#database
          .prepare(
            `SELECT id, cfp_selection, cfp_aliases_json, route_key,
                    submission_track, default_reviewer_group_id, description,
                    source_record_id
             FROM p_tracks
             WHERE organization_id = ?1 AND event_id = ?2
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 65`,
          )
          .bind(event.organization_id, event.id)
          .all<TrackRow>(),
        this.#database
          .prepare(
            `SELECT name
             FROM p_formats
             WHERE organization_id = ?1 AND event_id = ?2
               AND source_deleted_at IS NULL
             ORDER BY sort_order, id
             LIMIT 65`,
          )
          .bind(event.organization_id, event.id)
          .all<FormatRow>(),
      ]);

    if (
      fieldResult.results.length > 128 ||
      ruleResult.results.length > 256 ||
      trackResult.results.length > 64 ||
      formatResult.results.length > 64
    ) {
      throw new PublicCfpConfigurationError(
        "The published CFP configuration exceeds a response limit.",
      );
    }

    const fieldKeyById = new Map(
      fieldResult.results.map((field) => [field.id, field.stable_key]),
    );
    const helpTextByKey = new Map(
      fieldResult.results.map((field) => [
        field.stable_key,
        field.help_text ?? "",
      ]),
    );
    const validationByKey = new Map(
      fieldResult.results.map((field) => [
        field.stable_key,
        parsedValidation(field.validation_json),
      ]),
    );
    const rulesByTargetId = new Map<string, CfpConditionalRule[]>();
    for (const row of ruleResult.results) {
      const current = rulesByTargetId.get(row.target_field_id) ?? [];
      current.push(conditionalRule(row, fieldKeyById));
      rulesByTargetId.set(row.target_field_id, current);
    }
    const fields: CfpRuleField[] = fieldResult.results.map((field) => ({
      key: field.stable_key,
      label: field.label,
      options: parsedStringArray(
        field.options_json,
        `Options for ${field.stable_key}`,
      ),
      required: field.required === 1,
      rules: rulesByTargetId.get(field.id) ?? [],
      type: publicFieldType(field.block_type),
    }));
    const diagnostics = validateCfpRules(fields);
    if (diagnostics.length > 0) {
      throw new PublicCfpConfigurationError(
        diagnostics[0]?.message ?? "The published CFP rules are invalid.",
      );
    }

    const authorityTracks = trackResult.results.map((track) => {
      if (
        !track.cfp_selection?.trim() ||
        !track.route_key?.trim() ||
        !track.submission_track?.trim() ||
        !track.default_reviewer_group_id?.trim()
      ) {
        throw new PublicCfpConfigurationError(
          "A published CFP track is missing canonical routing metadata.",
        );
      }
      return {
        entityId: track.id,
        providerRecordId: track.source_record_id,
        route: {
          aliases: parsedStringArray(
            track.cfp_aliases_json,
            `Aliases for ${track.cfp_selection}`,
          ),
          defaultReviewerGroupId: track.default_reviewer_group_id,
          routeKey: track.route_key,
          selection: track.cfp_selection,
          submissionTrack: track.submission_track,
        },
      };
    });
    const routes = authorityTracks.map((track) => track.route);
    const routeCandidates = new Set<string>();
    for (const route of routes) {
      for (const candidate of [route.selection, ...(route.aliases ?? [])]) {
        const normalized = candidate.trim().toLocaleLowerCase("en-US");
        if (routeCandidates.has(normalized)) {
          throw new PublicCfpConfigurationError(
            "Published CFP track selections and aliases must be unique.",
          );
        }
        routeCandidates.add(normalized);
      }
    }

    const trackField = fields.find((field) => field.key === "track");
    if (trackField?.type !== "single_select" || !trackField.options?.length) {
      throw new PublicCfpConfigurationError(
        "The published CFP requires a single-choice track field.",
      );
    }
    const resolvedTrackOptions = trackField.options.map((option) => {
      const route = resolveCfpTrackRoute(routes, option);
      if (!route) {
        throw new PublicCfpConfigurationError(
          "A published CFP track option has no canonical route.",
        );
      }
      return route;
    });
    if (
      trackField.options.length !== routes.length ||
      new Set(resolvedTrackOptions).size !== routes.length
    ) {
      throw new PublicCfpConfigurationError(
        "Published CFP track options must map one-to-one to canonical routes.",
      );
    }

    const formatField = fields.find((field) => field.key === "format");
    if (formatField?.type !== "single_select" || !formatField.options?.length) {
      throw new PublicCfpConfigurationError(
        "The published CFP requires a single-choice format field.",
      );
    }
    const knownFormats = new Set(
      formatResult.results.map((format) =>
        format.name.trim().toLocaleLowerCase("en-US"),
      ),
    );
    const selectedFormats = new Set(
      formatField.options.map((format) =>
        format.trim().toLocaleLowerCase("en-US"),
      ),
    );
    if (
      selectedFormats.size !== formatField.options.length ||
      formatField.options.some(
        (format) => !knownFormats.has(format.trim().toLocaleLowerCase("en-US")),
      )
    ) {
      throw new PublicCfpConfigurationError(
        "A published CFP format option does not exist in the event.",
      );
    }

    const opensAt = validDate(event.cfp_opens_at, "CFP opens at");
    const closesAt = validDate(event.cfp_closes_at, "CFP closes at");
    const startsAt = validDate(event.starts_at, "Event starts at");
    const endsAt = validDate(event.ends_at, "Event ends at");
    assertValidTimezone(event.timezone);
    if (closesAt === null) {
      throw new PublicCfpConfigurationError(
        "The published CFP requires a close time.",
      );
    }
    if (opensAt !== null && opensAt >= closesAt) {
      throw new PublicCfpConfigurationError(
        "The CFP close time must be after its open time.",
      );
    }
    if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
      throw new PublicCfpConfigurationError(
        "The event end time must be after its start time.",
      );
    }
    const now = at.getTime();
    const acceptingSubmissions =
      Number.isFinite(now) &&
      event.status !== "closed" &&
      (form.status === "published" || formVersion !== undefined) &&
      (opensAt === null || opensAt <= now) &&
      now < closesAt;

    const publicConfigurationResult =
      publicCfpConfigurationResponseSchema.safeParse({
        acceptingSubmissions,
        event: {
          cfpClosesAt: event.cfp_closes_at,
          cfpOpensAt: event.cfp_opens_at,
          endsAt: event.ends_at,
          name: event.name,
          slug: event.slug,
          startsAt: event.starts_at,
          timezone: event.timezone,
          venue: event.venue ?? "",
        },
        form: {
          editAfterClose: form.edit_after_close === 1,
          fields: fields.map((field) => ({
            helpText: helpTextByKey.get(field.key) ?? "",
            key: field.key,
            label: field.label,
            options: [...(field.options ?? [])],
            required: field.required,
            rules: [...(field.rules ?? [])],
            type: field.type,
            validation: validationByKey.get(field.key) ?? {},
          })),
          name: form.name,
          status: form.status,
          submissionLimit: form.submission_limit,
          version: form.version,
          welcomeContent: form.welcome_content ?? "",
        },
        formats: [...formatField.options],
        tracks: resolvedTrackOptions.map((route) => ({
          description:
            trackResult.results.find(
              (track) => track.cfp_selection === route.selection,
            )?.description ?? "",
          selection: route.selection,
        })),
      });
    if (!publicConfigurationResult.success) {
      throw new PublicCfpConfigurationError(
        "The published CFP projection does not match the public contract.",
      );
    }

    return {
      acceptingSubmissions,
      authority: {
        eventRecordId: event.source_record_id,
        formRecordId: form.source_record_id,
        organizationRecordId: event.organization_source_record_id,
        tracks: authorityTracks,
      },
      eventId: event.id,
      formId: form.id,
      formVersion: form.version,
      organizationId: event.organization_id,
      publicConfiguration: publicConfigurationResult.data,
      routes,
    };
  }
}
