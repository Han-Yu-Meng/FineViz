import React from 'react';
import { AppConfig } from '../../hooks/useConfig';
import { FrameStats, Topic } from '../../hooks/useFoxglove';
import { Activity, Check, Layers, Route, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';
import { collectLayoutTopics } from '../../lib/layoutTopics';

interface StreamsPanelProps {
  topics: Topic[];
  config: AppConfig | null;
  messages: Record<string, any[]>;
  messageStats: Record<string, FrameStats>;
  topicVisibility: Record<string, boolean>;
  onToggleTopicVisibility: (topicName: string) => void;
}

function getTopicIcon(topicType: string) {
  if (topicType === 'sensor_msgs/msg/PointCloud2') return Layers;
  if (topicType === 'nav_msgs/msg/Path') return Route;
  if (topicType.includes('/srv/')) return Wrench;
  return Activity;
}

export function StreamsPanel({
  topics,
  config,
  messages,
  messageStats,
  topicVisibility,
  onToggleTopicVisibility,
}: StreamsPanelProps) {
  const layoutTopics = collectLayoutTopics(config);
  const streamTopics = layoutTopics.filter(t => !t.type.includes('/srv/') && t.name !== '/tf' && t.name !== '/tf_static');
  const availableTopicSet = new Set(topics.map((t) => t.name));

  return (
    <div className="py-2">
      {streamTopics.map((topicInfo) => {
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
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs truncate">{topic}</span>
              </div>
              <span className={cn('text-[10px] font-mono', isAvailable ? 'text-slate-500' : 'text-slate-400')}>
                {topicInfo.type}
              </span>
              <span className={cn('text-[10px] font-mono', isAvailable ? 'text-blue-600/80' : 'text-slate-400')}>
                {stats.fps.toFixed(1)} FPS | {stats.totalFrames} frames
              </span>
            </div>
          </div>
        );
      })}
      {streamTopics.length === 0 && (
        <div className="text-slate-500 text-sm text-center py-8">No streams available</div>
      )}
    </div>
  );
}
