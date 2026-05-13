'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCommandStore } from './store';
import { getSkin } from './skins';
import type { SkinConfig } from './skins';
import type { AgentState, StudioNode } from './store';

const AGENT_COLORS: Record<string, string> = {
  wren: '#e94560',
  lumen: '#0abde3',
  aster: '#f9ca24',
  myra: '#6c5ce7',
  benson: '#00b894',
  echo: '#ff9ff3',
};

function getAgentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? '#888888';
}

function getPhaseLabel(phase: string | null): string {
  if (!phase) return 'idle';
  if (phase.startsWith('active:')) return phase.slice(7);
  if (phase.startsWith('blocked:')) return 'BLOCKED';
  if (phase.startsWith('waiting:')) return phase.split(':').slice(1).join(':');
  return phase;
}

function getLifecycleIcon(lifecycle: string | null, phase: string | null): string {
  if (phase?.startsWith('blocked')) return '!!';
  if (lifecycle === 'running') return '>>';
  if (lifecycle === 'failed') return 'XX';
  if (lifecycle === 'completed') return 'OK';
  return 'zz';
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawPixelChar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  isRunning: boolean
) {
  const s = size / 8;
  ctx.fillStyle = color;

  // Body (wider rectangle)
  ctx.fillRect(x - 3 * s, y - 3 * s, 6 * s, 7 * s);
  // Head (top block)
  ctx.fillRect(x - 2.5 * s, y - 4.5 * s, 5 * s, 2 * s);

  // Eyes
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - 2 * s, y - 3.5 * s, 1.5 * s, 1.5 * s);
  ctx.fillRect(x + 0.5 * s, y - 3.5 * s, 1.5 * s, 1.5 * s);

  // Pupils
  ctx.fillStyle = '#000000';
  ctx.fillRect(x - 1.5 * s, y - 3 * s, s, s);
  ctx.fillRect(x + 1 * s, y - 3 * s, s, s);

  // Mouth (changes with state)
  ctx.fillStyle = '#ffffff';
  if (isRunning) {
    ctx.fillRect(x - 1.5 * s, y + 0.5 * s, 3 * s, s);
  } else {
    ctx.fillRect(x - s, y + 0.5 * s, 2 * s, 0.5 * s);
  }

  // Arms
  ctx.fillStyle = color;
  ctx.fillRect(x - 4.5 * s, y - 2 * s, 1.5 * s, 4 * s);
  ctx.fillRect(x + 3 * s, y - 2 * s, 1.5 * s, 4 * s);

  // Legs
  ctx.fillRect(x - 2.5 * s, y + 4 * s, 2 * s, 2 * s);
  ctx.fillRect(x + 0.5 * s, y + 4 * s, 2 * s, 2 * s);
}

function drawStatusBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fillPct: number,
  fillColor: string,
  bgColor: string
) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, fillPct)), height);
  ctx.strokeStyle = fillColor + '80';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
}

