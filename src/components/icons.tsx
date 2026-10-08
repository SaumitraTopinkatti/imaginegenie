import type { ReactNode, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 17, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l1.8 5.6 5.6 1.8-5.6 1.8L12 17.8l-1.8-5.6L4.6 10.4l5.6-1.8L12 3z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
    </Svg>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 17.5l4.5-4.5 3.5 3.5 2.5-2.5 4 4" />
    </Svg>
  );
}

export function GalleryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function CostIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v10" />
      <path d="M15 9.3c-.7-1-1.8-1.5-3-1.5-1.7 0-3 .9-3 2.4 0 3.4 6 1.7 6 5.2 0 1.5-1.3 2.4-3 2.4-1.2 0-2.3-.5-3-1.4" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h9" />
      <path d="M17 8h3" />
      <circle cx="15" cy="8" r="2" />
      <path d="M4 16h3" />
      <path d="M11 16h9" />
      <circle cx="9" cy="16" r="2" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.8-3.8" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v10.5" />
      <path d="M7.5 11l4.5 4.5L16.5 11" />
      <path d="M5 20h14" />
    </Svg>
  );
}

export function DeleteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7l.8 13h9.4l.8-13" />
      <path d="M10.2 11v5.5" />
      <path d="M13.8 11v5.5" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5.5 15h-1v-10.5h10.5v1" />
    </Svg>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="15.5" r="3.8" />
      <path d="M10.8 12.7L20 3.5" />
      <path d="M16.8 6.7l2.3 2.3" />
      <path d="M14.3 9.2l2 2" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.5L3 19.5h18L12 4.5z" />
      <path d="M12 10v4" />
      <path d="M12 17.2v.1" />
    </Svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 14.5V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 20h14" />
    </Svg>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M12 8v4.3l3.2 1.9" />
    </Svg>
  );
}

export function DiceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17.9 17.9A9.8 9.8 0 0 1 12 18.9c-6.5 0-10.2-6.9-10.2-6.9a17.4 17.4 0 0 1 4.7-4.7" />
      <path d="M9.9 5.2A9.3 9.3 0 0 1 12 5.1c6.5 0 10.2 6.9 10.2 6.9a17.6 17.6 0 0 1-2 2.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M2.5 2.5l19 19" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 6l-6 6 6 6" />
    </Svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 6l6 6-6 6" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Svg>
  );
}

/** Crafted inline SVG fallback mark (genie lamp), used only if the
 *  generated logo file is unavailable. Gradient tile, no emoji. */
export function LampMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="lamp"
      style={{ width: size, height: size, borderRadius: Math.max(8, size * 0.28) }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" width={size * 0.6} height={size * 0.6} aria-hidden="true">
        <path
          d="M9 3h6l1 4h3v2h-2.2c-.4 2.6-2.4 4.6-5 5.2L11 15H5l-1-2h4l.6-1.2C7 11.4 6 10 5.7 8H4V6h3L9 3Z"
          fill="#14091f"
          opacity="0.85"
        />
        <circle cx="17.5" cy="5.5" r="1.2" fill="#14091f" />
      </svg>
    </span>
  );
}
