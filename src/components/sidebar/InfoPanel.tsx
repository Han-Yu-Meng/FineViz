import React from 'react';
import { Power, PowerOff, Gauge, Activity } from 'lucide-react';
import { AppConfig } from '../../hooks/useConfig';

const iconMap: Record<string, React.ElementType> = {
  Power,
  PowerOff,
  Gauge,
  Activity
};

interface InfoPanelProps {
  config: AppConfig | null;
  connected: boolean;
}

export function InfoPanel({ config, connected }: InfoPanelProps) {
  if (!config) return null;
  
  const services = config.service ? Object.entries(config.service) : [];

  return (
    <div className="p-4 text-sm text-slate-700 space-y-6">
      {/* Status section */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Status</h3>
        
        <div className="flex items-center justify-between">
          <div className="text-slate-500">Connection</div>
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-blue-500' : 'bg-rose-500'}`} />
            <span className="font-medium">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        <div>
          <div className="text-slate-500 mb-1">Name</div>
          <div className="font-medium">{config.info.name}</div>
        </div>
        
        <div>
          <div className="text-slate-500 mb-1">WebSocket Server</div>
          <div className="font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200 break-all">{config.info.server}</div>
        </div>
        
        <div>
          <div className="text-slate-500 mb-1">API Server</div>
          <div className="font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200 break-all">{config.info.api_server}</div>
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
