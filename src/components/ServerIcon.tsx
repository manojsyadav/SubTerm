import React from "react";
import {
  Server,
  HardDrive,
  Box,
  Database,
  Cloud,
  Cpu,
  Wifi,
  Shield,
  Monitor,
  Terminal,
} from "lucide-react";

export function renderServerIcon(icon?: string, size: number = 14, className: string = "") {
  switch (icon) {
    case "nas":
    case "storage":
      return <HardDrive size={size} className={className} />;
    case "docker":
    case "container":
      return <Box size={size} className={className} />;
    case "database":
    case "db":
      return <Database size={size} className={className} />;
    case "cloud":
      return <Cloud size={size} className={className} />;
    case "cpu":
    case "worker":
      return <Cpu size={size} className={className} />;
    case "router":
    case "wifi":
      return <Wifi size={size} className={className} />;
    case "shield":
    case "firewall":
      return <Shield size={size} className={className} />;
    case "desktop":
      return <Monitor size={size} className={className} />;
    case "terminal":
      return <Terminal size={size} className={className} />;
    case "server":
    default:
      return <Server size={size} className={className} />;
  }
}
