import React, { useState, useMemo } from 'react';
import { AppConfig } from '../hooks/useConfig';
import { FrameStats, Topic } from '../hooks/useFoxglove';
import { Activity, Check, Layers, LineChart as LineChartIcon, Info, Wrench, Route, Network, ChevronRight, ChevronDown, Eye, EyeOff } from 'lucide-react';
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

type Tab = 'info' | 'streams' | 'charts' | 'transforms';

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
    <div className="w-80 bg-white/95 border-r border-slate-200 flex flex-col h-full shrink-0 backdrop-blur-md">
      <div className="flex border-b border-slate-200 overflow-x-auto no-scrollbar">
        <TabButton active={activeTab === 'info'} onClick={() => setActiveTab('info')}>
          Info
        </TabButton>
        <TabButton active={activeTab === 'streams'} onClick={() => setActiveTab('streams')}>
          Streams
        </TabButton>
        <TabButton active={activeTab === 'transforms'} onClick={() => setActiveTab('transforms')}>
          TF
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
        {activeTab === 'transforms' && <TransformsPanel config={config} messages={messages} />}
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
        <div className="text-slate-500 mb-1">Fixed Frame</div>
        <div className="font-mono text-xs bg-blue-50 text-blue-700 p-2 rounded border border-blue-200">{config.tf?.fixed_frame || 'map'}</div>
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

function TransformsPanel({ config, messages }: { config: AppConfig | null; messages: Record<string, any[]> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const hiddenFrames = useMemo(() => new Set(config?.tf?.hidden_frame || []), [config]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // 模拟从 /tf 或 /tf_static 提取层级结构
  // 在实际 ROS 项目中，这通常是一个树状结构
  const transforms = useMemo(() => {
    // 这里先根据 layout 展示一个结构化的示例，未来可以对接真实消息
    const base = {
      id: fixedFrame,
      name: fixedFrame,
      children: [
        { 
          id: 'odom', 
          name: 'odom', 
          children: [
            { 
              id: 'base_link', 
              name: 'base_link', 
              children: [
                { id: 'livox_frame_192_168_1_187', name: 'livox_frame_192_168_1_187' },
                { id: 'livox_frame_192_168_1_198', name: 'livox_frame_192_168_1_198' },
                { id: 'lidar_odom', name: 'lidar_odom' }
              ]
            }
          ] 
        }
      ]
    };
    return base;
  }, [fixedFrame]);

  const renderNode = (node: any, depth = 0) => {
    const isExpanded = expanded[node.id] ?? true;
    const isHidden = hiddenFrames.has(node.id);
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={node.id} className="select-none">
        <div 
          className={cn(
            "flex items-center gap-1 py-1 px-2 hover:bg-slate-100 rounded cursor-pointer group",
            isHidden && "opacity-40"
          )}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => hasChildren && toggleExpand(node.id)}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />
          ) : (
            <div className="w-3.5" />
          )}
          <Network size={14} className={cn("shrink-0", isHidden ? "text-slate-400" : "text-blue-500")} />
          <span className={cn("text-xs font-mono truncate flex-1", node.id === fixedFrame && "font-bold text-blue-600")}>
            {node.name}
            {node.id === fixedFrame && <span className="ml-2 text-[10px] bg-blue-100 text-blue-600 px-1 rounded">FIXED</span>}
          </span>
          {isHidden ? <EyeOff size={12} className="text-slate-400 opacity-0 group-hover:opacity-100" /> : <Eye size={12} className="text-slate-400 opacity-0 group-hover:opacity-100" />}
        </div>
        {hasChildren && isExpanded && (
          <div className="border-l border-slate-100 ml-3.5">
            {node.children.map((child: any) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="py-2">
      <div className="px-3 py-2 mb-2 bg-blue-50/50 rounded-md border border-blue-100 mx-2">
        <div className="text-[10px] uppercase tracking-wider text-blue-500 font-bold mb-1">Transform Tree</div>
        <div className="text-[10px] text-slate-500">Root: {fixedFrame}</div>
      </div>
      <div className="px-1">
        {renderNode(transforms)}
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
