import type { ConversationTaskStatus } from '../runtime/types';

export function isActiveConversationStatus(
  status: ConversationTaskStatus,
): boolean {
  return status === 'running'
    || status === 'waiting-approval'
    || status === 'waiting-input';
}

export function composerSubmitLabel(status: ConversationTaskStatus): string {
  return isActiveConversationStatus(status) ? 'Queue message' : 'Send message';
}
