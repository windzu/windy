import type {
  AssistantTurnStatus,
  ChatMessage,
  ToolCallInfo,
} from '../core/types';
import type { ConversationTaskStatus } from '../runtime/types';
import { formatToolName } from './messageFormatting';

export type ActivityState =
  | AssistantTurnStatus
  | 'running'
  | 'waiting-approval'
  | 'waiting-input';

export interface ActivityItem {
  id: string;
  kind: 'tool' | 'reasoning' | 'context' | 'subagent';
  title: string;
  status: ToolCallInfo['status'];
  detail?: string;
  toolCall?: ToolCallInfo;
}

export interface ActivityViewModel {
  state: ActivityState;
  summary: string;
  currentActivity?: string;
  items: ActivityItem[];
  defaultExpanded: boolean;
  shouldRender: boolean;
}

export function buildActivityViewModel(
  message: ChatMessage,
  isLatestAssistant: boolean,
  runtimeStatus: ConversationTaskStatus,
): ActivityViewModel {
  const state = resolveActivityState(message, isLatestAssistant, runtimeStatus);
  const items = buildActivityItems(message);
  const isActive = state === 'running'
    || state === 'waiting-approval'
    || state === 'waiting-input';

  if (isActive && items.at(-1)?.kind === 'reasoning') {
    items[items.length - 1].status = 'running';
  }

  return {
    state,
    summary: formatActivitySummary(state, message.durationSeconds),
    currentActivity: state === 'running'
      ? formatCurrentActivity(items.at(-1))
      : undefined,
    items,
    defaultExpanded: false,
    shouldRender: isActive
      || items.length > 0
      || message.durationSeconds !== undefined,
  };
}

