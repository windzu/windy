import type { Conversation, ToolCallInfo } from '../core/types';

export const CONVERSATION_DOCUMENT_VERSION = 3;

export interface ConversationDocumentV3 {
  version: typeof CONVERSATION_DOCUMENT_VERSION;
  conversation: Conversation;
}

export interface DecodedConversationDocument {
  conversation: Conversation;
  migratedFromLegacy: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidActiveTurn(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (
      value.status === 'running'
      || value.status === 'waiting-approval'
      || value.status === 'waiting-input'
      || value.status === 'interrupted'
    )
    && typeof value.userMessageId === 'string'
    && typeof value.assistantMessageId === 'string'
    && typeof value.primaryPagePath === 'string'
    && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.updatedAt)
    && (
      value.interruptedAt === undefined
      || isFiniteNumber(value.interruptedAt)
    )
  );
}

function isValidQueuedTurn(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string'
    && typeof value.content === 'string'
    && typeof value.primaryPagePath === 'string'
    && isFiniteNumber(value.createdAt)
    && (
      value.displayContent === undefined
      || typeof value.displayContent === 'string'
    )
    && (
      value.referencedPagePaths === undefined
      || (
        Array.isArray(value.referencedPagePaths)
        && value.referencedPagePaths.every(path => typeof path === 'string')
      )
    )
    && (value.attachments === undefined || Array.isArray(value.attachments))
  );
}

function mergeDuplicateToolCall(
  existing: ToolCallInfo,
  incoming: ToolCallInfo,
): ToolCallInfo {
  const existingIsTerminal = existing.status !== 'running';
  const incomingIsTerminal = incoming.status !== 'running';
  const status = incomingIsTerminal || !existingIsTerminal
    ? incoming.status
    : existing.status;

  return {
    ...existing,
    ...incoming,
    status,
    result: incoming.result ?? existing.result,
    providerPayload: existing.providerPayload || incoming.providerPayload
      ? {
          ...existing.providerPayload,
          ...incoming.providerPayload,
        }
      : undefined,
  };
}

function normalizeDuplicateToolCalls(conversation: Conversation): void {
  for (const message of conversation.messages) {
    if (!message.toolCalls?.length) {
      continue;
    }

    const callsById = new Map<string, ToolCallInfo>();
    for (const toolCall of message.toolCalls) {
      const existing = callsById.get(toolCall.id);
      callsById.set(
        toolCall.id,
        existing ? mergeDuplicateToolCall(existing, toolCall) : toolCall,
      );
    }
    message.toolCalls = Array.from(callsById.values());

    if (message.contentBlocks) {
      const seenToolIds = new Set<string>();
      message.contentBlocks = message.contentBlocks.filter(block => {
        if (block.type !== 'tool_use') {
          return true;
        }
        if (seenToolIds.has(block.toolId)) {
          return false;
        }
        seenToolIds.add(block.toolId);
        return true;
      });
    }
  }
}

function decodeConversation(value: unknown, expectedId: string): Conversation {
  if (!isRecord(value)) {
    throw new Error(`Conversation "${expectedId}" is not a JSON object.`);
  }
  if (value.id !== expectedId) {
    throw new Error(`Conversation file "${expectedId}" contains a different id.`);
  }
  if (
    typeof value.providerId !== 'string'
    || typeof value.title !== 'string'
    || !isFiniteNumber(value.createdAt)
    || !isFiniteNumber(value.updatedAt)
    || !Array.isArray(value.messages)
    || (
      value.activeTurn !== undefined
      && !isValidActiveTurn(value.activeTurn)
    )
    || (
      value.queuedTurns !== undefined
      && (
        !Array.isArray(value.queuedTurns)
        || !value.queuedTurns.every(isValidQueuedTurn)
      )
    )
  ) {
    throw new Error(`Conversation "${expectedId}" has an invalid schema.`);
  }
  if (value.sessionId !== null && typeof value.sessionId !== 'string') {
    throw new Error(`Conversation "${expectedId}" has an invalid session id.`);
  }
  const conversation = structuredClone(value) as unknown as Conversation;
  normalizeDuplicateToolCalls(conversation);
  return conversation;
}

export function decodeConversationDocument(
  value: unknown,
  expectedId: string,
): DecodedConversationDocument {
  if (!isRecord(value)) {
    throw new Error(`Conversation "${expectedId}" has an invalid document.`);
  }

  if ('version' in value) {
    if (
      value.version !== 1
      && value.version !== 2
      && value.version !== CONVERSATION_DOCUMENT_VERSION
    ) {
      throw new Error(
        `Conversation "${expectedId}" uses unsupported schema version "${String(value.version)}".`,
      );
    }
    return {
      conversation: decodeConversation(value.conversation, expectedId),
      migratedFromLegacy: value.version !== CONVERSATION_DOCUMENT_VERSION,
    };
  }

  return {
    conversation: decodeConversation(value, expectedId),
    migratedFromLegacy: true,
  };
}

export function encodeConversationDocument(
  conversation: Conversation,
): ConversationDocumentV3 {
  return {
    version: CONVERSATION_DOCUMENT_VERSION,
    conversation: structuredClone(conversation),
  };
}
