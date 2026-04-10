import React from 'react';
import { AppConfig } from '../../hooks/useConfig';
import { RealtimeChart } from './RealtimeChart';

interface ChartsPanelProps {
  config: AppConfig | null;
  messages: Record<string, any[]>;
}

// 【修复 3】提取成文件级常量。防止每次渲染时创建新的 [] 导致 React.memo 失效
const EMPTY_MESSAGES: any[] = [];

export function ChartsPanel({ config, messages }: ChartsPanelProps) {
  if (!config?.chart) return <div className="text-slate-500 text-sm text-center py-8">No charts configured</div>;
  
  return (
    <div className="p-2 space-y-4">
      {Object.entries(config.chart).map(([key, charts]) => (
        <div key={key} className="space-y-4">
          {charts.map((chart: any, idx: number) => (
            <div key={idx} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-mono text-slate-500">{chart.topic}</div>
                <div className="flex gap-3">
                  {chart.fields.map((field: string, fIdx: number) => (
                    <div key={field} className="flex items-center gap-1.5 text-xs">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: chart.colors[fIdx] }} />
                      <span className="text-slate-700">{field}</span>
                    </div>
                  ))}
                </div>
              </div>
              <RealtimeChart 
                topic={chart.topic} 
                fields={chart.fields} 
                colors={chart.colors} 
                // 使用上面提取的常量，如果该 topic 还没数据，透传相同的引用地址
                messages={messages[chart.topic] || EMPTY_MESSAGES} 
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
