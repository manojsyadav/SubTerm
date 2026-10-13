import type { AppSettings, SetAppSettings } from "../types.settings";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cloud,
  CloudOff,
  RefreshCw,
  Share2,
  Users,
  UserPlus,
  AlertTriangle,
  CheckCircle2,
  Lock,
  ArrowUpCircle,
  HardDrive,
  Trash2,
  User,
  History,
  ShieldCheck,
} from "lucide-react";
import { useConfirm, useTextPrompt } from "../ui/confirm";
import { RoleBadge } from "./shareRoles";
import { SyncConflictDiffModal } from "./SyncConflictDiffModal";
import { SyncScopeControls } from "./SyncScopeControls";

interface RecentEdit {
  name: string;
  edited_by: string;
  updated_at: string;
}

interface OutOfSyncItem {
  uuid: string;
  name: string;
  direction: "push" | "pull";
}

interface SyncDiff {
  in_sync: number;
  needs_push: number;
  needs_pull: number;
  out_of_sync_nodes: OutOfSyncItem[];
}

interface SyncStats {
  total_records: number;
  vault_bytes: number;
  recent_edits: RecentEdit[];
  diff: SyncDiff | null;
}

interface ShareStatus {
  profile: string | null;
  share_id: string | null;
  role: string | null;
  identity_unlocked: boolean;
  signed_in: boolean;
  email: string | null;
}

interface MemberInfo {
  user_id: number;
  email: string;
  role: string;
  status: string;
}

function hlcAgo(stamp: string): string {
  const ms = parseInt(stamp.slice(0, 15), 10);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  settings: AppSettings;
  setSettings: SetAppSettings;
  onOpenCloudAccount: () => void;
  onSync?: () => Promise<void> | void;
  syncing?: boolean;
  lastSyncLabel?: string | null;
}

