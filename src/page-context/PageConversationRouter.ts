import type { ActivePage, PageContextSource } from './PageContextResolver';
import type { PageAgentIndex, PageAgentRecord } from './PageAgentIndex';

export interface PageConversationRoute {
  page: ActivePage | null;
  conversationIds: string[];
  activeConversationId: string | null;
}

type RouteListener = (route: PageConversationRoute) => void;

const EMPTY_ROUTE: PageConversationRoute = {
  page: null,
  conversationIds: [],
  activeConversationId: null,
};

export class PageConversationRouter {
  private route: PageConversationRoute = EMPTY_ROUTE;
  private listeners = new Set<RouteListener>();
  private unsubscribePageContext: (() => void) | null = null;
  private routeGeneration = 0;

  constructor(
    private readonly pageContext: PageContextSource,
    private readonly index: PageAgentIndex,
  ) {}

  start(): void {
    if (this.unsubscribePageContext) {
      return;
    }
    this.unsubscribePageContext = this.pageContext.onChange(page => {
      this.routeTo(page);
    });
    this.routeTo(this.pageContext.getActivePage());
  }

  stop(): void {
    this.unsubscribePageContext?.();
    this.unsubscribePageContext = null;
    this.routeGeneration += 1;
  }

  getRoute(): PageConversationRoute {
    return {
      page: this.route.page,
      conversationIds: [...this.route.conversationIds],
      activeConversationId: this.route.activeConversationId,
    };
  }

  onChange(listener: RouteListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async associateConversation(conversationId: string): Promise<void> {
    const page = this.route.page;
    if (!page) {
      throw new Error('Cannot associate a conversation without an active page.');
    }

    await this.associateConversationForPage(page.path, conversationId);
  }

  async associateConversationForPage(
    pagePath: string,
    conversationId: string,
  ): Promise<void> {
    const record = await this.index.associate(pagePath, conversationId);
    const activePage = this.route.page;
    if (activePage?.path === pagePath) {
      this.publish(activePage, record);
    }
  }

  async selectConversation(conversationId: string): Promise<void> {
    const page = this.route.page;
    if (!page) {
      throw new Error('Cannot select a conversation without an active page.');
    }

    await this.selectConversationForPage(page.path, conversationId);
  }

  async selectConversationForPage(
    pagePath: string,
    conversationId: string,
  ): Promise<void> {
    const record = await this.index.setActive(pagePath, conversationId);
    const activePage = this.route.page;
    if (activePage?.path === pagePath) {
      this.publish(activePage, record);
    }
  }

  refresh(): void {
    const generation = this.routeGeneration;
    this.pageContext.refresh();
    if (generation === this.routeGeneration) {
      this.routeTo(this.pageContext.getActivePage());
    }
  }

  async migratePagePath(oldPath: string, newPath: string): Promise<void> {
    // The index updates in memory before saving, so publish the new route now.
    const migration = this.index.migratePath(oldPath, newPath);
    this.refresh();
    await migration;
  }

  private routeTo(page: ActivePage | null): void {
    const generation = ++this.routeGeneration;
    if (!page) {
      this.publish(null, null);
      return;
    }

    const record = this.index.get(page.path);
    if (generation === this.routeGeneration) {
      this.publish(page, record);
    }
  }

  private publish(page: ActivePage | null, record: PageAgentRecord | null): void {
    this.route = {
      page,
      conversationIds: record ? [...record.conversationIds] : [],
      activeConversationId: record?.activeConversationId ?? null,
    };
    for (const listener of this.listeners) {
      listener(this.getRoute());
    }
  }
}
