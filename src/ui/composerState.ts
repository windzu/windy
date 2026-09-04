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

export function shouldReuseComposer(
  currentKey: string | null,
  nextKey: string | null,
  forceRebuild: boolean,
): boolean {
  return !forceRebuild && currentKey !== null && currentKey === nextKey;
}
