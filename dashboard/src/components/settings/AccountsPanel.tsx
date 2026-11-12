/**
 * Your own password, in the dashboard (GH #164). Shown only when you are
 * logged in, i.e. when you use the dashboard from outside your network: on
 * the LAN the dashboard knows no user. Managing users is on the admin page.
 */
import { useEffect, useState } from 'react';
import { Loader2, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchMe, changeOwnPassword, type Me } from '../../api/client';
import { useToast } from '../common/Toast';

const INPUT = 'w-full bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 transition-colors';
const PRIMARY = 'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium transition-colors';
const SECONDARY = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 bg-gray-800/40 hover:bg-gray-800/70 text-xs text-zinc-200 transition-colors';
const MIN_PASSWORD = 6;

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function AccountsPanel() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { void fetchMe().then(setMe); }, []);
  if (me === undefined) return <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />;
  if (me === null) return null;
  return (
    <div className="space-y-3">
      <div className="text-sm text-zinc-200 truncate">{me.email}</div>
      <OwnPassword />
    </div>
  );
}

function OwnPassword() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return <button className={SECONDARY} onClick={() => setOpen(true)}><KeyRound className="w-3.5 h-3.5" />{t('settings.accounts.changePassword', 'Change password')}</button>;
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_PASSWORD) { setError(t('settings.accounts.tooShort', 'At least {{n}} characters', { n: MIN_PASSWORD })); return; }
    if (next !== repeat) { setError(t('settings.accounts.mismatch', 'The new passwords differ')); return; }
    setBusy(true);
    try {
      await changeOwnPassword(current, next);
      toast(t('settings.accounts.passwordChanged', 'Password changed'), 'success');
      setOpen(false); setCurrent(''); setNext(''); setRepeat('');
    } catch (err) { setError(message(err, t('common.failed'))); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <input className={INPUT} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
        placeholder={t('settings.accounts.currentPassword', 'Current password')} required />
      <input className={INPUT} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
        placeholder={t('settings.accounts.newPassword', 'New password')} required />
      <input className={INPUT} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)}
        placeholder={t('settings.accounts.repeatPassword', 'Repeat new password')} required />
      {error && <div className="text-red-400 text-xs">{error}</div>}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY} disabled={busy}>{busy && <Loader2 className="w-4 h-4 animate-spin" />}{t('common.save', 'Save')}</button>
        <button type="button" className={SECONDARY} onClick={() => setOpen(false)}>{t('common.cancel', 'Cancel')}</button>
      </div>
    </form>
  );
}
