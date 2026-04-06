import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export function MobileDrawer({ open, onClose, title, children }: Props) {
  const isMobile = useIsMobile();
  const backdropRef = useRef<HTMLDivElement>(null);

  // Prevent body scroll when drawer open on mobile
  useEffect(() => {
    if (isMobile && open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isMobile, open]);

  if (!open) return null;

  // Desktop: side panel (existing behavior)
  if (!isMobile) {
    return (
      <div className="w-80 flex-shrink-0 overflow-auto border-l border-gray-800">
        {children}
      </div>
    );
  }

  // Mobile: full-screen overlay drawer from right
  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[2000] flex"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="flex-1 bg-black/40" />
      <div className="w-full max-w-sm bg-gray-900 flex flex-col h-full animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 flex-shrink-0">
          {title && <span className="text-sm font-medium text-white">{title}</span>}
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
