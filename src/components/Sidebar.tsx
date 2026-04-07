import React, { useState } from 'react';
import { AppConfig } from '../hooks/useConfig';
import { Topic } from '../hooks/useFoxglove';
import { ChevronRight, ChevronDown, Activity, Layers, LineChart as LineChartIcon, Info } from 'lucide-react';
import { cn } from '../lib/utils';
import { RealtimeChart } from './RealtimeChart';

interface SidebarProps {
  config: AppConfig | null;
  topics: Topic[];
  connected: boolean;
  subscribe: (topicName: string) => void;
  unsubscribe?: (topicName: string) => void;
  messages: Record<string, any[]>;
}

type Tab = 'info' | 'streams' | 'charts';

export function Sidebar({ config, topics, connected, subscribe, messages }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<Tab>('streams');

  return (
    <div className="w-72 bg-zinc-900/95 border-r border-zinc-800 flex flex-col h-full shrink-0 backdrop-blur-md">
      <div className="flex border-b border-zinc-800">
        <TabButton active={activeTab === 'info'} onClick={() => setActiveTab('info')}>
          Info
        </TabButton>
        <TabButton active={activeTab === 'streams'} onClick={() => setActiveTab('streams')}>
          Streams
        </TabButton>
        <TabButton active={activeTab === 'charts'} onClick={() => setActiveTab('charts')}>
          Charts
        </TabButton>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {activeTab === 'info' && <InfoPanel config={config} />}
        {activeTab === 'streams' && <StreamsPanel topics={topics} config={config} subscribe={subscribe} messages={messages} />}
        {activeTab === 'charts' && <ChartsPanel config={config} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 py-3 text-sm font-medium transition-colors border-b-2",
        active ? "text-zinc-100 border-emerald-500 bg-zinc-800/50" : "text-zinc-400 border-transparent hover:text-zinc-200 hover:bg-zinc-800/30"
      )}
    >
      {children}
    </button>
  );
}

function InfoPanel({ config }: { config: AppConfig | null }) {
  if (!config) return null;
  return (
    <div className="p-4 text-sm text-zinc-300 space-y-4">
      <div>
        <div className="text-zinc-500 mb-1">Name</div>
        <div>{config.info.name}</div>
      </div>
      <div>
        <div className="text-zinc-500 mb-1">WebSocket Server</div>
        <div className="font-mono text-xs bg-zinc-950 p-2 rounded border border-zinc-800">{config.info.server}</div>
      </div>
      <div>
        <div className="text-zinc-500 mb-1">API Server</div>
        <div className="font-mono text-xs bg-zinc-950 p-2 rounded border border-zinc-800">{config.info.api_server}</div>
      </div>
    </div>
  );
}

function StreamsPanel({ topics, config, subscribe, messages }: { topics: Topic[], config: AppConfig | null, subscribe: (topicName: string) => void, messages: Record<string, any[]> }) {
  // If no topics from WS, let's show the ones from config as a fallback/preview
  const displayTopics = topics.length > 0 ? topics.map(t => t.name) : [];
  if (displayTopics.length === 0 && config) {
    Object.values(config.visualize).forEach(v => displayTopics.push(v.topic));
    Object.values(config.service).forEach(s => displayTopics.push(s.topic));
    Object.values(config.chart).forEach(c => (c as any[]).forEach((ch: any) => displayTopics.push(ch.topic)));
  }

  // Deduplicate and sort
  const uniqueTopics = Array.from(new Set(displayTopics)).sort();

  return (
    <div className="py-2">
      {uniqueTopics.map((topic, index) => {
        const hasMessages = (messages[topic] || []).length > 0;
        return (
          <div 
            key={`${topic}-${index}`} 
            onClick={() => subscribe(topic)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800/50 rounded cursor-pointer group"
          >
            <Activity 
              size={14} 
              className={cn(
                "transition-colors",
                hasMessages ? "text-emerald-400 animate-pulse" : "text-zinc-500 group-hover:text-emerald-400"
              )} 
            />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="font-mono text-xs truncate">{topic}</span>
              {hasMessages && (
                <span className="text-[10px] text-emerald-500/70 font-mono">Receiving data...</span>
              )}
            </div>
          </div>
        );
      })}
      {uniqueTopics.length === 0 && (
        <div className="text-zinc-500 text-sm text-center py-8">No topics available</div>
      )}
    </div>
  );
}

function ChartsPanel({ config }: { config: AppConfig | null }) {
  if (!config?.chart) return <div className="text-zinc-500 text-sm text-center py-8">No charts configured</div>;
  
  return (
    <div className="p-2 space-y-4">
      {Object.entries(config.chart).map(([key, charts]) => (
        <div key={key} className="space-y-4">
          {charts.map((chart: any, idx: number) => (
            <div key={idx} className="bg-zinc-950 rounded-lg p-3 border border-zinc-800">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-mono text-zinc-400">{chart.topic}</div>
                <div className="flex gap-3">
                  {chart.fields.map((field: string, fIdx: number) => (
                    <div key={field} className="flex items-center gap-1.5 text-xs">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: chart.colors[fIdx] }} />
                      <span className="text-zinc-300">{field}</span>
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
