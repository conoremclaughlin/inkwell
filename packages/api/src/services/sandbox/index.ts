export {
  SandboxOrchestrator,
  buildContainerName,
  buildEnvVars,
  buildDockerRunArgs,
  buildMounts,
  type SandboxSpinUpRequest,
  type SandboxSpinUpResult,
  type SandboxStatusResult,
  type BackendAuthName,
  type SandboxMount,
} from './orchestrator.js';

import { SandboxOrchestrator } from './orchestrator.js';

let _instance: SandboxOrchestrator | undefined;

export function getOrchestrator(): SandboxOrchestrator {
  if (!_instance) {
    _instance = new SandboxOrchestrator();
  }
  return _instance;
}
