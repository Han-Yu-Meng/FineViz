/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useConfig } from './hooks/useConfig';
import { useFoxglove } from './hooks/useFoxglove';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { DeckGLView } from './components/DeckGLView';

export default function App() {
  const { config, waypoints, loading } = useConfig();
  const { connected, topics } = useFoxglove(config?.info?.server || '');

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p>Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <TopBar config={config} connected={connected} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar config={config} topics={topics} />
        <main className="flex-1 relative">
          <DeckGLView config={config} waypoints={waypoints} />
        </main>
      </div>
    </div>
  );
}

