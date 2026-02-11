'use client';

import { cn } from '@/lib/utils';

export interface Agent {
  agentId: string;
  name: string;
  role: string;
  description?: string | null;
}

interface AgentPickerProps {
  agents: Agent[];
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}

export function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
}: AgentPickerProps) {
  if (agents.length === 0) return null;

  return (
    <div className="flex gap-2 border-b bg-white px-4 py-3">
      {agents.map((agent) => (
        <button
          key={agent.agentId}
          onClick={() => onSelect(agent.agentId)}
          className={cn(
            'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
            selectedAgentId === agent.agentId
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          )}
          title={agent.role}
        >
          {agent.name}
        </button>
      ))}
    </div>
  );
}
