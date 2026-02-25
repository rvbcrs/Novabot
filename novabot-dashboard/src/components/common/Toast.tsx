import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { X, AlertTriangle, CheckCircle2, Info } from 'lucide-react';

type ToastType = 'error' | 'success' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = nextId++;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast container — fixed bottom-right, above everything */}
      <div className="fixed bottom-4 right-4 z-[99999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICONS = {
  error: AlertTriangle,
  success: CheckCircle2,
  info: Info,
};

const COLORS = {
  error: 'border-red-500/40 bg-red-950/90 text-red-200',
  success: 'border-green-500/40 bg-green-950/90 text-green-200',
  info: 'border-blue-500/40 bg-blue-950/90 text-blue-200',
};

const ICON_COLORS = {
  error: 'text-red-400',
  success: 'text-green-400',
  info: 'text-blue-400',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onDismiss, 200);
    }, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const Icon = ICONS[toast.type];

  return (
    <div
      className={`pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border backdrop-blur-sm shadow-lg max-w-sm transition-all duration-200 ${COLORS[toast.type]} ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <Icon className={`w-4 h-4 flex-shrink-0 ${ICON_COLORS[toast.type]}`} />
      <span className="text-sm flex-1">{toast.message}</span>
      <button
        onClick={() => { setVisible(false); setTimeout(onDismiss, 200); }}
        className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
