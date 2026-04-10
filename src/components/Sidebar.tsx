import React, { useState } from 'react';
import { Info, Activity, ListTree, LineChart } from 'lucide-react';
import { AppConfig, ConfigManifest } from '../hooks/useConfig';
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
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  layoutPath: string;
  onLayoutPathChange: (path: string) => void;
  manifest: ConfigManifest[];
  meshModels?: Record<string, any>;
  showRobotModel: boolean;
  onToggleRobotModel: () => void;
}

export function Sidebar({ 
  config, 
  topics,
  connected,
  topicVisibility, 
  onToggleTopicVisibility, 
  messages, 
  messageStats,
  activeTab: externalTab,
  onTabChange,
  layoutPath,
  onLayoutPathChange,
  manifest,
  meshModels,
  showRobotModel,
  onToggleRobotModel
}: SidebarProps) {
  const [internalTab, setInternalTab] = useState<string>('info');
  
  const activeTab = externalTab !== undefined ? externalTab : internalTab;
  const setActiveTab = (tab: string) => {
    setInternalTab(tab);
    if (onTabChange) onTabChange(tab);
  };

  return (
    <div className="w-full md:w-80 bg-white/95 border-r border-slate-200 flex flex-col h-full shrink-0 backdrop-blur-md">
      <div className="hidden md:flex border-b border-slate-200 overflow-x-auto no-scrollbar">
        <TabButton active={activeTab === 'info'} onClick={() => setActiveTab('info')} title="Info">
          <Info size={20} />
        </TabButton>
        <TabButton active={activeTab === 'streams'} onClick={() => setActiveTab('streams')} title="Streams">
          <Activity size={20} />
        </TabButton>
        <TabButton active={activeTab === 'transforms'} onClick={() => setActiveTab('transforms')} title="TF">
          <ListTree size={20} />
        </TabButton>
        <TabButton active={activeTab === 'charts'} onClick={() => setActiveTab('charts')} title="Charts">
          <LineChart size={20} />
        </TabButton>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {activeTab === 'info' && (
          <InfoPanel 
            config={config} 
            connected={connected} 
            layoutPath={layoutPath} 
            onLayoutPathChange={onLayoutPathChange} 
            manifest={manifest}
            meshModels={meshModels}
            showRobotModel={showRobotModel}
            onToggleRobotModel={onToggleRobotModel}
          />
        )}
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

function TabButton({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex-1 flex justify-center items-center py-3 text-sm font-medium transition-colors border-b-2 outline-none",
        active ? "text-blue-600 border-blue-500 bg-blue-50" : "text-slate-500 border-transparent hover:text-slate-700 hover:bg-slate-100"
      )}
    >
      {children}
    </button>
  );
}
