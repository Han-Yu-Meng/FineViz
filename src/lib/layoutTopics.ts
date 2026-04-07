import { AppConfig } from '../hooks/useConfig';

export type LayoutTopicItem = {
  name: string;
  type: string;
};

export function collectLayoutTopics(config: AppConfig | null): LayoutTopicItem[] {
  if (!config) return [];

  const topicMap = new Map<string, LayoutTopicItem>();

  Object.values(config.visualize || {}).forEach((item: any) => {
    if (!item?.topic) return;
    topicMap.set(item.topic, {
      name: item.topic,
      type: item.type || 'unknown',
    });
  });

  Object.values(config.service || {}).forEach((item: any) => {
    if (!item?.topic) return;
    topicMap.set(item.topic, {
      name: item.topic,
      type: item.type || 'unknown',
    });
  });

  Object.values(config.chart || {}).forEach((charts: any) => {
    (charts as any[]).forEach((chart: any) => {
      if (!chart?.topic || topicMap.has(chart.topic)) return;
      topicMap.set(chart.topic, {
        name: chart.topic,
        type: 'chart',
      });
    });
  });

  return Array.from(topicMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}