import React from 'react';
import { AppConfig } from '../../hooks/useConfig';

export function InfoPanel({ config }: { config: AppConfig | null }) {
  if (!config) return null;
  return (
    <div className="p-4 text-sm text-slate-700 space-y-4">
      <div>
        <div className="text-slate-500 mb-1">Name</div>
        <div>{config.info.name}</div>
      </div>
      <div>
        <div className="text-slate-500 mb-1">WebSocket Server</div>
        <div className="font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200">{config.info.server}</div>
      </div>
      <div>
        <div className="text-slate-500 mb-1">API Server</div>
        <div className="font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200">{config.info.api_server}</div>
      </div>
    </div>
  );
}
