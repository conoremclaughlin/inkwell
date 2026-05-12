import type { SkinId } from './store';

export interface SkinConfig {
  id: SkinId;
  label: string;
  colors: {
    bg: string;
    surface: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    agentIdle: string;
    agentActive: string;
    agentBlocked: string;
    studioActive: string;
    studioIdle: string;
    taskPending: string;
    taskInProgress: string;
    taskCompleted: string;
    taskBlocked: string;
  };
  fonts: {
    heading: string;
    body: string;
    mono: string;
  };
  avatarStyle: 'pixel' | 'circle' | 'hex';
  studioShape: 'rounded' | 'sharp' | 'hex';
  animationSpeed: number;
}

const PIXEL_SKIN: SkinConfig = {
  id: 'pixel',
  label: '🎮 Pixel RPG',
  colors: {
    bg: '#1a1a2e',
    surface: '#16213e',
    border: '#0f3460',
    text: '#e8e8e8',
    textMuted: '#8888aa',
    accent: '#e94560',
    agentIdle: '#4ecca3',
    agentActive: '#00d2ff',
    agentBlocked: '#ff6b6b',
    studioActive: '#4ecca3',
    studioIdle: '#444466',
    taskPending: '#8888aa',
    taskInProgress: '#00d2ff',
    taskCompleted: '#4ecca3',
    taskBlocked: '#ff6b6b',
  },
  fonts: {
    heading: '"Press Start 2P", monospace',
    body: '"Courier New", monospace',
    mono: '"Courier New", monospace',
  },
  avatarStyle: 'pixel',
  studioShape: 'sharp',
  animationSpeed: 1,
};

const SCIFI_SKIN: SkinConfig = {
  id: 'scifi',
  label: '🚀 Sci-Fi',
  colors: {
    bg: '#0a0a0f',
    surface: '#111122',
    border: '#1a1a3e',
    text: '#c8d6e5',
    textMuted: '#576574',
    accent: '#0abde3',
    agentIdle: '#10ac84',
    agentActive: '#0abde3',
    agentBlocked: '#ee5a24',
    studioActive: '#10ac84',
    studioIdle: '#333355',
    taskPending: '#576574',
    taskInProgress: '#0abde3',
    taskCompleted: '#10ac84',
    taskBlocked: '#ee5a24',
  },
  fonts: {
    heading: '"Orbitron", sans-serif',
    body: '"Rajdhani", sans-serif',
    mono: '"Fira Code", monospace',
  },
  avatarStyle: 'hex',
  studioShape: 'hex',
  animationSpeed: 0.8,
};

const MINIMAL_SKIN: SkinConfig = {
  id: 'minimal',
  label: '📋 Minimal',
  colors: {
    bg: '#fafafa',
    surface: '#ffffff',
    border: '#e5e7eb',
    text: '#111827',
    textMuted: '#6b7280',
    accent: '#3b82f6',
    agentIdle: '#10b981',
    agentActive: '#3b82f6',
    agentBlocked: '#ef4444',
    studioActive: '#10b981',
    studioIdle: '#d1d5db',
    taskPending: '#9ca3af',
    taskInProgress: '#3b82f6',
    taskCompleted: '#10b981',
    taskBlocked: '#ef4444',
  },
  fonts: {
    heading: '"Inter", sans-serif',
    body: '"Inter", sans-serif',
    mono: '"JetBrains Mono", monospace',
  },
  avatarStyle: 'circle',
  studioShape: 'rounded',
  animationSpeed: 0.6,
};

export const SKINS: Record<SkinId, SkinConfig> = {
  pixel: PIXEL_SKIN,
  scifi: SCIFI_SKIN,
  minimal: MINIMAL_SKIN,
};

export function getSkin(id: SkinId): SkinConfig {
  return SKINS[id];
}
