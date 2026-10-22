import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Outline({ size = 24, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChevronDown(props: IconProps) {
  return <Outline {...props}><path d="m6 9 6 6 6-6" /></Outline>;
}

export function ChevronUp(props: IconProps) {
  return <Outline {...props}><path d="m6 15 6-6 6 6" /></Outline>;
}

export function ArrowRight(props: IconProps) {
  return <Outline {...props}><path d="M4 12h16m-6-6 6 6-6 6" /></Outline>;
}

export function ArrowLeft(props: IconProps) {
  return <Outline {...props}><path d="M20 12H4m6-6-6 6 6 6" /></Outline>;
}

export function Pin(props: IconProps) {
  return <Outline {...props}><path d="m16 3 5 5-4 1-3 6-2-2-5 5-1-1 5-5-2-2 6-3Z" /></Outline>;
}

export function Check(props: IconProps) {
  return <Outline {...props}><path d="m5 12 4 4L19 6" /></Outline>;
}

export function More(props: IconProps) {
  return <Outline {...props}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></Outline>;
}

export function Close(props: IconProps) {
  return <Outline {...props}><path d="m6 6 12 12M6 18 18 6" /></Outline>;
}

export function Cloud(props: IconProps) {
  return <Outline {...props}><path d="M6 19a4 4 0 0 1-1-7.87A7 7 0 0 1 18.8 9 5 5 0 0 1 18 19Z" /></Outline>;
}

export function Eye(props: IconProps) {
  return <Outline {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></Outline>;
}

export function EyeOff(props: IconProps) {
  return <Outline {...props}><path d="m3 3 18 18M10.5 5.1Q11.2 5 12 5c6.5 0 10 7 10 7a22 22 0 0 1-3 4M6.5 6.5A22 22 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Outline>;
}

export function Search(props: IconProps) {
  return <Outline {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></Outline>;
}

export function Settings(props: IconProps) {
  return <Outline {...props}><path d="m9 3-.6 2.4-2.1 1.2L4 6 2 9l1.8 1.8v2.4L2 15l2 3 2.3-.6 2.1 1.2L9 21h6l.6-2.4 2.1-1.2L20 18l2-3-1.8-1.8v-2.4L22 9l-2-3-2.3.6-2.1-1.2L15 3Z" /><circle cx="12" cy="12" r="3" /></Outline>;
}

export function Mail(props: IconProps) {
  return <Outline {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></Outline>;
}

export function SidebarIcon(props: IconProps) {
  return <Outline {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></Outline>;
}

export function Compose(props: IconProps) {
  return <Outline {...props}><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></Outline>;
}

export function Star(props: IconProps) {
  return <Outline {...props}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z" /></Outline>;
}

export function Inbox(props: IconProps) {
  return <Outline {...props}><path d="M3 13h5l1.5 3h5l1.5-3h5" /><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" /></Outline>;
}

export function Clock(props: IconProps) {
  return <Outline {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Outline>;
}

export function Filter(props: IconProps) {
  return <Outline {...props}><path d="M4 5h16l-6 7.5V18l-4 2v-7.5Z" /></Outline>;
}

export function Users(props: IconProps) {
  return <Outline {...props}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5.5 5.5 0 0 1 3.5 6" /></Outline>;
}

export function Megaphone(props: IconProps) {
  return <Outline {...props}><path d="M3 10v4a1 1 0 0 0 1 1h3l8 5V4L7 9H4a1 1 0 0 0-1 1ZM18.5 9a4 4 0 0 1 0 6M7 15l1.5 5" /></Outline>;
}

export function Newspaper(props: IconProps) {
  return <Outline {...props}><path d="M5 4h12a1 1 0 0 1 1 1v14a1 1 0 0 0 2 0V9h-2M5 4a1 1 0 0 0-1 1v13a2 2 0 0 0 2 2h14M8 8h6M8 12h6M8 16h4" /></Outline>;
}

export function Receipt(props: IconProps) {
  return <Outline {...props}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6M9 16h3" /></Outline>;
}

export function Bell(props: IconProps) {
  return <Outline {...props}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15ZM10 20.5a2 2 0 0 0 4 0" /></Outline>;
}

export function Reply(props: IconProps) {
  return <Outline {...props}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Outline>;
}

export function PanelRight(props: IconProps) {
  return <Outline {...props}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></Outline>;
}

export function Plus(props: IconProps) {
  return <Outline {...props}><path d="M12 5v14M5 12h14" /></Outline>;
}

export function Archive(props: IconProps) {
  return <Outline {...props}><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" /></Outline>;
}

export function Trash(props: IconProps) {
  return <Outline {...props}><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></Outline>;
}

export function Keyboard(props: IconProps) {
  return <Outline {...props}><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" /></Outline>;
}

export function AtSign(props: IconProps) {
  return <Outline {...props}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></Outline>;
}

export function Sort(props: IconProps) {
  return <Outline {...props}><path d="M4 6h16M7 12h10M10 18h4" /></Outline>;
}

export function Plug(props: IconProps) {
  return <Outline {...props}><path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v4" /></Outline>;
}

export function Palette(props: IconProps) {
  return <Outline {...props}><path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.9 1.4-1.8l-.3-.8a1.6 1.6 0 0 1 1.5-2.2H17a4 4 0 0 0 4-4c0-5-4-9.2-9-9.2Z" /><circle cx="7.5" cy="11" r="1" /><circle cx="10.5" cy="7" r="1" /><circle cx="15" cy="7.5" r="1" /></Outline>;
}

export function Image(props: IconProps) {
  return <Outline {...props}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="10" r="1.5" /><path d="m21 16-5-5-9 9" /></Outline>;
}

export function Cpu(props: IconProps) {
  return <Outline {...props}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9.5 9.5h5v5h-5zM9 2.5V6m6-3.5V6M9 18v3.5m6-3.5v3.5M2.5 9H6m-3.5 6H6m12-6h3.5M18 15h3.5" /></Outline>;
}

export function Info(props: IconProps) {
  return <Outline {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></Outline>;
}

export function Gmail(props: IconProps) {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path fill="#4285f4" d="M2 20h4V9L1 5.5V19a1 1 0 0 0 1 1Z" />
      <path fill="#34a853" d="M18 20h4a1 1 0 0 0 1-1V5.5L18 9Z" />
      <path fill="#fbbc04" d="M18 9v-5l1.8-1.1A2 2 0 0 1 23 4.5v6Z" />
      <path fill="#ea4335" d="M6 9v-5l6 4.5L18 4v5l-6 4.5Z" />
      <path fill="#c5221f" d="M1 4.5v6L6 9V4L4.2 2.9A2 2 0 0 0 1 4.5Z" />
    </svg>
  );
}

export function Calendar(props: IconProps) {
  return <Outline {...props}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></Outline>;
}

export function CalendarPlus(props: IconProps) {
  return <Outline {...props}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M12 14v4M10 16h4" /></Outline>;
}
