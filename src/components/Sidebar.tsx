import React, { useState } from 'react';
import { AppConfig } from '../hooks/useConfig';
import { FrameStats, Topic } from '../hooks/useFoxglove';
import { cn } from '../lib/utils';
import { InfoPanel } from './sidebar/InfoPanel';
import { StreamsPanel } from './sidebar/StreamsPanel';
import { TransformsPanel } from './sidebar/TransformsPanel';
import { ChartsPanel } from './sidebar/ChartsPanel';

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

export function Sidebar({ 
  config, 
  topics, 
  topicVisibility, 
  onToggleTopicVisibility, 
  messages, 
  messageStats 
}: SidebarProps) {
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
        {activeTab === 'transforms' && <TransformsPanel config={config} messages={messages} messageStats={messageStats} />}
        {activeTab === 'charts' && <ChartsPanel config={config} messages={messages} />}
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
