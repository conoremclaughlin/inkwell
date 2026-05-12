'use client';

import { useState } from 'react';
import { useCommandStore } from './store';
import { getSkin } from './skins';
import { useCommandData } from './data-hooks';
import { SpatialMap } from './spatial-map';
import { TaskGraph } from './task-graph';
import { ActivityLog } from './activity-log';
import { AgentPanel } from './agent-panel';
import { SkinPicker } from './skin-picker';

type ViewMode = 'split' | 'map' | 'graph';

export function CommandCenter() {
  useCommandData();

  const skin = getSkin(useCommandStore((s) => s.skin));
  const [viewMode, setViewMode] = useState<ViewMode>('map');

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: skin.colors.bg, color: skin.colors.text }}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-1.5 border-b shrink-0"
        style={{
          backgroundColor: skin.colors.surface,
          borderColor: skin.colors.border,
        }}
      >
        <div className="flex items-center gap-4">
          <h1
            className="text-xs font-bold tracking-wider"
            style={{ fontFamily: skin.fonts.heading, color: skin.colors.accent }}
          >
            COMMAND CENTER
          </h1>
          <div className="flex items-center gap-1">
            {(['split', 'map', 'graph'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                className="px-2 py-0.5 rounded text-xs transition-all"
                style={{
                  backgroundColor: viewMode === mode ? skin.colors.accent + '20' : 'transparent',
                  color: viewMode === mode ? skin.colors.accent : skin.colors.textMuted,
                  fontFamily: skin.fonts.mono,
                  fontSize: '11px',
                }}
              >
                {mode === 'split' ? 'SPLIT' : mode === 'map' ? 'MAP' : 'TASKS'}
              </button>
            ))}
          </div>
        </div>
        <SkinPicker />
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: spatial map + task graph */}
        <div className="flex-1 flex flex-col relative">
          {viewMode === 'split' ? (
            <>
              <div className="relative" style={{ height: '60%' }}>
                <SpatialMap />
                <AgentPanel />
              </div>
              <div className="border-t" style={{ borderColor: skin.colors.border, height: '40%' }}>
                <TaskGraph />
              </div>
            </>
          ) : viewMode === 'map' ? (
            <div className="flex-1 relative">
              <SpatialMap />
              <AgentPanel />
            </div>
          ) : (
            <div className="flex-1">
              <TaskGraph />
            </div>
          )}
        </div>

        {/* Right panel: activity log */}
        <div className="w-64 border-l shrink-0" style={{ borderColor: skin.colors.border }}>
          <ActivityLog />
        </div>
      </div>
    </div>
  );
}
