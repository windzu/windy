import { addIcon, Plugin } from 'obsidian';

import {
  mergeWindySettings,
} from './app/settings';
import { PermissionModeController } from './app/PermissionModeController';
import { WindyProviderHost } from './app/WindyProviderHost';
import type { WindySettings } from './core/types';
import { ConversationRepository } from './conversations/ConversationRepository';
import {
  PageAgentIndex,
  type PageAgentIndexDocument,
} from './page-context/PageAgentIndex';
import { PageContextResolver } from './page-context/PageContextResolver';
import { PageConversationRouter } from './page-context/PageConversationRouter';
import { PageConversationService } from './page-context/PageConversationService';
import { PageReferenceService } from './page-context/PageReferenceService';
import type { ConversationModelService } from './models/types';
import { CodexConversationModelService } from './providers/codex/CodexConversationModelService';
import { CodexAppServerGateway } from './providers/codex/runtime/CodexAppServerGateway';
import { CodexChatRuntime } from './providers/codex/runtime/CodexChatRuntime';
import { resolveCodexAppServerLaunchSpec } from './providers/codex/runtime/codexAppServerSupport';
import { RuntimeCoordinator } from './runtime/RuntimeCoordinator';
import { JsonFileStore } from './storage/JsonFileStore';
import {
  shouldShowFloatingAgentButton,
} from './ui/AgentEntryVisibility';
import { FloatingAgentButton } from './ui/FloatingAgentButton';
import { WINDY_ICON_SVG, WINDY_NAV_ICON } from './ui/icons';
import { WindyView, VIEW_TYPE_WINDY } from './ui/WindyView';
import { WindySettingTab } from './ui/WindySettingTab';

export default class WindyPlugin extends Plugin {
  private floatingButton: FloatingAgentButton | null = null;
  private pageContext: PageContextResolver | null = null;
  private pageIndex: PageAgentIndex | null = null;
  private router: PageConversationRouter | null = null;
  private pageConversations: PageConversationService | null = null;
  private conversationModels: ConversationModelService | null = null;
  private pageReferences: PageReferenceService | null = null;
  private conversations: ConversationRepository | null = null;
  private runtimeCoordinator: RuntimeCoordinator | null = null;
  private codexGateway: CodexAppServerGateway | null = null;
  private windySettings: WindySettings | null = null;
  private permissionModes: PermissionModeController | null = null;

