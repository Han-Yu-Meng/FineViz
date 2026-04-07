import { useState, useEffect, useRef, useCallback } from 'react';
import { FoxgloveClient } from '@foxglove/ws-protocol';

export interface Topic {
  name: string;
  schemaName: string;
}

export function useFoxglove(url: string) {
  const [client, setClient] = useState<FoxgloveClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [messages, setMessages] = useState<Record<string, any[]>>({});
  
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!url) return;

    const ws = new WebSocket(url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]);
    wsRef.current = ws;

    const foxgloveClient = new FoxgloveClient({
      ws,
    });

    foxgloveClient.on("open", () => {
      setConnected(true);
    });

    foxgloveClient.on("close", () => {
      setConnected(false);
      setTopics([]);
    });

    foxgloveClient.on("advertise", (newTopics) => {
      setTopics((prev) => {
        const existingNames = new Set(prev.map(t => t.name));
        const added = newTopics.filter(t => !existingNames.has(t.name));
        return [...prev, ...added];
      });
    });

    foxgloveClient.on("unadvertise", (removedTopics) => {
      setTopics((prev) => {
        const removedNames = new Set(removedTopics);
        return prev.filter(t => !removedNames.has(t.name));
      });
    });

    foxgloveClient.on("message", (event) => {
      // Handle incoming messages
      // This is a simplified version. In a real app, you'd decode the binary payload
      // based on the schema. For this visualization, we'll store raw or parsed data
      // depending on what we can do. Since we don't have real ROS schemas here,
      // we just acknowledge the message reception.
      
      // setMessages(prev => ...)
    });

    setClient(foxgloveClient);

    return () => {
      foxgloveClient.close();
      ws.close();
    };
  }, [url]);

  const subscribe = useCallback((topicName: string) => {
    if (!client) return;
    const topic = topics.find(t => t.name === topicName);
    if (topic) {
      // client.subscribe(topic.id);
    }
  }, [client, topics]);

  return { client, connected, topics, messages, subscribe };
}
