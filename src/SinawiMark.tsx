/** Sinawi logo: a rounded square with three wavy strokes. Colours come from --mark-1/2/3. */
export function SinawiMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return <svg className={`sinawi-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" focusable="false" style={{ pointerEvents: "none", flex: "none" }}>
    <rect width="96" height="96" rx="24" fill="var(--mark-1, #EFEAE0)" />
    <g fill="none" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 34c8-8 14 8 22 0s14 8 22 0 10-4 12-2" stroke="var(--mark-2, #4FB08F)" />
      <path d="M20 50c6 6 12-6 20 0s12 6 18 0 12-6 18 2" stroke="var(--mark-3, #D9774F)" />
      <path d="M20 66c10-6 16 6 26 0s14-4 30 0" stroke="var(--mark-2, #4FB08F)" />
    </g>
  </svg>;
}
