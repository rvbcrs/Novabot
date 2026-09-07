/** Retry only nav2-not-ready (122), using live status and the current session. */
export async function runAutoDock(
  send: (attempt: number) => Promise<boolean>,
  getStatus: () => { errorStatus: number; progressing: boolean },
  isActive: () => boolean,
): Promise<'accepted' | 'cancelled' | 'failed' | 'exhausted'> {
  const delay = () => new Promise(resolve => setTimeout(resolve, 500));
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (!isActive()) return 'cancelled';
    const sent = await send(attempt);
    if (!isActive()) return 'cancelled';
    if (!sent) return 'failed';
    let retry = false;
    const observeUntil = Date.now() + 6000;
    while (Date.now() < observeUntil) {
      if (!isActive()) return 'cancelled';
      const status = getStatus();
      if (status.progressing) return 'accepted';
      if (status.errorStatus === 122) { retry = true; break; }
      await delay();
    }
    if (!isActive()) return 'cancelled';
    if (!retry) return 'accepted';
    if (attempt === 6) return 'exhausted';
    const retryAt = Date.now() + 20000;
    while (Date.now() < retryAt) {
      if (!isActive()) return 'cancelled';
      if (getStatus().progressing) return 'accepted';
      await delay();
    }
  }
  return 'exhausted';
}
