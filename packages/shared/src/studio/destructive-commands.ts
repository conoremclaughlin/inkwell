/**
 * Destructive local commands, decided in the PreToolUse hook rather than by
 * a deny rule (spec automated-turn-permissions §3.4).
 *
 * A deny rule cannot be approved by anyone: deny is evaluated first, and a
 * hook's answer does not override it (Claude Code docs, permissions,
 * "Extend permissions with hooks"). `Bash(rm -rf *)` therefore left no way
 * to approve deleting a build cache, even with Conor at the terminal
 * (2026-10-13). These commands now reach the hook, which decides:
 *
 *   - `allowed`: a delete the session may make without asking;
 *   - `needs-approval`: destructive, and not that. For an unattended turn
 *     the hook requests Conor's approval, except a recursive rm it could not
 *     read (`asPlainRm`), which it first sends back to be run as a plain rm;
 *   - `not-destructive`: nothing for this module to decide.
 *
 * THE ALLOWANCE IS DELIBERATELY TINY (Lumen's review, 63ae5a80). This is
 * not a shell parser, and it does not claim to contain arbitrary Bash. A
 * command is allowed only when it is a single simple `rm` with recursive or
 * force flags and plain path operands, each strictly inside an allowed root
 * and never the root itself. Every construct the check does not model
 * (operators, redirections, substitutions, quotes, escapes, globs, `--`,
 * wrappers, any other flag) needs approval. `git` is never allowed here:
 * `git reset --hard` and `git clean` always ask.
 *
 * DETECTION IS BROAD; ALLOWANCE IS NARROW. Over-detecting only costs a
 * question. Detection is at least as wide as the deny rules it replaces,
 * which matched these commands at the start of each subcommand.
 *
 * LIMITS. The check is made against the filesystem when the hook runs. A
 * symlink swapped in between the check and the delete, a hard link, or a
 * mount point inside a root is not caught. Path classification is not
 * filesystem isolation; that is the sandbox, which is separate work.
 */

import { isAbsolute, join, posix } from 'path';

export type DestructiveVerdict =
  | { kind: 'not-destructive' }
  | { kind: 'allowed'; targets: string[] }
  | {
      kind: 'needs-approval';
      reason: string;
      /**
       * A recursive rm the check could not read because of what surrounds it
       * (a script, a wrapper, an operator, a variable). Run as its own plain
       * `rm`, it is fully checked: allowed inside a root, asked for outside.
       * So an unattended turn is told to do that before anyone is asked.
       */
      asPlainRm?: true;
    };

/** The filesystem reads the classifier needs, injected for tests. */
export interface DestructiveFs {
  /** The real path of an existing path, or null when it does not exist. */
  realpath(path: string): string | null;
  /** Whether the path itself (not its target) is a symbolic link. */
  isSymlink(path: string): boolean;
}

export interface DestructiveContext {
  /** The directory the command runs in: the hook input's `cwd`. */
  cwd: string;
  /** The home directory, for a leading `~/` in an operand. */
  home: string;
  /** Directories inside which a delete is allowed, already chosen by the caller. */
  roots: readonly string[];
}

