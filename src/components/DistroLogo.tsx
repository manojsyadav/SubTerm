import React from "react";

interface Props {
  distroId?: string | null;
  distroName?: string | null;
  osType?: string | null;
  className?: string;
  size?: number;
  title?: string;
}

export const DistroLogo: React.FC<Props> = ({
  distroId,
  distroName,
  osType,
  className = "",
  size = 24,
  title,
}) => {
  const dId = (distroId || "").toLowerCase();
  const dName = (distroName || "").toLowerCase();
  const os = (osType || "").toLowerCase();

  // Helper matcher
  const is = (key: string) => dId.includes(key) || dName.includes(key);

  const defaultTitle = title || (distroName ? `OS: ${distroName}` : "Operating System");

  // Helper render wrapper with title tooltip
  const renderSvg = (content: React.ReactNode) => (
    <span title={defaultTitle} className={`inline-flex items-center justify-center shrink-0 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        className="shrink-0"
      >
        <title>{defaultTitle}</title>
        {content}
      </svg>
    </span>
  );

  // 1. Debian
  if (is("debian")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#D70A53" fillOpacity="0.12" stroke="#D70A53" strokeWidth="2" strokeOpacity="0.3" />
        <path
          d="M48.5 22c-13.6 1.4-23.7 11.8-24.4 25.1-.6 10.7 5.7 20.9 15.6 25 1.5.6 2.3 1.5 2.1 2.5-.2 1-.9 1.7-2.1 1.7-.5 0-1.5-.3-2.2-.7-11.4-5.3-18.4-16.8-17.6-29.2.9-14.7 12-26.6 26.8-28.5 17.5-2.2 32.8 9.3 35.1 26.6 1.8 13.9-6.3 26.9-19.4 31.2-11.8 3.9-24.1-1.7-28.5-12.9-3.8-9.8.2-20.7 9.4-25.7 7.9-4.3 17.4-1.9 22.3 5.6 4.3 6.6 2.7 15.1-3.6 19.8-5.3 3.9-12.4 3-16.7-2-3.8-4.4-3.5-10.8.6-14.8 3.6-3.5 9-3.6 12.8-.2 3.1 2.8 3.6 7.3 1.2 10.7-1.8 2.6-5.1 3.4-7.9 1.9-2.3-1.2-3.3-3.6-2.4-5.9.7-1.7 2.4-2.5 4.1-2"
          fill="none"
          stroke="#D70A53"
          strokeWidth="4.2"
          strokeLinecap="round"
        />
      </>
    );
  }

  // 2. Ubuntu
  if (is("ubuntu")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#E95420" fillOpacity="0.12" stroke="#E95420" strokeWidth="2" strokeOpacity="0.3" />
        <circle cx="50" cy="50" r="30" fill="none" stroke="#E95420" strokeWidth="6" />
        <circle cx="21" cy="50" r="6" fill="#E95420" />
        <circle cx="64.5" cy="24.9" r="6" fill="#E95420" />
        <circle cx="64.5" cy="75.1" r="6" fill="#E95420" />
      </>
    );
  }

  // 3. Raspberry Pi / Raspbian
  if (is("raspberry") || is("raspbian") || is("rpi")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#C51A4A" fillOpacity="0.12" stroke="#C51A4A" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M42 22c3 4 5 11 3 16 5-4 12-5 16-2-4 5-11 6-16 4 1 5 4 11 9 14-6-1-12-5-15-10-3 5-9 9-15 10 5-3 8-9 9-14-5 2-12 1-16-4 4-3 11-2 16 2-2-5 0-12 3-16 2 4 4 8 5 10 1-2 3-6 5-10z" fill="#75A928" />
        <circle cx="38" cy="46" r="7" fill="#C51A4A" />
        <circle cx="62" cy="46" r="7" fill="#C51A4A" />
        <circle cx="50" cy="53" r="8" fill="#C51A4A" />
        <circle cx="34" cy="62" r="7.5" fill="#C51A4A" />
        <circle cx="66" cy="62" r="7.5" fill="#C51A4A" />
        <circle cx="48" cy="69" r="8" fill="#C51A4A" />
        <circle cx="41" cy="79" r="6.5" fill="#C51A4A" />
        <circle cx="59" cy="79" r="6.5" fill="#C51A4A" />
      </>
    );
  }

  // 4. Alpine Linux
  if (is("alpine")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#0D597F" fillOpacity="0.15" stroke="#0D597F" strokeWidth="2" strokeOpacity="0.35" />
        <path d="M18 72l28-46 12 19-8 13 8 14H18z" fill="#0D597F" />
        <path d="M50 45l14-23 20 33-8 15H62l-12-25z" fill="#3A8EB7" />
      </>
    );
  }

  // 5. Arch Linux
  if (is("arch")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#1793D1" fillOpacity="0.12" stroke="#1793D1" strokeWidth="2" strokeOpacity="0.3" />
        <path
          d="M50 20c-4 9-10 22-16 35 4 4 9 7 16 8-2-5-3-11-2-16 4 4 8 9 10 16 5-1 11-4 15-8-4-12-9-25-13-35zm-26 49c6-3 12-5 18-5-3 5-5 10-6 16-5-3-9-7-12-11zm52 0c-3 4-7 8-12 11-1-6-3-11-6-16 6 0 12 2 18 5z"
          fill="#1793D1"
        />
      </>
    );
  }

  // 6. Fedora
  if (is("fedora")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#51A2DA" fillOpacity="0.12" stroke="#51A2DA" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M57 32c-6 0-10 4-10 10v7H39v8h8v19h9V57h9c6 0 10-4 10-10v-5h-9v3c0 2-1 3-3 3h-7v-6c0-2 1-3 3-3h7v-7h-9z" fill="#294172" />
        <path d="M43 42c-6 0-10 4-10 10v19h9V57c0-2 1-3 3-3h7v-7h-7c-1 0-2-2-2-5z" fill="#51A2DA" />
      </>
    );
  }

  // 7. CentOS
  if (is("centos")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#932178" fillOpacity="0.1" stroke="#932178" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M50 25l18 18h-11l-7-7-7 7H32l18-18z" fill="#932178" />
        <path d="M75 50l-18 18v-11l7-7-7-7v-11l18 18z" fill="#FFA500" />
        <path d="M50 75L32 57h11l7 7 7-7h11L50 75z" fill="#262577" />
        <path d="M25 50l18-18v11l-7 7 7 7v11L25 50z" fill="#7EBD59" />
      </>
    );
  }

  // 8. Red Hat / RHEL
  if (is("redhat") || is("rhel")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#EE0000" fillOpacity="0.12" stroke="#EE0000" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M20 58c7-2 18-5 30-5 13 0 24 3 30 5 3 1 3 3 0 4-6 2-17 5-30 5-12 0-23-3-30-5-3-1-3-3 0-4z" fill="#EE0000" />
        <path d="M34 54c0-10 6-22 16-22s16 12 16 22c-5-2-11-3-16-3s-11 1-16 3z" fill="#EE0000" />
        <path d="M26 60c8 3 16 5 24 5s16-2 24-5c-5 6-14 10-24 10s-19-4-24-10z" fill="#111" />
      </>
    );
  }

  // 9. Rocky Linux
  if (is("rocky")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#10B981" fillOpacity="0.12" stroke="#10B981" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M50 22c-15 0-28 12-28 28 0 7 3 14 7 19l18-18 6 6-12 12c3 5 9 8 15 9 15 0 28-12 28-28s-13-28-28-28zm0 10c10 0 18 8 18 18s-8 18-18 18c-4 0-8-1-11-4l17-17-6-6-14 14c-3-4-4-9-4-13 0-10 8-18 18-18z" fill="#10B981" />
      </>
    );
  }

  // 10. AlmaLinux
  if (is("alma")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#007BFF" fillOpacity="0.12" stroke="#007BFF" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M50 24L30 50l20 26 20-26L50 24z" fill="#FF5E14" />
        <path d="M50 32L36 50l14 18 14-18L50 32z" fill="#0284C7" />
        <path d="M50 40l-8 10 8 10 8-10-8-10z" fill="#FACC15" />
      </>
    );
  }

  // 11. openSUSE / SUSE
  if (is("suse") || is("opensuse")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#73BA25" fillOpacity="0.12" stroke="#73BA25" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M68 36c-7-7-19-8-27-3-7 4-11 11-10 19 1 7 7 13 14 15 9 2 18-1 23-8 3-5 3-12 0-17l-3 3c2 4 2 9 0 13-3 5-10 8-16 6-6-1-10-6-11-12-1-6 2-12 7-15 7-4 16-3 22 2l3-3z" fill="#73BA25" />
        <circle cx="42" cy="42" r="3" fill="#111" />
      </>
    );
  }

  // 12. Kali Linux
  if (is("kali")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#557C94" fillOpacity="0.12" stroke="#557C94" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M30 65c5-1 12-4 16-8 4-4 7-9 6-15-1-4-4-7-8-8 8-2 15 2 18 8 2 4 2 9 0 13-4 8-12 13-21 14l-2 1c10 2 20-1 27-8 7-7 9-18 6-27-2-7-8-13-15-15 12 1 22 10 24 22 2 11-4 22-13 28-9 6-21 7-32 3l-1-1z" fill="#557C94" />
      </>
    );
  }

  // 13. TrueNAS / FreeNAS
  if (is("truenas") || is("freenas")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#0095D5" fillOpacity="0.12" stroke="#0095D5" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M50 24l18 10v20L50 64 32 54V34l18-10z" fill="none" stroke="#0095D5" strokeWidth="6" />
        <circle cx="50" cy="44" r="7" fill="#0095D5" />
        <path d="M32 54l18 10 18-10" fill="none" stroke="#0095D5" strokeWidth="5" />
      </>
    );
  }

  // 14. FreeBSD / BSD
  if (is("freebsd") || is("bsd")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#AB1818" fillOpacity="0.12" stroke="#AB1818" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M32 26c4 6 7 14 6 22-3-2-7-4-12-4-2-7 1-13 6-18zm36 0c-4 6-7 14-6 22 3-2 7-4 12-4 2-7-1-13-6-18z" fill="#AB1818" />
        <circle cx="50" cy="56" r="22" fill="#AB1818" />
      </>
    );
  }

  // 15. Windows
  if (os === "windows" || is("windows") || is("win")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#00A4EF" fillOpacity="0.12" stroke="#00A4EF" strokeWidth="2" strokeOpacity="0.3" />
        <rect x="25" y="25" width="22" height="22" fill="#00A4EF" rx="2" />
        <rect x="53" y="25" width="22" height="22" fill="#00A4EF" rx="2" />
        <rect x="25" y="53" width="22" height="22" fill="#00A4EF" rx="2" />
        <rect x="53" y="53" width="22" height="22" fill="#00A4EF" rx="2" />
      </>
    );
  }

  // 16. macOS / Darwin
  if (os === "darwin" || is("darwin") || is("macos") || is("apple")) {
    return renderSvg(
      <>
        <circle cx="50" cy="50" r="48" fill="#A2AAAD" fillOpacity="0.12" stroke="#A2AAAD" strokeWidth="2" strokeOpacity="0.3" />
        <path d="M52 23c2-3 4-5 8-5 0 4-2 7-5 9-2 2-5 3-7 3 0-3 2-5 4-7zm16 35c0-8 6-12 6-12-4-6-10-6-12-6-5 0-10 3-12 3s-7-3-11-3c-6 0-12 4-15 9-7 11-2 28 5 38 3 5 7 10 12 10s7-3 12-3 8 3 12 3c5 0 9-5 12-10 4-6 5-11 5-12-1 0-7-3-7-7z" fill="#E2E8F0" />
      </>
    );
  }

  // 17. Default / Generic Linux: Tux the Penguin
  return renderSvg(
    <>
      <circle cx="50" cy="50" r="48" fill="#EAB308" fillOpacity="0.12" stroke="#EAB308" strokeWidth="2" strokeOpacity="0.3" />
      <ellipse cx="50" cy="58" rx="22" ry="24" fill="#18181B" />
      <ellipse cx="50" cy="62" rx="14" ry="17" fill="#F4F4F5" />
      <circle cx="50" cy="38" r="16" fill="#18181B" />
      <ellipse cx="45" cy="36" rx="3.5" ry="5" fill="#FFFFFF" />
      <ellipse cx="55" cy="36" rx="3.5" ry="5" fill="#FFFFFF" />
      <circle cx="45" cy="37" r="2" fill="#000000" />
      <circle cx="55" cy="37" r="2" fill="#000000" />
      <path d="M44 42h12l-6 7z" fill="#F59E0B" />
      <ellipse cx="38" cy="80" rx="9" ry="4" fill="#F59E0B" />
      <ellipse cx="62" cy="80" rx="9" ry="4" fill="#F59E0B" />
    </>
  );
};

export default DistroLogo;
