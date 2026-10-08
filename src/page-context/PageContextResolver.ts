import type { App, EventRef, TFile } from 'obsidian';

export interface ActivePage {
  path: string;
  basename: string;
  extension: string;
}

type PageContextListener = (page: ActivePage | null) => void;

export interface PageContextSource {
  getActivePage(): ActivePage | null;
  onChange(listener: PageContextListener): () => void;
  refresh(): void;
}

const SUPPORTED_PAGE_EXTENSIONS = new Set(['md', 'base']);

export class PageContextResolver implements PageContextSource {
  private activePage: ActivePage | null = null;
  private eventRefs: EventRef[] = [];
  private listeners = new Set<PageContextListener>();

  constructor(private readonly app: App) {}

  start(): void {
    this.refresh();
    this.eventRefs.push(
      this.app.workspace.on('active-leaf-change', () => this.refresh()),
      this.app.workspace.on('file-open', () => this.refresh()),
    );
  }

  stop(): void {
    for (const eventRef of this.eventRefs) {
      this.app.workspace.offref(eventRef);
    }
    this.eventRefs = [];
  }

  getActivePage(): ActivePage | null {
    return this.activePage;
  }

  onChange(listener: PageContextListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  refresh(): void {
    const file = this.app.workspace.getActiveFile();
    const nextPage = file && SUPPORTED_PAGE_EXTENSIONS.has(file.extension)
      ? this.toActivePage(file)
      : null;
    if (nextPage?.path === this.activePage?.path) {
      return;
    }

    this.activePage = nextPage;
    for (const listener of this.listeners) {
      listener(this.activePage);
    }
  }

  private toActivePage(file: TFile): ActivePage {
    return {
      path: file.path,
      basename: file.basename,
      extension: file.extension,
    };
  }
}
