/** Async manual-skill I/O. Policy, durable selection and owner admission remain with the caller. */
import { constants } from 'fs';
import { open, opendir, realpath, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { isDeepStrictEqual } from 'util';
import type {
  DiscoveredSkill,
  SkillInstruction,
  SkillProvenance,
} from '../providers/skill-discovery.js';
import { inferSkillTrust, skillProvenanceFiles, skillRoots } from '../providers/skill-metadata.js';

export const sessionSkillLimits = {
  entries: 4096,
  instructionBytes: 256 * 1024,
  provenanceBytes: 16 * 1024,
  instructionChars: 8000,
} as const;

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

class SkillCatalogLimitError extends Error {}

function isolateCatalogEntry(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (
    error instanceof SkillCatalogLimitError ||
    (error instanceof Error && error.name === 'AbortError')
  )
    throw error;
}

/** Linked roots/files below the explicit host root refuse, rather than borrow a trust label. */
async function checkedPath(path: string, root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Skill path is outside its host root');
  const canonical = await realpath(path);
  signal?.throwIfAborted();
  if (canonical !== resolve(canonicalRoot, rel))
    throw new Error('Linked skill paths are not supported by the hosted instruction loader');
  return canonical;
}

async function readBounded(path: string, root: string, limit: number, signal?: AbortSignal) {
  const canonical = await checkedPath(path, root, signal);
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    signal?.throwIfAborted();
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Skill input must be a regular file');
    if (info.size > limit) throw new Error('Skill input exceeds the hosted byte limit');
    // Reading at most limit+1 also bounds a file that grows after stat.
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error('Skill input exceeds the hosted byte limit');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function provenance(
  path: string,
  root: string,
  signal?: AbortSignal
): Promise<SkillProvenance | undefined> {
  for (const name of skillProvenanceFiles) {
    let text: string;
    try {
      text = (
        await readBounded(join(path, name), root, sessionSkillLimits.provenanceBytes, signal)
      ).toString('utf8');
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const result: SkillProvenance = {};
    for (const key of [
      'registry',
      'installSource',
      'sourceUrl',
      'installedAt',
      'digest',
    ] as const) {
      if (typeof record[key] === 'string') result[key] = record[key];
    }
    if (typeof record.trusted === 'boolean') result.trusted = record.trusted;
    return result;
  }
  return undefined;
}

export function createSkillInstructionHost(cwd: string, home: string) {
  if (!isAbsolute(cwd) || !isAbsolute(home))
    throw new Error('Skill discovery needs absolute host roots');
  const roots = skillRoots(resolve(cwd), resolve(home));
  const hostRoot = (source: string) => (source.startsWith('repo:') ? resolve(cwd) : resolve(home));
  return {
    async discover(signal?: AbortSignal): Promise<DiscoveredSkill[]> {
      signal?.throwIfAborted();
      let entries = 0;
      const skills: DiscoveredSkill[] = [];
      const directories = async (dir: string, root: string): Promise<string[]> => {
        try {
          const canonical = await checkedPath(dir, root, signal);
          const names: string[] = [];
          for await (const entry of await opendir(canonical)) {
            signal?.throwIfAborted();
            if (++entries > sessionSkillLimits.entries)
              throw new SkillCatalogLimitError('Skill discovery exceeds the hosted entry limit');
            if (entry.isDirectory()) names.push(entry.name);
          }
          return names.sort();
        } catch (error) {
          isolateCatalogEntry(error, signal);
          // A bad shared home catalog must not hide independent repo catalogs.
          return [];
        }
      };
      const add = async (path: string, name: string, source: string): Promise<boolean> => {
        const root = hostRoot(source);
        try {
          const marker = await checkedPath(join(path, 'SKILL.md'), root, signal);
          if (!(await stat(marker)).isFile()) throw new Error('Skill input must be a regular file');
          const metadata = await provenance(path, root, signal);
          skills.push({
            name,
            path,
            source,
            provenance: metadata,
            trustLevel: inferSkillTrust(source, metadata),
          });
          return true;
        } catch (error) {
          isolateCatalogEntry(error, signal);
          // Only an absent marker asks the caller to look for .system children.
          // A malformed/unsafe skill is omitted, never followed or made trusted.
          return !missing(error);
        }
      };
      for (const { dir, source } of roots) {
        for (const name of await directories(dir, hostRoot(source))) {
          const path = join(dir, name);
          if (await add(path, name, source)) continue;
          for (const child of await directories(join(path, '.system'), hostRoot(source))) {
            await add(join(path, '.system', child), `${name}/.system/${child}`, source);
          }
        }
      }
      signal?.throwIfAborted();
      return [
        ...new Map(skills.map((skill) => [`${skill.name}:${skill.path}`, skill])).values(),
      ].sort((a, b) => a.name.localeCompare(b.name));
    },
    async load(
      skill: DiscoveredSkill,
      signal?: AbortSignal
    ): Promise<SkillInstruction & { contentDigest: string }> {
      signal?.throwIfAborted();
      // The caller may retain its candidate while I/O yields; pin the selection.
      skill = structuredClone(skill);
      const root = roots.find((candidate) => candidate.source === skill.source);
      const parts = root ? relative(root.dir, skill.path).split(sep) : [];
      if (
        !root ||
        !isAbsolute(skill.path) ||
        resolve(skill.path) !== skill.path ||
        !(
          (parts.length === 1 || (parts.length === 3 && parts[1] === '.system')) &&
          parts.every((part) => part && part !== '..' && part !== '.')
        ) ||
        parts.join('/') !== skill.name
      )
        throw new Error('Skill identity does not belong to this host catalog');
      const metadata = await provenance(skill.path, hostRoot(skill.source), signal);
      if (
        !isDeepStrictEqual(metadata, skill.provenance) ||
        inferSkillTrust(skill.source, metadata) !== skill.trustLevel
      )
        throw new Error('Skill provenance changed; discover and select it again');
      const bytes = await readBounded(
        join(skill.path, 'SKILL.md'),
        hostRoot(skill.source),
        sessionSkillLimits.instructionBytes,
        signal
      );
      if (
        !isDeepStrictEqual(metadata, await provenance(skill.path, hostRoot(skill.source), signal))
      )
        throw new Error('Skill provenance changed during loading; discover and select it again');
      let content = bytes.toString('utf8');
      if (content.length > sessionSkillLimits.instructionChars)
        content = `${content.slice(0, sessionSkillLimits.instructionChars)}\n\n...[truncated]`;
      signal?.throwIfAborted();
      return {
        ...skill,
        provenance: metadata,
        content,
        contentDigest: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  };
}
