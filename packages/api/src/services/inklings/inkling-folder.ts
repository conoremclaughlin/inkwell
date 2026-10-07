/**
 * An inkling's own working folder: ~/.ink/inklings/<sbId>/, made the first
 * time a turn needs it, and the directory every inkling turn runs in
 * (Lumen 97b1d66a).
 *
 * This is organisation and damage reduction, not isolation. What the folder
 * changes is where a turn starts. It never starts in the Inkwell checkout or
 * in the server's default directory, so a stray relative path lands somewhere
 * of the inkling's own. Its read tools stay inside it (validatePathArgs); its
 * shell and file writes are denied outright by the `inkling` tool profile,
 * run against a policy file of its own (inklingToolPolicyPath, task 0321ccf1).
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isUuid } from './inkling-service';

/** The inklings' parent folder. Tests pass their own. */
export function inklingsRoot(home: string = homedir()): string {
  return join(home, '.ink', 'inklings');
}

/**
 * The folder for one inkling. The id must be a UUID: it becomes a path
 * segment, and nothing but an identity id may choose that path.
 */
export function inklingFolder(sbId: string, root: string = inklingsRoot()): string {
  if (!isUuid(sbId)) throw new Error('An inkling folder needs the identity id');
  return join(root, sbId.toLowerCase());
}

/**
 * The tool-policy file an inkling's turn runs against (task 0321ccf1), in
 * place of the machine's own, whose grants are the operator's and must never
 * reach an inkling. It sits beside the inklings' folders, never inside one,
 * so nothing its turn can read or reach writes it. `ink chat` creates it.
 */
export function inklingToolPolicyPath(sbId: string, root: string = inklingsRoot()): string {
  if (!isUuid(sbId)) throw new Error('An inkling tool policy needs the identity id');
  return join(root, '.tool-policy', `${sbId.toLowerCase()}.json`);
}

/** The folder, created if it is not there yet. */
export async function ensureInklingFolder(
  sbId: string,
  root: string = inklingsRoot()
): Promise<string> {
  const folder = inklingFolder(sbId, root);
  await mkdir(folder, { recursive: true });
  return folder;
}
