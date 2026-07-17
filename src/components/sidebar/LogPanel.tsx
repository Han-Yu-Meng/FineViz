import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ScrollText, Trash2, ArrowDown, Filter } from 'lucide-react';
import { AppConfig } from '../../hooks/useConfig';

interface LogEntry {
  stamp: { sec: number; nanosec: number };
  level: number;
  name: string;
  msg: string;
  file: string;
  function: string;
  line: number;
}

const LOG_LEVELS: Record<number, { label: string; color: string; bg: string; dot: string }> = {
  10: { label: 'DEBUG', color: 'text-slate-500', bg: 'bg-slate-100', dot: 'bg-slate-400' },
  20: { label: 'INFO',  color: 'text-blue-600', bg: 'bg-blue-50',   dot: 'bg-blue-500' },
  30: { label: 'WARN',  color: 'text-amber-600', bg: 'bg-amber-50', dot: 'bg-amber-500' },
  40: { label: 'ERROR', color: 'text-red-600', bg: 'bg-red-50',     dot: 'bg-red-500' },
  50: { label: 'FATAL', color: 'text-purple-700', bg: 'bg-purple-50', dot: 'bg-purple-600' },
};

const LEVEL_ORDER = [10, 20, 30, 40, 50];

const MAX_ENTRIES = 500;

function formatTime(sec: number, nanosec: number): string {
  const d = new Date(sec * 1000 + nanosec / 1e6);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(nanosec / 1e6).padStart(3, '0').slice(0, 3);
}

interface LogPanelProps {
  config: AppConfig | null;
  messages: Record<string, any[]>;
}

