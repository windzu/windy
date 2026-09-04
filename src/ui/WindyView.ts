import {
  ItemView,
  Notice,
  setIcon,
  WorkspaceLeaf,
} from 'obsidian';

import type {
  AskUserAnswers,
  AskUserQuestionItem,
  ConversationMeta,
  FileAttachment,
  QueuedTurn,
} from '../core/types';
import type { PermissionModeController } from '../app/PermissionModeController';
import type {
  PageConversationRoute,
  PageConversationRouter,
} from '../page-context/PageConversationRouter';
import type { PageConversationService } from '../page-context/PageConversationService';
import type { ConversationModelService } from '../models/types';
import type { PageReferenceService } from '../page-context/PageReferenceService';
import type {
  ConversationRuntimeSnapshot,
  RuntimeCoordinator,
} from '../runtime/RuntimeCoordinator';
import { ClipboardImageStore } from '../storage/ClipboardImageStore';
import { renderConversationHistoryControl } from './ConversationHistoryControl';
import { EMPTY_STATE_ACTIONS } from './emptyStateActions';
import { renderWindyComposer } from './WindyComposer';
import { WINDY_NAV_ICON } from './icons';
import { MessageListRenderer } from './MessageListRenderer';
import {
  MessageScrollPositionStore,
} from './messageScrollPosition';
import {
  type ComposerPageReference,
  getReferencedPagePaths,
} from './pageReferenceMentions';
import { getVaultPath } from '../utils/path';
import { isActiveConversationStatus } from './composerState';

export const VIEW_TYPE_WINDY = 'windy-agent-view';

interface ComposerDraft {
  text: string;
  references: ComposerPageReference[];
  attachments: FileAttachment[];
  selectedModel?: string;
  selectedReasoningEffort?: string;
}

