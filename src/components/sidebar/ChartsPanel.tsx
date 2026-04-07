import React from 'react';
import { AppConfig } from '../../hooks/useConfig';
import { RealtimeChart } from '../RealtimeChart';

export function ChartsPanel({ config }: { config: AppConfig | null }) {
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
              <RealtimeChart topic={chart.topic} fields={chart.fields} colors={chart.colors} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
