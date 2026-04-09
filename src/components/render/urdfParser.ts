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

function parseVector(str: string | undefined, defaultVal: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!str) return defaultVal;
  const parts = str.trim().split(/\s+/).map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export async function parseURDF(xmlText: string, urdfPath: string): Promise<URDFRobot> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => ["link", "joint", "visual"].includes(name)
  });
  const result = parser.parse(xmlText);
  const robot = result.robot;
  const name = robot.name;

  const links: Record<string, URDFLink> = {};
  const joints: Record<string, URDFJoint> = {};

  (robot.link || []).forEach((l: any) => {
    const linkName = l.name;
    const visuals: URDFVisual[] = (l.visual || []).map((v: any) => {
      const origin = v.origin ? {
        xyz: parseVector(v.origin.xyz),
        rpy: parseVector(v.origin.rpy)
      } : { xyz: [0, 0, 0], rpy: [0, 0, 0] };

      const geometry: any = {};
      if (v.geometry.mesh) {
        let filename = v.geometry.mesh.filename;
        // Resolve package://
        if (filename.startsWith('package://')) {
          // package://meshes/wheel_chair.dae -> meshes/wheel_chair.dae
          filename = filename.replace('package://', '');
        }
        geometry.mesh = {
          filename,
          scale: parseVector(v.geometry.mesh.scale, [1, 1, 1])
        };
      } else if (v.geometry.box) {
        geometry.box = { size: parseVector(v.geometry.box.size) };
      }
      return { origin, geometry };
    });
    links[linkName] = { name: linkName, visuals };
  });

  (robot.joint || []).forEach((j: any) => {
    const jointName = j.name;
    joints[jointName] = {
      name: jointName,
      type: j.type,
      parent: j.parent.link,
      child: j.child.link,
      origin: j.origin ? {
        xyz: parseVector(j.origin.xyz),
        rpy: parseVector(j.origin.rpy)
      } : { xyz: [0, 0, 0], rpy: [0, 0, 0] }
    };
  });

  return { name, links, joints };
}
