import { randomUUID } from 'node:crypto';

import type { ChatRuntime } from '../core/runtime/ChatRuntime';
import type {
  ApprovalDecision,
  AskUserAnswers,
  AskUserQuestionItem,
  ChatMessage,
  Conversation,
  FileAttachment,
  StreamChunk,
} from '../core/types';
import type { ConversationStore } from '../conversations/ConversationRepository';
import { deriveConversationTitle } from '../conversations/conversationTitle';
import { TurnCheckpointManager } from './TurnCheckpointManager';
import { TurnUpdateScheduler } from './TurnUpdateScheduler';
import type {
  ConversationRuntimeSnapshot,
  ConversationTaskStatus,
  PendingApproval,
  PendingUserInput,
} from './types';

export class ConversationTaskController {
  private conversation: Conversation | null;
  private taskStatus: ConversationTaskStatus;
  private error: string | null = null;
  private pendingApproval: PendingApproval | null = null;
  private resolveApproval: ((decision: ApprovalDecision) => void) | null = null;
  private pendingUserInput: PendingUserInput | null = null;
  private resolveUserInput: ((answers: AskUserAnswers | null) => void) | null = null;
  private removeUserInputAbortListener: (() => void) | null = null;
  private shuttingDown = false;
  private readonly checkpoints: TurnCheckpointManager;
  private readonly updates: TurnUpdateScheduler;

  private constructor(
    private readonly conversations: ConversationStore,
    private readonly runtime: ChatRuntime,
    private readonly conversationId: string,
    conversation: Conversation | null,
    status: ConversationTaskStatus,
    private readonly now: () => number,
    progressPersistIntervalMs: number,
    private readonly onChange: (snapshot: ConversationRuntimeSnapshot) => void,
  ) {
    this.conversation = conversation;
    this.taskStatus = status;
    this.checkpoints = new TurnCheckpointManager(
      conversations,
      runtime,
      now,
      progressPersistIntervalMs,
    );
    this.updates = new TurnUpdateScheduler(() => this.publishSnapshot());
    this.configureRuntimeCallbacks();
  }

  static async create(options: {
    conversations: ConversationStore;
    createRuntime: () => ChatRuntime;
    conversationId: string;
    now: () => number;
    progressPersistIntervalMs: number;
    onChange: (snapshot: ConversationRuntimeSnapshot) => void;
  }): Promise<ConversationTaskController> {
    const conversation = await options.conversations.load(options.conversationId);
    const runtime = options.createRuntime();
    try {
      const controller = new ConversationTaskController(
        options.conversations,
        runtime,
        options.conversationId,
        conversation,
        'idle',
        options.now,
        options.progressPersistIntervalMs,
        options.onChange,
      );
      if (
        conversation
        && await controller.checkpoints.recoverInterrupted(conversation)
      ) {
        controller.taskStatus = 'interrupted';
      }
      return controller;
    } catch (error) {
      runtime.cleanup();
      throw error;
    }
  }

  get status(): ConversationTaskStatus {
    return this.taskStatus;
  }

  snapshot(): ConversationRuntimeSnapshot {
    return {
      conversation: this.conversation
        ? structuredClone(this.conversation)
        : null,
      status: this.taskStatus,
      error: this.error,
      pendingApproval: this.pendingApproval
        ? structuredClone(this.pendingApproval)
        : null,
      pendingUserInput: this.pendingUserInput
        ? structuredClone(this.pendingUserInput)
        : null,
    };
  }

