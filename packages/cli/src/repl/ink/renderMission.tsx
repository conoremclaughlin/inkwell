import React from 'react';
import { render } from 'ink';
import {
  MissionApp,
  type MissionAppHandle,
  type FeedEvent,
  type AgentSummary,
} from './MissionApp.js';

export interface InkMission {
  addEvent: (event: FeedEvent) => void;
  setAgents: (agents: AgentSummary[]) => void;
  setStatus: (status: string) => void;
  cleanup: () => void;
  /** Resolves when the user exits (double Ctrl+C). */
  waitForExit: () => Promise<void>;
}

export function renderInkMission(options: { timezone?: string; fullscreen?: boolean }): InkMission {
  const handleRef =
    React.createRef<MissionAppHandle>() as React.MutableRefObject<MissionAppHandle | null>;
  const fullscreen = !!options.fullscreen;

  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  const onExit = () => {
    if (exitResolve) {
      exitResolve();
      exitResolve = null;
    }
  };

  // alternateBuffer (--fullscreen): app-controlled viewport, eliminates scroll snapback.
  // incrementalRendering: line-by-line diffing — always on for better performance.
  const { unmount } = render(
    <MissionApp
      ref={handleRef}
      timezone={options.timezone}
      fullscreen={fullscreen}
      onExit={onExit}
    />,
    { alternateBuffer: fullscreen, incrementalRendering: true }
  );

  const getHandle = (): MissionAppHandle => {
    if (!handleRef.current) {
      throw new Error('MissionApp handle not available');
    }
    return handleRef.current;
  };

  return {
    addEvent: (event) => getHandle().addEvent(event),
    setAgents: (agents) => getHandle().setAgents(agents),
    setStatus: (status) => getHandle().setStatus(status),
    cleanup: () => {
      unmount();
    },
    waitForExit: () => exitPromise,
  };
}
