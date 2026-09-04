import type { SDKToolUseResult } from './diff';
import type { ProviderId } from './provider';
import type { SubagentMode, ToolCallInfo, ToolProviderPayload } from './tools';

/** Fork origin reference: identifies the source session and checkpoint. */
export interface ForkSource {
  sessionId: string;
  resumeAt: string;
}

/** View type identifier for Obsidian. */
export const VIEW_TYPE_WINDY = 'windy-view';

/** Supported image media types for attachments. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Image attachment metadata. */
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  /** Base64 encoded image data - single source of truth. */
  data: string;
  width?: number;
  height?: number;
  size: number;
  source: 'file' | 'paste' | 'drop';
}

/** A local file referenced by path without copying its contents into Windy. */
export interface FileAttachment {
  id: string;
  name: string;
  /** Vault-relative for vault files, absolute for external files. */
  path: string;
  location: 'vault' | 'external';
  mediaType?: string;
  size: number;
  source: 'picker' | 'drop' | 'paste';
}

/** User-visible phase for assistant text emitted during a turn. */
export type AssistantMessagePhase = 'commentary' | 'final_answer';

/** Content block for preserving streaming order in messages. */
export type ContentBlock =
  | {
      type: 'text';
      content: string;
      phase?: AssistantMessagePhase;
      itemId?: string;
    }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string; mode?: SubagentMode }
  | { type: 'context_compacted' };

export type AssistantTurnStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Chat message with content, tool calls, and attachments. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only content (e.g., "/tests" when content is the expanded prompt). */
  displayContent?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  contentBlocks?: ContentBlock[];
  primaryPagePath?: string;
  /** Additional Vault pages explicitly attached to this user turn. */
  referencedPagePaths?: string[];
  /** Local files explicitly attached to this user turn. */
  attachments?: FileAttachment[];
  images?: ImageAttachment[];
  /** True if this message represents a user interrupt (from SDK storage). */
  isInterrupt?: boolean;
  /** True if this message is rebuilt context sent to SDK on session reset (should be hidden). */
  isRebuiltContext?: boolean;
  /** Duration in seconds from user send to response completion. */
  durationSeconds?: number;
  /** Persisted terminal state for the assistant turn. */
  turnStatus?: AssistantTurnStatus;
  /** Flavor word used for duration display (e.g., "Baked", "Cooked"). */
  durationFlavorWord?: string;
  /** Provider-native user message identifier used for rewind. */
  userMessageId?: string;
  /** Provider-native assistant message identifier used for rewind/fork checkpoints. */
  assistantMessageId?: string;
  /** Marks a partial assistant response whose live turn could not be resumed. */
  interruptedAt?: number;
}

export type PersistedTurnStatus =
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'interrupted';

export interface PersistedTurnState {
  status: PersistedTurnStatus;
  userMessageId: string;
  assistantMessageId: string;
  primaryPagePath: string;
  startedAt: number;
  updatedAt: number;
  interruptedAt?: number;
}

/** Persisted conversation with messages and session state. */
export interface Conversation {
  id: string;
  providerId: ProviderId;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  sessionId: string | null;
  /** Conversation-owned model selection. Missing values are migrated lazily. */
  selectedModel?: string;
  /** Conversation-owned reasoning effort. Missing values use the model default. */
  selectedReasoningEffort?: string;
  /** Opaque provider-owned state bag (session tracking, fork metadata, etc.). */
  providerState?: Record<string, unknown>;
  messages: ChatMessage[];
  /** Session-specific external context paths (directories with full access). Resets on new session. */
  externalContextPaths?: string[];
  /** Context window usage information. */
  usage?: UsageInfo;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  /** UI-enabled MCP servers for this session (context-saving servers activated via selector). */
  enabledMcpServers?: string[];
  /** Assistant checkpoint identifier for resumeAtMessageId after rewind. */
  resumeAtMessageId?: string;
  /** Non-terminal turn state used to recover interrupted plugin sessions. */
  activeTurn?: PersistedTurnState;
}

/** Lightweight conversation metadata for the history dropdown. */
export interface ConversationMeta {
  id: string;
  providerId: ProviderId;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  messageCount: number;
  preview: string;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
}

/**
 * Session metadata overlay for provider-native storage.
 * The provider handles message storage; this stores UI-only state.
 */
export interface SessionMetadata {
  id: string;
  providerId?: ProviderId;
  title: string;
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  /** Session ID used for provider resume (may be cleared when invalidated). */
  sessionId?: string | null;
  /** Conversation-owned model selection. */
  selectedModel?: string;
  /** Conversation-owned reasoning effort. */
  selectedReasoningEffort?: string;
  /** Opaque provider-owned state bag. */
  providerState?: Record<string, unknown>;
  externalContextPaths?: string[];
  enabledMcpServers?: string[];
  usage?: UsageInfo;
  /** Assistant checkpoint identifier for resumeAtMessageId after rewind. */
  resumeAtMessageId?: string;
}

/**
 * Normalized stream chunk emitted by the active provider runtime.
 *
 * All providers must emit: text, tool_use, tool_result, error, done, usage.
 * Provider-specific behavior must be normalized before reaching this contract.
 * Providers may keep provider-native turn metadata internally and expose it via
 * runtime methods instead of encoding it as stream-control chunks.
 */
export type StreamChunk =
  | { type: 'user_message_start'; content: string; itemId?: string }
  | {
      type: 'assistant_message_start';
      itemId?: string;
      phase?: AssistantMessagePhase;
    }
  | {
      type: 'text';
      content: string;
      itemId?: string;
      phase?: AssistantMessagePhase;
    }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      providerPayload?: ToolProviderPayload;
    }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult }
  | { type: 'tool_output'; id: string; content: string }
  | {
      type: 'error';
      content: string;
      code?: 'provider_session_missing';
      providerSessionId?: string;
    }
  | { type: 'notice'; content: string; level?: 'info' | 'warning' }
  | { type: 'done' }
  | { type: 'usage'; usage: UsageInfo; sessionId?: string | null }
  | { type: 'context_compacted' }
  | { type: 'subagent_tool_use'; subagentId: string; id: string; name: string; input: Record<string, unknown> }
  | { type: 'subagent_tool_result'; subagentId: string; id: string; content: string; isError?: boolean; toolUseResult?: SDKToolUseResult };

/**
 * Context window usage information.
 *
 * `contextTokens` is the provider-computed total token count in the context window.
 * Claude sets it to `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`;
 * other providers should set it to their equivalent total.
 *
 * Cache token fields are optional — only providers with prompt caching (Claude)
 * populate them. Feature code should use `contextTokens` for display, not recompute
 * from the cache breakdown.
 */
export interface UsageInfo {
  model?: string;
  inputTokens: number;
  /** Prompt caching: tokens used to create cache entries. Claude-specific; 0 if omitted. */
  cacheCreationInputTokens?: number;
  /** Prompt caching: tokens read from cache. Claude-specific; 0 if omitted. */
  cacheReadInputTokens?: number;
  contextWindow: number;
  /** True when `contextWindow` came from provider runtime data instead of a local heuristic. */
  contextWindowIsAuthoritative?: boolean;
  contextTokens: number;
  percentage: number;
}
