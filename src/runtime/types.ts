import type { ApprovalCallbackOptions } from '../core/runtime/types';
import type {
  AskUserQuestionItem,
  Conversation,
} from '../core/types';

export type ConversationTaskStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface PendingApproval {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  options?: ApprovalCallbackOptions;
}

export interface PendingUserInput {
  questions: AskUserQuestionItem[];
}

export interface ConversationRuntimeSnapshot {
  conversation: Conversation | null;
  status: ConversationTaskStatus;
  error: string | null;
  pendingApproval: PendingApproval | null;
  pendingUserInput: PendingUserInput | null;
  canSteer: boolean;
  steeringQueuedTurnIds: string[];
}

export type RuntimeActivityStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface RuntimeActivitySummary {
  status: RuntimeActivityStatus;
  badgeCount: number;
  runningCount: number;
  waitingApprovalCount: number;
  waitingInputCount: number;
  failedCount: number;
  interruptedCount: number;
}
