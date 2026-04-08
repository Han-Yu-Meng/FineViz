import React from 'react';
import { Power, PowerOff, Gauge, Activity } from 'lucide-react';
import { AppConfig, ConfigManifest } from '../../hooks/useConfig';

const iconMap: Record<string, React.ElementType> = {
  Power,
  PowerOff,
  Gauge,
  Activity
};

interface InfoPanelProps {
  config: AppConfig | null;
  connected: boolean;
  layoutPath: string;
  onLayoutPathChange: (path: string) => void;
  manifest: ConfigManifest[];
}

export function InfoPanel({ config, connected, layoutPath, onLayoutPathChange, manifest }: InfoPanelProps) {
  if (!config) return null;
  
  const services = config.service ? Object.entries(config.service) : [];

  return (
    <div className="p-4 text-sm text-slate-700 space-y-6">
      {/* Layout Selection */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Layout</h3>
        <div>
          <select 
            id="layout-select"
            className="w-full bg-white border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            value={layoutPath}
            onChange={(e) => onLayoutPathChange(e.target.value)}
          >
            {manifest.map(item => (
              <option key={item.id} value={item.path}>{item.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status section */}
      <div className="space-y-4">
        <div className="relative group">
          <div className="flex items-center gap-2 font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200 break-all pr-8">
            <div 
              className={`shrink-0 w-2 h-2 rounded-full ${connected ? 'bg-blue-500 animate-pulse' : 'bg-rose-500'}`} 
              title={connected ? 'Connected' : 'Offline'}
            />
            <span className="truncate">{config.info.server}</span>
          </div>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <span className="text-[10px] uppercase font-bold text-slate-400">
              {connected ? 'Live' : 'Off'}
            </span>
          </div>
        </div>
      </div>

      {/* Services section */}
      {services.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Services</h3>
          <div className="flex flex-col gap-2">
            {services.map(([key, service]) => {
              const Icon = iconMap[service.icon] || Activity;
              return (
                <button
                  key={key}
                  className="flex items-center justify-center gap-2 w-full px-3 py-2.5 bg-blue-50 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors border border-blue-200 text-slate-700"
                  onClick={() => console.log(`Trigger service: ${service.topic}`)}
                >
                  <Icon size={16} className="text-blue-600" />
                  <span>{key}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
