import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Check,
  Clock3,
  Folder,
  FolderOpen,
  LoaderCircle,
  Pin,
  PinOff,
} from "lucide-react";
import type { WorkspaceId } from "../server/types";
import { recentPaths } from "./composer";
import "./folder-picker.css";
import { t } from "./i18n";

type DirectoryListing = {
  path: string;
  parent: string;
  directories: string[];
};

type FolderPickerProps = {
  workspaceId?: WorkspaceId;
  currentPath: string;
  onUse: (path: string) => void;
};

const RECENT_KEY = "orchestra.recentFolders";
const FAVORITES_KEY = "orchestra.favoriteFolders";

function storedPaths(key: string, limit = 8) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return recentPaths(value, limit);
  } catch {
    return [];
  }
}

function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function folderName(path: string) {
  if (path === "/") return "Macintosh HD";
  return path.replace(/\/$/, "").split("/").pop() || path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t("folder.checkFailed"));
  return data as T;
}

export function FolderPicker({ currentPath, onUse, workspaceId = "personal" }: FolderPickerProps) {
  const recentKey = `orchestra.${workspaceId}.recentFolders`;
  const favoritesKey = `orchestra.${workspaceId}.favoriteFolders`;
  const [recent, setRecent] = useState<string[]>(() => storedPaths(recentKey).length ? storedPaths(recentKey) : workspaceId === "personal" ? storedPaths(RECENT_KEY) : []);
  const [favorites, setFavorites] = useState<string[]>(() => storedPaths(favoritesKey, 20).length ? storedPaths(favoritesKey, 20) : workspaceId === "personal" ? storedPaths(FAVORITES_KEY, 20) : []);
  const [draft, setDraft] = useState(currentPath);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const pickerId = useRef(0);

  const loadDirectory = async (path: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const next = await request<DirectoryListing>(`/directories?path=${encodeURIComponent(path)}`);
      if (id !== requestId.current) return undefined;
      setListing(next);
      setDraft(next.path);
      return next;
    } catch (cause) {
      if (id === requestId.current) setError((cause as Error).message);
      return undefined;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    setDraft(currentPath);
    if (currentPath) void loadDirectory(currentPath);
    return () => { requestId.current += 1; pickerId.current += 1; };
    // Re-open the browser at the path owned by the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const remember = (path: string) => {
    const next = recentPaths([path, ...recent]);
    setRecent(next);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* Optional local convenience. */ }
  };

  const commit = async (path: string) => {
    const verified = await loadDirectory(path);
    if (!verified) return;
    remember(verified.path);
    onUse(verified.path);
  };

  const toggleFavorite = (path: string) => {
    const next = favorites.includes(path)
      ? favorites.filter((item) => item !== path)
      : [path, ...favorites].slice(0, 20);
    setFavorites(next);
    try { localStorage.setItem(favoritesKey, JSON.stringify(next)); } catch { /* Optional local convenience. */ }
  };

  const pickInFinder = async () => {
    if (picking) return;
    const id = ++pickerId.current;
    setPicking(true);
    setError("");
    try {
      const result = await request<{ path: string | null }>("/directories/pick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) });
      if (id !== pickerId.current || !result.path) return;
      const verified = await loadDirectory(result.path);
      if (!verified) return;
      remember(verified.path);
      onUse(verified.path);
    } catch (cause) {
      if (id === pickerId.current) setError((cause as Error).message);
    } finally {
      if (id === pickerId.current) setPicking(false);
    }
  };

  const renderSavedRow = (path: string, icon: "favorite" | "recent") => (
    <div className="folder-picker-saved-row" key={`${icon}-${path}`}>
      <button type="button" className="folder-picker-saved-main" title={path} onClick={() => void loadDirectory(path)}>
        {icon === "favorite" ? <Pin size={15} /> : <Clock3 size={15} />}
        <span>
          <strong>{folderName(path)}</strong>
          <small>{shortPath(path)}</small>
        </span>
        <ArrowRight size={14} />
      </button>
      <button
        type="button"
        className={`folder-picker-pin ${favorites.includes(path) ? "active" : ""}`}
        aria-label={t(favorites.includes(path) ? "folder.unfavoriteNamed" : "folder.favoriteNamed", { name: folderName(path) })}
        title={favorites.includes(path) ? t("folder.unfavorite") : t("folder.favorite")}
        onClick={() => toggleFavorite(path)}
      >
        {favorites.includes(path) ? <PinOff size={15} /> : <Pin size={15} />}
      </button>
    </div>
  );

  return (
    <div className="folder-picker">
      <p className="folder-picker-intro">{t("folder.intro")}</p>

      <button type="button" className="folder-picker-finder" disabled={picking || loading} onClick={() => void pickInFinder()}>
        {picking ? <LoaderCircle className="spin" size={20} /> : <FolderOpen size={20} />}
        <span><strong>{picking ? t("folder.waitingFinder") : t("folder.pickInFinder")}</strong><small>{t("folder.openPicker")}</small></span>
        <ArrowRight size={16} />
      </button>

      {(favorites.length > 0 || recent.length > 0) && (
        <div className="folder-picker-saved">
          {favorites.length > 0 && <section aria-labelledby="favorite-folders-title">
            <h3 id="favorite-folders-title">{t("folder.favorites")}</h3>
            {favorites.map((path) => renderSavedRow(path, "favorite"))}
          </section>}
          {recent.length > 0 && <section aria-labelledby="recent-folders-title">
            <h3 id="recent-folders-title">{t("folder.recent")}</h3>
            {recent.map((path) => renderSavedRow(path, "recent"))}
          </section>}
        </div>
      )}

      <form className="folder-picker-path" onSubmit={(event) => { event.preventDefault(); void commit(draft.trim()); }}>
        <label htmlFor="folder-picker-path">{t("folder.typePath")}</label>
        <div>
          <input id="folder-picker-path" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="/Users/me/project" spellCheck={false} />
          <button type="submit" className="button light" disabled={loading || !draft.trim()}>{loading ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t("folder.usePath")}</button>
        </div>
      </form>

      {error && <p className="folder-picker-error" role="alert">{error}</p>}

      {listing && (
        <section className="folder-picker-browser" aria-labelledby="folder-browser-title" aria-busy={loading}>
          <header>
            <div><span>{t("folder.current")}</span><h3 id="folder-browser-title">{folderName(listing.path)}</h3><small title={listing.path}>{shortPath(listing.path)}</small></div>
            <button type="button" className={`folder-picker-pin ${favorites.includes(listing.path) ? "active" : ""}`} onClick={() => toggleFavorite(listing.path)} aria-label={favorites.includes(listing.path) ? t("folder.unfavoriteCurrent") : t("folder.favoriteCurrent")}><Pin size={16} /></button>
          </header>
          <div className="folder-picker-directory-list">
            {listing.parent !== listing.path && <button type="button" onClick={() => void loadDirectory(listing.parent)}><ArrowUp size={16} /><span><strong>{t("folder.parent")}</strong><small>{shortPath(listing.parent)}</small></span></button>}
            {listing.directories.map((path) => <button type="button" key={path} onClick={() => void loadDirectory(path)}><Folder size={16} /><span><strong>{folderName(path)}</strong><small>{shortPath(path)}</small></span><ArrowRight size={13} /></button>)}
            {!listing.directories.length && <p className="folder-picker-empty">{t("folder.noSubfolders")}</p>}
          </div>
          <button type="button" className="button primary folder-picker-use" disabled={loading} onClick={() => void commit(listing.path)}>{t("folder.useFolder")} <Check size={15} /></button>
        </section>
      )}
    </div>
  );
}

export default FolderPicker;
