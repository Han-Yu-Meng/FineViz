export type PointCloudBinary = {
  length: number;
  positions: Float32Array;
  colors: Uint8Array;
  frameId: string;
};

export interface TFLink {
  parent: string;
  child: string;
  position: [number, number, number];
  rotation: [number, number, number, number]; // quaternion [x, y, z, w]
}