function formatCurrentActivity(item: ActivityItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  if (item.kind !== 'reasoning' || !item.detail) {
    return item.title;
  }

  const firstLine = item.detail
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return item.title;
  }

  const plainText = firstLine
    .replace(/^[#>*_`\s-]+/, '')
    .replace(/[*_`\s]+$/, '');
  return truncateInline(plainText || item.title, 90);
}

export function formatActivitySummary(
  state: ActivityState,
  durationSeconds?: number,
): string {
  const duration = durationSeconds === undefined
    ? ''
    : ` ${formatDuration(durationSeconds)}`;
  switch (state) {
    case 'running':
      return 'Working…';
    case 'waiting-approval':
      return 'Waiting for approval';
    case 'waiting-input':
      return 'Waiting for input';
    case 'completed':
      return duration ? `Worked for${duration}` : 'Work completed';
    case 'failed':
      return duration ? `Failed after${duration}` : 'Work failed';
    case 'cancelled':
      return duration ? `Stopped after${duration}` : 'Work stopped';
    case 'interrupted':
      return duration ? `Interrupted after${duration}` : 'Work interrupted';
  }
}

export function formatDuration(durationSeconds: number): string {
  const seconds = Math.max(0, Math.round(durationSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}

export function formatActivityToolTitle(toolCall: ToolCallInfo): string {
  const name = toolCall.name;
  const normalizedName = name.toLocaleLowerCase();
  const input = toolCall.input;

  if (normalizedName === 'bash' || normalizedName === 'command_execution') {
    const command = firstString(input.command, input.cmd);
    return command ? `Ran ${truncateInline(command)}` : 'Ran a command';
  }

  if (normalizedName === 'write_stdin') {
    return 'Continued a command';
  }

  if (normalizedName === 'apply_patch' || normalizedName === 'file_change') {
    const paths = extractChangedPaths(input);
    if (paths.length === 1) {
      return `Edited ${truncateInline(paths[0])}`;
    }
    return paths.length > 1 ? `Edited ${paths.length} files` : 'Edited files';
  }

  if (normalizedName === 'read' || normalizedName === 'view_image') {
    const path = firstString(input.file_path, input.path);
    if (path && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(path)) {
      return `Viewed ${truncateInline(path)}`;
    }
    return path ? `Read ${truncateInline(path)}` : 'Read a file';
  }

  if (normalizedName === 'websearch' || normalizedName === 'web_search') {
    const actionType = firstString(input.actionType, input.action_type);
    const url = firstString(input.url);
    const pattern = firstString(input.pattern);
    const query = firstString(input.query)
      || (Array.isArray(input.queries) ? firstString(input.queries[0]) : '');
    if (actionType === 'find_in_page' && pattern) {
      return `Found ${truncateInline(pattern)} in a page`;
    }
    if (actionType === 'open_page' && url) {
      return `Opened ${truncateInline(url)}`;
    }
    return query
      ? `Searched the web for ${truncateInline(query)}`
      : 'Searched the web';
  }

  if (normalizedName === 'todowrite' || normalizedName === 'update_plan') {
    return 'Updated the plan';
  }

  if (
    normalizedName === 'askuserquestion'
    || normalizedName === 'request_user_input'
  ) {
    return 'Asked for user input';
  }

  if (normalizedName === 'spawn_agent') {
    return 'Started a subagent';
  }
  if (normalizedName === 'wait' || normalizedName === 'wait_agent') {
    return 'Waited for a subagent';
  }
  if (normalizedName === 'send_input') {
    return 'Sent input to a subagent';
  }

  if (normalizedName.startsWith('mcp__')) {
    const [server, ...toolParts] = name.slice(5).split('__');
    const tool = toolParts.join('__');
    if (server && tool) {
      return `Used ${formatToolName(tool)} via ${formatToolName(server)}`;
    }
  }

  return `Used ${formatToolName(name)}`;
}

function buildActivityItems(message: ChatMessage): ActivityItem[] {
  const items: ActivityItem[] = [];
  const toolCalls = new Map(
    (message.toolCalls ?? []).map(toolCall => [toolCall.id, toolCall]),
  );
  const seenToolIds = new Set<string>();
  let thinkingChunks: string[] = [];
  let reasoningIndex = 0;
  let contextIndex = 0;

  const flushThinking = (): void => {
    const detail = thinkingChunks.join('').trim();
    thinkingChunks = [];
    if (!detail) {
      return;
    }
    items.push({
      id: `reasoning-${reasoningIndex}`,
      kind: 'reasoning',
      title: 'Reasoning',
      status: 'completed',
      detail,
    });
    reasoningIndex += 1;
  };

  for (const block of message.contentBlocks ?? []) {
    if (block.type === 'thinking') {
      thinkingChunks.push(block.content);
      continue;
    }

    flushThinking();
    if (block.type === 'tool_use') {
      const toolCall = toolCalls.get(block.toolId);
      if (toolCall && !seenToolIds.has(toolCall.id)) {
        items.push(toolActivityItem(toolCall));
        seenToolIds.add(toolCall.id);
      }
      continue;
    }
    if (block.type === 'context_compacted') {
      items.push({
        id: `context-${contextIndex}`,
        kind: 'context',
        title: 'Compacted the conversation context',
        status: 'completed',
      });
      contextIndex += 1;
      continue;
    }
    if (block.type === 'subagent') {
      items.push({
        id: `subagent-${block.subagentId}`,
        kind: 'subagent',
        title: 'Worked with a subagent',
        status: 'completed',
      });
    }
  }
  flushThinking();

  for (const toolCall of message.toolCalls ?? []) {
    if (!seenToolIds.has(toolCall.id)) {
      items.push(toolActivityItem(toolCall));
    }
  }
  return items;
}

function toolActivityItem(toolCall: ToolCallInfo): ActivityItem {
  return {
    id: `tool-${toolCall.id}`,
    kind: 'tool',
    title: formatActivityToolTitle(toolCall),
    status: toolCall.status,
    toolCall,
  };
}

function resolveActivityState(
  message: ChatMessage,
  isLatestAssistant: boolean,
  runtimeStatus: ConversationTaskStatus,
): ActivityState {
  if (isLatestAssistant) {
    switch (runtimeStatus) {
      case 'running':
      case 'waiting-approval':
      case 'waiting-input':
      case 'completed':
      case 'failed':
      case 'cancelled':
      case 'interrupted':
        return runtimeStatus;
      case 'idle':
        break;
    }
  }
  if (message.turnStatus) {
    return message.turnStatus;
  }
  if (message.interruptedAt !== undefined || message.isInterrupt) {
    return 'interrupted';
  }
  return 'completed';
}

function extractChangedPaths(input: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  if (Array.isArray(input.changes)) {
    for (const change of input.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        continue;
      }
      const path = firstString((change as Record<string, unknown>).path);
      if (path) {
        paths.add(path);
      }
    }
  }

  const patch = firstString(input.patch);
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) {
      paths.add(path);
    }
  }
  return [...paths];
}

function firstString(...values: unknown[]): string {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )?.trim() ?? '';
}

function truncateInline(value: string, maxLength = 120): string {
  const inline = value.replace(/\s+/g, ' ').trim();
  return inline.length <= maxLength
    ? inline
    : `${inline.slice(0, maxLength - 1)}…`;
}
