import type { SkillMcpServer } from './skill-mcp.js';

/** Scan complete lines: whitespace must never backtrack across line boundaries. */
function blockAfter(lines: string[], header: string, member: (line: string) => boolean): string[] {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return [];
  const result: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!member(lines[i])) break;
    result.push(lines[i]);
  }
  return result;
}

export function parseSkillMcpContent(content: string): SkillMcpServer | null {
  // Extract YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];

  // Simple YAML parsing for the mcp block — avoids adding a yaml dependency.
  // Looks for:
  //   mcp:
  //     name: <string>
  //     command: <string>
  //     args: [...]
  //     env: {}
  // Include the final property even without a trailing newline in the capture.
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => /^mcp:[ \t]*$/.test(line));
  if (start === -1) return null;
  let first = start + 1;
  while (first < lines.length && !lines[first].trim()) first++;
  const mcpLines: string[] = [];
  for (let i = first; i < lines.length && /^  .+/.test(lines[i]); i++) mcpLines.push(lines[i]);
  const matchLine = (pattern: RegExp) => {
    for (const line of mcpLines) {
      const match = pattern.exec(line);
      if (match) return match;
    }
    return null;
  };

  const name = matchLine(/^[ \t]*name:[ \t]*(.+)/)?.[1]?.trim();
  const command = matchLine(/^[ \t]*command:[ \t]*(.+)/)?.[1]?.trim();

  if (!name || !command) return null;

  // Inline args/env must fit one physical line; use block forms for multiline values.
  // Parse args — inline [a, b] or block-style list (- a\n- b)
  let args: string[] = [];
  const argsInlineMatch = matchLine(/^[ \t]*args:[ \t]*\[([^\]]*)\]/);
  if (argsInlineMatch) {
    args = argsInlineMatch[1]
      .split(',')
      .map((a) => a.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  } else {
    // Block-style: args:\n    - value1\n    - value2
    const argsBlock = blockAfter(mcpLines, 'args:', (line) => {
      const value = line.replace(/^[ \t]+/, '');
      return (
        value.length < line.length &&
        value[0] === '-' &&
        (value[1] === ' ' || value[1] === '\t') &&
        !/[\r\u2028\u2029]/.test(value)
      );
    });
    if (argsBlock.length) {
      args = argsBlock
        .map((line) =>
          line
            .replace(/^[ \t]*-[ \t]+/, '')
            .trim()
            .replace(/^["']|["']$/g, '')
        )
        .filter(Boolean);
    }
  }

  // Parse env — inline {K: V} or block-style (K: V\n K2: V2)
  const env: Record<string, string> = {};
  const envInlineMatch = matchLine(/^[ \t]*env:[ \t]*\{([^}]*)\}/);
  if (envInlineMatch && envInlineMatch[1].trim()) {
    envInlineMatch[1].split(',').forEach((pair) => {
      const [k, v] = pair.split(':').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      if (k && v) env[k] = v;
    });
  } else {
    // Block-style: env:\n    KEY: VALUE
    const envBlock = blockAfter(mcpLines, 'env:', (line) => /^[ \t]+\w+:.+$/.test(line));
    if (envBlock.length) {
      envBlock.forEach((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return;
        const k = line.slice(0, colonIdx).trim();
        const v = line
          .slice(colonIdx + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (k && v) env[k] = v;
      });
    }
  }

  return { name, command, args, env: Object.keys(env).length > 0 ? env : undefined };
}
