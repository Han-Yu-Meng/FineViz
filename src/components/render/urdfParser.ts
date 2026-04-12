import { Matrix4, Quaternion } from '@math.gl/core';
import { XMLParser } from 'fast-xml-parser';

export interface URDFVisual {
  origin: {
    xyz: [number, number, number];
    rpy: [number, number, number];
  };
  geometry: {
    mesh?: {
      filename: string;
      scale?: [number, number, number];
    };
    box?: { size: [number, number, number] };
    sphere?: { radius: number };
    cylinder?: { radius: number; length: number };
  };
}

export interface URDFLink {
  name: string;
  visuals: URDFVisual[];
}

export interface URDFJoint {
  name: string;
  type: string;
  parent: string;
  child: string;
  origin: {
    xyz: [number, number, number];
    rpy: [number, number, number];
  };
}

export interface URDFRobot {
  name: string;
  links: Record<string, URDFLink>;
  joints: Record<string, URDFJoint>;
}

function parseVector(val: any, defaultVal: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (val === undefined || val === null) return defaultVal;
  const str = Array.isArray(val) ? val[0] : val;
  if (typeof str !== 'string') return defaultVal;
  
  const parts = str.trim().split(/\s+/).map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export async function parseURDF(xmlText: string, urdfPath: string): Promise<URDFRobot> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    // 强制将这些关键节点设为数组，防止单节点时解析为对象
    isArray: (name) => ["link", "joint", "visual", "origin", "geometry", "mesh"].includes(name)
  });
  const result = parser.parse(xmlText);
  const robot = result.robot;
  const name = robot.name;

  const links: Record<string, URDFLink> = {};
  const joints: Record<string, URDFJoint> = {};

  (robot.link || []).forEach((l: any) => {
    const linkName = l.name;
    const visuals: URDFVisual[] = (l.visual || []).map((v: any) => {
      // 这里的 v.origin 已经是数组
      const o = v.origin?.[0];
      const origin = o ? {
        xyz: parseVector(o.xyz),
        rpy: parseVector(o.rpy)
      } : { xyz: [0, 0, 0], rpy: [0, 0, 0] };

      const geometry: any = {};
      const g = v.geometry?.[0];
      if (g) {
        if (g.mesh) {
          const m = g.mesh[0];
          let filename = m.filename;
          if (filename && filename.startsWith('package://')) {
            filename = filename.replace('package://', '');
          }
          geometry.mesh = {
            filename,
            scale: parseVector(m.scale, [1, 1, 1])
          };
        } else if (g.box) {
          geometry.box = { size: parseVector(g.box[0].size) };
        }
      }
      return { origin, geometry };
    });
    links[linkName] = { name: linkName, visuals };
  });

  (robot.joint || []).forEach((j: any) => {
    const jointName = j.name;
    
    const extractName = (node: any) => {
      if (!node) return '';
      const target = Array.isArray(node) ? node[0] : node;
      return target.link || target;
    };

    const parent = extractName(j.parent);
    const child = extractName(j.child);
    const o = j.origin?.[0];
    
    joints[jointName] = {
      name: jointName,
      type: j.type,
      parent: String(parent),
      child: String(child),
      origin: o ? {
        xyz: parseVector(o.xyz),
        rpy: parseVector(o.rpy)
      } : { xyz: [0, 0, 0], rpy: [0, 0, 0] }
    };
  });

  return { name, links, joints };
}
