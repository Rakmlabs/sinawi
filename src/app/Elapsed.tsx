import { formatElapsed } from "../conversation";
import { useNow } from "./clock";

/** `m:ss` since `start`; ticks every second only while `end` is unknown. */
export function Elapsed({ start, end }: { start: string; end?: string }) {
  const now = useNow(1_000, !end);
  return <time>{formatElapsed(Date.parse(start), end ? Date.parse(end) : now)}</time>;
}
