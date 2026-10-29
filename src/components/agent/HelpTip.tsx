import React, { useEffect, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';

interface HelpTipProps {
  /** Short label shown in the popover header */
  title: string;
  /** Body copy explaining the control */
  children: React.ReactNode;
  /** Prefer opening the panel to the left on cramped right-side controls */
  align?: 'left' | 'right';
  className?: string;
}

/** Clickable ? that opens a short how-to panel (better than native title tooltips for multi-line help). */
export const HelpTip: React.FC<HelpTipProps> = ({
  title,
  children,
  align = 'left',
  className = ''
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        aria-label={`Help: ${title}`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(v => !v);
        }}
        className={`p-0.5 rounded-full transition ${
          open
            ? 'text-indigo-300 bg-indigo-500/20'
            : 'text-zinc-500 hover:text-indigo-300 hover:bg-[#252530]'
        }`}
      >
        <CircleHelp className="w-3 h-3" />
      </button>

      {open && (
        <div
          role="dialog"
          className={`absolute z-50 top-full mt-1.5 w-64 p-2.5 rounded-lg border border-[#35354a] bg-[#1a1a22] shadow-xl text-left ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
          onClick={e => e.stopPropagation()}
        >
          <div className="text-[11px] font-semibold text-zinc-100 mb-1">{title}</div>
          <div className="text-[10px] leading-relaxed text-zinc-400 space-y-1.5">{children}</div>
        </div>
      )}
    </span>
  );
};
