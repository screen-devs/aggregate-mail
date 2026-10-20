import type { UpdateBridge } from "../shared/updates";
import type { OpenCodeSetupResult } from "../shared/opencode";
declare global {
  interface Window {
    desktop?: {
      platform: string;
      notifications?: import("../shared/notifications").NotificationBridge;
      materials: boolean;
      setMaterial?: (material: "none" | "mica" | "acrylic") => void;
      setScheme?: (mode: "system" | "light" | "dark") => void;
      windowControls?: "mac" | "windows";
      setWindowControls?: (controls: "mac" | "windows") => void;
      setOverlay?: (colors: { color: string; symbolColor: string }) => void;
      mailMenu?: (
        items: { id: string; label: string; enabled: boolean; accelerator?: string; separator?: boolean }[],
        position?: { x: number; y: number },
      ) => Promise<string | null>;
      credentialFallback?: "linux-local";
      copyMcpEndpoint?: () => Promise<void>;
      copyOpenCodeConfig?: (token: string) => Promise<void>;
      setupOpenCode?: (token: string) => Promise<OpenCodeSetupResult>;
      updates?: UpdateBridge;
      onNavigation: (callback: (direction: "back" | "forward") => void) => () => void;
      onMailChanged: (callback: () => void) => () => void;
      oauthUrl: string;
      windowCommand: (command: "minimize" | "maximize" | "close") => void;
      onWindowState: (callback: (maximized: boolean) => void) => () => void;
      onAccountConnected: (
        callback: (error: string | null) => void,
      ) => () => void;
    };
  }
}
