import { useState, useEffect, useRef, useCallback } from 'react';
import { FoxgloveClient } from '@foxglove/ws-protocol';
import { parse } from '@foxglove/rosmsg';
import { MessageReader } from '@foxglove/rosmsg2-serialization';

export interface Topic {
  id: number;
  name: string;
  schemaName: string;
  schema?: string;
}

export interface FrameStats {
  fps: number;
  totalFrames: number;
}

export function useFoxglove(url: string) {
  const [client, setClient] = useState<FoxgloveClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [messages, setMessages] = useState<Record<string, any[]>>({});
  const [messageStats, setMessageStats] = useState<Record<string, FrameStats>>({});
  
  const wsRef = useRef<WebSocket | null>(null);
  const topicsRef = useRef<Topic[]>([]);
  const readersRef = useRef<Map<number, MessageReader>>(new Map());
  const frameTimesRef = useRef<Map<string, number[]>>(new Map());
  const frameCountsRef = useRef<Map<string, number>>(new Map());
  
  const messageBufferRef = useRef<Record<string, any[]>>({});
  const statsBufferRef = useRef<Record<string, FrameStats>>({});
  const dirtyTopicsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = setInterval(() => {
      setMessages(prev => {
        if (dirtyTopicsRef.current.size === 0) return prev;
        
        const next = { ...prev };
        for (const topic of dirtyTopicsRef.current) {
          next[topic] = [...(messageBufferRef.current[topic] || [])];
        }
        // 清理脏标记以阻止 React 在安静期间无畏重绘！
        dirtyTopicsRef.current.clear();
        return next;
      });

      setMessageStats(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [topic, stats] of Object.entries(statsBufferRef.current)) {
          if (prev[topic]?.totalFrames !== stats.totalFrames || prev[topic]?.fps !== stats.fps) {
            next[topic] = stats;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 100); // 10Hz 的 React 状态同步率
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!url) return;

    console.log(`正在尝试连接到 WebSocket: ${url}`);

    const protocols = ["foxglove.websocket.v1", "foxglove.sdk.v1"];
    console.log("正在尝试连接，请求协议:", protocols);

    const ws = new WebSocket(url, protocols);
    wsRef.current = ws;

    // 🌟 打印服务器最终选择的协议
    ws.onopen = () => {
      console.log("WebSocket 握手成功，最终选择协议:", ws.protocol);
    };

    // 🌟 加上这段原生错误监听，看看控制台到底报了什么具体错误
    ws.onerror = (error) => {
      console.error("WebSocket 原生底层报错了:", error);
    };

    const foxgloveClient = new FoxgloveClient({
      ws: ws as any,
    });

    foxgloveClient.on("open", () => {
      console.log("Foxglove 连接成功！");
      setConnected(true);
    });

    foxgloveClient.on("close", () => {
      setConnected(false);
      setTopics([]);
      setMessageStats({});
      frameTimesRef.current.clear();
      frameCountsRef.current.clear();
    });

    foxgloveClient.on("advertise", (newTopics) => {
      console.log("收到话题列表 (原始):", newTopics);
      setTopics((prev) => {
        // Foxglove SDK (C++ bridge) provides {id, topic, schemaName}
        // Let's ensure we store the correct 'id' and 'name'
        const normalized = newTopics.map(t => ({
          id: (t as any).id,
          name: (t as any).topic || (t as any).name,
          schemaName: t.schemaName,
          schema: (t as any).schema,
        }));
        const existingIds = new Set(prev.map(t => t.id));
        const added = normalized.filter(t => !existingIds.has(t.id));
        const nextTopics = [...prev, ...added];
        topicsRef.current = nextTopics;

        // Build ROS2 CDR readers for topics that include schemas.
        for (const topic of added) {
          if (topic.schema && !readersRef.current.has(topic.id)) {
            try {
              const definitions = parse(topic.schema, { ros2: true });
              readersRef.current.set(topic.id, new MessageReader(definitions));
            } catch (err) {
              console.warn(`创建消息解析器失败: ${topic.name}`, err);
            }
          }
        }

        return nextTopics;
      });
    });

    foxgloveClient.on("unadvertise", (removedTopics) => {
      setTopics((prev) => {
        const removedNames = new Set(removedTopics);
        const nextTopics = prev.filter(t => !removedNames.has(t.id));
        topicsRef.current = nextTopics;
        for (const removedId of removedTopics) {
          readersRef.current.delete(removedId as number);
        }
        return nextTopics;
      });
    });

    foxgloveClient.on("message", (event) => {
      const topicName = subscriptionsRef.current.get(event.subscriptionId);
      if (topicName) {
        const now = Date.now();
        const times = frameTimesRef.current.get(topicName) || [];
        times.push(now);
        while (times.length > 0 && now - times[0] > 1000) {
          times.shift();
        }
        frameTimesRef.current.set(topicName, times);

        const totalFrames = (frameCountsRef.current.get(topicName) || 0) + 1;
        frameCountsRef.current.set(topicName, totalFrames);

        statsBufferRef.current[topicName] = {
          fps: times.length,
          totalFrames,
        };
      }

      // Find topic name using our subscription ID map
      if (!topicName) return;

      const topic = topicsRef.current.find(t => t.name === topicName);
      if (!topic) return;
      
      const existingMessages = messageBufferRef.current[topicName] || [];
      const reader = readersRef.current.get(topic.id);
      let decodedData: unknown = event.data;

      if (reader) {
        try {
          decodedData = reader.readMessage(event.data);
        } catch (err) {
          console.warn(`消息反序列化失败: ${topic.name}`, err);
        }
      }

      const newMessage = {
        data: decodedData,
        rawData: event.data,
        timestamp: event.timestamp,
        receivedAt: Date.now(),
      };

      // JS 原生数组 push 远比 [...arr] 原地重新构建立即拷贝快几个数量级，缓解 GC 压力
      if (!messageBufferRef.current[topicName]) {
        messageBufferRef.current[topicName] = [];
      }
      // 针对大数据结构，限制历史消息数量来释放内存
      const isLargeData = topic.schemaName === 'sensor_msgs/msg/PointCloud2' || topic.schemaName === 'sensor_msgs/msg/Image';
      const MAX_LENGTH = isLargeData ? 2 : 50; 
      
      const buffer = messageBufferRef.current[topicName];
      buffer.push(newMessage);
      // 保持历史限制，防止内存泄漏和 OOM
      while (buffer.length > MAX_LENGTH) {
        buffer.shift();
      }

      // 给这个话题打上“脏标志”，让稍后的 10Hz Interval 把它合并同步进 UI 引擎
      dirtyTopicsRef.current.add(topicName);
    });

    setClient(foxgloveClient);

    return () => {
      foxgloveClient.close();
      ws.close();
      readersRef.current.clear();
      topicsRef.current = [];
      frameTimesRef.current.clear();
      frameCountsRef.current.clear();
    };
  }, [url]);

  const subscriptionsRef = useRef<Map<number, string>>(new Map());
  const topicToSubscriptionRef = useRef<Map<string, number>>(new Map());

  const subscribe = useCallback((topicName: string) => {
    if (!client) return;
    const topic = topics.find(t => t.name === topicName);
    if (topic) {
      if (topicToSubscriptionRef.current.has(topicName)) {
        console.log(`话题已订阅，跳过重复订阅: ${topicName}`);
        return;
      }

      const subId = client.subscribe(topic.id);
      console.log(`正在订阅话题: ${topicName} (ChannelID: ${topic.id}, SubID: ${subId})`);
      subscriptionsRef.current.set(subId, topicName);
      topicToSubscriptionRef.current.set(topicName, subId);
    }
  }, [client, topics]);

  const unsubscribe = useCallback((topicName: string) => {
    if (!client) return;
    const topic = topics.find(t => t.name === topicName);
    if (topic) {
      console.log(`正在取消订阅话题: ${topicName}`);
      const subId = topicToSubscriptionRef.current.get(topicName);
      if (subId != undefined) {
        client.unsubscribe(subId);
        subscriptionsRef.current.delete(subId);
        topicToSubscriptionRef.current.delete(topicName);
      }
    }
  }, [client, topics]);

  return { client, connected, topics, messages, messageStats, subscribe, unsubscribe };
}
