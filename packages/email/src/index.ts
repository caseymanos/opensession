export {
  CampaignPlanError,
  createCampaignMessageKey,
  createCampaignPlan,
  serializeCampaignPlan,
  type CampaignAudienceCandidate,
  type CampaignAudienceExclusion,
  type CampaignAudienceFilter,
  type CampaignAudienceRole,
  type CampaignAudienceSample,
  type CampaignAudienceSnapshot,
  type CampaignExclusionReason,
  type CampaignPlan,
  type CampaignPortalState,
  type CampaignReadiness,
  type CampaignSchedule,
  type CampaignSuppressionReason,
} from "./campaign.js";
export {
  analyzeEmailTemplate,
  EmailTemplateValidationError,
  validateEmailMergeValues,
} from "./merge.js";
export { renderEmailTemplate } from "./render.js";
export {
  createSeedEmailTemplates,
  type SeedEmailTemplateOptions,
} from "./seeds.js";
export {
  EMAIL_MERGE_SCHEMA_VERSION,
  emailMergeFieldDefinitions,
  type EmailAddress,
  type EmailDocument,
  type EmailDocumentBlock,
  type EmailMergeFieldName,
  type EmailMergeFieldType,
  type EmailMergeValue,
  type EmailMergeValues,
  type EmailMessage,
  type EmailSender,
  type EmailTemplate,
  type EmailTemplateAnalysis,
  type EmailTemplateAudience,
  type EmailTemplateIssue,
  type EmailTemplateStatus,
  type RenderedEmailTemplate,
} from "./types.js";
export {
  activateEmailTemplate,
  createEmailTemplateRevision,
  serializeEmailTemplateSnapshot,
  snapshotEmailTemplate,
  type EmailTemplateRevisionChanges,
} from "./versioning.js";
