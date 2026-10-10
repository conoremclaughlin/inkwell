/** Per-session snapshot of the existing ink:-namespaced macOS credentials; never a global cache. */
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
export async function readHostKeychainCredentials(input: {
  platform: string;
  env: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (input.platform !== 'darwin') return result;
  input.signal?.throwIfAborted();
  const options = {
    env: { ...input.env },
    signal: input.signal,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8' as const,
  };
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', ['dump-keychain'], options);
    for (const entry of stdout.split(/^keychain:/gm)) {
      input.signal?.throwIfAborted();
      if (!entry.includes('class: "genp"')) continue;
      const service = entry.match(/"svce"<blob>="([^"]+)"/)?.[1];
      if (!service?.startsWith('ink:')) continue;
      try {
        const { stdout: pw } = await execFileAsync(
          '/usr/bin/security',
          ['find-generic-password', '-s', service, '-w'],
          options
        );
        result[service.slice(4)] = pw.trimEnd();
      } catch (error) {
        if (input.signal?.aborted) throw error;
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error; /* Same optional keychain availability as CLI. */
  }
  return result;
}

/** Tools-only sessions never acquire machine secrets, even for permitted MCP calls. */
export async function sessionCredentialsForProfile(
  profile: string | undefined,
  load: () => Promise<Readonly<Record<string, string>>>
): Promise<Readonly<Record<string, string>>> {
  return profile === 'tools' || profile === 'inkling' ? {} : load();
}
