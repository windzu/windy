import type { ProviderHost } from '../core/providers/ProviderHost';
import type { ChatRuntime } from '../core/runtime/ChatRuntime';
import type { ApprovalDecision, AskUserAnswers, FileAttachment } from '../core/types';
import type { ConversationStore } from '../conversations/ConversationRepository';
import { ConversationTaskController } from './ConversationTaskController';
import type {
  ConversationRuntimeSnapshot,
  RuntimeActivitySummary,
} from './types';

export type {
  ConversationRuntimeSnapshot,
  ConversationTaskStatus,
  PendingApproval,
  RuntimeActivityStatus,
  RuntimeActivitySummary,
} from './types';

type RuntimeListener = (
  conversationId: string,
  snapshot: ConversationRuntimeSnapshot,
) => void;

export class RuntimeCoordinator {
  private tasks = new Map<string, ConversationTaskController>();
  private pendingTasks = new Map<string, Promise<ConversationTaskController>>();
  private listeners = new Set<RuntimeListener>();
  private shuttingDown = false;

  constructor(
    private readonly host: ProviderHost,
    private readonly conversations: ConversationStore,
    private readonly createRuntime: (host: ProviderHost) => ChatRuntime,
    private readonly now: () => number = Date.now,
    private readonly progressPersistIntervalMs = 1_000,
  ) {}

  onChange(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSnapshot(conversationId: string): Promise<ConversationRuntimeSnapshot> {
    return (await this.ensureTask(conversationId)).snapshot();
  }

  getActivitySummary(activeConversationId: string | null): RuntimeActivitySummary {
    const statuses = Array.from(this.tasks.values(), task => task.status);
    const runningCount = statuses.filter(
      status => (
        status === 'running'
        || status === 'waiting-approval'
        || status === 'waiting-input'
      ),
    ).length;
    const waitingApprovalCount = statuses.filter(
      status => status === 'waiting-approval',
    ).length;
    const waitingInputCount = statuses.filter(
      status => status === 'waiting-input',
    ).length;
    const failedCount = statuses.filter(status => status === 'failed').length;
    const interruptedCount = statuses.filter(
      status => status === 'interrupted',
    ).length;
    const activeStatus = activeConversationId
      ? this.tasks.get(activeConversationId)?.status
      : undefined;

    if (waitingApprovalCount > 0) {
      return this.activity(
        'waiting-approval', waitingApprovalCount + waitingInputCount, runningCount,
        waitingApprovalCount, waitingInputCount, failedCount, interruptedCount,
      );
    }
    if (waitingInputCount > 0) {
      return this.activity(
        'waiting-input', waitingInputCount, runningCount,
        waitingApprovalCount, waitingInputCount, failedCount, interruptedCount,
      );
    }
    if (runningCount > 0) {
      return this.activity(
        'running', runningCount, runningCount,
        waitingApprovalCount, waitingInputCount, failedCount, interruptedCount,
      );
    }
    if (activeStatus === 'failed' || failedCount > 0) {
      return this.activity(
        'failed', failedCount, runningCount,
        waitingApprovalCount, waitingInputCount, failedCount, interruptedCount,
      );
    }
    if (activeStatus === 'interrupted' || interruptedCount > 0) {
      return this.activity(
        'interrupted', interruptedCount, runningCount,
        waitingApprovalCount, waitingInputCount, failedCount, interruptedCount,
      );
    }
    return this.activity(
      activeStatus === 'completed' ? 'completed' : 'idle',
      0, runningCount, waitingApprovalCount, waitingInputCount,
      failedCount, interruptedCount,
    );
  }

  async send(
    conversationId: string,
    text: string,
    primaryPagePath: string,
    referencedPagePaths: string[] = [],
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    await (await this.ensureTask(conversationId)).send(
      text,
      primaryPagePath,
      undefined,
      referencedPagePaths,
      attachments,
    );
  }

  async retryInterrupted(conversationId: string): Promise<void> {
    await (await this.ensureTask(conversationId)).retryInterrupted();
  }

  async steerQueuedTurn(
    conversationId: string,
    queuedTurnId: string,
  ): Promise<void> {
    await (await this.ensureTask(conversationId))
      .steerQueuedTurn(queuedTurnId);
  }

  async continueInterrupted(
    conversationId: string,
    primaryPagePath: string,
  ): Promise<void> {
    await (await this.ensureTask(conversationId))
      .continueInterrupted(primaryPagePath);
  }

  respondToApproval(
    conversationId: string,
    decision: ApprovalDecision,
  ): void {
    this.tasks.get(conversationId)?.respondToApproval(decision);
  }

  respondToUserInput(
    conversationId: string,
    answers: AskUserAnswers,
  ): void {
    this.tasks.get(conversationId)?.respondToUserInput(answers);
  }

  cancel(conversationId: string): void {
    this.tasks.get(conversationId)?.cancel();
  }

  async setModel(
    conversationId: string,
    model: string | undefined,
  ): Promise<void> {
    await (await this.ensureTask(conversationId)).setModel(model);
  }

  async setSelection(
    conversationId: string,
    model: string,
    reasoningEffort: string,
  ): Promise<void> {
    await (await this.ensureTask(conversationId)).setSelection(
      model,
      reasoningEffort,
    );
  }

  async materializeSelection(
    conversationId: string,
    model: string,
    reasoningEffort: string,
  ): Promise<void> {
    await (await this.ensureTask(conversationId)).materializeSelection(
      model,
      reasoningEffort,
    );
  }

  async setReasoningEffort(
    conversationId: string,
    reasoningEffort: string,
  ): Promise<void> {
    await (await this.ensureTask(conversationId))
      .setReasoningEffort(reasoningEffort);
  }

  cleanup(): void {
    this.shuttingDown = true;
    for (const task of this.tasks.values()) {
      task.cleanup();
    }
    this.tasks.clear();
    this.pendingTasks.clear();
    this.listeners.clear();
  }

  private async ensureTask(
    conversationId: string,
  ): Promise<ConversationTaskController> {
    if (this.shuttingDown) {
      throw new Error('Runtime coordinator is shutting down.');
    }
    const existing = this.tasks.get(conversationId);
    if (existing) {
      return existing;
    }
    const pending = this.pendingTasks.get(conversationId);
    if (pending) {
      return pending;
    }

    const creation = ConversationTaskController.create({
      conversations: this.conversations,
      createRuntime: () => this.createRuntime(this.host),
      conversationId,
      now: this.now,
      progressPersistIntervalMs: this.progressPersistIntervalMs,
      onChange: snapshot => this.emit(conversationId, snapshot),
    });
    this.pendingTasks.set(conversationId, creation);
    try {
      const task = await creation;
      if (this.shuttingDown) {
        task.cleanup();
        throw new Error('Runtime coordinator is shutting down.');
      }
      this.tasks.set(conversationId, task);
      return task;
    } finally {
      this.pendingTasks.delete(conversationId);
    }
  }

  private activity(
    status: RuntimeActivitySummary['status'],
    badgeCount: number,
    runningCount: number,
    waitingApprovalCount: number,
    waitingInputCount: number,
    failedCount: number,
    interruptedCount: number,
  ): RuntimeActivitySummary {
    return {
      status,
      badgeCount,
      runningCount,
      waitingApprovalCount,
      waitingInputCount,
      failedCount,
      interruptedCount,
    };
  }

  private emit(
    conversationId: string,
    snapshot: ConversationRuntimeSnapshot,
  ): void {
    for (const listener of this.listeners) {
      listener(conversationId, snapshot);
    }
  }
}
