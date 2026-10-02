import { useState, useEffect, useCallback } from "react";

export interface QuickCommandItem {
  id: string;
  label: string;
  cmd: string;
  autoEnter?: boolean;
}

export interface QuickCommandEnvGroup {
  id: string;
  name: string;
  icon: string;
  description: string;
  commands: QuickCommandItem[];
}

export const STORAGE_KEY = "subterm-quick-commands-v1";
export const CHANGE_EVENT = "subterm-quick-commands-changed";

export const DEFAULT_QUICK_COMMANDS: Record<string, QuickCommandEnvGroup> = {
  linux: {
    id: "linux",
    name: "Linux (Generic)",
    icon: "🐧",
    description: "Standard Linux distributions (Ubuntu, Debian, CentOS, Fedora, etc.)",
    commands: [
      { id: "l-1", label: "docker ps", cmd: "docker ps\r", autoEnter: true },
      { id: "l-2", label: "htop", cmd: "htop\r", autoEnter: true },
      { id: "l-3", label: "df -h", cmd: "df -h\r", autoEnter: true },
      { id: "l-4", label: "free -m", cmd: "free -m\r", autoEnter: true },
      { id: "l-5", label: "git status", cmd: "git status\r", autoEnter: true },
      { id: "l-6", label: "journalctl", cmd: "journalctl -n 50 -f\r", autoEnter: true },
      { id: "l-7", label: "netstat", cmd: "netstat -tulnp\r", autoEnter: true },
      { id: "l-8", label: "uptime", cmd: "uptime\r", autoEnter: true },
    ],
  },
  truenas: {
    id: "truenas",
    name: "TrueNAS / Appliance",
    icon: "🐡",
    description: "TrueNAS SCALE, CORE, and FreeBSD/appliance storage nodes",
    commands: [
      { id: "t-1", label: "docker ps", cmd: "docker ps\r", autoEnter: true },
      { id: "t-2", label: "htop", cmd: "htop\r", autoEnter: true },
      { id: "t-3", label: "df -h", cmd: "df -h\r", autoEnter: true },
      { id: "t-4", label: "free -m", cmd: "free -m\r", autoEnter: true },
      { id: "t-5", label: "git status", cmd: "git status\r", autoEnter: true },
      { id: "t-6", label: "tail messages", cmd: "tail -n 50 -f /var/log/messages\r", autoEnter: true },
      { id: "t-7", label: "zpool status", cmd: "zpool status\r", autoEnter: true },
      { id: "t-8", label: "midclt system", cmd: "midclt call system.info | jq .\r", autoEnter: true },
    ],
  },
  "windows-ps": {
    id: "windows-ps",
    name: "Windows (PowerShell)",
    icon: "🪟",
    description: "PowerShell 7 (pwsh) and Windows PowerShell environments",
    commands: [
      { id: "wps-1", label: "ipconfig", cmd: "ipconfig\r", autoEnter: true },
      { id: "wps-2", label: "Get-Process", cmd: "Get-Process | Select-Object -First 15\r", autoEnter: true },
      { id: "wps-3", label: "Get-Service", cmd: "Get-Service | Where-Object Status -eq 'Running' | Select-Object -First 10\r", autoEnter: true },
      { id: "wps-4", label: "dir", cmd: "dir\r", autoEnter: true },
      { id: "wps-5", label: "netstat", cmd: "netstat -ano\r", autoEnter: true },
      { id: "wps-6", label: "systeminfo", cmd: "systeminfo\r", autoEnter: true },
      { id: "wps-7", label: "Test-Port", cmd: "Test-NetConnection 8.8.8.8 -Port 53\r", autoEnter: true },
    ],
  },
  "windows-cmd": {
    id: "windows-cmd",
    name: "Windows (CMD)",
    icon: "🪟",
    description: "Windows Command Prompt (cmd.exe)",
    commands: [
      { id: "wcmd-1", label: "ipconfig", cmd: "ipconfig\r", autoEnter: true },
      { id: "wcmd-2", label: "tasklist", cmd: "tasklist\r", autoEnter: true },
      { id: "wcmd-3", label: "netstat", cmd: "netstat -ano\r", autoEnter: true },
      { id: "wcmd-4", label: "dir", cmd: "dir\r", autoEnter: true },
      { id: "wcmd-5", label: "systeminfo", cmd: "systeminfo\r", autoEnter: true },
      { id: "wcmd-6", label: "ping 8.8.8.8", cmd: "ping 8.8.8.8\r", autoEnter: true },
    ],
  },
  darwin: {
    id: "darwin",
    name: "macOS (Darwin)",
    icon: "🍎",
    description: "Apple macOS terminal and BSD userland",
    commands: [
      { id: "mac-1", label: "top", cmd: "top\r", autoEnter: true },
      { id: "mac-2", label: "df -h", cmd: "df -h\r", autoEnter: true },
      { id: "mac-3", label: "ifconfig", cmd: "ifconfig\r", autoEnter: true },
      { id: "mac-4", label: "ps aux", cmd: "ps aux | head -20\r", autoEnter: true },
      { id: "mac-5", label: "brew list", cmd: "brew list\r", autoEnter: true },
      { id: "mac-6", label: "git status", cmd: "git status\r", autoEnter: true },
      { id: "mac-7", label: "netstat -nr", cmd: "netstat -nr\r", autoEnter: true },
    ],
  },
};