export class WindyView extends ItemView {
  private draftPagePath: string | null = null;
  private history: ConversationMeta[] = [];
  private composerDrafts = new Map<string, ComposerDraft>();
  private messageRenderer: MessageListRenderer | null = null;
  private messageRenderGeneration = 0;
  private transcriptElement: HTMLElement | null = null;
  private messagesElement: HTMLElement | null = null;
  private backToLatestButton: HTMLButtonElement | null = null;
  private activeScrollKey: string | null = null;
  private readonly activityExpansion = new Map<string, boolean>();
  private readonly messageScrollPositions = new MessageScrollPositionStore();
  private readonly clipboardImages: ClipboardImageStore;
  private confirmingSteer: {
    conversationId: string;
    queuedTurnId: string;
  } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly router: PageConversationRouter,
    private readonly pageConversations: PageConversationService,
    private readonly runtimeCoordinator: RuntimeCoordinator,
    private readonly conversationModels: ConversationModelService,
    private readonly pageReferences: PageReferenceService,
    private readonly permissionModes: PermissionModeController,
  ) {
    super(leaf);
    this.clipboardImages = new ClipboardImageStore(this.app.vault.adapter);
  }

  getViewType(): string {
    return VIEW_TYPE_WINDY;
  }

  getDisplayText(): string {
    return 'Windy';
  }

  getIcon(): string {
    return WINDY_NAV_ICON;
  }

  focusComposer(): void {
    this.contentEl
      .querySelector<HTMLElement>('.windy-view__input')
      ?.focus();
  }

  async onOpen(): Promise<void> {
    try {
      await this.renderRoute(this.router.getRoute());
    } catch (error) {
      this.renderRouteError(error);
    }
    this.register(this.router.onChange(route => {
      if (this.draftPagePath && this.draftPagePath !== route.page?.path) {
        this.draftPagePath = null;
      }
      void this.renderRoute(route).catch(error => {
        this.renderRouteError(error);
      });
    }));
    this.register(this.runtimeCoordinator.onChange((conversationId, snapshot) => {
      const route = this.router.getRoute();
      if (
        this.draftPagePath !== route.page?.path
        && conversationId === route.activeConversationId
      ) {
        if (snapshot.conversation) {
          const updated = this.pageConversations.summarize(snapshot.conversation);
          this.history = this.history.map(item => (
            item.id === updated.id ? updated : item
          ));
        }
        this.renderConversation(route, snapshot, this.history);
      }
    }));
  }

  private async renderRoute(route: PageConversationRoute): Promise<void> {
    const history = await this.pageConversations.getHistory(route);
    if (
      this.router.getRoute().page?.path !== route.page?.path
      || this.router.getRoute().activeConversationId !== route.activeConversationId
    ) {
      return;
    }
    this.history = history?.conversations ?? [];
    if (this.draftPagePath === route.page?.path) {
      await this.ensureComposerDraftSelection(route.page.path);
      if (!this.isCurrentRoute(route)) {
        return;
      }
      this.renderConversation(route, null, this.history);
      return;
    }
    const conversationId = route.activeConversationId;
    if (!conversationId) {
      if (route.page) {
        await this.ensureComposerDraftSelection(route.page.path);
      }
      if (!this.isCurrentRoute(route)) {
        return;
      }
      this.renderConversation(route, null, this.history);
      return;
    }
    let snapshot = await this.runtimeCoordinator.getSnapshot(conversationId);
    if (
      snapshot.conversation
      && (
        !snapshot.conversation.selectedModel
        || !snapshot.conversation.selectedReasoningEffort
      )
    ) {
      const selection = await this.conversationModels.getLegacyConversationDefaults(
        snapshot.conversation.selectedModel,
        snapshot.conversation.selectedReasoningEffort,
      );
      await this.runtimeCoordinator.materializeSelection(
        conversationId,
        selection.model,
        selection.reasoningEffort,
      );
      snapshot = await this.runtimeCoordinator.getSnapshot(conversationId);
    }
    const currentRoute = this.router.getRoute();
    if (
      currentRoute.page?.path === route.page?.path
      && currentRoute.activeConversationId === conversationId
      && this.draftPagePath !== route.page?.path
    ) {
      this.renderConversation(route, snapshot, this.history);
    }
  }

  private renderConversation(
    route: PageConversationRoute,
    snapshot: ConversationRuntimeSnapshot | null,
    history: ConversationMeta[],
  ): void {
    const page = route.page;
    const previousMessages = this.messagesElement;
    const scrollKey = page
      ? snapshot?.conversation?.id ?? `draft:${page.path}`
      : null;
    const scrollPosition = this.messageScrollPositions.prepareForRender(
      scrollKey,
      previousMessages,
    );
    this.activeScrollKey = scrollKey;
    this.disposeMessageRenderer();
    this.contentEl.addClass('windy-view');

    if (!page) {
      this.resetConversationShell();
      const header = this.contentEl.createDiv('windy-view__header');
      const topbar = header.createDiv('windy-view__conversation-bar');
      const brand = topbar.createDiv('windy-view__brand');
      const brandIcon = brand.createSpan('windy-view__brand-icon');
      setIcon(brandIcon, WINDY_NAV_ICON);
      brand.createSpan({ text: 'Windy' });
      const messages = this.contentEl.createDiv('windy-view__messages');
      const empty = messages.createDiv('windy-view__empty');
      empty.createEl('h2', { text: 'Open a page to begin' });
      empty.createEl('p', {
        text: 'Windy follows the active Markdown or Bases page.',
      });
      return;
    }

    const { transcript, messages } = this.prepareTranscript();
    const header = this.contentEl.createDiv('windy-view__header');
    this.contentEl.insertBefore(header, transcript);

    renderConversationHistoryControl(header, {
      history,
      activeConversationId: route.activeConversationId,
      isDraft: this.draftPagePath === page.path || !snapshot?.conversation,
      onStartDraft: () => {
        void this.startDraft().catch(error => {
          new Notice(error instanceof Error ? error.message : String(error));
        });
      },
      onSelect: async conversationId => {
        this.draftPagePath = null;
        await this.pageConversations.selectConversation(
          page.path,
          conversationId,
        );
      },
    });
    if (!snapshot?.conversation) {
      this.renderEmptyState(messages, page.basename);
    }
    const renderer = new MessageListRenderer(this.app, this.activityExpansion);
    this.messageRenderer = renderer;
    this.addChild(renderer);
    const renderGeneration = ++this.messageRenderGeneration;
    const renderMessages = renderer.render(
      messages,
      snapshot?.conversation?.messages ?? [],
      page.path,
      snapshot?.status ?? 'idle',
      snapshot?.conversation?.activeTurn?.startedAt,
    );
    if (snapshot?.conversation?.queuedTurns?.length) {
      this.renderQueuedTurns(messages, snapshot);
    }
    this.messageScrollPositions.trackActiveContainer(scrollKey, messages);
    this.messageScrollPositions.restoreActivePosition(
      scrollKey,
      messages,
      scrollPosition,
    );
    this.syncTranscriptFollowingState();
    void renderMessages.then(() => {
      if (renderGeneration !== this.messageRenderGeneration) {
        return;
      }
      messages.ownerDocument.defaultView?.requestAnimationFrame(() => {
        this.messageScrollPositions.restoreActivePosition(
          scrollKey,
          messages,
          this.messageScrollPositions.getPosition(scrollKey),
        );
        this.syncTranscriptFollowingState();
      });
    });

    if (snapshot?.pendingApproval) {
      this.renderApproval(snapshot);
    }

    if (snapshot?.pendingUserInput) {
      this.renderUserInput(messages, snapshot);
    }

    if (snapshot?.error) {
      this.contentEl.createDiv({
        cls: 'windy-view__error',
        text: snapshot.error,
      });
    }

    if (snapshot?.status === 'interrupted') {
      this.renderInterruptedRecovery(snapshot, page.path);
    }

    const status = snapshot?.status ?? 'idle';
    const composerDraft = this.getComposerDraft(page.path);
    const isDraft = !snapshot?.conversation;
    renderWindyComposer(this.contentEl, {
      primaryPage: page,
      text: composerDraft.text,
      references: composerDraft.references,
      attachments: composerDraft.attachments,
      vaultPath: getVaultPath(this.app),
      clipboardImages: this.clipboardImages,
      selectedModel: isDraft
        ? composerDraft.selectedModel
        : snapshot.conversation?.selectedModel,
      selectedReasoningEffort: isDraft
        ? composerDraft.selectedReasoningEffort
        : snapshot.conversation?.selectedReasoningEffort,
      status,
      permissionMode: this.permissionModes.getMode(),
      models: this.conversationModels,
      referenceService: this.pageReferences,
      onDraftChange: (text, references) => {
        composerDraft.text = text;
        composerDraft.references = references;
      },
      onAttachmentsChange: attachments => {
        composerDraft.attachments = attachments;
      },
      onModelSelect: async model => {
        if (!snapshot?.conversation) {
          const selection = await this.conversationModels
            .getSelectionForModel(model);
          composerDraft.selectedModel = selection.model;
          composerDraft.selectedReasoningEffort = selection.reasoningEffort;
          this.renderConversation(route, snapshot, history);
          return;
        }
        await this.conversationModels.select(snapshot.conversation.id, model);
      },
      onReasoningEffortSelect: async reasoningEffort => {
        const selectedModel = isDraft
          ? composerDraft.selectedModel
          : snapshot?.conversation?.selectedModel;
        if (!snapshot?.conversation) {
          if (reasoningEffort === null) {
            const selection = await this.conversationModels
              .getSelectionForModel(selectedModel ?? null);
            composerDraft.selectedReasoningEffort = selection.reasoningEffort;
          } else {
            composerDraft.selectedReasoningEffort = reasoningEffort;
          }
          this.renderConversation(route, snapshot, history);
          return;
        }
        await this.conversationModels.selectReasoningEffort(
          snapshot.conversation.id,
          selectedModel,
          reasoningEffort,
        );
      },
      onPermissionModeSelect: async mode => {
        await this.permissionModes.setMode(mode);
      },
      onSubmit: text => {
        void this.send(text);
      },
      onStop: () => {
        const conversationId = snapshot?.conversation?.id;
        if (conversationId) {
          this.runtimeCoordinator.cancel(conversationId);
        }
      },
    });
  }

  private renderEmptyState(container: HTMLElement, pageName: string): void {
    const empty = container.createDiv('windy-view__empty');
    const mark = empty.createDiv('windy-view__empty-mark');
    setIcon(mark, WINDY_NAV_ICON);
    empty.createEl('h2', { text: 'What should we work on?' });
    empty.createEl('p', {
      text: `${pageName} is already in context.`,
    });
    const actions = empty.createDiv('windy-view__starter-actions');
    for (const action of EMPTY_STATE_ACTIONS) {
      const button = actions.createEl('button', {
        cls: 'windy-view__starter-action',
        attr: { type: 'button' },
      });
      const icon = button.createSpan('windy-view__starter-icon');
      setIcon(icon, action.icon);
      button.createSpan({ text: action.label });
      button.addEventListener('click', () => {
        void this.send(action.prompt);
      });
    }
  }

  private renderQueuedTurns(
    container: HTMLElement,
    snapshot: ConversationRuntimeSnapshot,
  ): void {
    const conversationId = snapshot.conversation?.id;
    const queuedTurns = snapshot.conversation?.queuedTurns ?? [];
    if (!conversationId) {
      return;
    }

    for (const [index, queuedTurn] of queuedTurns.entries()) {
      const card = container.createDiv(
        'windy-queued-turn windy-message windy-message--user',
      );
      const header = card.createDiv('windy-queued-turn__header');
      header.createSpan({
        cls: 'windy-queued-turn__author',
        text: 'You',
      });
      header.createSpan({
        cls: 'windy-queued-turn__position',
        text: index === 0 ? 'Queued · Next' : `Queued · #${index + 1}`,
      });
      card.createDiv({
        cls: 'windy-message__content windy-message__content--plain',
        text: queuedTurn.displayContent ?? queuedTurn.content,
      });
      this.renderQueuedTurnContext(card, queuedTurn);

      const actions = card.createDiv('windy-queued-turn__actions');
      const steering = snapshot.steeringQueuedTurnIds.includes(queuedTurn.id);
      if (steering) {
        const icon = actions.createSpan('windy-queued-turn__steering-icon');
        setIcon(icon, 'loader-circle');
        actions.createSpan({ text: 'Steering current turn…' });
        continue;
      }
      if (snapshot.steeringQueuedTurnIds.length > 0) {
        actions.createSpan({ text: 'Another queued message is being steered' });
        continue;
      }
      if (
        this.confirmingSteer?.conversationId === conversationId
        && this.confirmingSteer.queuedTurnId === queuedTurn.id
      ) {
        this.renderSteerConfirmation(actions, conversationId, queuedTurn.id);
        continue;
      }
      if (!snapshot.canSteer || !isActiveConversationStatus(snapshot.status)) {
        actions.createSpan({ text: 'Runs automatically after the current turn' });
        continue;
      }

      const sendNow = actions.createEl('button', {
        cls: 'windy-queued-turn__send-now',
        text: 'Send now',
        attr: { type: 'button' },
      });
      sendNow.addEventListener('click', () => {
        this.confirmingSteer = {
          conversationId,
          queuedTurnId: queuedTurn.id,
        };
        this.renderSteerConfirmation(actions, conversationId, queuedTurn.id);
      });
      actions.createSpan({ text: 'or wait for automatic FIFO execution' });
    }
  }

  private renderQueuedTurnContext(
    card: HTMLElement,
    queuedTurn: QueuedTurn,
  ): void {
    const context = [
      ...(queuedTurn.referencedPagePaths ?? []),
      ...(queuedTurn.attachments ?? []).map(attachment => attachment.name),
    ];
    if (context.length === 0) {
      return;
    }
    card.createDiv({
      cls: 'windy-queued-turn__context',
      text: context.join(' · '),
    });
  }

  private renderSteerConfirmation(
    container: HTMLElement,
    conversationId: string,
    queuedTurnId: string,
  ): void {
    container.empty();
    container.createSpan({
      cls: 'windy-queued-turn__confirmation',
      text: 'Steer the active turn with this message now?',
    });
    const cancel = container.createEl('button', {
      text: 'Cancel',
      attr: { type: 'button' },
    });
    const confirm = container.createEl('button', {
      cls: 'mod-cta',
      text: 'Steer now',
      attr: { type: 'button' },
    });
    cancel.addEventListener('click', () => {
      this.confirmingSteer = null;
      void this.renderRoute(this.router.getRoute());
    });
    confirm.addEventListener('click', () => {
      cancel.disabled = true;
      confirm.disabled = true;
      this.confirmingSteer = null;
      void this.runtimeCoordinator
        .steerQueuedTurn(conversationId, queuedTurnId)
        .catch(error => {
          new Notice(error instanceof Error ? error.message : String(error));
        });
    });
  }

  private renderApproval(snapshot: ConversationRuntimeSnapshot): void {
    const approval = snapshot.pendingApproval;
    const conversationId = snapshot.conversation?.id;
    if (!approval || !conversationId) {
      return;
    }

    const container = this.contentEl.createDiv('windy-view__approval');
    container.createEl('strong', { text: 'Approval required' });
    container.createEl('p', { text: approval.description });
    const actions = container.createDiv('windy-view__approval-actions');
    const allow = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Allow once',
    });
    allow.addEventListener('click', () => {
      this.runtimeCoordinator.respondToApproval(conversationId, 'allow');
    });
    const deny = actions.createEl('button', { text: 'Deny' });
    deny.addEventListener('click', () => {
      this.runtimeCoordinator.respondToApproval(conversationId, 'deny');
    });
  }

  private renderInterruptedRecovery(
    snapshot: ConversationRuntimeSnapshot,
    pagePath: string,
  ): void {
    const conversationId = snapshot.conversation?.id;
    if (!conversationId) {
      return;
    }
    const container = this.contentEl.createDiv('windy-view__interrupted');
    container.createEl('strong', { text: 'Response interrupted' });
    container.createEl('p', {
      text: 'Partial output was preserved. Retry the original request or continue from here.',
    });
    const actions = container.createDiv('windy-view__interrupted-actions');
    const retry = actions.createEl('button', { text: 'Retry' });
    retry.addEventListener('click', () => {
      this.runRecoveryAction(
        () => this.runtimeCoordinator.retryInterrupted(conversationId),
      );
    });
    const continueButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Continue',
    });
    continueButton.addEventListener('click', () => {
      this.runRecoveryAction(
        () => this.runtimeCoordinator.continueInterrupted(
          conversationId,
          pagePath,
        ),
      );
    });
  }

  private renderUserInput(
    container: HTMLElement,
    snapshot: ConversationRuntimeSnapshot,
  ): void {
    const pending = snapshot.pendingUserInput;
    const conversationId = snapshot.conversation?.id;
    if (!pending || !conversationId) {
      return;
    }

    const form = container.createEl('form', {
      cls: 'windy-view__user-input',
    });
    form.createEl('strong', { text: 'Windy needs your input' });
    const readers = pending.questions.map((question, index) => (
      this.renderUserInputQuestion(form, question, index)
    ));
    const actions = form.createDiv('windy-view__user-input-actions');
    actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Continue',
      attr: { type: 'submit' },
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const answers: AskUserAnswers = {};
      for (const read of readers) {
        const answer = read();
        if (!answer || (Array.isArray(answer.value) && answer.value.length === 0)) {
          new Notice(`Answer “${answer?.label ?? 'the question'}” to continue.`);
          return;
        }
        answers[answer.key] = answer.value;
      }
      this.runtimeCoordinator.respondToUserInput(conversationId, answers);
    });
  }

  private renderUserInputQuestion(
    container: HTMLElement,
    question: AskUserQuestionItem,
    index: number,
  ): () => { key: string; label: string; value: string | string[] } | null {
    const fieldset = container.createEl('fieldset', {
      cls: 'windy-view__user-question',
    });
    fieldset.createEl('legend', {
      text: question.header || `Question ${index + 1}`,
    });
    fieldset.createEl('p', { text: question.question });
    const key = question.id || question.question;
    const inputName = `windy-question-${index}`;

    if (question.options.length === 0) {
      const input = fieldset.createEl('input', {
        cls: 'windy-view__user-text',
        attr: {
          type: question.isSecret ? 'password' : 'text',
          autocomplete: question.isSecret ? 'off' : 'on',
        },
      });
      return () => {
        const value = input.value.trim();
        return value ? { key, label: question.header, value } : null;
      };
    }

    const optionInputs: HTMLInputElement[] = [];
    for (const option of question.options) {
      const label = fieldset.createEl('label', {
        cls: 'windy-view__user-option',
      });
      const input = label.createEl('input', {
        attr: {
          type: question.multiSelect ? 'checkbox' : 'radio',
          name: inputName,
          value: option.label,
        },
      });
      optionInputs.push(input);
      const copy = label.createSpan('windy-view__user-option-copy');
      copy.createSpan({ text: option.label });
      if (option.description) {
        copy.createEl('small', { text: option.description });
      }
    }

    let otherInput: HTMLInputElement | null = null;
    let otherChoice: HTMLInputElement | null = null;
    if (question.isOther !== false) {
      const other = fieldset.createEl('label', {
        cls: 'windy-view__user-option windy-view__user-option--other',
      });
      otherChoice = other.createEl('input', {
        attr: {
          type: question.multiSelect ? 'checkbox' : 'radio',
          name: inputName,
          value: '__other__',
        },
      });
      otherInput = other.createEl('input', {
        cls: 'windy-view__user-text',
        attr: {
          type: question.isSecret ? 'password' : 'text',
          placeholder: 'Other…',
          autocomplete: question.isSecret ? 'off' : 'on',
        },
      });
      otherInput.addEventListener('focus', () => {
        if (otherChoice) {
          otherChoice.checked = true;
        }
      });
    }

    return () => {
      const selected = optionInputs
        .filter(input => input.checked)
        .map(input => input.value);
      if (otherChoice?.checked) {
        const custom = otherInput?.value.trim();
        if (custom) {
          selected.push(custom);
        }
      }
      if (selected.length === 0) {
        return null;
      }
      return {
        key,
        label: question.header,
        value: question.multiSelect ? selected : selected[0],
      };
    };
  }

  private runRecoveryAction(action: () => Promise<void>): void {
    void action().catch(error => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }

  private async startDraft(): Promise<void> {
    const route = this.router.getRoute();
    if (!route.page) {
      return;
    }
    const selection = await this.conversationModels.getNewConversationDefaults();
    if (this.router.getRoute().page?.path !== route.page.path) {
      return;
    }
    this.draftPagePath = route.page.path;
    this.composerDrafts.set(route.page.path, {
      text: '',
      references: [],
      attachments: [],
      selectedModel: selection.model,
      selectedReasoningEffort: selection.reasoningEffort,
    });
    this.renderConversation(route, null, this.history);
  }

  private async send(rawText: string): Promise<void> {
    const route = this.router.getRoute();
    const text = rawText.trim();
    if (!route.page) {
      return;
    }
    const pagePath = route.page.path;
    const composerDraft = this.getComposerDraft(pagePath);
    if (!text && composerDraft.attachments.length === 0) {
      return;
    }
    const referencedPagePaths = getReferencedPagePaths(
      composerDraft.references,
    );
    try {
      const conversationId = this.draftPagePath === pagePath
        || !route.activeConversationId
        ? await this.pageConversations.ensureConversationForPage(
          pagePath,
          composerDraft.selectedModel,
          composerDraft.selectedReasoningEffort,
        )
        : route.activeConversationId;
      if (this.draftPagePath === pagePath) {
        this.draftPagePath = null;
      }
      this.composerDrafts.delete(pagePath);
      await this.runtimeCoordinator.send(
        conversationId,
        text,
        pagePath,
        referencedPagePaths,
        composerDraft.attachments,
      );
    } catch (error) {
      if (!this.composerDrafts.has(pagePath)) {
        this.composerDrafts.set(pagePath, composerDraft);
      }
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private getComposerDraft(pagePath: string): ComposerDraft {
    let draft = this.composerDrafts.get(pagePath);
    if (!draft) {
      draft = { text: '', references: [], attachments: [] };
      this.composerDrafts.set(pagePath, draft);
    }
    return draft;
  }

  private async ensureComposerDraftSelection(pagePath: string): Promise<void> {
    const draft = this.getComposerDraft(pagePath);
    if (draft.selectedModel && draft.selectedReasoningEffort) {
      return;
    }
    const selection = await this.conversationModels.getNewConversationDefaults();
    if (this.composerDrafts.get(pagePath) !== draft) {
      return;
    }
    draft.selectedModel = selection.model;
    draft.selectedReasoningEffort = selection.reasoningEffort;
  }

  private isCurrentRoute(route: PageConversationRoute): boolean {
    const current = this.router.getRoute();
    return current.page?.path === route.page?.path
      && current.activeConversationId === route.activeConversationId;
  }

  private renderRouteError(error: unknown): void {
    this.disposeMessageRenderer();
    this.resetConversationShell();
    this.contentEl.addClass('windy-view');
    this.contentEl.createDiv({
      cls: 'windy-view__error',
      text: `Could not load Windy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  private disposeMessageRenderer(): void {
    if (!this.messageRenderer) {
      return;
    }
    this.removeChild(this.messageRenderer);
    this.messageRenderer = null;
  }

  private prepareTranscript(): {
    transcript: HTMLElement;
    messages: HTMLElement;
  } {
    if (
      !this.transcriptElement
      || !this.messagesElement
      || !this.backToLatestButton
      || this.transcriptElement.parentElement !== this.contentEl
    ) {
      this.contentEl.empty();
      const transcript = this.contentEl.createDiv('windy-view__transcript');
      const messages = transcript.createDiv('windy-view__messages');
      const backToLatest = transcript.createEl('button', {
        cls: 'windy-view__back-to-latest',
        attr: {
          type: 'button',
          'aria-label': 'Back to latest',
          title: 'Back to latest',
        },
      });
      const icon = backToLatest.createSpan(
        'windy-view__back-to-latest-icon',
      );
      setIcon(icon, 'arrow-down');
      backToLatest.createSpan({ text: 'Back to latest' });
      messages.addEventListener('wheel', event => {
        if (event.deltaY >= 0) {
          return;
        }
        this.messageScrollPositions.pauseActiveFollowing(
          this.activeScrollKey,
          messages,
        );
        this.syncTranscriptFollowingState();
      }, { passive: true });
      messages.addEventListener('scroll', () => {
        this.messageScrollPositions.recordActiveScroll(
          this.activeScrollKey,
          messages,
        );
        this.syncTranscriptFollowingState();
      });
      backToLatest.addEventListener('click', () => {
        this.messageScrollPositions.resumeActiveFollowing(
          this.activeScrollKey,
          messages,
        );
        this.syncTranscriptFollowingState();
      });
      this.transcriptElement = transcript;
      this.messagesElement = messages;
      this.backToLatestButton = backToLatest;
    }

    for (const child of Array.from(this.contentEl.children)) {
      if (child !== this.transcriptElement) {
        child.remove();
      }
    }
    this.messagesElement.empty();
    return {
      transcript: this.transcriptElement,
      messages: this.messagesElement,
    };
  }

  private syncTranscriptFollowingState(): void {
    if (!this.transcriptElement || !this.backToLatestButton) {
      return;
    }
    const isBrowsing = !this.messageScrollPositions.isFollowing(
      this.activeScrollKey,
    );
    this.transcriptElement.classList.toggle('is-browsing', isBrowsing);
    this.backToLatestButton.hidden = !isBrowsing;
  }

  private resetConversationShell(): void {
    this.contentEl.empty();
    this.transcriptElement = null;
    this.messagesElement = null;
    this.backToLatestButton = null;
    this.activeScrollKey = null;
  }

}
