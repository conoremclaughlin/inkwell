/** CLI dispatch seam; all preparation and execution lives in shared. */
import {
  startBackendTurn as startSharedBackendTurn,
  type BackendRunRequest,
  type BackendRunResult,
  type BackendTurnHandle,
} from '@inklabs/shared/providers';
export type { BackendRunRequest, BackendRunResult, BackendTurnHandle };

// A CLI owns one chat for its process lifetime. Hosts serving many sessions
// use the explicit request restriction in shared instead of this latch.
let providerToolsWithheld = false;
export function withholdProviderToolsForThisProcess(): void {
  providerToolsWithheld = true;
}
export function providerToolsWithheldForThisProcess(): boolean {
  return providerToolsWithheld;
}
export function startBackendTurn(request: BackendRunRequest): BackendTurnHandle {
  return startSharedBackendTurn({
    ...request,
    ...(providerToolsWithheld ? { withholdProviderTools: true } : {}),
  });
}
export async function runBackendTurn(request: BackendRunRequest): Promise<BackendRunResult> {
  return startBackendTurn(request).result;
}
