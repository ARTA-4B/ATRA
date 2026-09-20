import { useEffect, useState } from 'react';
import { Dashboard } from './Dashboard';
import { PublicSite } from './Public';
import { MotionLayer } from './motion';

/**
 * Routing on real paths, not on the fragment.
 *
 * A hash route needs no server support, which is why it is where a static
 * site starts. It also means every address carries a `#`: the path a person
 * copies is `artallm.org/#/market`, the server is never told which page was
 * asked for, and a crawler sees one page. The deployment serves index.html
 * for any unmatched path (`not_found_handling: single-page-application`), so
 * the fragment buys nothing here.
 *
 * Links stay plain `<a href="/market">`, which is what they should be: they
 * work with middle-click, "open in new tab" and with JavaScript disabled. One
 * delegated click handler upgrades a same-origin click to a pushState so the
 * page does not reload — and deliberately does not interfere with a modified
 * click, a different target, or a download.
 */

/** The address a link should go to, as this app understands it. */
function currentPath(): string {
  return window.location.pathname + window.location.hash;
}

/** Old `#/market` links, including any a visitor bookmarked, still arrive. */
function redirectLegacyHash(): boolean {
  const hash = window.location.hash;
  if (!hash.startsWith('#/')) return false;
  const path = hash.slice(1) || '/';
  window.history.replaceState(null, '', path);
  return true;
}

export function App() {
  const [route, setRoute] = useState(() => {
    redirectLegacyHash();
    return currentPath();
  });

  useEffect(() => {
    const onPop = () => setRoute(currentPath());
    window.addEventListener('popstate', onPop);

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download') || anchor.getAttribute('rel')?.includes('external')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;

      event.preventDefault();
      const next = url.pathname + url.hash;
      if (next !== currentPath()) window.history.pushState(null, '', next);
      setRoute(next);
    };
    document.addEventListener('click', onClick);

    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, []);

  useEffect(() => {
    const anchor = route.indexOf('#');
    if (anchor >= 0) {
      const id = route.slice(anchor + 1);
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        }),
      );
    } else {
      window.scrollTo(0, 0);
    }
    const segments = route.split('#')[0]!.split('/').filter(Boolean);
    const page = segments.at(-1) ?? 'Home';
    document.title = `ATRA — ${page.charAt(0).toUpperCase()}${page.slice(1).replaceAll('-', ' ')}`;
  }, [route]);

  const path = route.split('#')[0]!;
  const local = path.startsWith('/app/');
  const page = path.replace(/^\/+/, '').split('#')[0] || 'home';

  return (
    <>
      {local ? (
        <Dashboard page={path.split('/')[2] || 'overview'} />
      ) : (
        <PublicSite page={page} />
      )}
      <MotionLayer route={route} />
    </>
  );
}
