import { useEffect, useRef, useState } from "react";
import { fileToken, commandItems, slashToken } from "../composer";
import type { Api } from "./api";

export type SlashItem = ReturnType<typeof commandItems>[number];

/** `/command` and `@file` completion plus prompt-history cursor for the composer textarea. */
export function useComposerCompletion(api: Api, cwd: string) {
  const [slash, setSlash] = useState<ReturnType<typeof slashToken>>();
  const [skillIndex, setSkillIndex] = useState(0);
  const [fileCompletion, setFileCompletion] = useState<ReturnType<typeof fileToken>>();
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const historyIndex = useRef(-1);
  const historyDraft = useRef("");
  const lastEscape = useRef(0);
  const slashItems = slash ? commandItems(slash.query) : [];
  const highlightedSkill = Math.min(skillIndex, Math.max(0, slashItems.length - 1));
  useEffect(() => {
    if (slash) document.getElementById(`slash-skill-${highlightedSkill}`)?.scrollIntoView({ block: "nearest" });
  }, [slash?.query, highlightedSkill]);
  useEffect(() => {
    if (!fileCompletion || !cwd) { setFileSuggestions([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api<{ files: string[] }>(`/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(fileCompletion.query)}`)
        .then((result) => { if (!cancelled) setFileSuggestions(result.files); })
        .catch(() => { if (!cancelled) setFileSuggestions([]); });
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileCompletion?.query, cwd]);
  return {
    slash, setSlash, skillIndex, setSkillIndex, fileCompletion, setFileCompletion, fileSuggestions, setFileSuggestions, fileIndex, setFileIndex,
    composerInput, historyIndex, historyDraft, lastEscape, slashItems, highlightedSkill,
  };
}

export type ComposerCompletion = ReturnType<typeof useComposerCompletion>;