export function loadQuickCommandsConfig(): Record<string, QuickCommandEnvGroup> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_QUICK_COMMANDS };
    const parsed = JSON.parse(raw);
    // Ensure all default env keys exist
    const merged: Record<string, QuickCommandEnvGroup> = { ...DEFAULT_QUICK_COMMANDS };
    for (const [key, group] of Object.entries(parsed)) {
      if (group && typeof group === "object") {
        merged[key] = {
          ...DEFAULT_QUICK_COMMANDS[key],
          ...(group as QuickCommandEnvGroup),
        };
      }
    }
    return merged;
  } catch (e) {
    console.warn("Failed to load quick commands from localStorage", e);
    return { ...DEFAULT_QUICK_COMMANDS };
  }
}

export function saveQuickCommandsConfig(config: Record<string, QuickCommandEnvGroup>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: config }));
  } catch (e) {
    console.warn("Failed to save quick commands to localStorage", e);
  }
}

export function resolveEnvKey(detectedOs: any, session: any): string {
  const osType = detectedOs?.os_type || (session?.isLocal ? "windows" : "linux");
  if (osType === "windows") {
    if (session?.isLocal && session?.localShell === "cmd") {
      return "windows-cmd";
    }
    return "windows-ps";
  }
  if (osType === "darwin") {
    return "darwin";
  }
  const isTrueNas =
    detectedOs?.distro_id === "truenas" ||
    /truenas/i.test(detectedOs?.distro || "") ||
    /freenas/i.test(detectedOs?.distro || "");
  if (isTrueNas) {
    return "truenas";
  }
  return "linux";
}

export function useQuickCommands(targetEnv?: string) {
  const [config, setConfig] = useState<Record<string, QuickCommandEnvGroup>>(() => loadQuickCommandsConfig());

  useEffect(() => {
    const handleUpdate = () => {
      setConfig(loadQuickCommandsConfig());
    };
    window.addEventListener(CHANGE_EVENT, handleUpdate);
    window.addEventListener("storage", handleUpdate);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleUpdate);
      window.removeEventListener("storage", handleUpdate);
    };
  }, []);

  const commands = targetEnv && config[targetEnv] ? config[targetEnv].commands : [];

  const updateCommandsForEnv = useCallback(
    (envKey: string, newCommands: QuickCommandItem[]) => {
      const next = { ...config };
      if (!next[envKey]) {
        next[envKey] = {
          id: envKey,
          name: envKey,
          icon: "⚡",
          description: `Custom environment: ${envKey}`,
          commands: [],
        };
      }
      next[envKey] = {
        ...next[envKey],
        commands: newCommands,
      };
      saveQuickCommandsConfig(next);
      setConfig(next);
    },
    [config]
  );

  const addCommand = useCallback(
    (envKey: string, cmd: Omit<QuickCommandItem, "id">) => {
      const newCmd: QuickCommandItem = {
        ...cmd,
        id: `${envKey}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      };
      const existing = config[envKey]?.commands || [];
      updateCommandsForEnv(envKey, [...existing, newCmd]);
    },
    [config, updateCommandsForEnv]
  );

  const removeCommand = useCallback(
    (envKey: string, commandId: string) => {
      const existing = config[envKey]?.commands || [];
      updateCommandsForEnv(
        envKey,
        existing.filter((c) => c.id !== commandId)
      );
    },
    [config, updateCommandsForEnv]
  );

  const updateCommand = useCallback(
    (envKey: string, commandId: string, updated: Partial<QuickCommandItem>) => {
      const existing = config[envKey]?.commands || [];
      updateCommandsForEnv(
        envKey,
        existing.map((c) => (c.id === commandId ? { ...c, ...updated } : c))
      );
    },
    [config, updateCommandsForEnv]
  );

  const reorderCommands = useCallback(
    (envKey: string, fromIndex: number, toIndex: number) => {
      const existing = [...(config[envKey]?.commands || [])];
      if (toIndex < 0 || toIndex >= existing.length) return;
      const [moved] = existing.splice(fromIndex, 1);
      existing.splice(toIndex, 0, moved);
      updateCommandsForEnv(envKey, existing);
    },
    [config, updateCommandsForEnv]
  );

  const resetEnv = useCallback(
    (envKey: string) => {
      const defaultGroup = DEFAULT_QUICK_COMMANDS[envKey];
      if (defaultGroup) {
        updateCommandsForEnv(envKey, [...defaultGroup.commands]);
      }
    },
    [updateCommandsForEnv]
  );

  const resetAll = useCallback(() => {
    saveQuickCommandsConfig({ ...DEFAULT_QUICK_COMMANDS });
    setConfig({ ...DEFAULT_QUICK_COMMANDS });
  }, []);

  const addCustomEnv = useCallback(
    (id: string, name: string, icon: string, description?: string) => {
      const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!cleanId || config[cleanId]) return false;
      const next = {
        ...config,
        [cleanId]: {
          id: cleanId,
          name: name.trim() || cleanId,
          icon: icon || "⚡",
          description: description?.trim() || `Custom environment: ${cleanId}`,
          commands: [],
        },
      };
      saveQuickCommandsConfig(next);
      setConfig(next);
      return true;
    },
    [config]
  );

  const removeCustomEnv = useCallback(
    (envKey: string) => {
      if (DEFAULT_QUICK_COMMANDS[envKey]) return; // Cannot delete standard OS envs
      const next = { ...config };
      delete next[envKey];
      saveQuickCommandsConfig(next);
      setConfig(next);
    },
    [config]
  );

  return {
    config,
    commands,
    updateCommandsForEnv,
    addCommand,
    removeCommand,
    updateCommand,
    reorderCommands,
    resetEnv,
    resetAll,
    addCustomEnv,
    removeCustomEnv,
  };
}
