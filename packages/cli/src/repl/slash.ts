export interface SlashCommand {
  name: string;
  args: string[];
  raw: string;
}

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const raw = trimmed.slice(1);
  if (!raw) return null;

  const [name, ...args] = raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!name) return null;

  return {
    name: name.toLowerCase(),
    args,
    raw,
  };
}

