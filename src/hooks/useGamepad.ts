import { useEffect, useRef, useState } from 'react';

interface GamepadSettings {
  maxLinearSpeed: number;  // 最大线速度 m/s
  maxAngularSpeed: number; // 最大角速度 rad/s
  publishRate: number;     // 发送频率 (ms)
  deadzone: number;        // 死区
  enabled?: boolean;       // 是否启用控制
}

export function useGamepad(
  publish: (topic: string, type: string, data: any) => void,
  settings: GamepadSettings = { 
    maxLinearSpeed: 0.5, 
    maxAngularSpeed: 1.0, 
    publishRate: 50, 
    deadzone: 0.1,
    enabled: true
  }
) {
  const [gamepadInfo, setGamepadInfo] = useState<{
    connected: boolean, 
    id: string,
    axes: number[],
    v: { x: number, y: number, w: number }
  }>({
    connected: false,
    id: '',
    axes: [],
    v: { x: 0, y: 0, w: 0 }
  });

  const [manualV, setManualV] = useState({ x: 0, y: 0, w: 0 });

  const requestRef = useRef<number>(0);
  const lastPubTimeRef = useRef<number>(0);
  const lastLogTimeRef = useRef<number>(0);
  const lastUIUpdateTimeRef = useRef<number>(0);
  const isStoppedRef = useRef<boolean>(true); // 防止在静止状态下持续发送零速包

  // 核心逻辑：获取并处理手柄数据
  const updateLoop = () => {
    const gamepads = navigator.getGamepads();
    
    // 1. 自动寻找有效的手柄（支持蓝牙多槽位）
    let activeGp: Gamepad | null = null;
    for (const gp of gamepads) {
      if (gp && gp.connected) {
        activeGp = gp;
        break;
      }
    }

    const now = Date.now();
    let vx = 0;
    let vy = 0;
    let w = 0;

    if (activeGp) {
      // ... 手柄控制逻辑 ...
      const rawAngular = -activeGp.axes[0];
      const rawVx = -activeGp.axes[3];
      const rawVy = -activeGp.axes[2];

      vx = Math.abs(rawVx) > settings.deadzone ? rawVx * settings.maxLinearSpeed : 0;
      vy = Math.abs(rawVy) > settings.deadzone ? rawVy * settings.maxLinearSpeed : 0;
      w = Math.abs(rawAngular) > settings.deadzone ? rawAngular * settings.maxAngularSpeed : 0;

      // 只有当坐标值变化超过一定阈值，或者时间超过 200ms 才更新 UI 状态
      const shouldUpdateUI = !gamepadInfo.connected || 
                            Math.abs(vx - gamepadInfo.v.x) > 0.05 || 
                            Math.abs(vy - gamepadInfo.v.y) > 0.05 ||
                            Math.abs(w - gamepadInfo.v.w) > 0.05 ||
                            now - lastUIUpdateTimeRef.current > 200;

      if (shouldUpdateUI) {
        lastUIUpdateTimeRef.current = now;
        setGamepadInfo({ 
          connected: true, 
          id: activeGp.id,
          axes: [...activeGp.axes],
          v: { x: vx, y: vy, w: w }
        });
        
        if (now - lastLogTimeRef.current > 2000) {
          console.log(
            `%c[Gamepad Debug] 型号: ${activeGp.id.substring(0, 20)}... | vx: ${vx.toFixed(2)}, vy: ${vy.toFixed(2)}, w: ${w.toFixed(2)}`,
            "color: #3b82f6"
          );
          lastLogTimeRef.current = now;
        }
      }
    } else {
      // 无手柄连接，使用手动控制值
      vx = manualV.x * settings.maxLinearSpeed;
      vy = manualV.y * settings.maxLinearSpeed;
      w = manualV.w * settings.maxAngularSpeed;

      if (gamepadInfo.connected) {
        console.warn("[Gamepad] 手柄已断开连接");
        setGamepadInfo({ 
          connected: false, 
          id: '', 
          axes: [],
          v: { x: 0, y: 0, w: 0 }
        });
      }
    }

    // 3. 发布逻辑控制
    if (settings.enabled && now - lastPubTimeRef.current > settings.publishRate) {
      if (vx !== 0 || vy !== 0 || w !== 0) {
        publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
          linear: { x: vx, y: vy, z: 0 },
          angular: { x: 0, y: 0, z: w }
        });
        isStoppedRef.current = false;
      } else if (!isStoppedRef.current) {
        publish('/cmd_vel', 'geometry_msgs/msg/Twist', {
          linear: { x: 0, y: 0, z: 0 },
          angular: { x: 0, y: 0, z: 0 }
        });
        console.log("[Control] 停止移动 (已下发零速)");
        isStoppedRef.current = true;
      }
      lastPubTimeRef.current = now;
    }

    requestRef.current = requestAnimationFrame(updateLoop);
  };

  useEffect(() => {
    // ... 事件监听 ...
    const onConnect = (e: GamepadEvent) => {
      console.log("%c[Gamepad Event] 设备已连接: " + e.gamepad.id, "color: #22c55e");
    };
    const onDisconnect = (e: GamepadEvent) => {
      console.log("%c[Gamepad Event] 设备已移除: " + e.gamepad.id, "color: #ef4444");
    };

    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    
    requestRef.current = requestAnimationFrame(updateLoop);

    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      cancelAnimationFrame(requestRef.current);
    };
  }, [publish, gamepadInfo.connected, manualV, settings.enabled]);

  return { 
    gamepadConnected: gamepadInfo.connected, 
    gamepadId: gamepadInfo.id,
    axes: gamepadInfo.axes,
    v: gamepadInfo.connected ? gamepadInfo.v : {
      x: manualV.x * settings.maxLinearSpeed,
      y: manualV.y * settings.maxLinearSpeed,
      w: manualV.w * settings.maxAngularSpeed
    },
    manualV,
    setManualV
  };
}