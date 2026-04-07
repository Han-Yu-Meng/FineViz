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

export function useFoxglove(url: string) {
  const [client, setClient] = useState<FoxgloveClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [messages, setMessages] = useState<Record<string, any[]>>({});
  
  const wsRef = useRef<WebSocket | null>(null);
  const topicsRef = useRef<Topic[]>([]);
  const readersRef = useRef<Map<number, MessageReader>>(new Map());

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
      setMessages(prev => {
        // Find topic name using our subscription ID map
        const topicName = subscriptionsRef.current.get(event.subscriptionId);
        if (!topicName) return prev;

        const topic = topicsRef.current.find(t => t.name === topicName);
        if (!topic) return prev;
        
        const existingMessages = prev[topicName] || [];
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
        };
        
        if (topic.schemaName === 'sensor_msgs/msg/PointCloud2') {
          return { ...prev, [topicName]: [newMessage] };
        }

        return {
          ...prev,
          [topicName]: [...existingMessages.slice(-19), newMessage]
        };
      });
    });

    setClient(foxgloveClient);

    return () => {
      foxgloveClient.close();
      ws.close();
      readersRef.current.clear();
      topicsRef.current = [];
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

      // Map SDK subscription id to topic name for message routing
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

  return { client, connected, topics, messages, subscribe, unsubscribe };
}
