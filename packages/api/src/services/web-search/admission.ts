import { LIMITS } from './config.js';
import { WebSearchError } from './errors.js';

/**
 * Server-process-wide, no queue. One run includes both sequential capability
 * probes and inference, so parallel callers cannot multiply children or the
 * per-run estimated USD threshold. This is not a billing guarantee or a
 * fleet-wide/daily spend quota; the CLI's budget check can overshoot.
 */
export class SearchAdmission {
  private active = 0;
  private quarantined = false;

  acquire(): { release(): void; quarantine(): void } {
    if (this.quarantined) throw new WebSearchError('service_quarantined');
    if (this.active >= LIMITS.concurrent) throw new WebSearchError('capacity_exhausted');
    this.active++;
    let released = false;
    let retained = false;
    return {
      release: () => {
        if (released || retained) return;
        released = true;
        this.active--;
      },
      quarantine: () => {
        // No automatic retry/reset: an operator must investigate the physical
        // child/group before restarting the server to restore admission.
        retained = true;
        this.quarantined = true;
      },
    };
  }
}

export const searchAdmission = new SearchAdmission();
