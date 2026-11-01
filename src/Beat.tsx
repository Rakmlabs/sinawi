/** 장단 (beat): the running indicator — three dots pulsing in turn. Decorative; pair it with text. */
export function Beat({ className = "" }: { className?: string }) {
  return <span className={`beat${className ? ` ${className}` : ""}`} aria-hidden="true"><i /><i /><i /></span>;
}