/** Characters whose presence means the command is not a single simple command. */
const UNMODELLED = /[;&|<>()$`'"\\*?[\]{}!#\n\r\t]/;

/**
 * Programs that run what they read as commands. A heredoc fed to one of
 * these, directly or through a pipe, is code, and its body stays in view.
 * Wrappers that run another program (sudo, env, timeout) count too: what
 * they wrap is not known here.
 */
const HEREDOC_RUNNERS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'source',
  '.',
  'exec',
  'ssh',
  'xargs',
  'sudo',
  'su',
  'env',
  'nohup',
  'timeout',
  'nice',
  'doas',
]);

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** The first program word of the last command segment in `text`. */
function lastProgram(text: string): string | null {
  const segment = text.split(/[;&|(]/).pop() ?? '';
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const first = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return first ? posix.basename(first) : null;
}

/**
 * The command with the bodies of data heredocs removed, for detection only:
 * a commit message or a file written with `cat > f <<'EOF'` that mentions
 * `rm -rf` deletes nothing. A heredoc stays when what
 * reads it runs commands (`bash <<EOF`, `cat <<EOF | sh`). This narrows only
 * what is asked about; nothing it removes could ever have been allowed,
 * since any heredoc makes a command one the allowance does not model.
 */
export function withoutDataHeredocs(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const bodies: Array<{ delimiter: string; data: boolean; dash: boolean }> = [];
    for (const match of line.matchAll(HEREDOC)) {
      const before = line.slice(0, match.index);
      const after = line.slice((match.index ?? 0) + match[0].length);
      const reader = lastProgram(before);
      const pipedTo = /\|/.test(after) ? lastProgram(after.slice(after.indexOf('|') + 1)) : null;
      const runs =
        reader === null ||
        HEREDOC_RUNNERS.has(reader) ||
        (pipedTo !== null && HEREDOC_RUNNERS.has(pipedTo));
      bodies.push({ delimiter: match[2], data: !runs, dash: match[0].startsWith('<<-') });
    }
    for (const body of bodies) {
      while (i + 1 < lines.length) {
        const next = lines[++i];
        const end = (body.dash ? next.replace(/^\t+/, '') : next) === body.delimiter;
        if (end || !body.data) kept.push(next);
        if (end) break;
      }
    }
  }
  return kept.join('\n');
}

/**
 * The command's words for detection: split on whitespace, shell operators
 * and quote characters, so a quoted or wrapped command (`bash -c "rm -rf
 * x"`, `timeout 5 rm -r x`) is still seen. A rough cut, used only to decide
 * whether to ask, never to allow.
 */
function detectionWords(command: string): string[] {
  return command.split(/[\s;&|()`'"$<>]+/).filter(Boolean);
}

const RM_FLAG = /^(?:-[rRf]+|--recursive|--force)$/;

function isRecursiveRmFlag(token: string): boolean {
  if (token === '--recursive') return true;
  return /^-[A-Za-z]*[rR][A-Za-z]*$/.test(token);
}

/** Strip a leading path from a program name: `/bin/rm` is `rm`. */
function program(word: string): string {
  return posix.basename(word);
}

/** `git [-C dir] [-c k=v] <sub> ...` → the subcommand and its arguments. */
function gitArgs(words: string[]): string[] | null {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    i += words[i] === '-C' || words[i] === '-c' || words[i] === '--git-dir' ? 2 : 1;
  }
  return i < words.length ? words.slice(i) : null;
}

/**
 * What destructive thing the words starting here do, if any. `rm` counts
 * when a recursive flag follows it anywhere later in the command: broad on
 * purpose, since over-detecting only costs a question.
 */
function destructiveKindAt(words: string[]): string | null {
  const name = program(words[0]);
  if (name === 'rm' && words.slice(1).some(isRecursiveRmFlag)) return 'a recursive rm';
  if (name === 'git') {
    const args = gitArgs(words);
    if (!args) return null;
    if (args[0] === 'reset' && args.includes('--hard')) return 'git reset --hard';
    if (args[0] === 'clean' && args.slice(1).some((a) => /^-[A-Za-z]*f/.test(a) || a === '--force'))
      return 'git clean -f';
    if (args[0] === 'checkout' && args.includes('--') && args[args.indexOf('--') + 1] === '.')
      return 'git checkout -- .';
  }
  return null;
}

/** Whether `child` lies strictly inside `root` (both real, absolute paths). */
function strictlyInside(child: string, root: string): boolean {
  const base = root.endsWith('/') ? root : `${root}/`;
  return child !== root && child.startsWith(base);
}

/**
 * The real path a target names, without following the target itself: the
 * real path of its deepest existing ancestor, joined to the rest. Null when
 * no ancestor resolves.
 */
function realTarget(absolute: string, fs: DestructiveFs): string | null {
  const parts = absolute.split('/').filter(Boolean);
  for (let keep = parts.length - 1; keep >= 0; keep--) {
    const ancestor = '/' + parts.slice(0, keep).join('/');
    const real = fs.realpath(ancestor);
    if (real !== null) return posix.join(real, ...parts.slice(keep));
  }
  return null;
}

export function classifyDestructiveCommand(
  command: string,
  context: DestructiveContext,
  fs: DestructiveFs
): DestructiveVerdict {
  const words = detectionWords(withoutDataHeredocs(command));
  const kinds = words
    .map((_, i) => destructiveKindAt(words.slice(i)))
    .filter((kind): kind is string => kind !== null);
  if (kinds.length === 0) return { kind: 'not-destructive' };
  const what = kinds[0];
  const needs = (why: string, asPlainRm = false): DestructiveVerdict => ({
    kind: 'needs-approval',
    reason: `${what}: ${why}`,
    ...(asPlainRm ? { asPlainRm: true as const } : {}),
  });
  const text = command.trim();
  // Sent back to be run plain only when it can be: every destructive thing
  // found is an rm (a git reset or clean is asked about as is), and the rm
  // is wrapped in something, a script, an operator or another program. A
  // single rm whose operands need quotes or escapes is already as plain as
  // it gets, so it is asked about as written (Lumen, #861).
  const onlyRm = kinds.every((kind) => kind === 'a recursive rm');
  const wrapped = /[;&|<>()$`\n\r]/.test(text) || text.split(/\s+/)[0] !== 'rm';
  const asPlain = onlyRm && wrapped;

  if (UNMODELLED.test(text)) {
    return needs('the command is not one simple command the check models', asPlain);
  }
  const argv = text.split(/ +/);
  if (argv[0] !== 'rm') return needs('only a plain rm is ever allowed without asking', asPlain);

  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    if (!RM_FLAG.test(argv[i])) return needs(`the flag ${argv[i]} is not one the check allows`);
    i++;
  }
  const operands = argv.slice(i);
  if (operands.length === 0) return needs('there is no path to check');

  const realRoots = context.roots
    .map((root) => (isAbsolute(root) ? fs.realpath(root) : null))
    .filter((root): root is string => root !== null);
  if (realRoots.length === 0) return needs('this session has no directory it may delete inside');

  const targets: string[] = [];
  for (const operand of operands) {
    if (operand.startsWith('-')) return needs(`${operand} reads as a flag after the paths`);
    if (operand.endsWith('/')) return needs(`${operand} ends in a slash, which follows a link`);
    // `link/..` is erased by lexical normalisation, but the kernel resolves
    // the link first, so `rm -rf link/../x` reaches outside (Lumen, #853).
    if (operand.split('/').includes('..')) {
      return needs(`${operand} has a .. segment, which a symlink before it can redirect`);
    }
    if (operand.includes('~') && !operand.startsWith('~/')) {
      return needs(`${operand} uses ~ in a form the check does not expand`);
    }
    const expanded = operand.startsWith('~/') ? join(context.home, operand.slice(2)) : operand;
    const absolute = posix.normalize(
      isAbsolute(expanded) ? expanded : posix.join(context.cwd, expanded)
    );
    if (fs.isSymlink(absolute)) return needs(`${operand} is a symbolic link`);
    const real = realTarget(absolute, fs);
    if (real === null) return needs(`${operand} cannot be resolved`);
    if (!realRoots.some((root) => strictlyInside(real, root))) {
      return needs(`${operand} is not inside a directory this session may delete in`);
    }
    targets.push(real);
  }
  return { kind: 'allowed', targets };
}
