/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Map as MapIcon, Activity, ListTree, LineChart, Info } from 'lucide-react';
import { useConfig } from './hooks/useConfig';
import { useFoxglove } from './hooks/useFoxglove';
import { Sidebar } from './components/Sidebar';
import { DeckGLView } from './components/DeckGLView';
import { collectLayoutTopics } from './lib/layoutTopics';

export default function App() {
  const [layoutPath, setLayoutPath] = useState<string>(() => {
    return localStorage.getItem('fineviz-layout-path') || 'layout/wheelchair.yaml';
  });
  const { config, waypoints, manifest, loading } = useConfig(layoutPath);

  useEffect(() => {
    localStorage.setItem('fineviz-layout-path', layoutPath);
  }, [layoutPath]);

  const { connected, topics, subscribe, messages, messageStats, publish } = useFoxglove(config?.info?.server || '');
  const layoutTopics = useMemo(() => collectLayoutTopics(config), [config]);
  const layoutTopicNames = useMemo(() => layoutTopics.map((t) => t.name), [layoutTopics]);
  const [topicVisibility, setTopicVisibility] = useState<Record<string, boolean>>({});
  const [tfVisibility, setTfVisibility] = useState<Record<string, boolean>>({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<string>('map');
  const [meshModels, setMeshModels] = useState<Record<string, any>>({});
  const [showRobotModel, setShowRobotModel] = useState<boolean>(true);

  useEffect(() => {
    setTopicVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const topicName of layoutTopicNames) {
        next[topicName] = prev[topicName] ?? true;
      }
      return next;
    });
  }, [layoutTopicNames]);

  // 从配置中初始化 TF 的可见性
  useEffect(() => {
    if (!config?.tf) return;
    setTfVisibility((prev) => {
      const next = { ...prev };
      const hiddenOnes = new Set(config.tf.hidden_frame || []);
      
      // 这里的逻辑：如果 prev 中没有该 frame 的记录，则按配置文件初始化
      // 如果已经有了，保持用户在 UI 上的操作状态
      // 我们在 TransformsPanel 渲染时也会发现新 frame
      return next;
    });
  }, [config?.tf]);

  useEffect(() => {
    if (!connected) return;
    layoutTopicNames.forEach((topicName) => subscribe(topicName));
  }, [connected, layoutTopicNames, subscribe]);

  const toggleTopicVisibility = useCallback((topicName: string) => {
    setTopicVisibility((prev) => ({
      ...prev,
      [topicName]: !(prev[topicName] ?? true),
    }));
  }, []);

  const toggleTfVisibility = useCallback((frameId: string) => {
    setTfVisibility((prev) => {
      // 如果之前从未记录（且配置中不在隐藏列表），则默认为显示(true)，取反为隐藏(false)
      const current = prev[frameId] ?? !(config?.tf?.hidden_frame || []).includes(frameId);
      return {
        ...prev,
        [frameId]: !current,
      };
    });
  }, [config?.tf?.hidden_frame]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-600">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p>Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-slate-50 text-slate-900 overflow-hidden">
      <div className="flex flex-1 overflow-hidden relative">
        {/* DESKTOP SIDEBAR */}
        <div className={`hidden md:block h-full shrink-0 transition-[width] duration-300 ease-in-out z-20 ${
          isSidebarOpen ? 'w-80' : 'w-0'
        }`}>
          {/* Prevent inner content from shrinking and causing layout issues during animation */}
          <div className={`h-full shrink-0 flex w-80 transform transition-transform duration-300 ease-in-out ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}>
            <Sidebar 
              config={config} 
              topics={topics} 
              connected={connected} 
              topicVisibility={topicVisibility}
              onToggleTopicVisibility={toggleTopicVisibility}
              tfVisibility={tfVisibility}
              onToggleTfVisibility={toggleTfVisibility}
              messages={messages} 
              messageStats={messageStats}
              layoutPath={layoutPath}
              onLayoutPathChange={setLayoutPath}
              manifest={manifest}
              meshModels={meshModels}
              showRobotModel={showRobotModel}
              onToggleRobotModel={() => setShowRobotModel(!showRobotModel)}
            />
          </div>
        </div>

        {/* MOBILE SIDEBAR CONTENT (Hidden if Map is selected) */}
        <div className={`md:hidden absolute top-0 left-0 w-full h-full bg-white z-20 transition-transform duration-300 ease-in-out ${
          mobileTab === 'map' ? 'translate-y-full opacity-0' : 'translate-y-0 opacity-100'
        }`}>
          <Sidebar 
            config={config} 
            topics={topics} 
            connected={connected} 
            topicVisibility={topicVisibility}
            onToggleTopicVisibility={toggleTopicVisibility}
            messages={messages} 
            messageStats={messageStats}
            activeTab={mobileTab}
            tfVisibility={tfVisibility}
            onToggleTfVisibility={toggleTfVisibility}
            layoutPath={layoutPath}
            onLayoutPathChange={setLayoutPath}
            manifest={manifest}
            meshModels={meshModels}
            showRobotModel={showRobotModel}
            onToggleRobotModel={() => setShowRobotModel(!showRobotModel)}
          />
        </div>

        {/* Floating toggle button (Desktop only) */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className={`hidden md:flex absolute z-30 top-4 transition-all duration-300 ease-in-out items-center justify-center w-8 h-10 bg-white shadow-md border border-slate-200 rounded-r-md hover:bg-slate-50 text-slate-500 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
            isSidebarOpen ? 'left-80' : 'left-0'
          }`}
          aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          {isSidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>

        <main className="flex-1 relative z-10 w-full h-full pb-safe">
          <DeckGLView 
            config={config} 
            waypoints={waypoints} 
            messages={messages} 
            topicVisibility={topicVisibility} 
            tfVisibility={tfVisibility}
            onSendMessage={publish}
            meshModels={meshModels}
            onMeshModelsChange={setMeshModels}
            showRobotModel={showRobotModel}
          />
        </main>
      </div>

      {/* MOBILE BOTTOM NAVIGATION */}
      <div className="md:hidden border-t border-slate-200 bg-white/95 backdrop-blur-md flex items-center justify-around h-14 shrink-0 z-30 px-2 pb-safe-bottom">
        <button className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${mobileTab === 'map' ? 'text-blue-600' : 'text-slate-500'}`} onClick={() => setMobileTab('map')}>
          <MapIcon size={24} />
        </button>
        <button className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${mobileTab === 'streams' ? 'text-blue-600' : 'text-slate-500'}`} onClick={() => setMobileTab('streams')}>
          <Activity size={24} />
        </button>
        <button className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${mobileTab === 'transforms' ? 'text-blue-600' : 'text-slate-500'}`} onClick={() => setMobileTab('transforms')}>
          <ListTree size={24} />
        </button>
        <button className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${mobileTab === 'charts' ? 'text-blue-600' : 'text-slate-500'}`} onClick={() => setMobileTab('charts')}>
          <LineChart size={24} />
        </button>
        <button className={`flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors ${mobileTab === 'info' ? 'text-blue-600' : 'text-slate-500'}`} onClick={() => setMobileTab('info')}>
          <Info size={24} />
        </button>
      </div>
    </div>
  );
}

