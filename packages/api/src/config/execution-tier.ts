/**
 * The execution tier: which tools a turn is offered, decided by this
 * server's configuration and never by anything a turn's input can set
 * (task 0321ccf1; Conor, Oct 7: an SB is aware of its environment "by what
 * tools are available and the setting we put on the deployment").
 *
 * - `tools`: Inkwell's tools, and reads inside the SB's own folder. No shell,
 *   no file edits or writes, no shared-image reads, no trigger_agent, no
 *   send_response, no tools of the model provider's own, and none of this
 *   machine's tool grants. It runs only on ink, which enforces it. These are
 *   limits on the turn's local tools only: send_to_inbox stays, and whom it
 *   may reach or wake is the server's own authorization, the same for any
 *   SB on any tier (an inkling's owner and thread rules among it).
 * - `full`: what a self-hosted SB has on this machine: the `safe` profile,
 *   the machine's tool policy, and the SB's own tool-routing setting.
 *
 * A third tier, an on-demand sandbox, is being scoped (Lumen). It isn't
 * accepted here yet, so naming it fails closed to `tools`.
 *
 * The tier is the same for any SB. The configuration chooses it, in this
 * order, and the first that names one decides:
 *   1. INK_EXECUTION_TIER_SBS: `<identity uuid>=<tier>`, comma-separated.
 *   2. INK_EXECUTION_TIER_CLIENTS: `<identity client>=<tier>`, comma-separated,
 *      matched against agent_identities.metadata.client. Unset, it is
 *      `inkling-mobile=tools`: the app's inklings stay tools-only until the
 *      configuration says otherwise. Set, it replaces that default whole.
 *   3. INK_EXECUTION_TIER: the deployment's default. Unset, `full`, which is
 *      what every other SB on a self-hosted server already has.
 * Read when asked rather than once at startup, as inkling-flags.ts is, so a
 * test can pass its own source.
 *
 * Anything that doesn't parse fails closed: a malformed variable makes the
 * turn `tools`, and `problem` says which variable, never its value. A map
 * that is present but names no one (`,` or `, ,`) is malformed too, never an
 * empty map: an empty client map would drop the inkling default (Lumen,
 * #787). Blank or whitespace alone is unset.
 */

type EnvSource = Record<string, string | undefined>;

export const EXECUTION_TIERS = ['tools', 'full'] as const;
export type ExecutionTier = (typeof EXECUTION_TIERS)[number];

/** The client default when INK_EXECUTION_TIER_CLIENTS is unset. */
export const DEFAULT_CLIENT_TIERS: Readonly<Record<string, ExecutionTier>> = {
  'inkling-mobile': 'tools',
};

export interface TierSubject {
  /** The canonical identity id, when the turn has one. */
  sbId: string | null | undefined;
  /** agent_identities.metadata.client, when the identity names one. */
  client: string | null | undefined;
}

export interface TierDecision {
  tier: ExecutionTier;
  /** Which setting decided it. */
  from: 'sb' | 'client' | 'deployment' | 'default' | 'malformed';
  /** The variable that couldn't be read, when one couldn't. */
  problem?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isTier(value: string): value is ExecutionTier {
  return (EXECUTION_TIERS as readonly string[]).includes(value);
}

/** `key=tier, key=tier`, or null when any entry is malformed. */
function parseMap(raw: string, keyShape: RegExp): Map<string, ExecutionTier> | null {
  const map = new Map<string, ExecutionTier>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) return null;
    const key = trimmed.slice(0, at).trim().toLowerCase();
    const tier = trimmed
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (!keyShape.test(key) || !isTier(tier)) return null;
    if (map.has(key) && map.get(key) !== tier) return null;
    map.set(key, tier);
  }
  // Present but naming no one is a mistake, not a request to clear the map.
  return map.size > 0 ? map : null;
}

function present(raw: string | undefined): raw is string {
  return raw !== undefined && raw.trim() !== '';
}

export function executionTierFor(
  subject: TierSubject,
  source: EnvSource = process.env
): TierDecision {
  const malformed = (problem: string): TierDecision => ({
    tier: 'tools',
    from: 'malformed',
    problem,
  });

  const sbRaw = source.INK_EXECUTION_TIER_SBS;
  if (present(sbRaw)) {
    const bySb = parseMap(sbRaw, UUID);
    if (!bySb) return malformed('INK_EXECUTION_TIER_SBS');
    const sbId = subject.sbId?.toLowerCase();
    const tier = sbId ? bySb.get(sbId) : undefined;
    if (tier) return { tier, from: 'sb' };
  }

  const clientRaw = source.INK_EXECUTION_TIER_CLIENTS;
  let byClient: Map<string, ExecutionTier>;
  if (present(clientRaw)) {
    const parsed = parseMap(clientRaw, CLIENT);
    if (!parsed) return malformed('INK_EXECUTION_TIER_CLIENTS');
    byClient = parsed;
  } else {
    byClient = new Map(Object.entries(DEFAULT_CLIENT_TIERS));
  }
  const client = subject.client?.toLowerCase();
  const clientTier = client ? byClient.get(client) : undefined;
  if (clientTier) return { tier: clientTier, from: 'client' };

  const deploymentRaw = source.INK_EXECUTION_TIER;
  if (present(deploymentRaw)) {
    const tier = deploymentRaw.trim().toLowerCase();
    if (!isTier(tier)) return malformed('INK_EXECUTION_TIER');
    return { tier, from: 'deployment' };
  }
  return { tier: 'full', from: 'default' };
}

/**
 * What a turn is told about its tier, appended to its identity prompt, so it
 * knows the bounds it runs in rather than finding them by refusal. The full
 * tier adds nothing: it is what a self-hosted SB's prompt already assumes.
 */
export function executionTierPrompt(tier: ExecutionTier): string {
  if (tier !== 'tools') return '';
  return `

### Your environment
This server runs your turns on its tools tier. You have Inkwell's tools, and you can read files in your own folder. There is no shell, and you can't edit or write files. Reply in your conversation with \`send_to_inbox\`. When something needs more than these tools, say so plainly rather than looking for another way.`;
}
