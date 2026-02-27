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

export function renderInkMission(options: { timezone?: string }): InkMission {
  const handleRef =
    React.createRef<MissionAppHandle>() as React.MutableRefObject<MissionAppHandle | null>;

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

  // Pre-clear ghost lines on resize (see renderApp.tsx for explanation).
  const onResize = () => {
    const clearLines = 20;
    let seq = '\x1b7';
    for (let i = 0; i < clearLines; i++) {
      seq += '\x1b[1A\x1b[2K';
    }
    seq += '\x1b8';
    process.stdout.write(seq);
  };
  process.stdout.on('resize', onResize);

  const { unmount } = render(
    <MissionApp ref={handleRef} timezone={options.timezone} onExit={onExit} />
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
      process.stdout.off('resize', onResize);
      unmount();
    },
    waitForExit: () => exitPromise,
  };
}
