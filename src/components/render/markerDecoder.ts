import { Matrix4, Quaternion } from '@math.gl/core';

export interface MarkerPrimitive {
  type: number; // 0: ARROW, 1: CUBE, 2: SPHERE, 3: CYLINDER, 4: LINE_STRIP, 5: LINE_LIST, 8: POINTS
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  color: [number, number, number, number]; // RGBA 0-255
  points: [number, number, number][]; // optional for list types
  colors: [number, number, number, number][]; // optional per point
  ns: string;
  id: number;
}

function parseColor(c: any): [number, number, number, number] {
  if (!c) return [255, 255, 255, 255];
  return [
    Math.round((c.r || 0) * 255),
    Math.round((c.g || 0) * 255),
    Math.round((c.b || 0) * 255),
    Math.round((c.a || 1) * 255)
  ];
}

export function decodeMarkerArray(msg: any): Record<string, MarkerPrimitive[]> {
  if (!msg || !msg.markers) return {};

  const result: Record<string, MarkerPrimitive[]> = {};

  msg.markers.forEach((m: any) => {
    // Only handling ADD/MODIFY (0), skipping DELETE (2) / DELETEALL (3) for a stateless snapshot approach 
    // In a stateless approach of the latest message, we just assume we draw what's ADD/MODIFY.
    if (m.action !== 0) return;

    let frameId = m.header?.frame_id || 'map';
    if (frameId.startsWith('/')) frameId = frameId.substring(1);

    if (!result[frameId]) result[frameId] = [];

    const baseColor = parseColor(m.color);
    
    const points = (m.points || []).map((p: any) => [p.x, p.y, p.z || 0]);
    const colors = (m.colors || []).map((c: any) => parseColor(c));

    const primitive: MarkerPrimitive = {
      type: m.type,
      ns: m.ns,
      id: m.id,
      position: [m.pose?.position?.x || 0, m.pose?.position?.y || 0, m.pose?.position?.z || 0],
      rotation: [
        m.pose?.orientation?.x || 0,
        m.pose?.orientation?.y || 0,
        m.pose?.orientation?.z || 0,
        m.pose?.orientation?.w !== undefined ? m.pose.orientation.w : 1
      ],
      scale: [m.scale?.x || 1, m.scale?.y || 1, m.scale?.z || 1],
      color: baseColor,
      points,
      colors
    };

    result[frameId].push(primitive);
  });

  return result;
}
