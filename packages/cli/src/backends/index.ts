/**
 * Backend Registry — compatibility path. The registry and adapters live in
 * @inklabs/shared/providers; resolving which SB and backend a CLI invocation
 * means stays in ./identity.ts.
 */

export type { BackendAdapter, BackendConfig, PreparedBackend } from '@inklabs/shared/providers';
export { resolveSlug, resolveBackend } from './identity.js';
export {
  BACKEND_NAMES,
  DEPRECATED_BACKENDS,
  deprecatedBackendReason,
  getBackend,
  promptTransportFor,
} from '@inklabs/shared/providers';
