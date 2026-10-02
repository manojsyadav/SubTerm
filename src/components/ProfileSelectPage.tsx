import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X, AlertTriangle, ArrowRight, Download,
  CheckCircle2, Cloud, HardDrive, ChevronDown, RefreshCw, ArrowUpCircle, Heart,
  ShieldCheck, Settings
} from "lucide-react";
import AboutPanel from "./AboutPanel";
import logoUrl from "../assets/logo.png";
import { IS_ANDROID } from "../util/platform";
import { useTextPrompt, useConfirm } from "../ui/confirm";

interface CloudStatus { signed_in: boolean; email: string | null; }
// One personal profile as reported by the cloud (GET /sync/profiles). Names +
// counts only — the server never sees the encrypted contents. `profile` is the
// partition key (a name for legacy profiles, a UUID for new ones); `name` is the
// human-readable label to show and to restore under.
interface CloudProfile { profile: string; name: string; records: number; live_records: number; last_updated: string; }
// Result of the GitHub release check (backend: about::check_for_updates).
// `has_update` is true only when `latest` is a strictly newer semver than the
// running build. Mirrors the shape AboutPanel already consumes.
interface UpdateInfo { current: string; latest: string | null; has_update: boolean; release_url: string | null; }

// The picker's unit of display: one profile, wherever it lives. `local` = an
// on-disk vault exists here; `cloud` = the matching cloud partition (or null).
// Merging local + cloud into a single row is what lets the login screen be the
// one place to SEE and MANAGE every profile — open it, export it, remove it
// here, get it from the cloud, or delete it from the cloud.
interface Row { name: string; local: boolean; cloud: CloudProfile | null; }

interface Props {
  onUnlocked: (profileName: string) => void;
  autoSync?: boolean;
  onOpenSettings?: () => void;
}

