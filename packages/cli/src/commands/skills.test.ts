import { describe, expect, it } from 'vitest';
import { buildSkillMd } from './skills.js';

describe('buildSkillMd', () => {
  it('serializes empty nested MCP env objects as valid YAML', () => {
    const skillMd = buildSkillMd({
      success: true,
      skillName: 'playwright-mcp',
      type: 'cli',
      version: '1.0.0',
      description: 'Playwright MCP',
      content: '# Playwright MCP',
      triggers: {
        keywords: ['playwright', 'browser'],
      },
      mcp: {
        name: 'playwright',
        command: 'npx',
        args: ['@playwright/mcp', '--headless'],
        env: {},
      },
    });

    expect(skillMd).toContain('env: {}');
    expect(skillMd).not.toContain('env:\n{}');
    expect(skillMd).toContain('env: {}\n---\n');
  });
});