  async onload(): Promise<void> {
    addIcon(WINDY_NAV_ICON, WINDY_ICON_SVG);
    this.windySettings = mergeWindySettings(await this.loadData());
    this.permissionModes = new PermissionModeController(
      this.windySettings,
      settings => this.saveData(settings),
    );
    this.conversations = new ConversationRepository(this.app.vault.adapter);
    const providerHost = new WindyProviderHost(
      this.app,
      this.windySettings,
      this.manifest,
    );
    this.codexGateway = new CodexAppServerGateway(providerHost);
    this.runtimeCoordinator = new RuntimeCoordinator(
      providerHost,
      this.conversations,
      host => new CodexChatRuntime(host, this.requireCodexGateway()),
    );

    const pageIndexStore = new JsonFileStore<PageAgentIndexDocument>(
      this.app.vault.adapter,
      '.windy/page-agent-index.json',
    );
    this.pageIndex = new PageAgentIndex(pageIndexStore);
    await this.pageIndex.initialize();
    await this.pageIndex.reconcileConversationReferences(
      conversationId => this.requireConversations().exists(conversationId),
    );

    this.pageContext = new PageContextResolver(this.app);
    this.router = new PageConversationRouter(this.pageContext, this.pageIndex);
    this.pageConversations = new PageConversationService(
      this.router,
      this.conversations,
    );
    this.conversationModels = new CodexConversationModelService(
      this.codexGateway,
      this.runtimeCoordinator,
      this.windySettings,
    );
    this.addSettingTab(new WindySettingTab(
      this.app,
      this,
      this.windySettings,
      this.conversationModels,
      settings => this.saveData(settings),
      async () => {
        const spec = await resolveCodexAppServerLaunchSpec(providerHost);
        return spec.target.method === 'wsl'
          ? [spec.command, ...spec.args].join(' ')
          : spec.command;
      },
    ));
    this.pageReferences = new PageReferenceService(() => (
      this.app.vault.getFiles().map(file => ({
        path: file.path,
        basename: file.basename,
        extension: file.extension,
      }))
    ));

    this.registerView(
      VIEW_TYPE_WINDY,
      leaf => new WindyView(
        leaf,
        this.requireRouter(),
        this.requirePageConversations(),
        this.requireRuntimeCoordinator(),
        this.requireConversationModels(),
        this.requirePageReferences(),
        this.requirePermissionModes(),
      ),
    );

    this.pageContext.start();
    this.router.start();
    this.register(() => this.pageContext?.stop());
    this.register(() => this.router?.stop());
    this.register(() => {
      this.runtimeCoordinator?.cleanup();
      void this.codexGateway?.cleanup();
    });
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (!this.pageIndex || !this.router) {
          return;
        }
        void this.pageIndex.migratePath(oldPath, file.path).then(() => {
          this.router?.refresh();
        });
      }),
    );

    this.floatingButton = new FloatingAgentButton(this.app, () => {
      void this.openAgent();
    });
    const updateFloatingVisibility = (): void => {
      const surfaces = this.app.workspace
        .getLeavesOfType(VIEW_TYPE_WINDY)
        .map(leaf => {
          const sidedock = leaf.view.containerEl.closest<HTMLElement>(
            '.workspace-split.mod-left-split, .workspace-split.mod-right-split',
          );
          return {
            containerShown: leaf.view.containerEl.isShown(),
            sidedockCollapsed: sidedock?.hasClass('is-sidedock-collapsed') ?? false,
          };
        });
      this.floatingButton?.setVisible(
        shouldShowFloatingAgentButton(surfaces),
      );
    };
    const updateFloatingActivity = (): void => {
      const activeConversationId = this.router?.getRoute().activeConversationId ?? null;
      const activity = this.runtimeCoordinator?.getActivitySummary(
        activeConversationId,
      );
      if (activity) {
        this.floatingButton?.setActivity(activity);
      }
    };
    this.register(this.router.onChange(updateFloatingActivity));
    this.register(this.runtimeCoordinator.onChange(updateFloatingActivity));
    updateFloatingActivity();

    let observedSidedock: HTMLElement | null = null;
    const sidedockObserver = new MutationObserver(updateFloatingVisibility);
    const observeRightSidedock = (): void => {
      const rightSidedock = this.app.workspace.containerEl
        .querySelector<HTMLElement>('.workspace-split.mod-right-split');
      if (rightSidedock === observedSidedock) {
        return;
      }
      sidedockObserver.disconnect();
      observedSidedock = rightSidedock;
      if (rightSidedock) {
        sidedockObserver.observe(rightSidedock, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }
    };
    const refreshFloatingEntry = (): void => {
      this.floatingButton?.mount();
      observeRightSidedock();
      updateFloatingVisibility();
    };
    this.app.workspace.onLayoutReady(() => {
      refreshFloatingEntry();
    });
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        refreshFloatingEntry();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        refreshFloatingEntry();
      }),
    );
    this.register(() => sidedockObserver.disconnect());
    this.register(() => this.floatingButton?.unmount());

    this.addRibbonIcon(
      WINDY_NAV_ICON,
      'Open Windy for the current page',
      () => {
        void this.openAgent();
      },
    );
    this.addCommand({
      id: 'open-page-agent',
      name: 'Open agent for current page',
      callback: () => {
        void this.openAgent();
      },
    });
  }

  private async openAgent(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WINDY)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_WINDY,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
    this.floatingButton?.setVisible(false);
    if (leaf.view instanceof WindyView) {
      leaf.view.focusComposer();
    }
  }

  private requireRouter(): PageConversationRouter {
    if (!this.router) {
      throw new Error('Windy page conversation router is not initialized.');
    }
    return this.router;
  }

  private requireConversations(): ConversationRepository {
    if (!this.conversations) {
      throw new Error('Windy conversation repository is not initialized.');
    }
    return this.conversations;
  }

  private requireRuntimeCoordinator(): RuntimeCoordinator {
    if (!this.runtimeCoordinator) {
      throw new Error('Windy runtime coordinator is not initialized.');
    }
    return this.runtimeCoordinator;
  }

  private requirePageConversations(): PageConversationService {
    if (!this.pageConversations) {
      throw new Error('Page conversation service is not initialized.');
    }
    return this.pageConversations;
  }

  private requireConversationModels(): ConversationModelService {
    if (!this.conversationModels) {
      throw new Error('Conversation model service is not initialized.');
    }
    return this.conversationModels;
  }

  private requirePageReferences(): PageReferenceService {
    if (!this.pageReferences) {
      throw new Error('Page reference service is not initialized.');
    }
    return this.pageReferences;
  }

  private requireCodexGateway(): CodexAppServerGateway {
    if (!this.codexGateway) {
      throw new Error('Windy Codex gateway is not initialized.');
    }
    return this.codexGateway;
  }

  private requirePermissionModes(): PermissionModeController {
    if (!this.permissionModes) {
      throw new Error('Permission mode controller is not initialized.');
    }
    return this.permissionModes;
  }
}
