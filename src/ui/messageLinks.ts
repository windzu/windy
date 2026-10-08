export interface MessageLinkContext {
  sourcePath: string;
  vaultName: string;
  vaultPath: string | null;
}

export interface MessageLinkNavigator {
  openInternal(linkText: string, sourcePath: string, paneType: 'window'): Promise<void>;
  openExternal(url: string): void;
  onError(error: unknown): void;
}

type MessageLinkTarget =
  | { type: 'internal'; linkText: string }
  | { type: 'external'; url: string };

export function resolveMessageLink(
  link: { href: string | null; dataHref?: string | null },
  context: MessageLinkContext,
): MessageLinkTarget | null {
  const href = (link.dataHref || link.href)?.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) {
    return null;
  }
  const scheme = href.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript') {
    return null;
  }
  if (href.startsWith('//')) {
    return { type: 'external', url: `https:${href}` };
  }
  if (scheme === 'obsidian' || scheme === 'file' || scheme === 'app') {
    try {
      const uri = new URL(href);
      if (scheme === 'obsidian' && uri.hostname === 'open') {
        const absolutePath = uri.searchParams.get('path');
        const file = uri.searchParams.get('file');
        const vault = uri.searchParams.get('vault');
        const linkText = absolutePath
          ? vaultRelativeLink(absolutePath, context.vaultPath)
          : (!vault || vault === context.vaultName || vault === context.vaultPath)
            ? file
            : null;
        if (linkText) {
          return { type: 'internal', linkText };
        }
        uri.searchParams.set('paneType', 'window');
        return { type: 'external', url: uri.toString() };
      }
      if (scheme === 'app' && uri.hostname === 'obsidian.md') {
        return {
          type: 'internal',
          linkText: decodeLink(uri.pathname.slice(1) + uri.hash),
        };
      }
      if (scheme === 'file' && (!uri.hostname || uri.hostname === 'localhost')) {
        const linkText = vaultRelativeLink(
          decodeLink(uri.pathname + uri.hash).replace(/^\/(?=[a-z]:\/)/i, ''),
          context.vaultPath,
        );
        if (linkText) {
          return { type: 'internal', linkText };
        }
      }
    } catch {
      return null;
    }
  }
  if (scheme && !/^[a-z]:[\\/]/i.test(href)) {
    return { type: 'external', url: href };
  }
  const linkText = link.dataHref ? href : decodeLink(href);
  return {
    type: 'internal',
    linkText: vaultRelativeLink(linkText, context.vaultPath) ?? linkText,
  };
}

export function handleMessageLinkClick(
  event: MouseEvent,
  container: HTMLElement,
  context: MessageLinkContext,
  navigator: MessageLinkNavigator,
): void {
  if (event.button !== 0 && event.button !== 1) {
    return;
  }
  // Popout windows have separate DOM constructors, so avoid global instanceof checks.
  const node = event.target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  const anchor = element?.closest<HTMLAnchorElement>('a');
  if (!anchor || !container.contains(anchor) || anchor.matches(
    '.tag, .footnote-link, .footnote-backref, [role="doc-noteref"], [role="doc-backlink"]',
  )) {
    return;
  }
  const target = resolveMessageLink({
    href: anchor.getAttribute('href'),
    dataHref: anchor.getAttribute('data-href'),
  }, context);
  event.preventDefault();
  event.stopImmediatePropagation();
  if (target) {
    void openMessageLink(target, context, navigator).catch(navigator.onError);
  }
}

async function openMessageLink(
  target: MessageLinkTarget,
  context: MessageLinkContext,
  navigator: MessageLinkNavigator,
): Promise<void> {
  if (target.type === 'internal') {
    await navigator.openInternal(target.linkText, context.sourcePath, 'window');
  } else {
    navigator.openExternal(target.url);
  }
}

function decodeLink(link: string): string {
  try {
    return decodeURIComponent(link);
  } catch {
    return link;
  }
}

function vaultRelativeLink(linkText: string, vaultPath: string | null): string | null {
  if (!vaultPath) {
    return null;
  }
  const root = `${vaultPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const normalized = linkText.replace(/\\/g, '/');
  const isWindowsPath = /^[a-z]:\//i.test(root);
  const isInsideVault = isWindowsPath
    ? normalized.toLowerCase().startsWith(root.toLowerCase())
    : normalized.startsWith(root);
  return isInsideVault ? normalized.slice(root.length) : null;
}
