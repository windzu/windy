import type { ChatRuntime } from '../core/runtime/ChatRuntime';
import type { Conversation } from '../core/types';
import type { ConversationStore } from '../conversations/ConversationRepository';

export class TurnCheckpointManager {
  private lastProgressPersistedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly conversations: ConversationStore,
    private readonly runtime: ChatRuntime,
    private readonly now: () => number,
    private readonly progressPersistIntervalMs: number,
  ) {}

  resetProgressClock(): void {
    this.lastProgressPersistedAt = Number.NEGATIVE_INFINITY;
  }

  persistProgressIfDue(conversation: Conversation): void {
    const activeTurn = conversation.activeTurn;
    if (!activeTurn) {
      return;
    }
    const now = this.now();
    activeTurn.updatedAt = now;
    if (now - this.lastProgressPersistedAt < this.progressPersistIntervalMs) {
      return;
    }
    this.lastProgressPersistedAt = now;
    this.captureSessionState(conversation);
    this.persistWithoutBlocking(conversation);
  }

  updateActiveStatus(
    conversation: Conversation,
    status: 'running' | 'waiting-approval' | 'waiting-input',
  ): void {
    if (!conversation.activeTurn) {
      return;
    }
    conversation.activeTurn.status = status;
    conversation.activeTurn.updatedAt = this.now();
    this.persistWithoutBlocking(conversation);
  }

  async recoverInterrupted(conversation: Conversation): Promise<boolean> {
    if (!conversation.activeTurn) {
      return false;
    }
    this.markInterrupted(conversation);
    await this.conversations.save(conversation);
    return true;
  }

  interruptAndPersist(conversation: Conversation): void {
    if (!this.markInterrupted(conversation)) {
      return;
    }
    this.captureSessionState(conversation);
    this.persistWithoutBlocking(conversation);
  }

  captureSessionState(conversation: Conversation): void {
    const sessionUpdates = this.runtime.buildSessionUpdates({
      conversation,
      sessionInvalidated: false,
    });
    Object.assign(conversation, sessionUpdates.updates);
  }

  persistWithoutBlocking(conversation: Conversation): void {
    void this.conversations.save(conversation).catch(() => undefined);
  }

  private markInterrupted(conversation: Conversation): boolean {
    const activeTurn = conversation.activeTurn;
    if (!activeTurn) {
      return false;
    }
    const interruptedAt = activeTurn.interruptedAt ?? this.now();
    activeTurn.status = 'interrupted';
    activeTurn.interruptedAt = interruptedAt;
    activeTurn.updatedAt = interruptedAt;
    const assistantMessage = conversation.messages.find(
      message => message.id === activeTurn.assistantMessageId
        && message.role === 'assistant',
    );
    if (assistantMessage) {
      assistantMessage.interruptedAt = interruptedAt;
      assistantMessage.turnStatus = 'interrupted';
      assistantMessage.durationSeconds ??= Math.max(
        0,
        Math.round((interruptedAt - activeTurn.startedAt) / 1000),
      );
      for (const toolCall of assistantMessage.toolCalls ?? []) {
        if (toolCall.status === 'running') {
          toolCall.status = 'blocked';
        }
      }
    }
    return true;
  }
}