  async send(
    text: string,
    primaryPagePath: string,
    displayContent?: string,
    referencedPagePaths: string[] = [],
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    if (
      this.taskStatus === 'running'
      || this.taskStatus === 'waiting-approval'
      || this.taskStatus === 'waiting-input'
    ) {
      throw new Error('This conversation already has a running turn.');
    }
    if (!this.conversation) {
      throw new Error(`Conversation "${this.conversationId}" does not exist.`);
    }

    const conversation = this.conversation;
    const startedAt = this.now();
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: text,
      ...(displayContent ? { displayContent } : {}),
      timestamp: startedAt,
      primaryPagePath,
      ...(referencedPagePaths.length > 0
        ? { referencedPagePaths: [...new Set(referencedPagePaths)] }
        : {}),
      ...(attachments.length > 0
        ? { attachments: structuredClone(attachments) }
        : {}),
    };
    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: startedAt,
      contentBlocks: [],
      toolCalls: [],
    };
    if (conversation.title === 'New conversation') {
      conversation.title = deriveConversationTitle(text || attachments[0]?.name || '');
    }
    conversation.messages.push(userMessage, assistantMessage);
    conversation.activeTurn = {
      status: 'running',
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      primaryPagePath,
      startedAt,
      updatedAt: startedAt,
    };
    this.taskStatus = 'running';
    this.error = null;
    this.pendingApproval = null;
    this.pendingUserInput = null;
    this.checkpoints.resetProgressClock();
    await this.conversations.save(conversation);
    this.runtime.syncConversationState(conversation);
    this.emit();

    const turn = this.runtime.prepareTurn({
      text,
      primaryPagePath,
      referencedPagePaths,
      attachments,
    });
    try {
      for await (const chunk of this.runtime.query(
        turn,
        conversation.messages.slice(0, -2),
        {
          model: conversation.selectedModel,
          reasoningEffort: conversation.selectedReasoningEffort,
        },
      )) {
        if (this.shuttingDown) {
          break;
        }
        this.applyChunk(assistantMessage, conversation, chunk);
        if (chunk.type === 'error') {
          this.taskStatus = 'failed';
          this.error = chunk.content;
        }
        this.checkpoints.persistProgressIfDue(conversation);
        this.emitProgress();
      }

      if (this.shuttingDown) {
        return;
      }
      const sessionUpdates = this.runtime.buildSessionUpdates({
        conversation,
        sessionInvalidated: this.runtime.consumeSessionInvalidation(),
      });
      Object.assign(conversation, sessionUpdates.updates);
      const completedAt = this.now();
      conversation.lastResponseAt = completedAt;
      if (!this.isCancelled()) {
        this.taskStatus = this.taskStatus === 'failed' ? 'failed' : 'completed';
        this.completeAssistantTurn(
          assistantMessage,
          startedAt,
          completedAt,
          this.taskStatus,
        );
      }
      delete conversation.activeTurn;
      await this.conversations.save(conversation);
      this.emit();
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      if (!this.isCancelled()) {
        this.taskStatus = 'failed';
        this.error = error instanceof Error ? error.message : String(error);
        if (!assistantMessage.content) {
          assistantMessage.content = this.error;
        }
        const failedAt = this.now();
        conversation.lastResponseAt = failedAt;
        this.completeAssistantTurn(
          assistantMessage,
          startedAt,
          failedAt,
          'failed',
        );
      }
      this.checkpoints.captureSessionState(conversation);
      delete conversation.activeTurn;
      await this.conversations.save(conversation);
    } finally {
      if (!this.shuttingDown) {
        await this.syncSessionTitle(conversation.title);
      }
      this.pendingApproval = null;
      this.resolveApproval = null;
      this.clearPendingUserInput();
      this.emit();
    }
  }

  private async syncSessionTitle(title: string): Promise<void> {
    if (!this.runtime.setSessionTitle || title === 'New conversation') {
      return;
    }
    try {
      await this.runtime.setSessionTitle(title);
    } catch {
      // Provider metadata must never turn a completed response into a failed turn.
    }
  }

  async retryInterrupted(): Promise<void> {
    const state = this.requireInterruptedTurn();
    const userMessage = this.conversation!.messages.find(
      message => message.id === state.userMessageId && message.role === 'user',
    );
    if (!userMessage) {
      throw new Error('The interrupted request is no longer available.');
    }
    await this.send(
      userMessage.content,
      userMessage.primaryPagePath ?? state.primaryPagePath,
      userMessage.displayContent,
      userMessage.referencedPagePaths,
      userMessage.attachments,
    );
  }

  async continueInterrupted(primaryPagePath: string): Promise<void> {
    this.requireInterruptedTurn();
    await this.send(
      'Continue from where the previous response was interrupted. '
        + 'Do not repeat work that is already complete.',
      primaryPagePath,
      'Continue',
    );
  }

  respondToApproval(decision: ApprovalDecision): void {
    if (!this.resolveApproval) {
      return;
    }
    const resolve = this.resolveApproval;
    this.resolveApproval = null;
    this.pendingApproval = null;
    this.taskStatus = 'running';
    if (this.conversation) {
      this.checkpoints.updateActiveStatus(this.conversation, 'running');
    }
    this.emit();
    resolve(decision);
  }

  respondToUserInput(answers: AskUserAnswers): void {
    if (!this.resolveUserInput) {
      return;
    }
    const resolve = this.resolveUserInput;
    this.clearPendingUserInput();
    this.taskStatus = 'running';
    if (this.conversation) {
      this.checkpoints.updateActiveStatus(this.conversation, 'running');
    }
    this.emit();
    resolve(answers);
  }

  async setModel(model: string | undefined): Promise<void> {
    if (
      this.taskStatus === 'running'
      || this.taskStatus === 'waiting-approval'
      || this.taskStatus === 'waiting-input'
    ) {
      throw new Error('Cannot change the model while a turn is running.');
    }
    if (!this.conversation) {
      throw new Error(`Conversation "${this.conversationId}" does not exist.`);
    }
    const modelChanged = this.conversation.selectedModel !== model;
    if (model) {
      this.conversation.selectedModel = model;
    } else {
      delete this.conversation.selectedModel;
    }
    if (modelChanged) {
      delete this.conversation.selectedReasoningEffort;
    }
    await this.conversations.save(this.conversation);
    this.runtime.syncConversationState(this.conversation);
    this.emit();
  }

  async setSelection(model: string, reasoningEffort: string): Promise<void> {
    this.assertSelectionCanChange();
    this.conversation!.selectedModel = model;
    this.conversation!.selectedReasoningEffort = reasoningEffort;
    await this.persistSelection();
  }

  async materializeSelection(
    model: string,
    reasoningEffort: string,
  ): Promise<void> {
    this.assertSelectionCanChange();
    let changed = false;
    if (!this.conversation!.selectedModel) {
      this.conversation!.selectedModel = model;
      changed = true;
    }
    if (!this.conversation!.selectedReasoningEffort) {
      this.conversation!.selectedReasoningEffort = reasoningEffort;
      changed = true;
    }
    if (changed) {
      await this.persistSelection();
    }
  }

  async setReasoningEffort(reasoningEffort: string): Promise<void> {
    this.assertSelectionCanChange();
    this.conversation!.selectedReasoningEffort = reasoningEffort;
    await this.persistSelection();
  }

  private assertSelectionCanChange(): void {
    if (
      this.taskStatus === 'running'
      || this.taskStatus === 'waiting-approval'
      || this.taskStatus === 'waiting-input'
    ) {
      throw new Error('Cannot change reasoning effort while a turn is running.');
    }
    if (!this.conversation) {
      throw new Error(`Conversation "${this.conversationId}" does not exist.`);
    }
  }

  private async persistSelection(): Promise<void> {
    const conversation = this.conversation;
    if (!conversation) {
      throw new Error(`Conversation "${this.conversationId}" does not exist.`);
    }
    await this.conversations.save(conversation);
    this.runtime.syncConversationState(conversation);
    this.emit();
  }

  cancel(): void {
    this.resolveApproval?.('cancel');
    this.resolveApproval = null;
    this.pendingApproval = null;
    this.resolveUserInput?.(null);
    this.clearPendingUserInput();
    this.runtime.cancel();
    this.taskStatus = 'cancelled';
    if (this.conversation) {
      const activeTurn = this.conversation.activeTurn;
      if (activeTurn) {
        const assistantMessage = this.conversation.messages.find(
          message => message.id === activeTurn.assistantMessageId
            && message.role === 'assistant',
        );
        const cancelledAt = this.now();
        if (assistantMessage) {
          this.completeAssistantTurn(
            assistantMessage,
            activeTurn.startedAt,
            cancelledAt,
            'cancelled',
          );
        }
        this.conversation.lastResponseAt = cancelledAt;
      }
      this.checkpoints.captureSessionState(this.conversation);
      delete this.conversation.activeTurn;
      this.checkpoints.persistWithoutBlocking(this.conversation);
    }
    this.emit();
  }

  cleanup(): void {
    this.shuttingDown = true;
    this.updates.cancel();
    this.resolveApproval?.('cancel');
    this.resolveUserInput?.(null);
    this.clearPendingUserInput();
    if (this.conversation) {
      this.checkpoints.interruptAndPersist(this.conversation);
    }
    this.runtime.cleanup();
  }

  private requireInterruptedTurn(): NonNullable<Conversation['activeTurn']> {
    if (
      this.taskStatus !== 'interrupted'
      || !this.conversation?.activeTurn
      || this.conversation.activeTurn.status !== 'interrupted'
    ) {
      throw new Error('This conversation does not have an interrupted turn.');
    }
    return this.conversation.activeTurn;
  }

  private configureRuntimeCallbacks(): void {
    this.runtime.setApprovalCallback((toolName, input, description, options) => {
      return new Promise<ApprovalDecision>(resolve => {
        this.pendingApproval = { toolName, input, description, options };
        this.resolveApproval = resolve;
        this.taskStatus = 'waiting-approval';
        if (this.conversation) {
          this.checkpoints.updateActiveStatus(
            this.conversation,
            'waiting-approval',
          );
        }
        this.emit();
      });
    });
    this.runtime.setAskUserQuestionCallback((input, signal) => {
      const questions = normalizeUserInputQuestions(input);
      if (questions.length === 0 || signal?.aborted) {
        return Promise.resolve(null);
      }
      return new Promise<AskUserAnswers | null>(resolve => {
        this.pendingUserInput = { questions };
        this.resolveUserInput = resolve;
        this.taskStatus = 'waiting-input';
        if (this.conversation) {
          this.checkpoints.updateActiveStatus(
            this.conversation,
            'waiting-input',
          );
        }
        if (signal) {
          const abort = (): void => {
            const pendingResolve = this.resolveUserInput;
            this.clearPendingUserInput();
            if (!this.shuttingDown && this.taskStatus === 'waiting-input') {
              this.taskStatus = 'running';
              if (this.conversation) {
                this.checkpoints.updateActiveStatus(this.conversation, 'running');
              }
            }
            pendingResolve?.(null);
            this.emit();
          };
          signal.addEventListener('abort', abort, { once: true });
          this.removeUserInputAbortListener = () => {
            signal.removeEventListener('abort', abort);
          };
        }
        this.emit();
      });
    });
  }

  private applyChunk(
    assistantMessage: ChatMessage,
    conversation: Conversation,
    chunk: StreamChunk,
  ): void {
    if (chunk.type === 'text') {
      if (chunk.phase !== 'commentary') {
        assistantMessage.content += chunk.content;
      }
      this.appendContentBlock(
        assistantMessage,
        'text',
        chunk.content,
        chunk.phase,
        chunk.itemId,
      );
      return;
    }
    if (chunk.type === 'thinking') {
      this.appendContentBlock(assistantMessage, 'thinking', chunk.content);
      return;
    }
    if (chunk.type === 'tool_use') {
      const existing = assistantMessage.toolCalls?.find(call => call.id === chunk.id);
      if (existing) {
        existing.name = chunk.name;
        existing.input = chunk.input;
        if (chunk.providerPayload) {
          existing.providerPayload = chunk.providerPayload;
        }
      } else {
        assistantMessage.toolCalls?.push({
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
          status: 'running',
          providerPayload: chunk.providerPayload,
        });
      }
      if (
        !assistantMessage.contentBlocks?.some(
          block => block.type === 'tool_use' && block.toolId === chunk.id,
        )
      ) {
        assistantMessage.contentBlocks?.push({ type: 'tool_use', toolId: chunk.id });
      }
      return;
    }
    if (chunk.type === 'tool_output') {
      const toolCall = assistantMessage.toolCalls?.find(call => call.id === chunk.id);
      if (toolCall) {
        toolCall.result = `${toolCall.result ?? ''}${chunk.content}`;
      }
      return;
    }
    if (chunk.type === 'tool_result') {
      const toolCall = assistantMessage.toolCalls?.find(call => call.id === chunk.id);
      if (toolCall) {
        toolCall.result = chunk.content;
        toolCall.status = chunk.isError ? 'error' : 'completed';
      }
      return;
    }
    if (chunk.type === 'usage') {
      conversation.usage = chunk.usage;
      if (chunk.sessionId) {
        conversation.sessionId = chunk.sessionId;
      }
      return;
    }
    if (chunk.type === 'context_compacted') {
      assistantMessage.contentBlocks?.push({ type: 'context_compacted' });
      return;
    }
    if (chunk.type === 'error') {
      assistantMessage.content += assistantMessage.content
        ? `\n\n${chunk.content}`
        : chunk.content;
    }
  }

  private emit(): void {
    this.updates.flush();
  }

  private emitProgress(): void {
    this.updates.schedule();
  }

  private publishSnapshot(): void {
    this.onChange(this.snapshot());
  }

  private appendContentBlock(
    assistantMessage: ChatMessage,
    type: 'text' | 'thinking',
    content: string,
    phase?: Extract<StreamChunk, { type: 'text' }>['phase'],
    itemId?: string,
  ): void {
    const blocks = assistantMessage.contentBlocks ??= [];
    const previous = blocks.at(-1);
    if (
      previous?.type === type
      && (
        type !== 'text'
        || (
          previous.type === 'text'
          && previous.phase === phase
          && previous.itemId === itemId
        )
      )
    ) {
      previous.content += content;
      return;
    }
    if (type === 'text') {
      blocks.push({
        type,
        content,
        ...(phase ? { phase } : {}),
        ...(itemId ? { itemId } : {}),
      });
      return;
    }
    blocks.push({ type, content });
  }

  private isCancelled(): boolean {
    return this.taskStatus === 'cancelled';
  }

  private completeAssistantTurn(
    assistantMessage: ChatMessage,
    startedAt: number,
    completedAt: number,
    status: NonNullable<ChatMessage['turnStatus']>,
  ): void {
    assistantMessage.turnStatus = status;
    assistantMessage.durationSeconds ??= Math.max(
      0,
      Math.round((completedAt - startedAt) / 1000),
    );
    for (const toolCall of assistantMessage.toolCalls ?? []) {
      if (toolCall.status !== 'running') {
        continue;
      }
      toolCall.status = status === 'failed'
        ? 'error'
        : status === 'completed'
          ? 'completed'
          : 'blocked';
    }
  }

  private clearPendingUserInput(): void {
    this.removeUserInputAbortListener?.();
    this.removeUserInputAbortListener = null;
    this.pendingUserInput = null;
    this.resolveUserInput = null;
  }
}

function normalizeUserInputQuestions(
  input: Record<string, unknown>,
): AskUserQuestionItem[] {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const question = entry as Record<string, unknown>;
    const text = typeof question.question === 'string'
      ? question.question.trim()
      : '';
    if (!text) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap(option => {
          if (!option || typeof option !== 'object' || Array.isArray(option)) {
            return [];
          }
          const item = option as Record<string, unknown>;
          const label = typeof item.label === 'string' ? item.label.trim() : '';
          if (!label) {
            return [];
          }
          return [{
            label,
            description: typeof item.description === 'string'
              ? item.description
              : '',
          }];
        })
      : [];
    return [{
      question: text,
      id: typeof question.id === 'string' && question.id.trim()
        ? question.id
        : undefined,
      header: typeof question.header === 'string' && question.header.trim()
        ? question.header
        : `Q${index + 1}`,
      options,
      multiSelect: Boolean(question.multiSelect ?? question.multi_select),
      isOther: question.isOther !== false,
      isSecret: question.isSecret === true,
    }];
  });
}
