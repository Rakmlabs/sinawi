import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import "./glass-select.css";

export type GlassSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
};

type GlassSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: GlassSelectOption[];
  label: string;
  disabled?: boolean;
  allowCustom?: boolean;
  placeholder?: string;
  className?: string;
};

type MenuPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  transform?: string;
};

const SEARCH_THRESHOLD = 7;

export function GlassSelect({
  value,
  onChange,
  options,
  label,
  disabled = false,
  allowCustom = false,
  placeholder = "선택하세요",
  className = "",
}: GlassSelectProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const controlRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [queryDirty, setQueryDirty] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition>();
  const searchable = allowCustom || options.length >= SEARCH_THRESHOLD;
  const selected = options.find((option) => option.value === value);

  const filteredOptions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("ko-KR");
    if (!searchable || !queryDirty || !term) return options;
    return options.filter((option) =>
      `${option.label} ${option.value}`.toLocaleLowerCase("ko-KR").includes(term),
    );
  }, [options, query, queryDirty, searchable]);

  const firstEnabled = (items = filteredOptions) => items.findIndex((option) => !option.disabled);
  const lastEnabled = () => {
    for (let index = filteredOptions.length - 1; index >= 0; index -= 1) {
      if (!filteredOptions[index].disabled) return index;
    }
    return -1;
  };

  const updatePosition = () => {
    const trigger = controlRef.current?.parentElement;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const gap = 6;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - gutter * 2);
    const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter);
    const below = window.innerHeight - rect.bottom - gap - gutter;
    const above = rect.top - gap - gutter;
    const placeAbove = below < 180 && above > below;
    const maxHeight = Math.max(40, Math.min(320, placeAbove ? above : below));
    setPosition({
      left,
      top: placeAbove ? Math.max(gutter, rect.top - gap) : Math.max(gutter, rect.bottom + gap),
      transform: placeAbove ? "translateY(-100%)" : undefined,
      width,
      maxHeight,
    });
  };

  const openMenu = () => {
    if (disabled || open) return;
    setQuery(allowCustom ? value : "");
    setQueryDirty(false);
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setQueryDirty(false);
    setActiveIndex(-1);
    if (restoreFocus) requestAnimationFrame(() => controlRef.current?.focus());
  };

  const choose = (option: GlassSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  };

  const moveActive = (direction: 1 | -1) => {
    if (!filteredOptions.length) return;
    let next = activeIndex;
    for (let count = 0; count < filteredOptions.length; count += 1) {
      next = (next + direction + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[next].disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const updateQuery = (nextQuery: string) => {
    const term = nextQuery.trim().toLocaleLowerCase("ko-KR");
    const matches = !term ? options : options.filter((option) =>
      `${option.label} ${option.value}`.toLocaleLowerCase("ko-KR").includes(term),
    );
    setQuery(nextQuery);
    setQueryDirty(true);
    setActiveIndex(firstEnabled(matches));
    if (!open) setOpen(true);
    if (allowCustom) onChange(nextQuery);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openMenu();
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (!open && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? firstEnabled() : lastEnabled());
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option && !option.disabled) choose(option);
      else if (allowCustom) {
        onChange(query.trim());
        closeMenu(true);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const handleViewportChange = () => updatePosition();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [allowCustom, filteredOptions.length, open]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!controlRef.current?.parentElement?.contains(target) && !menuRef.current?.contains(target)) closeMenu(false);
    };
    document.addEventListener("pointerdown", handleOutside, true);
    return () => document.removeEventListener("pointerdown", handleOutside, true);
  }, [open]);

  useEffect(() => {
    if (disabled && open) closeMenu(false);
  }, [disabled, open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  const shownValue = open && searchable ? query : selected?.label ?? value;
  const menuStyle = position
    ? ({ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, transform: position.transform } satisfies CSSProperties)
    : undefined;

  return (
    <div className={`glass-select ${className}`}>
      <div className="glass-select-control">
        {selected?.icon && !(searchable && open) && <span className="glass-select-icon">{selected.icon}</span>}
        {searchable && open && <Search size={14} aria-hidden="true" />}
        <input
          ref={controlRef}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          aria-autocomplete={searchable ? "list" : "none"}
          autoComplete="off"
          disabled={disabled}
          readOnly={!searchable || !open}
          value={shownValue}
          placeholder={placeholder}
          onClick={() => {
            if (open && !searchable) closeMenu(false);
            else openMenu();
          }}
          onBlur={() => {
            requestAnimationFrame(() => {
              const focused = document.activeElement;
              if (!controlRef.current?.parentElement?.contains(focused) && !menuRef.current?.contains(focused)) closeMenu(false);
            });
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            updateQuery(event.currentTarget.value);
          }}
          onChange={(event) => {
            if (composingRef.current) setQuery(event.target.value);
            else updateQuery(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="glass-select-toggle"
          tabIndex={-1}
          aria-label={`${label} 목록 ${open ? "닫기" : "열기"}`}
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            controlRef.current?.focus();
            if (open) closeMenu(true);
            else openMenu();
          }}
        >
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      </div>
      {open && position && createPortal(
        <div
          ref={menuRef}
          className="glass-select-menu"
          style={menuStyle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div id={listboxId} role="listbox" aria-label={`${label} 선택 항목`}>
            {filteredOptions.map((option, index) => (
              <button
                type="button"
                role="option"
                id={`${id}-option-${index}`}
                key={option.value}
                tabIndex={-1}
                aria-selected={option.value === value}
                disabled={option.disabled}
                title={option.title}
                className={index === activeIndex ? "active" : ""}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span className="glass-select-option-label">{option.icon}{option.label}</span>
                {option.value === value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!filteredOptions.length && (
              <p className="glass-select-empty">
                {allowCustom ? "입력한 값을 직접 사용할 수 있습니다." : "일치하는 항목이 없습니다."}
              </p>
            )}
          </div>
          {allowCustom && query.trim() && !options.some((option) => option.value === query.trim()) && (
            <button
              type="button"
              className="glass-select-custom"
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(query.trim());
                closeMenu(true);
              }}
            >
              “{query.trim()}” 사용
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
