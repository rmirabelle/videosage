import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One choice in a right-click menu, or a line between groups of choices. */
export type ContextMenuItem =
  | { label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | "separator";

/**
 * A right-click menu at the mouse, in the look of the Open dialog's menu,
 * kept inside the window. A click on a choice runs it and closes the menu;
 * a click outside, Esc, the wheel, or the window losing focus closes it.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    setPlace({
      left: Math.max(8, Math.min(x, window.innerWidth - 8 - menu.offsetWidth)),
      top: Math.max(8, Math.min(y, window.innerHeight - 8 - menu.offsetHeight))
    });
  }, [x, y]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    /* Capture, so Esc closes the menu and does not also clear the selection. */
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onClose, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onClose, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div ref={menuRef} className="open-context-menu" role="menu" style={place} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, index) => item === "separator"
        ? <hr key={`separator-${index}`} />
        : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon} <span>{item.label}</span> {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ))}
    </div>
  );
}
