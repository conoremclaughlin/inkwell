import { describe, it, expect } from 'vitest';
import type { LoadedSkill } from './types';
import { mergeSkillsByPriority, cloudInstalledSkillToLoaded } from './providers';

function makeLoadedSkill(name: string, sourcePath: string): LoadedSkill {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: `${name} description`,
      type: 'guide',
      displayName: name,
    },
    skillContent: `# ${name}`,
    sourcePath,
    eligibility: { eligible: true },
  };
}

describe('skill providers', () => {
  describe('mergeSkillsByPriority', () => {
    it('applies deterministic source precedence (later source overrides earlier)', () => {
      const cloudSkill = makeLoadedSkill('shared-skill', 'cloud://abc');
      const localSkill = makeLoadedSkill('shared-skill', '/Users/test/.pcp/skills/shared-skill.md');

      const merged = mergeSkillsByPriority(
        [
          { source: 'cloud', skills: [cloudSkill] },
          { source: 'local', skills: [localSkill] },
        ],
        ['cloud', 'local']
      );

      expect(merged).toHaveLength(1);
      expect(merged[0].sourcePath).toBe('/Users/test/.pcp/skills/shared-skill.md');
    });

    it('returns deterministic alphabetical ordering of final skills', () => {
      const merged = mergeSkillsByPriority(
        [
          {
            source: 'cloud',
            skills: [makeLoadedSkill('zeta', 'cloud://z'), makeLoadedSkill('alpha', 'cloud://a')],
          },
        ],
        ['cloud', 'local']
      );

      expect(merged.map((s) => s.manifest.name)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('cloudInstalledSkillToLoaded', () => {
    it('converts cloud installed skill shape into runtime loaded skill', () => {
      const loaded = cloudInstalledSkillToLoaded({
        installationId: 'inst-1',
        userId: 'user-1',
        enabled: true,
        userConfig: {},
        versionPinned: null,
        installedAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
        usageCount: 0,
        skillId: 'skill-1',
        name: 'browser-check',
        displayName: 'Browser Check',
        description: 'Checks a site in browser',
        type: 'guide',
        category: 'qa',
        tags: ['browser', 'qa'],
        emoji: '🧪',
        currentVersion: '1.0.0',
        manifest: {
          name: 'browser-check',
          version: '1.0.0',
          description: 'Checks a site in browser',
          type: 'guide',
        },
        content: '# Browser Check',
        isOfficial: false,
        isVerified: false,
        author: null,
        repositoryUrl: null,
        resolvedContent: '# Browser Check',
        resolvedManifest: {
          name: 'browser-check',
          version: '1.1.0',
          description: 'Checks a site in browser',
          type: 'guide',
        },
        resolvedVersion: '1.1.0',
      });

      expect(loaded.manifest.name).toBe('browser-check');
      expect(loaded.manifest.version).toBe('1.1.0');
      expect(loaded.skillContent).toBe('# Browser Check');
      expect(loaded.sourcePath).toBe('cloud://skill-1');
    });
  });
});
