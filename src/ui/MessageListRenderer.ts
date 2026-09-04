import * as fs from 'node:fs';

import {
  type App,
  Component,
  MarkdownRenderer,
  setIcon,
} from 'obsidian';

import type {
  ChatMessage,
  ToolCallInfo,
} from '../core/types';
import {
  isInlinePageReference,
  splitPageMentionText,
} from './pageReferenceMentions';
import type { ConversationTaskStatus } from '../runtime/RuntimeCoordinator';
import {
  formatToolPayload,
  toolStatusIcon,
  toolStatusLabel,
} from './messageFormatting';
import {
  type ActivityItem,
  type ActivityState,
  buildActivityViewModel,
  elapsedTurnSeconds,
  formatActivitySummary,
} from './activityFormatting';
import { WINDY_NAV_ICON } from './icons';
import {
  attachmentIcon,
  attachmentTypeLabel,
  formatFileSize,
} from './FileAttachmentControl';
import { resolveFileAttachmentPath } from '../utils/fileAttachment';
import { getVaultPath } from '../utils/path';

export class MessageListRenderer extends Component {
  constructor(
    private readonly app: App,
    private readonly activityExpansion = new Map<string, boolean>(),
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async render(
    container: HTMLElement,
    messages: ChatMessage[],
    sourcePath: string,
    status: ConversationTaskStatus,
    activeTurnStartedAt?: number,
  ): Promise<void> {
    const markdownRenders: Promise<void>[] = [];
    let lastAssistantIndex = -1;
    messages.forEach((message, index) => {
      if (message.role === 'assistant') {
        lastAssistantIndex = index;
      }
    });
    for (const [index, message] of messages.entries()) {
      const messageElement = container.createDiv({
        cls: `windy-message windy-message--${message.role}`,
      });
      const role = messageElement.createDiv('windy-message__role');
      const roleIcon = role.createSpan('windy-message__role-icon');
      setIcon(roleIcon, message.role === 'user' ? 'user-round' : WINDY_NAV_ICON);
      role.createSpan({
        text: message.role === 'user' ? 'You' : 'Windy',
      });
      this.renderFileAttachments(messageElement, message);
      this.renderReferences(messageElement, message);
      if (message.role === 'assistant') {
        this.renderActivity(
          messageElement,
          message,
          index === lastAssistantIndex,
          status,
          index === lastAssistantIndex ? activeTurnStartedAt : undefined,
        );
      }
      const content = message.displayContent
        ?? message.content;
      if (message.role === 'assistant' && !content) {
        continue;
      }
      const contentElement = messageElement.createDiv(
        'windy-message__content',
      );
      const isLiveAssistant = (
        message.role === 'assistant'
        && index === messages.length - 1
        && (
          status === 'running'
          || status === 'waiting-approval'
          || status === 'waiting-input'
          || status === 'interrupted'
        )
      );
      if (message.role === 'assistant' && !isLiveAssistant && message.content) {
        contentElement.addClass('markdown-rendered');
        markdownRenders.push(
          this.renderMarkdown(contentElement, content, sourcePath),
        );
      } else {
        contentElement.addClass('windy-message__content--plain');
        if (message.role === 'user') {
          this.renderPageMentions(
            contentElement,
            content,
            message.referencedPagePaths ?? [],
          );
        } else {
          contentElement.setText(content);
        }
      }
    }
    await Promise.all(markdownRenders);
  }

  private renderFileAttachments(
    messageElement: HTMLElement,
    message: ChatMessage,
  ): void {
    if (!message.attachments?.length) {
      return;
    }
    const container = messageElement.createDiv('windy-message__file-attachments');
    const vaultPath = getVaultPath(this.app);
    for (const attachment of message.attachments) {
      const resolvedPath = resolveFileAttachmentPath(attachment, vaultPath);
      const available = Boolean(resolvedPath && fs.existsSync(resolvedPath));
      const item = container.createDiv({
        cls: `windy-message__file${available ? '' : ' is-missing'}`,
      });
      const icon = item.createSpan('windy-message__file-icon');
      setIcon(icon, available ? attachmentIcon(attachment) : 'file-x');
      const labels = item.createSpan('windy-message__file-labels');
      labels.createSpan({
        cls: 'windy-message__file-name',
        text: attachment.name,
      });
      labels.createSpan({
        cls: 'windy-message__file-path',
        text: available
          ? `${attachmentTypeLabel(attachment)} · ${attachment.path} · ${formatFileSize(attachment.size)}`
          : `${attachmentTypeLabel(attachment)} · ${attachment.path} · File unavailable`,
      });
      item.setAttribute('title', attachment.path);
      item.setAttribute('aria-label', available
        ? `Attached file: ${attachment.path}`
        : `Attached file unavailable: ${attachment.path}`);
    }
  }

  private async renderMarkdown(
    container: HTMLElement,
    content: string,
    sourcePath: string,
  ): Promise<void> {
    try {
      await MarkdownRenderer.render(
        this.app,
        content,
        container,
        sourcePath,
        this,
      );
    } catch {
      container.empty();
      container.removeClass('markdown-rendered');
      container.addClass('windy-message__content--plain');
      container.setText(content);
    }
  }

  private renderReferences(
    messageElement: HTMLElement,
    message: ChatMessage,
  ): void {
    const attachedPaths = message.referencedPagePaths?.filter(
      path => !isInlinePageReference(message.content, path),
    ) ?? [];
    if (attachedPaths.length === 0) {
      return;
    }
    const references = messageElement.createDiv(
      'windy-message__references',
    );
    for (const path of attachedPaths) {
      references.createSpan({
        cls: 'windy-message__reference',
        text: path,
      });
    }
  }

  private renderPageMentions(
    container: HTMLElement,
    content: string,
    paths: string[],
  ): void {
    for (const segment of splitPageMentionText(content, paths)) {
      if (segment.type === 'text') {
        container.appendText(segment.text);
        continue;
      }
      const mention = container.createSpan({
        cls: 'windy-message__inline-reference',
        attr: {
          'aria-label': `Page: ${segment.path}`,
          title: segment.path,
        },
      });
      const icon = mention.createSpan(
        'windy-message__inline-reference-icon',
      );
      setIcon(icon, segment.path.endsWith('.base') ? 'database' : 'file-text');
      mention.createSpan({
        cls: 'windy-message__inline-reference-title',
        text: pageBasename(segment.path),
      });
    }
  }

  private renderActivity(
    messageElement: HTMLElement,
    message: ChatMessage,
    isLatestAssistant: boolean,
    status: ConversationTaskStatus,
    activeTurnStartedAt?: number,
  ): void {
    const liveElapsedSeconds = activeTurnStartedAt === undefined
      ? undefined
      : elapsedTurnSeconds(activeTurnStartedAt, this.now());
    const activity = buildActivityViewModel(
      message,
      isLatestAssistant,
      status,
      liveElapsedSeconds,
    );
    if (!activity.shouldRender) {
      return;
    }

    const details = messageElement.createEl('details', {
      cls: `windy-activity windy-activity--${activity.state}`,
    });
    details.open = this.activityExpansion.get(message.id)
      ?? activity.defaultExpanded;
    details.addEventListener('toggle', () => {
      this.activityExpansion.set(message.id, details.open);
    });
    const summary = details.createEl('summary', {
      cls: 'windy-activity__summary',
    });
    const disclosure = summary.createSpan('windy-activity__disclosure');
    setIcon(disclosure, 'chevron-right');
    const stateIcon = summary.createSpan('windy-activity__state-icon');
    setIcon(stateIcon, activityStateIcon(activity.state));
    const title = summary.createSpan({
      cls: 'windy-activity__title',
      text: activity.summary,
      attr: { 'aria-live': 'off' },
    });
    if (activeTurnStartedAt !== undefined && isActiveState(activity.state)) {
      const view = messageElement.ownerDocument.defaultView;
      if (view) {
        this.registerInterval(view.setInterval(() => {
          title.setText(formatActivitySummary(
            activity.state,
            elapsedTurnSeconds(activeTurnStartedAt, this.now()),
          ));
        }, 1_000));
      }
    }
    if (activity.currentActivity) {
      summary.createSpan({
        cls: 'windy-activity__current',
        text: activity.currentActivity,
      });
    } else if (activity.items.length > 0) {
      summary.createSpan({
        cls: 'windy-activity__count',
        text: `${activity.items.length} ${activity.items.length === 1 ? 'activity' : 'activities'}`,
      });
    }

    const body = details.createDiv('windy-activity__body');
    if (activity.items.length === 0) {
      body.createDiv({
        cls: 'windy-activity__empty',
        text: activity.defaultExpanded
          ? 'Preparing…'
          : 'No detailed activity recorded.',
      });
    } else {
      for (const item of activity.items) {
        this.renderActivityItem(body, item);
      }
    }
  }

  private renderActivityItem(container: HTMLElement, item: ActivityItem): void {
    if (item.kind === 'commentary') {
      container.createDiv({
        cls: 'windy-activity__commentary',
        text: item.detail ?? item.title,
      });
      return;
    }
    if (item.toolCall) {
      this.renderTool(container, item.toolCall, item.title);
      return;
    }

    const details = item.detail
      ? container.createEl('details', {
          cls: `windy-tool windy-tool--${item.status}`,
        })
      : null;
    const summary = details
      ? details.createEl('summary', { cls: 'windy-tool__summary' })
      : container.createDiv({
          cls: `windy-tool__summary windy-tool__summary--static windy-tool--${item.status}`,
        });
    const icon = summary.createSpan('windy-tool__icon');
    setIcon(icon, item.kind === 'reasoning'
      ? (item.status === 'running' ? 'loader-circle' : 'brain')
      : toolStatusIcon(item.status));
    summary.createSpan({
      cls: 'windy-tool__name',
      text: item.title,
    });
    if (details && item.detail) {
      details.createEl('pre', {
        cls: 'windy-thinking__content',
        text: item.detail,
      });
    }
  }

  private renderTool(
    container: HTMLElement,
    toolCall: ToolCallInfo,
    title: string,
  ): void {
    const details = container.createEl('details', {
      cls: `windy-tool windy-tool--${toolCall.status}`,
    });
    details.open = (
      toolCall.isExpanded === true
      || toolCall.status === 'error'
      || toolCall.status === 'blocked'
    );
    const summary = details.createEl('summary', {
      cls: 'windy-tool__summary',
    });
    const icon = summary.createSpan('windy-tool__icon');
    setIcon(icon, toolStatusIcon(toolCall.status));
    summary.createSpan({
      cls: 'windy-tool__name',
      text: title,
    });
    summary.createSpan({
      cls: 'windy-tool__status',
      text: toolStatusLabel(toolCall.status),
    });

    const body = details.createDiv('windy-tool__body');
    if (Object.keys(toolCall.input).length > 0) {
      this.renderPayload(body, 'Input', toolCall.input);
    }
    if (toolCall.result !== undefined) {
      this.renderPayload(body, 'Output', toolCall.result);
    }
    if (body.childElementCount === 0) {
      body.createDiv({
        cls: 'windy-tool__empty',
        text: 'No details available.',
      });
    }
  }

  private renderPayload(
    container: HTMLElement,
    label: string,
    value: unknown,
  ): void {
    const section = container.createDiv('windy-tool__section');
    section.createDiv({
      cls: 'windy-tool__label',
      text: label,
    });
    section.createEl('pre', {
      cls: 'windy-tool__payload',
      text: formatToolPayload(value),
    });
  }
}

function isActiveState(state: ActivityState): boolean {
  return state === 'running'
    || state === 'waiting-approval'
    || state === 'waiting-input';
}

function activityStateIcon(state: string): string {
  switch (state) {
    case 'running':
      return 'loader-circle';
    case 'waiting-approval':
    case 'waiting-input':
      return 'circle-help';
    case 'completed':
      return 'clock-3';
    case 'failed':
      return 'circle-alert';
    case 'cancelled':
      return 'circle-stop';
    case 'interrupted':
      return 'pause-circle';
    default:
      return 'activity';
  }
}

function pageBasename(path: string): string {
  const filename = path.split('/').at(-1) ?? path;
  return filename.replace(/\.(?:md|base)$/i, '');
}
