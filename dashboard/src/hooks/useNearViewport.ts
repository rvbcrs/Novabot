import { useEffect, useRef, useState, type RefObject } from 'react';

/** The closest ancestor that scrolls, or null for the page itself. */
function scrollParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (/auto|scroll/.test(overflowX + overflowY)) return p;
  }
  return null;
}

/**
 * True from the moment the element is within `margin` px of the visible part of
 * its scroll container (or of the page), and it stays true. For tiles whose photo
 * is fetched only when it is, or is about to be, on screen: sixty photo requests
 * at once make everything else on the page wait for a free connection.
 * Without IntersectionObserver every element counts as near.
 */
export function useNearViewport<T extends Element>(margin = 200): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    // The scroll container is the root, so the margin reaches the tiles just
    // outside its edge (against the page, an ancestor's clip would hide them).
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setNear(true); io.disconnect(); }
    }, { root: scrollParent(el), rootMargin: `${margin}px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near];
}
