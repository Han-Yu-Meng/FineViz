/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { FoxgloveViewer } from "@foxglove/embed-react";

interface FoxgloveEmbedViewProps {
  wsUrl: string; // 例如 "ws://localhost:8765"
  layoutJsonPath: string; // 例如 "/layout/wheelchair_layout.json"
}

export function FoxgloveEmbedView({ wsUrl, layoutJsonPath }: FoxgloveEmbedViewProps) {
  // 1. 定义数据源配置，使用 memo 避免不必要的重连
  const dataSource = useMemo(() => ({
    type: "live" as const,
    protocol: "foxglove-websocket" as const,
    url: wsUrl,
  }), [wsUrl]);

  // 2. 状态管理与布局加载
  const [opaqueLayout, setOpaqueLayout] = React.useState<any>(null);
  const [loadingLayout, setLoadingLayout] = React.useState(true);

  React.useEffect(() => {
    setLoadingLayout(true);
    fetch(layoutJsonPath)
      .then(res => res.json())
      .then(data => {
        setOpaqueLayout(data);
        setLoadingLayout(false);
      })
      .catch(err => {
        console.error("加载 Foxglove 布局失败:", err);
        setLoadingLayout(false);
      });
  }, [layoutJsonPath]);

  // 3. 将加载到的 JSON 传递给组件的 layout 参数
  const layoutConfig = useMemo(() => {
    if (!opaqueLayout) return undefined;
    return {
      storageKey: `fineviz-layout-${layoutJsonPath}`,
      opaqueLayout: opaqueLayout,
      force: true, // 强制覆盖本地缓存，确保与配置文件一致
    };
  }, [opaqueLayout, layoutJsonPath]);

  if (loadingLayout) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-400">
        加载 Foxglove 视图配置中...
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      <FoxgloveViewer
        data={dataSource}
        layout={layoutConfig}
        colorScheme="dark"
        style={{ width: "100%", height: "100%" }}
        onError={(err) => console.error("Foxglove Viewer 报错:", err)}
      />
    </div>
  );
}
