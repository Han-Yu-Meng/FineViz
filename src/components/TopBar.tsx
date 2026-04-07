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
    <div className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 text-slate-900 shrink-0 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${connected ? 'bg-blue-500' : 'bg-rose-500'}`} />
        <h1 className="font-semibold text-lg tracking-wide">{config?.info?.name || 'Robot Vis'}</h1>
      </div>
      
      <div className="flex items-center gap-2">
        {services.map(([key, service]) => {
          const Icon = iconMap[service.icon] || Activity;
          return (
            <button
              key={key}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors border border-blue-200 text-slate-700"
              onClick={() => console.log(`Trigger service: ${service.topic}`)}
            >
              <Icon size={16} className="text-blue-600" />
              <span className="hidden sm:inline">{key}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
