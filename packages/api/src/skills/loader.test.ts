/**
 * Tests for Skill Loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

// Mock child_process for eligibility checks
vi.mock('child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
}));

// Mock os
vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
}));

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';

// Must import after mocks are set up
const loaderModule = await import('./loader');
const { loadAllSkills, loadSkillByName, getSkillPaths } = loaderModule;

describe('Skill Loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directories exist but are empty
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
      typeof statSync
    >);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadAllSkills', () => {
    it('should return empty array when no skills exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const skills = loadAllSkills('/test/user/skills');
      expect(skills).toEqual([]);
    });

    it('should load a single-file skill with YAML frontmatter', () => {
      const skillContent = `---
name: test-skill
version: "1.0.0"
displayName: Test Skill
description: A test skill
type: guide
category: testing
tags:
  - test
  - example
triggers:
  keywords:
    - test
    - example
---

# Test Skill

This is the skill content.
`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['test-skill.md'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockReturnValue(skillContent);

      const skills = loadAllSkills('/test/user/skills');

      expect(skills.length).toBe(1);
      expect(skills[0].manifest.name).toBe('test-skill');
      expect(skills[0].manifest.displayName).toBe('Test Skill');
      expect(skills[0].manifest.description).toBe('A test skill');
      expect(skills[0].manifest.type).toBe('guide');
      expect(skills[0].manifest.category).toBe('testing');
      expect(skills[0].manifest.tags).toEqual(['test', 'example']);
      expect(skills[0].manifest.triggers?.keywords).toEqual(['test', 'example']);
      expect(skills[0].skillContent).toBe('# Test Skill\n\nThis is the skill content.');
    });

    it('should load a directory-based skill with manifest.yaml', () => {
      const manifestYaml = `
name: dir-skill
version: "2.0.0"
displayName: Directory Skill
description: A directory-based skill
type: mini-app
category: productivity
`;

      const skillMd = `# Directory Skill

Instructions for this skill.
`;

      vi.mocked(existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        return (
          pathStr.includes('manifest.yaml') ||
          pathStr.includes('SKILL.md') ||
          pathStr.includes('builtin') ||
          pathStr.includes('user')
        );
      });
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['dir-skill'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p).includes('manifest.yaml')) {
          return manifestYaml;
        }
        if (String(p).includes('SKILL.md')) {
          return skillMd;
        }
        return '';
      });

      const skills = loadAllSkills('/test/user/skills');

      expect(skills.length).toBe(1);
      expect(skills[0].manifest.name).toBe('dir-skill');
      expect(skills[0].manifest.version).toBe('2.0.0');
      expect(skills[0].manifest.type).toBe('mini-app');
      expect(skills[0].skillContent).toContain('# Directory Skill');
      expect(skills[0].skillContent).toContain('Instructions for this skill');
    });

    it('should skip README.md files', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['README.md', 'real-skill.md'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p).includes('README')) {
          return '# README';
        }
        return `---
name: real-skill
version: "1.0.0"
description: A real skill
type: guide
---

Real content.
`;
      });

      const skills = loadAllSkills('/test/user/skills');

      // Should only load real-skill, not README
      expect(skills.length).toBe(1);
      expect(skills[0].manifest.name).toBe('real-skill');
    });

    it('should handle malformed YAML gracefully', () => {
      const badSkill = `---
name: bad-skill
version: 1.0.0  # Missing quotes
description:
  - this is wrong
---

Content
`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['bad-skill.md'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockReturnValue(badSkill);

      // Should not throw, just skip the bad skill or return partial data
      expect(() => loadAllSkills('/test/user/skills')).not.toThrow();
    });

    it('should handle files without frontmatter', () => {
      const noFrontmatter = `# Just Markdown

No YAML here.
`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['no-frontmatter.md'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockReturnValue(noFrontmatter);

      const skills = loadAllSkills('/test/user/skills');

      // Should still load with defaults
      expect(skills.length).toBe(1);
      expect(skills[0].manifest.name).toBe('no-frontmatter');
      expect(skills[0].manifest.version).toBe('1.0.0');
      expect(skills[0].manifest.type).toBe('guide'); // default
    });
  });

  describe('loadSkillByName', () => {
    it('should find a skill by name', () => {
      const skillContent = `---
name: find-me
version: "1.0.0"
description: Find me
type: guide
---

Found!
`;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((dir) => {
        if (String(dir).includes('builtin')) {
          return ['find-me.md', 'other.md'] as unknown as ReturnType<typeof readdirSync>;
        }
        return [] as unknown as ReturnType<typeof readdirSync>;
      });
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<
        typeof statSync
      >);
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p).includes('find-me')) {
          return skillContent;
        }
        return `---
name: other
version: "1.0.0"
description: Other
type: guide
---

Other content.
`;
      });

      const skill = loadSkillByName('find-me', '/test/user/skills');

      expect(skill).not.toBeNull();
      expect(skill?.manifest.name).toBe('find-me');
    });

    it('should return null for non-existent skill', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([]);

      const skill = loadSkillByName('does-not-exist', '/test/user/skills');
      expect(skill).toBeNull();
    });
  });

  describe('getSkillPaths', () => {
    it('should return builtin and user paths', () => {
      const paths = getSkillPaths('/custom/user/path');

      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain('builtin');
      expect(paths[1]).toBe('/custom/user/path');
    });

    it('should use default user path when not specified', () => {
      const paths = getSkillPaths();

      expect(paths).toHaveLength(2);
      expect(paths[1]).toContain('.pcp/skills');
    });
  });
});