function drawStudio(
  ctx: CanvasRenderingContext2D,
  skin: SkinConfig,
  studio: StudioNode,
  pos: { x: number; y: number },
  z: number,
  timestamp: number
) {
  const isActive = studio.status === 'active';
  const baseColor = isActive ? skin.colors.studioActive : skin.colors.studioIdle;
  const radius = 28 * z;

  if (skin.studioShape === 'hex') {
    hexPath(ctx, pos.x, pos.y, radius);
    ctx.fillStyle = baseColor + '18';
    ctx.fill();
    ctx.strokeStyle = baseColor + '50';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (skin.studioShape === 'sharp') {
    const r = radius * 0.85;
    ctx.fillStyle = baseColor + '18';
    ctx.fillRect(pos.x - r, pos.y - r, r * 2, r * 2);
    ctx.strokeStyle = baseColor + '50';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pos.x - r, pos.y - r, r * 2, r * 2);

    // Corner ticks for pixel style
    const tickLen = 5 * z;
    ctx.strokeStyle = baseColor + '70';
    ctx.lineWidth = 2;
    const corners = [
      [pos.x - r, pos.y - r],
      [pos.x + r, pos.y - r],
      [pos.x - r, pos.y + r],
      [pos.x + r, pos.y + r],
    ];
    for (const [cx, cy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (cx < pos.x ? tickLen : -tickLen), cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + (cy < pos.y ? tickLen : -tickLen));
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = baseColor + '18';
    ctx.fill();
    ctx.strokeStyle = baseColor + '50';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Active studio pulse
  if (isActive) {
    const pulse = Math.sin(timestamp / 1200) * 0.15 + 0.85;
    ctx.strokeStyle =
      baseColor +
      Math.round(pulse * 40)
        .toString(16)
        .padStart(2, '0');
    ctx.lineWidth = 1;
    if (skin.studioShape === 'hex') {
      hexPath(ctx, pos.x, pos.y, radius + 4 * z * pulse);
      ctx.stroke();
    } else if (skin.studioShape === 'sharp') {
      const r2 = radius * 0.85 + 4 * z * pulse;
      ctx.strokeRect(pos.x - r2, pos.y - r2, r2 * 2, r2 * 2);
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 4 * z * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Label
  const label = studio.slug ?? studio.branch.split('/').pop() ?? '?';
  ctx.fillStyle = skin.colors.textMuted + 'cc';
  ctx.font = `${Math.max(8, 9 * z)}px ${skin.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(label, pos.x, pos.y + radius + 4 * z);
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  skin: SkinConfig,
  agent: AgentState,
  pos: { x: number; y: number },
  z: number,
  timestamp: number,
  isSelected: boolean
) {
  const color = getAgentColor(agent.agentId);
  const agentRadius = 26 * z;
  const isRunning = agent.lifecycle === 'running';

  // Pulse ring for running agents
  if (isRunning) {
    const pulse = Math.sin(timestamp / 400) * 0.4 + 0.6;
    const alpha = Math.round(pulse * 60)
      .toString(16)
      .padStart(2, '0');
    ctx.strokeStyle = color + alpha;
    ctx.lineWidth = 2 * z;

    if (skin.avatarStyle === 'hex') {
      hexPath(ctx, pos.x, pos.y, agentRadius + 10 * z * pulse);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, agentRadius + 10 * z * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Selection ring
  if (isSelected) {
    ctx.strokeStyle = skin.colors.accent;
    ctx.lineWidth = 2.5 * z;
    ctx.setLineDash([4 * z, 3 * z]);
    if (skin.avatarStyle === 'hex') {
      hexPath(ctx, pos.x, pos.y, agentRadius + 6 * z);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, agentRadius + 6 * z, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Agent body
  if (skin.avatarStyle === 'pixel') {
    // Background square
    ctx.fillStyle = color + '30';
    ctx.fillRect(pos.x - agentRadius, pos.y - agentRadius, agentRadius * 2, agentRadius * 2);
    ctx.strokeStyle = color + '60';
    ctx.lineWidth = 2;
    ctx.strokeRect(pos.x - agentRadius, pos.y - agentRadius, agentRadius * 2, agentRadius * 2);
    drawPixelChar(ctx, pos.x, pos.y - 2 * z, agentRadius * 1.6, color, isRunning);
  } else if (skin.avatarStyle === 'hex') {
    // Hex avatar
    hexPath(ctx, pos.x, pos.y, agentRadius);
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, agentRadius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + 'aa');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Initial letter
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${16 * z}px ${skin.fonts.body}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(agent.name.charAt(0).toUpperCase(), pos.x, pos.y);
  } else {
    // Circle avatar with gradient
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, agentRadius, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(
      pos.x - agentRadius * 0.3,
      pos.y - agentRadius * 0.3,
      0,
      pos.x,
      pos.y,
      agentRadius
    );
    grad.addColorStop(0, color + 'ff');
    grad.addColorStop(1, color + 'cc');
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Initial
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${16 * z}px ${skin.fonts.body}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(agent.name.charAt(0).toUpperCase(), pos.x, pos.y);
  }

  // Name label
  ctx.fillStyle = skin.colors.text;
  ctx.font = `bold ${Math.max(10, 13 * z)}px ${skin.fonts.body}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(agent.name, pos.x, pos.y + agentRadius + 6 * z);

  // Status bar (HP-bar style)
  const barWidth = 50 * z;
  const barHeight = 4 * z;
  const barY = pos.y + agentRadius + 22 * z;
  const statusPct = isRunning
    ? 1.0
    : agent.lifecycle === 'completed'
      ? 1.0
      : agent.phase?.startsWith('blocked')
        ? 0.3
        : 0.5;
  const barColor = isRunning
    ? skin.colors.agentActive
    : agent.phase?.startsWith('blocked')
      ? skin.colors.agentBlocked
      : skin.colors.agentIdle;
  drawStatusBar(
    ctx,
    pos.x - barWidth / 2,
    barY,
    barWidth,
    barHeight,
    statusPct,
    barColor,
    skin.colors.bg + 'cc'
  );

  // Phase text
  const icon = getLifecycleIcon(agent.lifecycle, agent.phase);
  const phaseText = `[${icon}] ${getPhaseLabel(agent.phase)}`;
  ctx.fillStyle = skin.colors.textMuted;
  ctx.font = `${Math.max(8, 10 * z)}px ${skin.fonts.mono}`;
  ctx.textAlign = 'center';
  ctx.fillText(phaseText, pos.x, barY + barHeight + 6 * z);

  // Active thread key (what artifact they're working on)
  if (agent.activeThreadKey) {
    ctx.fillStyle = skin.colors.accent;
    ctx.font = `${Math.max(7, 9 * z)}px ${skin.fonts.mono}`;
    ctx.fillText(agent.activeThreadKey, pos.x, barY + barHeight + 18 * z);
  }
}

export function SpatialMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const timeRef = useRef(0);

  const skin = useCommandStore((s) => getSkin(s.skin));
  const agents = useCommandStore((s) => s.agents);
  const studios = useCommandStore((s) => s.studios);
  const selectedAgent = useCommandStore((s) => s.selectedAgent);
  const selectAgent = useCommandStore((s) => s.selectAgent);

  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 0.7 });
  const hasAutoFit = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, camX: 0, camY: 0 });

  // Auto-fit camera on first data load (deferred to ensure layout is ready)
  useEffect(() => {
    if (hasAutoFit.current || agents.length === 0) return;

    const fitCamera = () => {
      const container = containerRef.current;
      if (!container || container.clientWidth === 0) {
        requestAnimationFrame(fitCamera);
        return;
      }
      hasAutoFit.current = true;

      const allPositions = [...agents.map((a) => a.position), ...studios.map((s) => s.position)];
      if (allPositions.length === 0) return;

      const pad = 120;
      const minX = Math.min(...allPositions.map((p) => p.x)) - pad;
      const maxX = Math.max(...allPositions.map((p) => p.x)) + pad;
      const minY = Math.min(...allPositions.map((p) => p.y)) - pad;
      const maxY = Math.max(...allPositions.map((p) => p.y)) + pad;

      const cw = container.clientWidth;
      const ch = container.clientHeight;

      const worldW = maxX - minX;
      const worldH = maxY - minY;
      const zoom = Math.min(cw / worldW, ch / worldH, 1.5) * 0.85;

      setCamera({
        x: -(minX + maxX) / 2,
        y: -(minY + maxY) / 2,
        zoom,
      });
    };

    requestAnimationFrame(fitCamera);
  }, [agents, studios]);

  // Handle canvas resize
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const observer = new ResizeObserver(() => {
      canvas.width = container.clientWidth * window.devicePixelRatio;
      canvas.height = container.clientHeight * window.devicePixelRatio;
      canvas.style.width = `${container.clientWidth}px`;
      canvas.style.height = `${container.clientHeight}px`;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Mouse handlers for pan
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        camX: camera.x,
        camY: camera.y,
      };
    },
    [camera]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setCamera((c) => ({
        ...c,
        x: dragStart.current.camX + dx,
        y: dragStart.current.camY + dy,
      }));
    },
    [isDragging]
  );

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setCamera((c) => ({
      ...c,
      zoom: Math.max(0.2, Math.min(3, c.zoom * delta)),
    }));
  }, []);

  // Click handler for selecting agents
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      const mx = (e.clientX - rect.left) * dpr;
      const my = (e.clientY - rect.top) * dpr;

      const z = camera.zoom * dpr;
      for (const agent of agents) {
        const sx = (agent.position.x + camera.x) * z + canvas.width / 2;
        const sy = (agent.position.y + camera.y) * z + canvas.height / 2;
        const dist = Math.sqrt((mx - sx) ** 2 + (my - sy) ** 2);
        if (dist < 35 * z) {
          selectAgent(selectedAgent === agent.agentId ? null : agent.agentId);
          return;
        }
      }
      selectAgent(null);
    },
    [agents, camera, selectedAgent, selectAgent]
  );

  // Main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function draw(timestamp: number) {
      timeRef.current = timestamp;
      const dpr = window.devicePixelRatio;
      const w = canvas!.width;
      const h = canvas!.height;
      const z = camera.zoom * dpr;

      ctx!.clearRect(0, 0, w, h);

      // Background gradient
      const bgGrad = ctx!.createLinearGradient(0, 0, 0, h);
      bgGrad.addColorStop(0, skin.colors.bg);
      bgGrad.addColorStop(1, skin.colors.surface);
      ctx!.fillStyle = bgGrad;
      ctx!.fillRect(0, 0, w, h);

      // Grid
      ctx!.strokeStyle = skin.colors.border + '25';
      ctx!.lineWidth = 1;
      const gridSize = 50 * z;
      const offsetX = ((((camera.x * z) % gridSize) + gridSize) % gridSize) + ((w / 2) % gridSize);
      const offsetY = ((((camera.y * z) % gridSize) + gridSize) % gridSize) + ((h / 2) % gridSize);
      for (let x = offsetX - gridSize; x < w + gridSize; x += gridSize) {
        ctx!.beginPath();
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, h);
        ctx!.stroke();
      }
      for (let y = offsetY - gridSize; y < h + gridSize; y += gridSize) {
        ctx!.beginPath();
        ctx!.moveTo(0, y);
        ctx!.lineTo(w, y);
        ctx!.stroke();
      }

      // Major grid lines (every 4th)
      ctx!.strokeStyle = skin.colors.border + '10';
      ctx!.lineWidth = 2;
      const majorGrid = gridSize * 4;
      const majorOffX =
        ((((camera.x * z) % majorGrid) + majorGrid) % majorGrid) + ((w / 2) % majorGrid);
      const majorOffY =
        ((((camera.y * z) % majorGrid) + majorGrid) % majorGrid) + ((h / 2) % majorGrid);
      for (let x = majorOffX - majorGrid; x < w + majorGrid; x += majorGrid) {
        ctx!.beginPath();
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, h);
        ctx!.stroke();
      }
      for (let y = majorOffY - majorGrid; y < h + majorGrid; y += majorGrid) {
        ctx!.beginPath();
        ctx!.moveTo(0, y);
        ctx!.lineTo(w, y);
        ctx!.stroke();
      }

      const toScreen = (px: number, py: number) => ({
        x: (px + camera.x) * z + w / 2,
        y: (py + camera.y) * z + h / 2,
      });

      // Draw agent territory zones (subtle colored regions)
      for (const agent of agents) {
        const pos = toScreen(agent.position.x, agent.position.y);
        const color = getAgentColor(agent.agentId);
        const territoryRadius = 140 * z;

        const grad = ctx!.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, territoryRadius);
        grad.addColorStop(0, color + '0a');
        grad.addColorStop(0.7, color + '04');
        grad.addColorStop(1, color + '00');
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(pos.x, pos.y, territoryRadius, 0, Math.PI * 2);
        ctx!.fill();
      }

      // Draw studios
      for (const studio of studios) {
        const pos = toScreen(studio.position.x, studio.position.y);
        drawStudio(ctx!, skin, studio, pos, z, timestamp);
      }

      // Draw connections from agents to studios
      for (const agent of agents) {
        const agentStudios = studios.filter((s) => s.agentId === agent.agentId);
        for (const studio of agentStudios) {
          const from = toScreen(agent.position.x, agent.position.y);
          const to = toScreen(studio.position.x, studio.position.y);
          const color = getAgentColor(agent.agentId);
          const isActive = studio.id === agent.studioId;

          ctx!.strokeStyle = isActive ? color + '50' : color + '20';
          ctx!.lineWidth = isActive ? 2 * z : 1 * z;
          ctx!.setLineDash(isActive ? [] : [3 * z, 3 * z]);
          ctx!.beginPath();
          ctx!.moveTo(from.x, from.y);
          ctx!.lineTo(to.x, to.y);
          ctx!.stroke();
          ctx!.setLineDash([]);

          // Arrow head for active connection
          if (isActive) {
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            const arrowLen = 8 * z;
            const midX = (from.x + to.x) / 2;
            const midY = (from.y + to.y) / 2;
            ctx!.fillStyle = color + '50';
            ctx!.beginPath();
            ctx!.moveTo(midX + arrowLen * Math.cos(angle), midY + arrowLen * Math.sin(angle));
            ctx!.lineTo(
              midX + arrowLen * Math.cos(angle + 2.5),
              midY + arrowLen * Math.sin(angle + 2.5)
            );
            ctx!.lineTo(
              midX + arrowLen * Math.cos(angle - 2.5),
              midY + arrowLen * Math.sin(angle - 2.5)
            );
            ctx!.fill();
          }
        }
      }

      // Draw agents (on top of everything)
      for (const agent of agents) {
        const pos = toScreen(agent.position.x, agent.position.y);
        const isSelected = selectedAgent === agent.agentId;
        drawAgent(ctx!, skin, agent, pos, z, timestamp, isSelected);
      }

      // HUD: title
      ctx!.fillStyle = skin.colors.text + 'cc';
      ctx!.font = `bold ${12 * dpr}px ${skin.fonts.heading}`;
      ctx!.textAlign = 'left';
      ctx!.textBaseline = 'top';
      ctx!.fillText('COMMAND CENTER', 14 * dpr, 12 * dpr);

      // HUD: agent count
      const running = agents.filter((a) => a.lifecycle === 'running').length;
      ctx!.fillStyle = skin.colors.textMuted;
      ctx!.font = `${10 * dpr}px ${skin.fonts.mono}`;
      ctx!.fillText(
        `${running} active / ${agents.length} agents · ${studios.length} studios`,
        14 * dpr,
        28 * dpr
      );

      // HUD: zoom indicator
      ctx!.textAlign = 'right';
      ctx!.fillText(`${Math.round(camera.zoom * 100)}%`, w - 14 * dpr, 12 * dpr);

      animFrameRef.current = requestAnimationFrame(draw);
    }

    animFrameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [agents, studios, camera, skin, selectedAgent]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full cursor-grab active:cursor-grabbing"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onClick={handleClick}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}
