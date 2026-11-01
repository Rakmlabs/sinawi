import { useState } from "react";

const brands: Record<string, { name: string; src: string }> = {
  codex: { name: "Codex", src: new URL("./assets/agents/codex.svg", import.meta.url).href },
  claude: { name: "Claude", src: new URL("./assets/agents/claude-color.svg", import.meta.url).href },
  grok: { name: "Grok Build", src: new URL("./assets/agents/grok.svg", import.meta.url).href },
};

export function AgentMark({ agent, size = "" }: { agent: string; size?: string }) {
  const [failedSource, setFailedSource] = useState<string>();
  const brand = Object.hasOwn(brands, agent) ? brands[agent] : undefined;
  const name = brand?.name ?? agent;
  return <span className={`agent-mark ${brand ? agent : "unknown"} ${size}`} role="img" aria-label={name} title={name}>
    {brand && failedSource !== brand.src
      ? <img src={brand.src} alt="" aria-hidden="true" onError={() => setFailedSource(brand.src)} />
      : <span className="agent-mark-fallback">{name.slice(0, 2)}</span>}
  </span>;
}
