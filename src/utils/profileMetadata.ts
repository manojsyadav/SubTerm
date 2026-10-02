import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "subterm-profile-icons";
const CHANGE_EVENT = "subterm-profile-icons-changed";

export const DEFAULT_PROFILE_ICONS = [
  "👤", "💼", "🚀", "🛡️", "⚡", "💻", "🌐", "🔥", "🏢", "📦", "🐧", "🪟", "🍎", "☁️", "🔒", "🔑", "🛠️", "⚙️"
];

export function getAllProfileIcons(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getProfileIcon(name?: string | null): string {
  if (!name) return "👤";
  const map = getAllProfileIcons();
  return map[name] || "👤";
}

export function setProfileIcon(name: string, icon: string): void {
  if (!name) return;
  const map = getAllProfileIcons();
  map[name] = icon || "👤";
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: map }));
  } catch (e) {
    console.warn("Failed to save profile icon:", e);
  }
}

export function renameProfileIcon(oldName: string, newName: string): void {
  if (!oldName || !newName || oldName === newName) return;
  const map = getAllProfileIcons();
  if (map[oldName]) {
    map[newName] = map[oldName];
    delete map[oldName];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: map }));
    } catch (e) {
      console.warn("Failed to rename profile icon:", e);
    }
  }
}

export function deleteProfileIcon(name: string): void {
  if (!name) return;
  const map = getAllProfileIcons();
  if (map[name]) {
    delete map[name];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: map }));
    } catch (e) {
      console.warn("Failed to delete profile icon:", e);
    }
  }
}

export function useProfileIcon(name?: string | null) {
  const [icon, setIcon] = useState<string>(() => getProfileIcon(name));

  useEffect(() => {
    setIcon(getProfileIcon(name));
    const handleUpdate = () => {
      setIcon(getProfileIcon(name));
    };
    window.addEventListener(CHANGE_EVENT, handleUpdate);
    window.addEventListener("storage", handleUpdate);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handleUpdate);
      window.removeEventListener("storage", handleUpdate);
    };
  }, [name]);

  const updateIcon = useCallback(
    (newIcon: string) => {
      if (name) {
        setProfileIcon(name, newIcon);
        setIcon(newIcon);
      }
    },
    [name]
  );

  return { icon, updateIcon };
}
