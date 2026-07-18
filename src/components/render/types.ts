export type PointCloudBinary = {
  length: number;
  positions: Float32Array;
  colors: Uint8Array;
  frameId: string;
  pointSize?: number;
  alpha?: number;
};

// ── Web Worker 消息协议 ──

export interface OccupancyGridRaw {
  width: number;
  height: number;
  resolution: number;
  origin: {
    position: [number, number, number];
    orientation: [number, number, number, number];
  };
  rgba: Uint8ClampedArray;
  frameId: string;
}

export type WorkerRequest =
  | {
      id: number;
      type: 'PC_DECODE';
      topic: string;
      data: any;
      options: { colorField?: string; colorScheme?: string; targetMaxPoints: number };
    }
  | {
      id: number;
      type: 'GRID_DECODE';
      topic: string;
      data: any;
      options: { existingWidth?: number; existingHeight?: number };
    };

export type WorkerResponse =
  | { id: number; type: 'PC_RESULT'; topic: string; payload: PointCloudBinary | null }
  | { id: number; type: 'GRID_RESULT'; topic: string; payload: OccupancyGridRaw | null };