const ProfileSelectPage = ({ onUnlocked, autoSync, onOpenSettings }: Props) => {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The expanded row (by display name). A local row expands to a password +
  // Open + actions; a cloud-only row expands to Get + Delete-from-cloud.
  const [selected, setSelected] = useState<string>("");
  const [password, setPassword] = useState("");
  const [enableBiometric, setEnableBiometric] = useState(false);

  const [aboutOpen, setAboutOpen] = useState(false);

  // Cloud status surfaced directly on this page so the user doesn't have
  // to open the modal just to know if sync is connected or pending.
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>({ signed_in: false, email: null });
  // Profiles that live in the signed-in cloud account. Merged with the local
  // list below so a fresh device SHOWS the user's profiles instead of making
  // them remember and type a name. Empty until signed in (or on network error).
  const [cloudProfiles, setCloudProfiles] = useState<CloudProfile[]>([]);
  // A newer published release than the running build, if any. Set only when
  // one actually exists, so the notice by "About" appears solely when there's
  // something to announce.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  const textPrompt = useTextPrompt();
  const confirm = useConfirm();

  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  // Clean the [PREFIX] off backend errors for display.
  const cleanErr = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const list = await invoke<string[]>("list_profiles");
      setProfiles(list);
      setSelected((prev) => (prev && list.includes(prev) ? prev : list[0] || ""));
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // Cloud connection + the account's profile list. Best-effort: a network
  // failure must never block unlocking a local profile, so errors are swallowed
  // and just leave the cloud side empty.
  const refreshCloud = useCallback(async () => {
    if (!autoSync) {
      setCloudStatus({ signed_in: false, email: null });
      setCloudProfiles([]);
      return;
    }
    try {
      const s = await invoke<CloudStatus>("cloud_status");
      setCloudStatus(s);
      if (s.signed_in) {
        try {
          const cps = await invoke<CloudProfile[]>("cloud_list_sync_profiles");
          // Hide empty / retired partitions (all-tombstone or escrow-only) —
          // they'd just be noise in the picker.
          setCloudProfiles(cps.filter((c) => c.live_records > 0));
        } catch {
          setCloudProfiles([]);
        }
      } else {
        setCloudProfiles([]);
      }
    } catch {
      // swallow — network down, modal can still be opened to retry
    }
  }, []);

  useEffect(() => { refreshCloud(); }, [refreshCloud, autoSync]);

  // Check GitHub for a newer release once per app open (this page mounts on
  // launch and on every return to the picker). Best-effort and silent: the
  // fetch+semver-compare happens in Rust (about::check_for_updates), and any
  // failure — offline, rate-limited, no releases — simply shows nothing.
  useEffect(() => {
    invoke<UpdateInfo>("check_for_updates")
      .then((u) => { if (u.has_update && u.latest) setUpdate(u); })
      .catch(() => {});
  }, []);

  const openReleaseNotes = () => {
    if (update?.release_url) invoke("open_external_url", { url: update.release_url }).catch(() => {});
  };
  // Donate → the project's GitHub, anchored at #donate (placeholder section the
  // owner fills in later). Goes through the backend URL-opener like every other
  // external link so the CSP stays tight.
  const openDonate = () => {
    invoke("open_external_url", { url: "https://github.com/manojsyadav/SubTerm" }).catch(() => {});
  };

  // When the expanded row changes, reset + focus the password so opening a
  // profile is always "click row, type, Enter".
  useEffect(() => {
    setPassword("");
    setError(null);
    requestAnimationFrame(() => passwordInputRef.current?.focus());
  }, [selected]);

  // Merge local + cloud into one ordered list, matched case-insensitively by
  // Merge local + cloud into one ordered list
  const buildRows = (): Row[] => {
    const byKey = new Map<string, Row>();
    for (const p of profiles) byKey.set(p.toLowerCase(), { name: p, local: true, cloud: null });
    for (const c of cloudProfiles) {
      const k = c.name.toLowerCase();
      const existing = byKey.get(k);
      if (existing) existing.cloud = c;
      else byKey.set(k, { name: c.name, local: false, cloud: c });
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.local !== b.local ? (a.local ? -1 : 1) : a.name.localeCompare(b.name)
    );
  };
  const rows = buildRows();

  const toggle = (row: Row) => setSelected((prev) => (prev === row.name ? "" : row.name));

  const unlockSelected = async () => {
    if (!selected) { setError("Pick a profile first."); return; }
    if (!password) { setError("Type your password."); return; }
    setBusy(true); setError(null);
    try {
      await invoke("select_profile", { name: selected });
      await invoke("setup_master_db", { password });
      if (enableBiometric) {
        localStorage.setItem(`submarine-bio-${selected}`, btoa(password));
      }
      onUnlocked(selected);
    } catch (e: any) {
      const raw = String(e);
      setError(raw.toLowerCase().includes("decrypt") ? "Wrong password." : raw);
    } finally {
      setBusy(false);
    }
  };

  const unlockWithBiometrics = async (profileName: string) => {
    const saved = localStorage.getItem(`submarine-bio-${profileName}`);
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
      const decodedPass = atob(saved);
      await invoke("select_profile", { name: profileName });
      await invoke("setup_master_db", { password: decodedPass });
      onUnlocked(profileName);
    } catch (e: any) {
      const raw = String(e);
      setError(raw.toLowerCase().includes("decrypt") ? "Biometric credential invalid." : raw);
    } finally {
      setBusy(false);
    }
  };

  const bringDown = async (cloud: CloudProfile) => {
    setBusy(true); setError(null); setInfo(null);
    try {
      await invoke("import_profile_cloud", { profile: cloud.profile, name: cloud.name });
      await reload();
      setSelected(cloud.name);
      setInfo(`Downloaded "${cloud.name}". Open it with its original password.`);
    } catch (e: any) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const showCreate = !loading && profiles.length === 0 && cloudProfiles.length === 0;

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-10 bg-background">
      <div className="w-full max-w-[340px] flex flex-col">
        {/* Brand */}
        <div className="flex flex-col items-center mb-8 select-none">
          <img
            src={logoUrl}
            alt=""
            draggable={false}
            className="h-28 w-auto max-w-full object-contain mb-4 drop-shadow-[0_0_32px_rgba(var(--primary),0.22)]"
          />
          <h1 className="text-[22px] font-semibold text-white tracking-tight leading-none">SubTerm</h1>
          <p className="text-[10px] text-primary/80 mt-1.5 tracking-[0.22em] uppercase font-semibold">
            Modern SSH & SFTP Client
          </p>
          <p className="text-[12.5px] text-zinc-500 mt-2">
            {loading
              ? " "
              : showCreate
                ? "You don't have any profiles yet."
                : null}
          </p>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-200 text-[12.5px] flex items-center gap-2">
            <AlertTriangle size={13} className="shrink-0" /> {error}
          </div>
        )}

        {info && !error && (
          <div className="mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-100 text-[12.5px] flex items-center gap-2">
            <CheckCircle2 size={13} className="shrink-0" /> <span className="truncate flex-1">{info}</span>
            <button onClick={() => setInfo(null)} className="text-emerald-200/70 hover:text-white shrink-0"><X size={13} /></button>
          </div>
        )}

        {loading ? (
          <div className="text-center text-zinc-500 text-[12.5px] py-6">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="pt-4 flex justify-center">
            <button
              onClick={onOpenSettings}
              className="w-full h-11 rounded-xl bg-primary text-black font-semibold text-[14px] flex items-center justify-center gap-2 hover:shadow-[0_0_24px_rgba(var(--primary),0.3)] transition-all"
            >
              <Settings size={16} /> Open Settings to Create Profile
            </button>
          </div>
        ) : (
          /* ---- Your profiles (local + cloud, one list) ---- */
          <div className="space-y-3">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Your profiles</span>
              {cloudStatus.signed_in && (
                <button
                  onClick={refreshCloud}
                  disabled={busy}
                  title="Refresh from cloud"
                  className="text-zinc-600 hover:text-primary disabled:opacity-40 p-0.5"
                >
                  <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
                </button>
              )}
            </div>

            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden divide-y divide-white/5">
              {rows.map((row) => {
                const open = selected === row.name;
                return (
                  <div key={row.name}>
                    <button
                      onClick={() => toggle(row)}
                      className={`w-full flex items-center gap-2.5 px-3 h-11 text-left transition-colors ${open ? "bg-white/[0.03]" : "hover:bg-white/[0.02]"}`}
                    >
                      {row.local
                        ? <HardDrive size={13} className="text-zinc-500 shrink-0" />
                        : <Cloud size={13} className="text-primary/70 shrink-0" />}
                      <span className="flex-1 min-w-0 truncate text-[13.5px] text-zinc-100">{row.name}</span>
                      <StatusChip row={row} />
                      <ChevronDown size={13} className={`text-zinc-600 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>

                    {open && (
                      <div className="px-3 pb-3 pt-1 bg-black/20 space-y-2.5 animate-in fade-in">
                        {row.local ? (
                          <>
                            {localStorage.getItem(`submarine-bio-${row.name}`) && (
                              <button
                                type="button"
                                onClick={() => unlockWithBiometrics(row.name)}
                                disabled={busy}
                                className="w-full h-10 px-3.5 rounded-lg text-[13px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 flex items-center justify-center gap-2 transition-all shadow-inner"
                              >
                                <ShieldCheck size={16} />
                                Unlock with Biometrics (Windows Hello / Fingerprint)
                              </button>
                            )}
                            <div className="flex gap-2">
                              <input
                                ref={passwordInputRef}
                                type="password"
                                placeholder="Password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && unlockSelected()}
                                className="flex-1 h-10 px-3.5 bg-zinc-900/50 border border-white/5 rounded-lg text-[13.5px] text-zinc-50 placeholder:text-zinc-600 outline-none focus:border-primary/50 transition-colors"
                              />
                              <button
                                onClick={unlockSelected}
                                disabled={busy || !password}
                                title="Open"
                                className="h-10 px-3.5 rounded-lg text-[13px] font-semibold bg-primary text-black hover:shadow-[0_0_20px_rgba(var(--primary),0.3)] disabled:opacity-40 flex items-center gap-1.5 shrink-0 transition-all"
                              >
                                {busy ? <RefreshCw size={14} className="animate-spin" /> : <>Open <ArrowRight size={14} /></>}
                              </button>
                            </div>
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-300">
                                <input
                                  type="checkbox"
                                  className="accent-primary rounded"
                                  checked={enableBiometric}
                                  onChange={(e) => setEnableBiometric(e.target.checked)}
                                />
                                Save for Biometric Unlock
                              </label>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-[11.5px] text-zinc-400 leading-snug">
                              Not on this device yet · {row.cloud!.live_records} item{row.cloud!.live_records === 1 ? "" : "s"}.
                              Get it with this profile's password.
                            </p>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => bringDown(row.cloud!)}
                                disabled={busy}
                                className="flex-1 h-9 rounded-lg text-[12.5px] font-semibold bg-primary/10 border border-primary/30 text-primary hover:bg-primary hover:text-black disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors"
                              >
                                <Download size={13} /> Get on this device
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

          </div>
        )}

        {/* Cloud status bar — always visible. Signed-in shows the account email. */}
        <CloudBar status={cloudStatus} />

        {/* About + Donate — a matched pair of pills, with a live "new version"
            notice underneath when one is available. */}
        <div className="mt-4 flex flex-col items-center gap-2.5">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAboutOpen(true)}
              className="h-8 px-4 rounded-lg text-[12.5px] font-bold text-zinc-200 bg-white/[0.04] border border-white/10 hover:bg-white/[0.09] hover:text-white transition-colors"
            >
              About
            </button>
            <button
              onClick={openDonate}
              title="Support Submarine on GitHub"
              className="h-8 px-4 rounded-lg text-[12.5px] font-bold text-rose-200 bg-rose-500/10 border border-rose-500/25 hover:bg-rose-500/20 hover:text-rose-100 transition-colors flex items-center gap-1.5"
            >
              <Heart size={13} className="fill-rose-400/40" /> Donate
            </button>
          </div>
          {update?.has_update && update.latest && (
            <button
              onClick={openReleaseNotes}
              title="Open the release notes on GitHub"
              className="group flex items-center gap-1.5 text-[10.5px] text-primary/90 hover:text-primary animate-in fade-in slide-in-from-bottom-1 duration-700"
            >
              {/* pulsing dot — the "something new" signal */}
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <ArrowUpCircle size={11} className="shrink-0" />
              <span>New version <span className="font-mono font-semibold">v{update.latest}</span> available</span>
              <span className="opacity-60 transition-transform group-hover:translate-x-0.5">→</span>
            </button>
          )}
        </div>
      </div>

      <AboutPanel isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  );
};

// Small pill telling you where a profile lives at a glance.
const StatusChip = ({ row }: { row: Row }) => {
  const base = "inline-flex items-center gap-1 px-1.5 h-5 rounded-md text-[9.5px] font-semibold uppercase tracking-wide border shrink-0";
  if (row.local && row.cloud)
    return <span className={`${base} text-emerald-300 bg-emerald-500/10 border-emerald-500/20`}><CheckCircle2 size={10} /> Synced</span>;
  if (row.local)
    return <span className={`${base} text-zinc-400 bg-white/[0.04] border-white/10`}><HardDrive size={10} /> This device</span>;
  return <span className={`${base} text-primary bg-primary/10 border-primary/25`}><Cloud size={10} /> In cloud</span>;
};

// A compact secondary action inside an expanded row.
const RowAction = ({
  onClick, disabled, icon, label, danger,
}: {
  onClick: () => void; disabled?: boolean; icon: React.ReactNode; label: string; danger?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    className={`h-7 px-2 rounded-md text-[11px] font-medium border flex items-center gap-1 disabled:opacity-40 transition-colors ${
      danger
        ? "text-rose-300/90 bg-rose-500/5 border-rose-500/15 hover:bg-rose-500/15 hover:text-rose-200"
        : "text-zinc-400 bg-white/[0.03] border-white/10 hover:bg-white/[0.07] hover:text-zinc-100"
    }`}
  >
    {icon} {label}
  </button>
);

const CloudBar = ({
  status,
}: {
  status: CloudStatus;
}) => {
  if (!status.signed_in) {
    return null;
  }
  return (
    <div className="mt-4 h-9 px-2.5 rounded-lg border border-white/5 bg-white/[0.02] flex items-center gap-2 text-[11.5px]">
      <Cloud size={12} className="text-primary shrink-0" />
      <span className="text-zinc-300 truncate font-mono flex-1 min-w-0">{status.email}</span>
      <span className="text-emerald-400 flex items-center gap-1 shrink-0">
        <CheckCircle2 size={11} /> Connected
      </span>
    </div>
  );
};

export default ProfileSelectPage;
