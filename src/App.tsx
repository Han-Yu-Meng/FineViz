/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useConfig } from './hooks/useConfig';
import { useFoxglove } from './hooks/useFoxglove';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { DeckGLView } from './components/DeckGLView';
import { collectLayoutTopics } from './lib/layoutTopics';

export default function App() {
  const { config, waypoints, loading } = useConfig();
  const { connected, topics, subscribe, messages, messageStats } = useFoxglove(config?.info?.server || '');
  const layoutTopics = useMemo(() => collectLayoutTopics(config), [config]);
  const layoutTopicNames = useMemo(() => layoutTopics.map((t) => t.name), [layoutTopics]);
  const [topicVisibility, setTopicVisibility] = useState<Record<string, boolean>>({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  useEffect(() => {
    setTopicVisibility((prev) => {
      const next: Record<string, boolean> = {};
      for (const topicName of layoutTopicNames) {
        next[topicName] = prev[topicName] ?? true;
      }
      return next;
    });
  }, [layoutTopicNames]);

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
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 overflow-hidden">
      <TopBar config={config} connected={connected} />
      <div className="flex flex-1 overflow-hidden relative">
        <div className={`h-full shrink-0 transition-[width] duration-300 ease-in-out z-20 ${
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
              messages={messages} 
              messageStats={messageStats}
            />
          </div>
        </div>

        {/* Floating toggle button */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className={`absolute z-30 top-4 transition-all duration-300 ease-in-out flex items-center justify-center w-8 h-10 bg-white shadow-md border border-slate-200 rounded-r-md hover:bg-slate-50 text-slate-500 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
            isSidebarOpen ? 'left-80' : 'left-0'
          }`}
          aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
        >
          {isSidebarOpen ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
        </button>

        <main className="flex-1 relative">
          <DeckGLView config={config} waypoints={waypoints} messages={messages} topicVisibility={topicVisibility} />
        </main>
      </div>
    </div>
  );
}

