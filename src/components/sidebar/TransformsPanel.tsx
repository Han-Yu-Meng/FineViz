import React, { useMemo, useState } from 'react';
import { AppConfig } from '../../hooks/useConfig';
import { Network, ChevronRight, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TransformsPanelProps {
  config: AppConfig | null;
  messages: Record<string, any[]>;
}

export function TransformsPanel({ config, messages }: TransformsPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const fixedFrame = config?.tf?.fixed_frame || 'map';
  const hiddenFrames = useMemo(() => new Set(config?.tf?.hidden_frame || []), [config]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const transforms = useMemo(() => {
    const rawTf = [...(messages['/tf'] || []), ...(messages['/tf_static'] || [])];
    const nodes: Record<string, any> = {
      [fixedFrame]: { id: fixedFrame, name: fixedFrame, children: [] }
    };
    
    const seen = new Set();
    rawTf.forEach(msg => {
      const ts = msg.data?.transforms || msg.transforms || [];
      ts.forEach((t: any) => {
        const p = t.header.frame_id;
        const c = t.child_frame_id;
        if (seen.has(c)) return;
        seen.add(c);

        if (!nodes[p]) nodes[p] = { id: p, name: p, children: [] };
        if (!nodes[c]) nodes[c] = { id: c, name: c, children: [] };
        nodes[p].children.push(nodes[c]);
      });
    });

    return nodes[fixedFrame] || { id: fixedFrame, name: fixedFrame, children: [] };
  }, [fixedFrame, messages]);

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
      <div className="px-1">
        {renderNode(transforms)}
      </div>
    </div>
  );
}