export function LogPanel({ config, messages }: LogPanelProps) {
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [minLevel, setMinLevel] = useState<number>(10);
  const [nameFilter, setNameFilter] = useState('');
  const seenRef = useRef<Set<string>>(new Set());
  const listEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 从 config 获取 rosout 配置
  const logConfigs = config?.log ? Object.entries(config.log) : [];
  const topicNames = logConfigs.map(([, cfg]: [string, any]) => cfg.topic);

  // 构建 topic → ignore_nodes 的映射
  const ignoreNodesMap = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const [, cfg] of logConfigs) {
      const ignores: string[] = (cfg as any).ignore_nodes || [];
      if (ignores.length > 0) {
        map[cfg.topic] = new Set(ignores);
      }
    }
    return map;
  }, [logConfigs]);

  // 从 messages 中提取新日志条目
  useEffect(() => {
    let added = false;
    const newEntries: LogEntry[] = [];

    for (const topicName of topicNames) {
      const topicMsgs = messages[topicName];
      if (!topicMsgs || topicMsgs.length === 0) continue;

      const ignoredNodes = ignoreNodesMap[topicName] || null;

      for (const msg of topicMsgs) {
        const data = msg?.data;
        if (!data || typeof data.level !== 'number' || !data.msg) continue;

        // 过滤来自忽略节点的日志
        if (ignoredNodes && ignoredNodes.has(data.name || '')) continue;

        // 用 stamp + line + name + msg 前 8 字符作为去重 key
        const key = `${data.stamp?.sec ?? 0}_${data.stamp?.nanosec ?? 0}_${data.line ?? 0}_${data.name ?? ''}_${(data.msg ?? '').slice(0, 8)}`;
        if (seenRef.current.has(key)) continue;
        seenRef.current.add(key);

        newEntries.push({
          stamp: data.stamp || { sec: 0, nanosec: 0 },
          level: data.level,
          name: data.name || '',
          msg: data.msg || '',
          file: data.file || '',
          function: data.function || '',
          line: data.line || 0,
        });
        added = true;
      }
    }

    if (!added) return;

    setLogEntries(prev => {
      const next = [...prev, ...newEntries];
      // 按时间排序
      next.sort((a, b) => {
        const ta = a.stamp.sec * 1e9 + a.stamp.nanosec;
        const tb = b.stamp.sec * 1e9 + b.stamp.nanosec;
        return ta - tb;
      });
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, [messages, topicNames]);

  // 限制 seenRef 大小
  useEffect(() => {
    if (seenRef.current.size > MAX_ENTRIES * 3) {
      seenRef.current = new Set([...seenRef.current].slice(-MAX_ENTRIES * 2));
    }
  }, [logEntries.length]);

  // 自动滚动
  useEffect(() => {
    if (autoScroll && listEndRef.current) {
      listEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logEntries, autoScroll]);

  const clearLogs = useCallback(() => {
    setLogEntries([]);
    seenRef.current.clear();
  }, []);

  // 过滤
  const filteredEntries = logEntries.filter(e => {
    if (e.level < minLevel) return false;
    if (nameFilter && !e.name.toLowerCase().includes(nameFilter.toLowerCase())) return false;
    return true;
  });

  // 按日志级别统计
  const levelCounts: Record<number, number> = {};
  for (const e of logEntries) {
    levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
  }

  return (
    <div className="flex flex-col h-full text-sm text-slate-700 p-2">
      {/* Toolbar */}
      <div className="shrink-0 space-y-2 pb-2 border-b border-slate-100">
        {/* Level filter */}
        <div className="flex flex-wrap gap-1">
          {LEVEL_ORDER.map(lv => {
            const info = LOG_LEVELS[lv] || LOG_LEVELS[10];
            const active = lv >= minLevel;
            const count = levelCounts[lv] || 0;
            return (
              <button
                key={lv}
                onClick={() => setMinLevel(active ? (lv === 50 ? 10 : lv + 10) : lv)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-all border ${
                  active
                    ? `${info.bg} ${info.color} border-current/30`
                    : 'bg-white text-slate-400 border-slate-200 opacity-50'
                }`}
                title={`${info.label} (${count})`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${active ? info.dot : 'bg-slate-300'}`} />
                {info.label}
                {count > 0 && <span className="tabular-nums">({count})</span>}
              </button>
            );
          })}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 flex-1 bg-slate-50 rounded border border-slate-200 px-1.5 py-0.5">
            <Filter size={12} className="text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Filter logger..."
              value={nameFilter}
              onChange={e => setNameFilter(e.target.value)}
              className="flex-1 bg-transparent text-xs outline-none text-slate-700 placeholder:text-slate-400"
            />
            {nameFilter && (
              <button onClick={() => setNameFilter('')} className="text-slate-400 hover:text-slate-600 text-xs">
                ✕
              </button>
            )}
          </div>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded text-xs transition-colors ${autoScroll ? 'text-blue-600 bg-blue-50' : 'text-slate-400 hover:text-slate-600'}`}
            title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          >
            <ArrowDown size={14} />
          </button>
          <button
            onClick={clearLogs}
            className="p-1 rounded text-xs text-slate-400 hover:text-red-600 transition-colors"
            title="Clear logs"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Log list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-1 space-y-0.5">
        {filteredEntries.length === 0 ? (
          <div className="text-xs text-slate-400 italic text-center py-8">
            {logEntries.length === 0 ? '等待 /rosout 日志...' : '无匹配的日志条目'}
          </div>
        ) : (
          filteredEntries.map((entry, idx) => {
            const info = LOG_LEVELS[entry.level] || LOG_LEVELS[10];
            return (
              <div
                key={`${entry.stamp.sec}_${entry.stamp.nanosec}_${idx}`}
                className="px-2 py-1 rounded text-xs font-mono hover:bg-slate-100 transition-colors group"
              >
                {/* 元数据行: 级别 + 时间 + Logger */}
                <div className="flex items-center gap-1.5">
                  <span className={`shrink-0 px-1 py-px rounded text-[10px] font-semibold leading-tight ${info.bg} ${info.color}`}>
                    {info.label}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
                    {formatTime(entry.stamp.sec, entry.stamp.nanosec)}
                  </span>
                  <span className="text-[10px] text-slate-500 truncate" title={entry.name}>
                    [{entry.name.split('.').pop() || entry.name}]
                  </span>
                </div>
                {/* 内容行: 日志消息 */}
                <div className={`break-all leading-tight mt-0.5 ${info.color}`}>
                  {entry.msg}
                </div>
              </div>
            );
          })
        )}
        <div ref={listEndRef} />
      </div>

      {/* Footer — entry count */}
      <div className="shrink-0 text-[10px] text-slate-400 text-right pt-1 border-t border-slate-100">
        {filteredEntries.length}/{logEntries.length} entries
      </div>
    </div>
  );
}
