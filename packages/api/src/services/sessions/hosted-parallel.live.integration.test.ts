/** Explicit opt-in only. Never collected by the token-free DB/CI project. */
import { readFile } from 'node:fs/promises';
import { registerHostedParallelAcceptance } from './hosted-parallel.test-support';
import {
  parallelLiveDriver,
  type ParallelLivePlan,
} from '../../test/fixtures/hosted-parallel-live';
const enabled = process.env.INK_LIVE_TESTS === '1' && process.env.INK_PARALLEL_LIVE === '1';
if (enabled && process.env.INTEGRATION_PARALLEL_MUTANT)
  throw new Error('Scope mutants belong only in the token-free twin');
const plan = enabled
  ? (JSON.parse(await readFile(process.env.INK_PARALLEL_LIVE_PLAN!, 'utf8')) as ParallelLivePlan)
  : { providerHome: '', claudeBinary: '', codexBinary: '', codexConfig: [] };
registerHostedParallelAcceptance(parallelLiveDriver(plan, enabled));
