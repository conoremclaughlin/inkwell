/** Freshness describes a working consumer, not mere process existence. Receipt
 * backpressure may last arbitrarily long without stopping independent probes. */
export async function pulseCodexMail(options: {
  usable(): boolean;
  lastDiscovery(): number;
  probe(): Promise<unknown>;
  credential(): Promise<string | null | undefined>;
  stamp(token: string): Promise<void>;
  now?: () => number;
}): Promise<boolean> {
  const ready = () =>
    options.usable() && (options.now?.() ?? Date.now()) - options.lastDiscovery() <= 20_000;
  if (!ready()) return false;
  await options.probe();
  const token = await options.credential();
  if (!ready() || !token) return false;
  await options.stamp(token);
  return true;
}
