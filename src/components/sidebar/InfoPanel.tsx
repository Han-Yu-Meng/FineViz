import React from 'react';
import { Power, PowerOff, Gauge, Activity, Box, Eye, EyeOff } from 'lucide-react';
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
  meshModels?: Record<string, any>;
  showRobotModel: boolean;
  onToggleRobotModel: () => void;
}

export function InfoPanel({ 
  config, 
  connected, 
  layoutPath, 
  onLayoutPathChange, 
  manifest,
  meshModels = {},
  showRobotModel,
  onToggleRobotModel
}: InfoPanelProps) {
  if (!config) return null;
  
  const services = config.service ? Object.entries(config.service) : [];

  // 计算模型统计信息
  const modelStats = Object.entries(meshModels).map(([path, data]) => {
    const positions = data.attributes?.positions?.value;
    const faceCount = positions ? positions.length / 9 : 0; // 每个面3个顶点，每个顶点3个坐标
    const fileName = path.split('/').pop() || path;
    return { fileName, faceCount };
  });

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

      {/* Robot Model Info */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
          <h3 className="font-semibold text-slate-900">Robot Model</h3>
          <button 
            onClick={onToggleRobotModel}
            className={`p-1 rounded hover:bg-slate-100 transition-colors ${showRobotModel ? 'text-blue-600' : 'text-slate-400'}`}
            title={showRobotModel ? 'Hide Model' : 'Show Model'}
          >
            {showRobotModel ? <Eye size={18} /> : <EyeOff size={18} />}
          </button>
        </div>
        
        {modelStats.length > 0 ? (
          <div className="space-y-2">
            {modelStats.map((stat, i) => (
              <div key={i} className="bg-slate-50 rounded p-2 border border-slate-200">
                <div className="flex items-center gap-2 mb-1">
                  <Box size={14} className="text-slate-500" />
                  <span className="font-medium text-xs truncate" title={stat.fileName}>{stat.fileName}</span>
                </div>
                <div className="text-[10px] text-slate-500 flex justify-between">
                  <span>Faces:</span>
                  <span className="font-mono">{stat.faceCount.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-400 italic px-1">No meshes loaded</div>
        )}
      </div>

      {/* Services section */}
      {services.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Services</h3>
          <div className="flex flex-col gap-3">
            {services.map(([key, service]: [string, any]) => {
              const Icon = iconMap[service.icon] || Activity;
              const hasPayload = service.payload && service.payload.length > 0;
              
              // 【代理模式修复】由于网络环境问题，请求先发给 FineViz 代理，再由代理转发至 4000 端口
              const apiUrl = `/api-proxy${service.url}`;

              const handleTrigger = async (payloadData?: any) => {
                try {
                  const response = await fetch(apiUrl, {
                    method: service.method || 'POST',
                    headers: { 
                      'Content-Type': 'application/json',
                      'x-target-port': service.port || '3000' 
                    },
                    body: payloadData ? JSON.stringify(payloadData) : undefined
                  });
                  if (response.ok) {
                    console.log(`Successfully triggered ${key}`);
                  } else {
                    console.error(`Failed to trigger ${key}: ${response.statusText}`);
                  }
                } catch (err) {
                  console.error(`Error triggering ${key}:`, err);
                }
              };

              return (
                <div key={key} className="space-y-2 p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={16} className="text-blue-600" />
                    <span className="font-medium text-slate-800">{key}</span>
                  </div>
                  
                  {hasPayload ? (
                    <div className="space-y-2">
                      {service.payload.map((field: any, idx: number) => {
                        const fieldName = Object.keys(field)[0];
                        const defaultValue = field[fieldName];
                        return (
                          <div key={idx} className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-500 w-16 truncate">{fieldName}</span>
                            <input
                              type="number"
                              step="0.1"
                              className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 text-xs"
                              defaultValue={defaultValue}
                              id={`input-${key}-${fieldName}`}
                            />
                          </div>
                        );
                      })}
                      <button
                        className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition-colors"
                        onClick={() => {
                          const payload: any = {};
                          service.payload.forEach((field: any) => {
                            const name = Object.keys(field)[0];
                            const input = document.getElementById(`input-${key}-${name}`) as HTMLInputElement;
                            payload[name] = parseFloat(input.value);
                          });
                          handleTrigger(payload);
                        }}
                      >
                        Execute
                      </button>
                    </div>
                  ) : (
                    <button
                      className="w-full py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded text-xs font-medium transition-colors border border-blue-200"
                      onClick={() => handleTrigger()}
                    >
                      Trigger
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
