import { useState, useEffect, useRef, useCallback } from 'react';
import { FoxgloveClient } from '@foxglove/ws-protocol';
import { parse } from '@foxglove/rosmsg';
import { MessageReader, MessageWriter } from '@foxglove/rosmsg2-serialization';

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
  const [retryCount, setRetryCount] = useState(0);
  
  // Track client-side advertised channels
  const clientAdvertisedChannelsRef = useRef<Map<string, number>>(new Map());
  const nextClientChannelIdRef = useRef<number>(10000); // Start from a high range to avoid collisions

  const wsRef = useRef<WebSocket | null>(null);
  const topicsRef = useRef<Topic[]>([]);
  const readersRef = useRef<Map<number, MessageReader>>(new Map());
  const writersRef = useRef<Map<number, MessageWriter>>(new Map());
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
    }, 100); // 20Hz 的 React 状态同步率
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
      
      // 检测是否为重连状态（通过 sessionStorage 跨刷新持久化标记）
      const wasDisconnected = sessionStorage.getItem('foxglove-reconnect-needed') === 'true';
      if (wasDisconnected || retryCount > 0) {
        console.log("检测到断线重连成功，正在刷新页面以重置 TF 树...");
        sessionStorage.removeItem('foxglove-reconnect-needed');
        window.location.reload();
        return;
      }
      
      setRetryCount(0); // 重置重试计数
    });

    foxgloveClient.on("close", () => {
      setConnected(false);
      sessionStorage.setItem('foxglove-reconnect-needed', 'true'); // 记录掉线标记
      setTopics([]);
      setMessageStats({});
      frameTimesRef.current.clear();
      frameCountsRef.current.clear();

      // 自动尝试重连
      console.log("Foxglove 连接关闭，500ms后尝试重连...");
      setTimeout(() => {
        setRetryCount(prev => prev + 1);
      }, 500);
    });

    foxgloveClient.on("advertise", (newTopics) => {
      console.log("收到话题列表 (原始):", newTopics);
      setTopics((prev) => {
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

        for (const topic of added) {
          if (topic.schema) {
            try {
              const definitions = parse(topic.schema, { ros2: true });
              if (!readersRef.current.has(topic.id)) {
                readersRef.current.set(topic.id, new MessageReader(definitions));
              }
              if (!writersRef.current.has(topic.id)) {
                writersRef.current.set(topic.id, new MessageWriter(definitions));
              }
            } catch (err) {
              console.warn(`创建消息解析器/生成器失败: ${topic.name}`, err);
            }
          }
        }

        return nextTopics;
      });

      // 自动通告并创建本地发布者 (用于 /goal_pose 等反向传输)
      // 如果服务器没有通告这些话题，我们需要在这里主动注册给服务器，
      // 以便服务器后续知道如何处理 sendMessage 传过去的 channelId。
    });

    foxgloveClient.on("serverInfo", (info) => {
      if (info.capabilities && info.capabilities.includes("clientPublish")) {
        console.log("服务器支持 clientPublish 能力");
      }
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
        // 核心修复：移除对 event.data (Uint8Array) 的引用，防止原始二进制缓冲区无法被 GC 回收
        // rawData: event.data, 
        timestamp: event.timestamp,
        receivedAt: Date.now(),
      };

      // JS 原生数组 push 远比 [...arr] 原地重新构建立即拷贝快几个数量级，缓解 GC 压力
      if (!messageBufferRef.current[topicName]) {
        messageBufferRef.current[topicName] = [];
      }
      
      const MAX_LENGTH = 10; 
      
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
      writersRef.current.clear();
      topicsRef.current = [];
      frameTimesRef.current.clear();
      frameCountsRef.current.clear();
    };
  }, [url, retryCount]);

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

  const publish = useCallback((topicName: string, schemaName: string, data: any) => {
    if (!client) return;
    
    // Foxglove WebSocket Protocol requirement:
    // To publish a message, the client must first 'advertise' the channel.
    
    let channelId = clientAdvertisedChannelsRef.current.get(topicName);
    
    if (channelId === undefined) {
      // 1. Check if we have a schema definition for this schemaName from existing topics
      const existingTopicWithSchema = topicsRef.current.find(t => t.schemaName === schemaName && t.schema);
      
      if (!existingTopicWithSchema) {
        console.warn(`Cannot advertise ${topicName}: No schema found for ${schemaName}.`);
        return;
      }

      // 2. Locally advertise to get a channel ID
      channelId = nextClientChannelIdRef.current++;
      clientAdvertisedChannelsRef.current.set(topicName, channelId);

      // 3. Send 'advertise' operation to server
      client.advertise({
        id: channelId,
        topic: topicName,
        encoding: "cdr",
        schemaName: schemaName,
        schema: existingTopicWithSchema.schema
      });
      
      console.log(`Advertised new channel: ${topicName} (ID: ${channelId}) with schema ${schemaName}`);

      // 4. Ensure we have a writer for this new ID
      try {
        const definitions = parse(existingTopicWithSchema.schema!, { ros2: true });
        writersRef.current.set(channelId, new MessageWriter(definitions));
      } catch (err) {
        console.error(`Failed to create writer for advertised topic ${topicName}:`, err);
        return;
      }
    }

    const writer = writersRef.current.get(channelId);
    if (!writer) {
      console.warn(`No writer available for channel ${channelId} (${topicName}).`);
      return;
    }

    try {
      const encoded = writer.writeMessage(data);
      client.sendMessage(channelId, encoded);
      console.log(`Sent message to ${topicName} via channel ID ${channelId}`);
    } catch (err) {
      console.error(`Failed to encode or send message to ${topicName}:`, err);
    }
  }, [client]);

  return { client, connected, topics, messages, messageStats, subscribe, unsubscribe, publish };
}
