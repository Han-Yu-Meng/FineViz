import { useState, useEffect } from 'react';
import YAML from 'yaml';

export interface AppConfig {
  info: {
    name: string;
    server: string;
    api_server: string;
  };
  visualize: Record<string, any>;
  service: Record<string, any>;
  chart: Record<string, any>;
  tf: Record<string, any>;
}

export interface Waypoint {
  id: number;
  name: string;
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/layout.yaml').then(res => res.text()),
      fetch('/waypoints.yaml').then(res => res.text()).catch(() => '')
    ])
      .then(([layoutText, waypointsText]) => {
        const parsedLayout = YAML.parse(layoutText);
        setConfig(parsedLayout);
        
        if (waypointsText) {
          const parsedWaypoints = YAML.parse(waypointsText);
          if (parsedWaypoints && parsedWaypoints.waypoints) {
            setWaypoints(parsedWaypoints.waypoints);
          }
        }
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load config:', err);
        setLoading(false);
      });
  }, []);

  return { config, waypoints, loading };
}
