import React, { useState } from 'react';
import { AppConfig } from '../hooks/useConfig';
import { FrameStats, Topic } from '../hooks/useFoxglove';
import { Activity, Check, Layers, LineChart as LineChartIcon, Info, Wrench, Route } from 'lucide-react';
import { cn } from '../lib/utils';
import { RealtimeChart } from './RealtimeChart';
import { collectLayoutTopics } from '../lib/layoutTopics';

interface SidebarProps {
  config: AppConfig | null;
  topics: Topic[];
  connected: boolean;
  topicVisibility: Record<string, boolean>;
  onToggleTopicVisibility: (topicName: string) => void;
  messages: Record<string, any[]>;
  messageStats: Record<string, FrameStats>;
}

type Tab = 'info' | 'streams' | 'charts';

function getTopicIcon(topicType: string) {
  if (topicType === 'sensor_msgs/msg/PointCloud2') return Layers;
  if (topicType === 'nav_msgs/msg/Path') return Route;
  if (topicType.includes('/srv/')) return Wrench;
  if (topicType === 'chart') return LineChartIcon;
  return Activity;
}
export function Sidebar({ config, topics, connected, topicVisibility, onToggleTopicVisibility, messages, messageStats }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<Tab>('streams');

  return (
    <div className="w-72 bg-white/95 border-r border-slate-200 flex flex-col h-full shrink-0 backdrop-blur-md">
      <div className="flex border-b border-slate-200">
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
        {activeTab === 'streams' && (
          <StreamsPanel
            topics={topics}
            config={config}
            messages={messages}
            messageStats={messageStats}
            topicVisibility={topicVisibility}
            onToggleTopicVisibility={onToggleTopicVisibility}
          />
        )}
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
        active ? "text-slate-900 border-blue-500 bg-blue-50" : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-100"
      )}
    >
      {children}
    </button>
  );
}

function InfoPanel({ config }: { config: AppConfig | null }) {
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

function StreamsPanel({
  topics,
  config,
  messages,
  messageStats,
  topicVisibility,
  onToggleTopicVisibility,
}: {
  topics: Topic[];
  config: AppConfig | null;
  messages: Record<string, any[]>;
  messageStats: Record<string, FrameStats>;
  topicVisibility: Record<string, boolean>;
  onToggleTopicVisibility: (topicName: string) => void;
}) {
  const layoutTopics = collectLayoutTopics(config);
  const availableTopicSet = new Set(topics.map((t) => t.name));

  return (
    <div className="py-2">
      {layoutTopics.map((topicInfo) => {
        const topic = topicInfo.name;
        const hasMessages = (messages[topic] || []).length > 0;
        const isAvailable = availableTopicSet.has(topic);
        const TopicIcon = getTopicIcon(topicInfo.type);
        const isVisible = topicVisibility[topic] ?? true;
        const stats = messageStats[topic] || { fps: 0, totalFrames: 0 };

        return (
          <div 
            key={topic}
            onClick={() => onToggleTopicVisibility(topic)}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 text-sm rounded group',
              isAvailable
                ? 'text-slate-700 hover:bg-blue-50 cursor-pointer'
                : 'text-slate-400 bg-slate-100 cursor-pointer',
              !isVisible && 'opacity-60',
            )}
          >
            <div
              className={cn(
                'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                isVisible ? 'border-blue-500 bg-blue-500/20' : 'border-slate-300 bg-slate-100',
              )}
            >
              {isVisible && <Check size={12} className="text-blue-500" />}
            </div>
            <TopicIcon
              size={14} 
              className={cn(
                'transition-colors',
                !isAvailable
                  ? 'text-slate-400'
                  : hasMessages
                    ? 'text-blue-500 animate-pulse'
                    : 'text-slate-500 group-hover:text-blue-500'
              )} 
            />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="font-mono text-xs truncate">{topic}</span>
              <span className={cn('text-[10px] font-mono', isAvailable ? 'text-slate-500' : 'text-slate-400')}>
                {topicInfo.type}
              </span>
              <span className={cn('text-[10px] font-mono', isAvailable ? 'text-blue-600/80' : 'text-slate-400')}>
                {stats.fps.toFixed(1)} FPS | {stats.totalFrames} frames | {isVisible ? 'Visible' : 'Hidden'}
              </span>
            </div>
          </div>
        );
      })}
      {layoutTopics.length === 0 && (
        <div className="text-slate-500 text-sm text-center py-8">No topics available</div>
      )}
    </div>
  );
}

function ChartsPanel({ config }: { config: AppConfig | null }) {
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
