import { useState, useEffect } from 'react';
import YAML from 'yaml';

export interface AppConfig {
  info: {
    api_port?: string;
  };
  visualize: Record<string, any>;
  service: Record<string, any>;
  status: Record<string, any>;
  log: Record<string, any>;
  chart: Record<string, any>;
  tf: Record<string, any>;
  control?: {
    max_linear_speed?: number;
    max_angular_speed?: number;
    max_pose_range?: number;
    publish_rate?: number;
  };
  robot?: {
    urdf?: string;
  };
}

export interface ConfigManifest {
  id: string;
  name: string;
  path: string;
}

export function useConfig(layoutPath: string = 'layout/wheelchair.yaml') {
  const [config, setConfig] = useState<AppConfig | null>(null);
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
    fetch(`/${layoutPath}`)
      .then(res => res.text())
      .then(text => {
        setConfig(YAML.parse(text));
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load config:', err);
        setLoading(false);
      });
  }, [layoutPath]);

  return { config, manifest, loading };
}
