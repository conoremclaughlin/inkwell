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

  let unmounted = false;

  const onExit = () => {
    unmounted = true;
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

  return {
    addEvent: (event) => {
      if (!unmounted && handleRef.current) handleRef.current.addEvent(event);
    },
    setAgents: (agents) => {
      if (!unmounted && handleRef.current) handleRef.current.setAgents(agents);
    },
    setStatus: (status) => {
      if (!unmounted && handleRef.current) handleRef.current.setStatus(status);
    },
    cleanup: () => {
      unmounted = true;
      unmount();
    },
    waitForExit: () => exitPromise,
  };
}
