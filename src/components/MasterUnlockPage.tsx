import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle, ArrowRight, ShieldCheck, Heart,
  Sparkles, CheckCircle2, Lock, Cloud, KeyRound, ArrowUpCircle, Info
} from "lucide-react";
import logoUrl from "../assets/logo.png";
import PasswordField from "./PasswordField";
import AboutPanel from "./AboutPanel";

interface UpdateInfo {
  current: string;
  latest: string | null;
  has_update: boolean;
  release_url: string | null;
}

interface CloudStatus {
  signed_in: boolean;
  email: string | null;
}

interface Props {
  onUnlocked: (profileName: string) => void;
  autoSync?: boolean;
  onOpenSettings?: () => void;
  initialSelectedProfile?: string | null;
}

export const MasterUnlockPage = ({
  onUnlocked,
  autoSync,
  onOpenSettings,
  initialSelectedProfile,
}: Props) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Password state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [enableBiometric, setEnableBiometric] = useState(false);
  const [hasBiometricSaved, setHasBiometricSaved] = useState(false);

  // Is this a brand new setup with zero profiles?
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // Cloud status & restore drawer
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>({ signed_in: false, email: null });
  const [showCloudRestore, setShowCloudRestore] = useState(false);
  const [cloudEmail, setCloudEmail] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // Clean error prefixes
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  // Load profiles on mount and pick target
  const getTargetWorkspace = (available: string[]) => {
    if (available.length === 0) return "default";
    const remembered = localStorage.getItem("subterm_last_workspace");
    if (remembered && available.includes(remembered)) return remembered;
    if (initialSelectedProfile && available.includes(initialSelectedProfile)) return initialSelectedProfile;
    return available[0];
  };

  useEffect(() => {
    let isMounted = true;
    const init = async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<string[]>("list_profiles");
        if (!isMounted) return;
        setProfiles(list);
        if (list.length === 0) {
          setIsFirstRun(true);
        } else {
          setIsFirstRun(false);
          const target = getTargetWorkspace(list);
          const bioSaved = localStorage.getItem("subterm-master-bio") || localStorage.getItem(`submarine-bio-${target}`);
          setHasBiometricSaved(!!bioSaved);
        }
      } catch (e: any) {
        if (isMounted) setError(cleanErr(e));
      } finally {
        if (isMounted) {
          setLoading(false);
          requestAnimationFrame(() => passwordInputRef.current?.focus());
        }
      }
    };

    init();
    return () => { isMounted = false; };
  }, [initialSelectedProfile]);

  // Check for updates
  useEffect(() => {
    invoke<UpdateInfo>("check_for_updates")
      .then((u) => { if (u?.has_update && u.latest) setUpdate(u); })
      .catch(() => {});
  }, []);

  // Check cloud status
  useEffect(() => {
    if (autoSync) {
      invoke<CloudStatus>("cloud_status")
        .then(setCloudStatus)
        .catch(() => {});
    }
  }, [autoSync]);

  const handleUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!password) {
      setError("Please enter your Master Password.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (isFirstRun) {
        // Initial setup
        if (password.length < 8) {
          setError("Password must be at least 8 characters long.");
          setBusy(false);
          return;
        }
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          setBusy(false);
          return;
        }

        // Create default workspace
        await invoke("create_profile", { name: "default", password });
        await invoke("select_profile", { name: "default" });
        await invoke("setup_master_db", { password });

        if (enableBiometric) {
          localStorage.setItem("subterm-master-bio", btoa(password));
        }
        localStorage.setItem("subterm_last_workspace", "default");
        onUnlocked("default");
      } else {
        // Normal unlock
        const target = getTargetWorkspace(profiles);
        await invoke("select_profile", { name: target });
        await invoke("setup_master_db", { password });

        if (enableBiometric) {
          localStorage.setItem("subterm-master-bio", btoa(password));
          localStorage.setItem(`submarine-bio-${target}`, btoa(password));
        }
        localStorage.setItem("subterm_last_workspace", target);
        onUnlocked(target);
      }
    } catch (e: any) {
      const raw = String(e);
      if (raw.toLowerCase().includes("decrypt") || raw.includes("PASSWORD")) {
        setError("Incorrect Master Password. Please try again.");
      } else {
        setError(cleanErr(raw));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUnlockWithBiometrics = async () => {
    const target = getTargetWorkspace(profiles);
    const saved = localStorage.getItem("subterm-master-bio") || localStorage.getItem(`submarine-bio-${target}`);
    if (!saved) return;

    setBusy(true);
    setError(null);
    try {
      if (window.PublicKeyCredential) {
        try {
          const challenge = new Uint8Array(32);
          window.crypto.getRandomValues(challenge);
          await navigator.credentials.get({
            publicKey: { challenge, timeout: 60000, userVerification: "preferred" },
          }).catch(() => {});
        } catch {}
      }

      const decoded = atob(saved);
      await invoke("select_profile", { name: target });
      await invoke("setup_master_db", { password: decoded });

      localStorage.setItem("subterm_last_workspace", target);
      onUnlocked(target);
    } catch (e: any) {
      const raw = String(e);
      if (raw.toLowerCase().includes("decrypt")) {
        setError("Biometric token expired or invalid. Please type your password.");
      } else {
        setError(cleanErr(raw));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCloudSignInAndRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudEmail || !cloudPassword) return;
    setCloudBusy(true);
    setError(null);
    try {
      await invoke("cloud_auth_sign_in", { email: cloudEmail, password: cloudPassword });
      // Fetch sync profiles from cloud
      const cps = await invoke<any[]>("cloud_list_sync_profiles");
      if (cps && cps.length > 0) {
        // Import first cloud profile
        const first = cps[0];
        await invoke("import_profile_cloud", { profile: first.profile, name: first.name });
        const list = await invoke<string[]>("list_profiles");
        setProfiles(list);
        setIsFirstRun(false);
        setShowCloudRestore(false);
        setError(null);
      } else {
        setError("No profiles found in cloud account.");
      }
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setCloudBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 bg-background min-h-screen relative overflow-hidden select-none">
      {/* Background ambient lighting */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-primary/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="w-full max-w-[340px] flex flex-col z-10 animate-in fade-in zoom-in-95 duration-200">
        {/* Logo & Branding */}
        <div className="flex flex-col items-center mb-6">
          <div className="relative mb-3 group">
            <img
              src={logoUrl}
              alt="SubTerm Logo"
              draggable={false}
              className="h-24 w-auto max-w-full object-contain drop-shadow-[0_0_28px_rgba(var(--primary),0.35)] transition-transform duration-300 group-hover:scale-105"
            />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight leading-none">
            SubTerm
          </h1>
          <p className="text-[10px] text-primary/80 mt-1.5 tracking-[0.25em] uppercase font-semibold">
            {isFirstRun ? "Setup Master Vault" : "Encrypted SSH & SFTP Workspace"}
          </p>
          <p className="text-xs text-zinc-400 mt-2 text-center">
            {loading
              ? "Checking security status…"
              : isFirstRun
              ? "Create a Master Password to encrypt and secure your workspaces."
              : "Enter your Master Password to unlock SubTerm"}
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 px-3.5 py-2.5 bg-rose-500/10 border border-rose-500/25 rounded-xl text-rose-200 text-xs flex items-center gap-2.5 animate-in shake duration-200">
            <AlertTriangle size={15} className="shrink-0 text-rose-400" />
            <span className="flex-1 text-[11.5px] leading-tight">{error}</span>
          </div>
        )}

        {/* Main Unlock Card */}
        {loading ? (
          <div className="py-8 text-center text-xs text-zinc-500 flex flex-col items-center gap-2">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span>Loading…</span>
          </div>
        ) : showCloudRestore ? (
          /* Cloud Restore Card */
          <form onSubmit={handleCloudSignInAndRestore} className="space-y-3 p-4 bg-white/[0.02] border border-white/10 rounded-2xl shadow-xl">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <Cloud size={14} className="text-primary" />
              <span>Restore from Cloud</span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Sign in with your SubTerm Cloud account to restore your workspaces.
            </p>
            <input
              type="email"
              value={cloudEmail}
              onChange={(e) => setCloudEmail(e.target.value)}
              placeholder="Account email..."
              className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50"
            />
            <PasswordField
              value={cloudPassword}
              onChange={setCloudPassword}
              placeholder="Account password..."
              className="w-full h-9 px-3 bg-black/40 border border-white/10 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-primary/50"
            />
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowCloudRestore(false)}
                className="h-8 px-3 rounded-lg text-xs text-zinc-400 hover:text-white hover:bg-white/5"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={cloudBusy || !cloudEmail || !cloudPassword}
                className="h-8 px-4 rounded-lg bg-primary text-black font-semibold text-xs flex items-center gap-1.5 hover:shadow-[0_0_15px_rgba(var(--primary),0.3)] disabled:opacity-50"
              >
                {cloudBusy ? "Restoring…" : "Restore"}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleUnlock} className="space-y-3.5">
            {/* Master Password Field */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-medium text-zinc-400">
                {isFirstRun ? "Create Master Password" : "Master Password"}
              </label>
              <PasswordField
                value={password}
                onChange={setPassword}
                placeholder="Enter master password..."
                autoFocus
                disabled={busy}
                className="w-full h-11 px-3.5 bg-black/40 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-primary/60 transition-all shadow-inner"
              />
            </div>

            {/* Confirm Password (if first run) */}
            {isFirstRun && (
              <div className="space-y-1.5 animate-in fade-in duration-150">
                <label className="block text-[11px] font-medium text-zinc-400">
                  Confirm Master Password
                </label>
                <PasswordField
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Repeat master password..."
                  disabled={busy}
                  className="w-full h-11 px-3.5 bg-black/40 border border-white/10 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-primary/60 transition-all shadow-inner"
                />
              </div>
            )}

            {/* Biometric Checkbox */}
            <label className="flex items-center gap-2.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer select-none pt-0.5">
              <input
                type="checkbox"
                checked={enableBiometric}
                onChange={(e) => setEnableBiometric(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-black/40 text-primary focus:ring-0 focus:ring-offset-0 cursor-pointer accent-primary"
              />
              <span>Enable Windows Hello / Touch ID</span>
            </label>

            {/* Main Unlock Button */}
            <button
              type="submit"
              disabled={busy || !password}
              className="w-full h-11 rounded-xl bg-primary text-black font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-[0_0_25px_rgba(var(--primary),0.35)] transition-all disabled:opacity-50 disabled:hover:shadow-none mt-2"
            >
              {busy ? (
                <>
                  <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  <span>Unlocking…</span>
                </>
              ) : (
                <>
                  <Lock size={15} />
                  <span>{isFirstRun ? "Create Vault & Get Started" : "Unlock SubTerm"}</span>
                  <ArrowRight size={15} />
                </>
              )}
            </button>

            {/* Biometric Quick Button (if saved previously) */}
            {hasBiometricSaved && !isFirstRun && (
              <button
                type="button"
                onClick={handleUnlockWithBiometrics}
                disabled={busy}
                className="w-full h-10 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-zinc-300 hover:text-white font-medium text-xs flex items-center justify-center gap-2 transition-all"
              >
                <ShieldCheck size={15} className="text-emerald-400" />
                <span>Unlock with Windows Hello</span>
              </button>
            )}

            {/* Fresh install cloud restore shortcut */}
            {isFirstRun && (
              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setShowCloudRestore(true)}
                  className="text-xs text-zinc-400 hover:text-primary transition-colors flex items-center justify-center gap-1.5 mx-auto"
                >
                  <Cloud size={13} />
                  <span>Already have a cloud backup? Restore</span>
                </button>
              </div>
            )}
          </form>
        )}

        {/* Footer info & Links */}
        <div className="mt-8 pt-4 border-t border-white/5 flex items-center justify-between text-[11px] text-zinc-500">
          <button
            type="button"
            onClick={() => setAboutOpen(true)}
            className="hover:text-zinc-300 transition-colors flex items-center gap-1"
          >
            <Info size={12} />
            <span>About SubTerm</span>
          </button>

          {update?.has_update && update.latest && (
            <button
              type="button"
              onClick={() => {
                if (update.release_url) {
                  invoke("open_external_url", { url: update.release_url }).catch(() => {});
                }
              }}
              className="text-primary hover:underline flex items-center gap-1 text-[11px]"
            >
              <ArrowUpCircle size={12} />
              <span>Update v{update.latest} available</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              invoke("open_external_url", { url: "https://github.com/manojsyadav/SubTerm" }).catch(() => {});
            }}
            className="hover:text-rose-400 transition-colors flex items-center gap-1"
          >
            <Heart size={11} className="text-rose-400/80" />
            <span>Support</span>
          </button>
        </div>
      </div>

      <AboutPanel isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
};

export default MasterUnlockPage;
