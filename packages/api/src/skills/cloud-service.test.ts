import { describe, it, expect } from 'vitest';
import type { LoadedSkill } from './types';
import { CloudSkillsService } from './cloud-service';
import type { SkillSourceProvider } from './providers';

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

describe('CloudSkillsService', () => {
  it('applies configured deterministic source priority when loading user skills', async () => {
    const providers: SkillSourceProvider[] = [
      {
        id: 'cloud',
        loadUserSkills: async () => [makeLoadedSkill('shared', 'cloud://shared')],
      },
      {
        id: 'local',
        loadUserSkills: async () => [makeLoadedSkill('shared', '/tmp/shared.md')],
      },
    ];

    const service = new CloudSkillsService({} as never, {
      providers,
      sourcePriority: ['cloud', 'local'],
    });

    const loaded = await service.loadUserSkills('user-1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sourcePath).toBe('/tmp/shared.md');
  });

  it('continues loading if one provider fails', async () => {
    const providers: SkillSourceProvider[] = [
      {
        id: 'cloud',
        loadUserSkills: async () => {
          throw new Error('cloud unavailable');
        },
      },
      {
        id: 'local',
        loadUserSkills: async () => [makeLoadedSkill('local-only', '/tmp/local-only.md')],
      },
    ];

    const service = new CloudSkillsService({} as never, { providers });
    const loaded = await service.loadUserSkills('user-1');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].manifest.name).toBe('local-only');
  });
});
