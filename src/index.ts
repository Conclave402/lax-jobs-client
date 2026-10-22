/**
 * LAX — Linked Agent eXchange
 * "Discoverable by design. An agent that cannot be found cannot transact."
 *
 * Public API surface
 * @version 0.3.0
 */

// Types
export type {
  LaxOffer,
  LaxCapability,
  LaxPricing,
  RegistryClientConfig,
  RegistrySearchParams,
  RegistrySearchResult,
  OfferValidationResult,
  A2AAgentCard,
  A2ASkill,
} from './types.js';

// Core: offer helpers
export {
  createOffer,
  createCapability,
  validateOffer,
} from './core.js';

// Core: registry client
export { RegistryClient } from './core.js';

// Jobs client: list, read and submit work
export { createJobsClient, LaxJobsError } from './jobs.js';
export type {
  LaxJobsClient,
  LaxJobsClientOptions,
  LaxJobsErrorCode,
  LaxJobsFetch,
  LaxJobsList,
  LaxJobsListParams,
  LaxJobsResponse,
  LaxJob,
  LaxSubmission,
  LaxSubmissionInput,
} from './jobs.js';

// Core: A2A exporter
export { A2AExporter } from './core.js';

// Core: discovery helpers
export {
  fetchOffer,
  fetchA2ACard,
  LAX_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
} from './core.js';

/** Protocol version constant */
export const LAX_VERSION = '1.0' as const;
