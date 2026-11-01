import { useId } from "react";

/** Sinawi logo: two stems that part into three voices. Source: src-tauri/icons/app-icon.svg. */
export function SinawiMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  const id = useId();
  return <svg className={`sinawi-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false" style={{ pointerEvents: "none", flex: "none" }}>
    <defs>
      <linearGradient id={`${id}l`} gradientUnits="userSpaceOnUse" x1="43" y1="30" x2="17" y2="76"><stop offset="0.2" stopColor="#5BD6A0" /><stop offset="0.85" stopColor="#F28C6A" /></linearGradient>
      <linearGradient id={`${id}r`} gradientUnits="userSpaceOnUse" x1="57" y1="30" x2="83" y2="76"><stop offset="0.2" stopColor="#5BD6A0" /><stop offset="0.85" stopColor="#6B8CFF" /></linearGradient>
      <linearGradient id={`${id}m`} gradientUnits="userSpaceOnUse" x1="31" y1="0" x2="69" y2="0"><stop offset="0.4" stopColor="#5BD6A0" /><stop offset="1" stopColor="#6B8CFF" /></linearGradient>
    </defs>
    <g transform="translate(0 5)" fill="none" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round">
      <path d="M43 18V36C43 42 40 45 34 49.5C25 56 17 61 17 71" stroke={`url(#${id}l)`} />
      <path d="M57 18V36C57 42 60 45 66 49.5C75 56 83 61 83 71" stroke={`url(#${id}r)`} />
      <path d="M31 68.5L50 52.5L69 68.5" stroke={`url(#${id}m)`} />
    </g>
  </svg>;
}
