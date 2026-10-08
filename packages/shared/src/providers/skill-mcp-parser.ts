import type { SkillMcpServer } from './skill-mcp.js';
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
  // `\n?` on the last line: the frontmatter capture strips the newline before
  // the closing ---, so an mcp block that ends the frontmatter would otherwise
  // silently lose its final property.
  const mcpMatch = frontmatter.match(/^mcp:\s*\n((?:  .+\n?)*)/m);
  if (!mcpMatch) return null;

  const mcpBlock = mcpMatch[1];

  const name = mcpBlock.match(/^\s*name:\s*(.+)/m)?.[1]?.trim();
  const command = mcpBlock.match(/^\s*command:\s*(.+)/m)?.[1]?.trim();

  if (!name || !command) return null;

  // Parse args — inline [a, b] or block-style list (- a\n- b)
  let args: string[] = [];
  const argsInlineMatch = mcpBlock.match(/^\s*args:\s*\[([^\]]*)\]/m);
  if (argsInlineMatch) {
    args = argsInlineMatch[1]
      .split(',')
      .map((a) => a.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  } else {
    // Block-style: args:\n    - value1\n    - value2
    const argsBlockMatch = mcpBlock.match(/^\s*args:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (argsBlockMatch) {
      args = argsBlockMatch[1]
        .split('\n')
        .map((line) =>
          line
            .replace(/^\s*-\s+/, '')
            .trim()
            .replace(/^["']|["']$/g, '')
        )
        .filter(Boolean);
    }
  }

  // Parse env — inline {K: V} or block-style (K: V\n K2: V2)
  const env: Record<string, string> = {};
  const envInlineMatch = mcpBlock.match(/^\s*env:\s*\{([^}]*)\}/m);
  if (envInlineMatch && envInlineMatch[1].trim()) {
    envInlineMatch[1].split(',').forEach((pair) => {
      const [k, v] = pair.split(':').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      if (k && v) env[k] = v;
    });
  } else {
    // Block-style: env:\n    KEY: VALUE
    const envBlockMatch = mcpBlock.match(/^\s*env:\s*\n((?:\s+\w+:.+\n?)*)/m);
    if (envBlockMatch) {
      envBlockMatch[1].split('\n').forEach((line) => {
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