export function SettingsCloudSync({
  settings,
  setSettings,
  onOpenCloudAccount,
  onSync,
  syncing = false,
  lastSyncLabel,
}: Props) {
  const confirm = useConfirm();
  const textPrompt = useTextPrompt();

  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "user">("editor");
  const [stuck, setStuck] = useState(false);
  const prevPull = useRef<number | null>(null);
  const [diffTarget, setDiffTarget] = useState<{ uuid: string; name: string } | null>(null);

  const clean = (e: unknown) => String(e).replace(/^\[[A-Z_]+\]\s*/, "");
  const flash = (m: string) => {
    setOk(m);
    setErr(null);
    setTimeout(() => setOk(null), 4000);
  };
  const fail = (e: unknown) => {
    setErr(clean(e));
    setOk(null);
  };

  const refreshStatus = useCallback(async () => {
    try {
      const s = await invoke<ShareStatus>("profile_share_status");
      setShareStatus(s);
      if (s.share_id) {
        try {
          const list = await invoke<MemberInfo[]>("share_member_list", { shareId: s.share_id });
          setMembers(list);
        } catch {
          setMembers(null);
        }
      } else {
        setMembers(null);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const s = await invoke<SyncStats>("profile_sync_stats");
      setStats(s);
      const pull = s.diff?.needs_pull ?? 0;
      if (pull > 0 && prevPull.current === pull) setStuck(true);
      if (pull === 0) setStuck(false);
      prevPull.current = pull;
    } catch {
      // offline or not synced
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    loadStats();
  }, [refreshStatus, loadStats]);

  const handleManualSync = async () => {
    if (onSync) {
      await onSync();
      await refreshStatus();
      await loadStats();
      flash("Sync completed.");
    }
  };

  const forcePush = async () => {
    const agreed = await confirm({
      title: "Replace cloud copy?",
      message:
        "Everything currently in the cloud for this profile will be wiped and replaced with this machine's local vault in full.\n\n" +
        "Use this if records are stuck or out of sync.",
      okLabel: "Replace Cloud Copy",
      destructive: true,
    });
    if (!agreed) return;

    setBusy(true);
    setErr(null);
    try {
      const rep = await invoke<{ pushed: number; pulled: number }>("force_push_profile");
      setStuck(false);
      prevPull.current = null;
      flash(`Cloud copy replaced — uploaded ${rep.pushed} items.`);
      await loadStats();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const ensureIdentity = useCallback(async (): Promise<boolean> => {
    const cur = await invoke<ShareStatus>("profile_share_status");
    setShareStatus(cur);
    if (cur.identity_unlocked) return true;
    const pass = await textPrompt({
      title: "Unlock sharing identity",
      message:
        "Sharing uses an end-to-end encrypted identity passphrase that protects the private key for shared vaults. Enter yours (min 8 characters):",
      placeholder: "Passphrase (min 8 chars)",
      password: true,
      okLabel: "Unlock",
      validate: (v) => (v.length < 8 ? "At least 8 characters" : null),
    });
    if (!pass) return false;
    await invoke("setup_identity", { encPassphrase: pass });
    await refreshStatus();
    return true;
  }, [textPrompt, refreshStatus]);

  const handleStartSharing = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!(await ensureIdentity())) return;
      await invoke<{ share_id: string }>("share_current_profile", {
        name: shareStatus?.profile ?? "profile",
      });
      await refreshStatus();
      flash("Profile sharing is active. Invite members below.");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = async () => {
    const e = inviteEmail.trim().toLowerCase();
    if (!e.includes("@")) {
      fail("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (!(await ensureIdentity())) return;
      await invoke("invite_to_share", {
        shareId: shareStatus!.share_id,
        email: e,
        role: inviteRole,
      });
      setInviteEmail("");
      await refreshStatus();
      flash(`Invited ${e} as ${inviteRole === "user" ? "Viewer" : "Editor"}.`);
    } catch (er) {
      fail(er);
    } finally {
      setBusy(false);
    }
  };

  const handleChangeRole = async (uid: number, next: string) => {
    setBusy(true);
    try {
      await invoke("share_set_role", {
        shareId: shareStatus!.share_id,
        memberUserId: uid,
        role: next,
      });
      await refreshStatus();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (m: MemberInfo) => {
    const okConfirm = await confirm({
      title: "Revoke Access?",
      message: `Remove access for ${m.email} from this shared profile?`,
      okLabel: "Revoke Access",
      destructive: true,
    });
    if (!okConfirm) return;
    setBusy(true);
    try {
      await invoke("share_revoke", {
        shareId: shareStatus!.share_id,
        memberUserId: m.user_id,
      });
      await refreshStatus();
      flash(`${m.email} access revoked.`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const handleStopSharing = async () => {
    const isOwner = shareStatus?.role === "owner";
    const okConfirm = await confirm({
      title: isOwner ? "Stop sharing profile?" : "Leave shared profile?",
      message: isOwner
        ? "Everyone you invited will lose access immediately. Your copy remains on this machine."
        : "You will stop receiving updates for this profile.",
      okLabel: isOwner ? "Stop Sharing" : "Leave Share",
      destructive: true,
    });
    if (!okConfirm) return;
    setBusy(true);
    try {
      await invoke("stop_sharing");
      await refreshStatus();
      flash(isOwner ? "Sharing stopped." : "Left shared profile.");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const isShared = Boolean(shareStatus?.share_id);
  const isOwner = shareStatus?.role === "owner";

  return (
    <section className="break-inside-avoid mb-4 sm:mb-8 bg-[#121215] border border-white/5 rounded-2xl p-5 sm:p-6 shadow-xl" id="cloud-sync-setting">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <Cloud size={14} className="text-primary" /> Cloud Sync & Collaboration
        </h3>
        {lastSyncLabel && (
          <span className="text-[11px] text-zinc-500 font-mono">Last sync: {lastSyncLabel}</span>
        )}
      </div>

      <div className="space-y-6">
        {err && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-200 text-xs flex gap-2 items-center">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{err}</span>
          </div>
        )}
        {ok && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-200 text-xs flex gap-2 items-center">
            <CheckCircle2 size={14} className="shrink-0" />
            <span>{ok}</span>
          </div>
        )}

        {/* Sync Controls Card */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <span>Automatic Profile Sync</span>
                {settings.autoSync !== false ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Active
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-white/5">
                    Manual Only
                  </span>
                )}
              </div>
              <p className="text-[12px] text-zinc-400 leading-relaxed mt-0.5">
                Automatically keep open profiles synchronized in the background whenever changes are made.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {onSync && (
                <button
                  type="button"
                  disabled={syncing || busy}
                  onClick={handleManualSync}
                  className="h-8 px-3 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-zinc-200 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40"
                >
                  <RefreshCw size={12} className={syncing ? "animate-spin text-primary" : ""} />
                  <span>{syncing ? "Syncing…" : "Sync Now"}</span>
                </button>
              )}

              <button
                type="button"
                role="switch"
                aria-checked={settings.autoSync !== false}
                onClick={() => setSettings((s) => ({ ...s, autoSync: !(s.autoSync !== false) }))}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  settings.autoSync !== false ? "bg-primary" : "bg-white/10"
                }`}
              >
                <span
                  className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                    settings.autoSync !== false ? "translate-x-5" : "translate-x-0.5"
                  } shadow-md`}
                />
              </button>
            </div>
          </div>

          {settings.autoSync !== false && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-white/5 text-xs text-zinc-400">
              <div className="flex items-center justify-between p-2.5 bg-black/40 border border-white/5 rounded-xl">
                <span>Sync Interval:</span>
                <select
                  value={settings.syncIntervalMin || 5}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, syncIntervalMin: parseInt(e.target.value, 10) || 5 }))
                  }
                  className="bg-black/60 border border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-200 outline-none focus:border-primary/50"
                >
                  <option value={1}>Every 1 min</option>
                  <option value={3}>Every 3 min</option>
                  <option value={5}>Every 5 min</option>
                  <option value={15}>Every 15 min</option>
                  <option value={30}>Every 30 min</option>
                  <option value={60}>Every 1 hr</option>
                </select>
              </div>

              <div className="flex items-center justify-between p-2.5 bg-black/40 border border-white/5 rounded-xl">
                <span>Account:</span>
                <button
                  type="button"
                  onClick={onOpenCloudAccount}
                  className="px-2.5 py-1 bg-primary text-zinc-950 font-bold rounded-lg text-xs hover:bg-primary/90 transition-colors flex items-center gap-1.5"
                >
                  <User size={12} /> Manage Cloud Account
                </button>
              </div>
            </div>
          )}

          {/* Custom API Endpoint */}
          <div className="pt-2 border-t border-white/5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 block mb-1">
              Custom API Base URL (Self-Hosted / Enterprise)
            </label>
            <input
              type="text"
              value={settings.cloudApiBase || ""}
              onChange={(e) => setSettings((s) => ({ ...s, cloudApiBase: e.target.value }))}
              placeholder="https://api.subterm.com (leave empty for default)"
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-200 outline-none focus:border-primary/50"
            />
          </div>
        </div>

        <SyncScopeControls />

        {/* Sync Metrics & Health Card */}
        {stats && (
          <div className="p-4 bg-black/40 border border-white/5 rounded-xl space-y-3">
            <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
              <span className="flex items-center gap-1.5">
                <HardDrive size={13} className="text-primary" /> Profile Metrics & Sync Health
              </span>
              <span className="text-zinc-500 font-mono text-[11px]">
                {stats.total_records} records · {fmtBytes(stats.vault_bytes)}
              </span>
            </div>

            {stats.diff && (
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                  <div className="text-emerald-400 font-bold text-sm font-mono">{stats.diff.in_sync}</div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">In Sync</div>
                </div>
                <div className="p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                  <div className="text-blue-400 font-bold text-sm font-mono">{stats.diff.needs_push}</div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">Needs Push</div>
                </div>
                <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                  <div className="text-amber-400 font-bold text-sm font-mono">{stats.diff.needs_pull}</div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">Needs Pull</div>
                </div>
              </div>
            )}

            {!!stats.diff?.out_of_sync_nodes.length && (
              <div className="pt-2 border-t border-white/5 space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Out of Sync
                </div>
                <div className="space-y-1">
                  {stats.diff.out_of_sync_nodes.map((item) => (
                    <button
                      key={item.uuid}
                      onClick={() => setDiffTarget({ uuid: item.uuid, name: item.name })}
                      className="w-full text-[11px] text-zinc-300 flex items-center justify-between p-1.5 bg-white/[0.02] hover:bg-white/[0.05] rounded-lg transition-colors text-left"
                    >
                      <span className="truncate">{item.name}</span>
                      <span className={`text-[10px] font-mono shrink-0 ml-2 ${item.direction === "push" ? "text-blue-400" : "text-amber-400"}`}>
                        needs {item.direction} · view diff
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {stuck && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-center justify-between gap-3">
                <div className="text-xs text-amber-200 leading-snug">
                  Some items failed to converge with the cloud. You can force-replace the cloud copy with your local vault.
                </div>
                <button
                  type="button"
                  onClick={forcePush}
                  disabled={busy}
                  className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-semibold shrink-0"
                >
                  Force Push
                </button>
              </div>
            )}

            {/* Recent Edits preview */}
            {stats.recent_edits && stats.recent_edits.length > 0 && (
              <div className="pt-2 border-t border-white/5 space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
                  <History size={11} /> Recent Profile Edits
                </div>
                <div className="space-y-1">
                  {stats.recent_edits.slice(0, 3).map((ed, idx) => (
                    <div
                      key={idx}
                      className="text-[11px] text-zinc-300 flex items-center justify-between p-1.5 bg-white/[0.02] rounded-lg"
                    >
                      <span className="truncate">{ed.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">
                        {ed.edited_by} · {hlcAgo(ed.updated_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Team Collaboration & Encrypted Sharing */}
        <div className="pt-3 border-t border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                <Users size={14} className="text-primary" /> End-to-End Encrypted Team Sharing
              </div>
              <p className="text-[12px] text-zinc-400 mt-0.5">
                Share this profile vault with coworkers or teammates with cryptographic zero-knowledge security.
              </p>
            </div>
            {isShared ? (
              <button
                type="button"
                onClick={handleStopSharing}
                disabled={busy}
                className="h-7 px-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded-lg text-xs font-medium transition-colors"
              >
                {isOwner ? "Stop Sharing" : "Leave Share"}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStartSharing}
                disabled={busy}
                className="h-8 px-3.5 bg-primary text-zinc-950 font-bold rounded-xl text-xs hover:bg-primary/90 transition-colors flex items-center gap-1.5"
              >
                <Share2 size={12} /> Share This Profile
              </button>
            )}
          </div>

          {isShared && (
            <div className="p-4 bg-black/40 border border-white/5 rounded-xl space-y-4">
              {/* Invite Form */}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="email"
                  placeholder="Invite colleague by email…"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="flex-1 bg-black/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-primary/50"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "editor" | "user")}
                  className="bg-black/60 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-primary/50"
                >
                  <option value="editor">Editor (Read & Write)</option>
                  <option value="user">Viewer (Read Only)</option>
                </select>
                <button
                  type="button"
                  onClick={handleInvite}
                  disabled={busy || !inviteEmail.trim()}
                  className="px-3 py-1.5 bg-primary text-zinc-950 font-bold rounded-lg text-xs hover:bg-primary/90 disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <UserPlus size={12} /> Invite
                </button>
              </div>

              {/* Members List */}
              {members && members.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-white/5">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                    Members with access ({members.length})
                  </div>
                  <div className="divide-y divide-white/5">
                    {members.map((m) => (
                      <div
                        key={m.user_id}
                        className="py-2 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="text-zinc-200 font-medium truncate">{m.email}</div>
                          <div className="text-[10px] text-zinc-500">{m.status}</div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {isOwner && m.role !== "owner" ? (
                            <select
                              value={m.role}
                              onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                              className="bg-black/50 border border-white/10 rounded px-2 py-0.5 text-[11px] text-zinc-300 outline-none"
                            >
                              <option value="editor">Editor</option>
                              <option value="user">Viewer</option>
                            </select>
                          ) : (
                            <RoleBadge role={m.role} />
                          )}

                          {isOwner && m.role !== "owner" && (
                            <button
                              type="button"
                              onClick={() => handleRevoke(m)}
                              title="Revoke access"
                              className="p-1 hover:bg-rose-500/10 text-zinc-500 hover:text-rose-400 rounded transition-colors"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <SyncConflictDiffModal
        isOpen={!!diffTarget}
        onClose={() => setDiffTarget(null)}
        uuid={diffTarget?.uuid ?? null}
        name={diffTarget?.name ?? null}
      />
    </section>
  );
}
