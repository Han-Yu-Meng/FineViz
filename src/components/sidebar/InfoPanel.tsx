import React, { useState, useEffect } from 'react';
import { Power, PowerOff, Gauge, Activity, Box, Eye, EyeOff } from 'lucide-react';
import { AppConfig, ConfigManifest } from '../../hooks/useConfig';

const iconMap: Record<string, React.ElementType> = {
  Power,
  PowerOff,
  Gauge,
  Activity,
  Box
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

// 定义保存每个服务状态的数据结构
interface ServiceState {
  current: string;
  available: string[];
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
  const globalPort = config.info?.api_port || '4000'; // 读取全局端口

  // 状态机数据与加载状态
  const [serviceStates, setServiceStates] = useState<Record<string, ServiceState>>({});
  const [loadingServices, setLoadingServices] = useState<Record<string, boolean>>({});

  // 1. 获取状态的心跳逻辑（Heartbeat Polling）
  useEffect(() => {
    if (services.length === 0) return;

    const fetchStates = async () => {
      for (const [key, service] of services as [string, any][]) {
        if (!service.prefix) continue;

        const apiUrl = `/api-proxy${service.prefix}/get_state`;
        try {
          const response = await fetch(apiUrl, {
            method: 'POST', // 统一采用 POST 方法
            headers: { 
              'Content-Type': 'application/json',
              'x-target-port': globalPort 
            },
            body: JSON.stringify({}) // 留空的 body
          });

          if (response.ok) {
            const resData = await response.json();
            // 约定返回结构：{ current_state: "IDLE", available_states: ["IDLE", "RUNNING"] }
            setServiceStates(prev => ({
              ...prev,
              [key]: {
                current: resData.current_state || 'UNKNOWN',
                available: resData.available_states || []
              }
            }));
          } else {
            console.warn(`Failed heartbeat for ${key}: ${response.statusText}`);
          }
        } catch (err) {
          console.error(`Error during heartbeat for ${key}:`, err);
        }
      }
    };

    // 立即执行一次，随后每 3 秒执行一次
    fetchStates();
    const interval = setInterval(fetchStates, 3000);

    return () => clearInterval(interval);
  }, [config.service, globalPort]);

  // 2. 状态切换触发逻辑（Set State）
  const handleSetState = async (serviceKey: string, prefix: string, targetState: string) => {
    setLoadingServices(prev => ({ ...prev, [serviceKey]: true }));
    const apiUrl = `/api-proxy${prefix}/set_state`;

    try {
      const response = await fetch(apiUrl, {
        method: 'POST', // 采用 POST 方法
        headers: { 
          'Content-Type': 'application/json',
          'x-target-port': globalPort 
        },
        body: JSON.stringify({ state: targetState }) // 传递目标状态
      });

      if (response.ok) {
        console.log(`Successfully set state of ${serviceKey} to ${targetState}`);
        
        // 乐观更新：在服务器响应成功后，先在本地更新当前状态，提升界面响应感
        setServiceStates(prev => {
          const existing = prev[serviceKey];
          if (!existing) return prev;
          return {
            ...prev,
            [serviceKey]: { ...existing, current: targetState }
          };
        });
      } else {
        console.error(`Failed to set state for ${serviceKey}: ${response.statusText}`);
      }
    } catch (err) {
      console.error(`Error setting state for ${serviceKey}:`, err);
    } finally {
      setLoadingServices(prev => ({ ...prev, [serviceKey]: false }));
    }
  };

  // 模型统计信息计算
  const modelStats = Object.entries(meshModels).map(([path, data]) => {
    const positions = data.attributes?.positions?.value;
    const faceCount = positions ? positions.length / 9 : 0;
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

      {/* Connection Status */}
      <div className="space-y-4">
        <div className="relative group">
          <div className="flex items-center gap-2 font-mono text-xs bg-slate-50 p-2 rounded border border-slate-200 break-all pr-8">
            <div 
              className={`shrink-0 w-2 h-2 rounded-full ${connected ? 'bg-blue-500 animate-pulse' : 'bg-rose-500'}`} 
              title={connected ? 'Connected' : 'Offline'}
            />
            <span className="truncate">{`ws://${window.location.hostname}:8765`}</span>
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

      {/* Services Section with State Machine Support */}
      {services.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Services</h3>
          <div className="flex flex-col gap-3">
            {services.map(([key, service]: [string, any]) => {
              const Icon = iconMap[service.icon] || Activity;
              const stateInfo = serviceStates[key] || { current: 'FETCHING...', available: [] };
              const isProcessing = loadingServices[key] || false;

              return (
                <div key={key} className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
                  {/* Header info showing Service Name & Current State */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon size={16} className="text-blue-600" />
                      <span className="font-medium text-slate-800">{key}</span>
                    </div>
                  </div>
                  
                  {/* Transition/State Switches */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {stateInfo.available.length > 0 ? (
                        stateInfo.available.map((state) => {
                          const isCurrent = state === stateInfo.current;
                          return (
                            <button
                              key={state}
                              disabled={isProcessing || isCurrent}
                              onClick={() => handleSetState(key, service.prefix, state)}
                              className={`px-2 py-1 rounded text-xs transition-all border ${
                                isCurrent
                                  ? 'bg-blue-100 text-blue-700 border-blue-300 font-semibold cursor-not-allowed'
                                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100 hover:text-slate-800 active:scale-95'
                              }`}
                            >
                              {state}
                            </button>
                          );
                        })
                      ) : (
                        <span className="text-xs text-slate-400 italic">
                          No states retrieved yet.
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}