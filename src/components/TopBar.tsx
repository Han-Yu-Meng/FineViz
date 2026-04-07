import React from 'react';
import { Power, PowerOff, Gauge, Activity } from 'lucide-react';
import { AppConfig } from '../hooks/useConfig';

interface TopBarProps {
  config: AppConfig | null;
  connected: boolean;
}

const iconMap: Record<string, React.ElementType> = {
  Power,
  PowerOff,
  Gauge,
  Activity
};

export function TopBar({ config, connected }: TopBarProps) {
  const services = config?.service ? Object.entries(config.service) : [];

  return (
    <div className="h-14 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-4 text-zinc-100 shrink-0">
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        <h1 className="font-semibold text-lg tracking-wide">{config?.info?.name || 'Robot Vis'}</h1>
      </div>
      
      <div className="flex items-center gap-2">
        {services.map(([key, service]) => {
          const Icon = iconMap[service.icon] || Activity;
          return (
            <button
              key={key}
              className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-md text-sm font-medium transition-colors border border-zinc-700"
              onClick={() => console.log(`Trigger service: ${service.topic}`)}
            >
              <Icon size={16} className="text-zinc-400" />
              <span className="hidden sm:inline">{key}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
