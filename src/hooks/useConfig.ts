import { useState, useEffect } from 'react';
import YAML from 'yaml';

export interface AppConfig {
  info: {
    server: string;
    api_server: string;
  };
  visualize: Record<string, any>;
  service: Record<string, any>;
  chart: Record<string, any>;
  tf: Record<string, any>;
  robot?: {
    urdf?: string;
  };
}

export interface ConfigManifest {
  id: string;
  name: string;
  path: string;
}

export interface Waypoint {
  id: number;
  name: string;
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

export function useConfig(layoutPath: string = 'layout/wheelchair.yaml') {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [manifest, setManifest] = useState<ConfigManifest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/configs.json')
      .then(res => res.json())
      .then(data => setManifest(data))
      .catch(err => console.error('Failed to load configs manifest:', err));
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/${layoutPath}`).then(res => res.text()),
      fetch('/navigation/waypoints.yaml').then(res => res.text()).catch(() => '')
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
  }, [layoutPath]);

  return { config, waypoints, manifest, loading };
}
