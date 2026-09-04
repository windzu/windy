import { Menu, Notice, setIcon, setTooltip } from 'obsidian';

import type { FileAttachment, PermissionMode } from '../core/types';
import type { ConversationModelService } from '../models/types';
import type { ClipboardImageStore } from '../storage/ClipboardImageStore';
import type {
  PageReference,
  PageReferenceService,
} from '../page-context/PageReferenceService';
import type { ConversationTaskStatus } from '../runtime/RuntimeCoordinator';
import { renderModelPickerControl } from './ModelPickerControl';
import { renderFileAttachmentControl } from './FileAttachmentControl';
import { renderReasoningEffortPickerControl } from './ReasoningEffortPickerControl';
import { renderPageReferenceComposer } from './PageReferenceComposer';
import type { ComposerPageReference } from './pageReferenceMentions';
import {
  composerSubmitLabel,
  isActiveConversationStatus,
} from './composerState';

export interface WindyComposerOptions {
  primaryPage: PageReference;
  text: string;
  references: ComposerPageReference[];
  attachments: FileAttachment[];
  vaultPath: string | null;
  clipboardImages: ClipboardImageStore;
  selectedModel: string | undefined;
  selectedReasoningEffort: string | undefined;
  status: ConversationTaskStatus;
  permissionMode: PermissionMode;
  models: ConversationModelService;
  referenceService: PageReferenceService;
  onDraftChange: (text: string, references: ComposerPageReference[]) => void;
  onAttachmentsChange: (attachments: FileAttachment[]) => void;
  onModelSelect: (model: string | null) => Promise<void>;
  onReasoningEffortSelect: (reasoningEffort: string | null) => Promise<void>;
  onPermissionModeSelect: (mode: PermissionMode) => Promise<void>;
  onSubmit: (text: string) => void;
  onStop: () => void;
}

export interface WindyComposerControl {
  element: HTMLElement;
  updateStatus(status: ConversationTaskStatus): void;
}

export function renderWindyComposer(
  container: HTMLElement,
  options: WindyComposerOptions,
): WindyComposerControl {
  const composer = container.createDiv('windy-view__composer');
  const isRunning = isActiveConversationStatus(options.status);
  let updateSendState = (): void => undefined;
  const fileAttachments = renderFileAttachmentControl(composer, {
    attachments: options.attachments,
    disabled: false,
    vaultPath: options.vaultPath,
    clipboardImages: options.clipboardImages,
    onChange: attachments => {
      options.onAttachmentsChange(attachments);
      updateSendState();
    },
  });
  const referenceComposer = renderPageReferenceComposer(composer, {
    primaryPage: options.primaryPage,
    text: options.text,
    references: options.references,
    disabled: false,
    referenceService: options.referenceService,
    onChange: options.onDraftChange,
    onPasteImages: images => {
      void fileAttachments.addClipboardImages(images);
    },
    onSubmit: options.onSubmit,
  });
  const actions = composer.createDiv('windy-view__composer-actions');
  const leftActions = actions.createDiv('windy-view__composer-actions-left');
  const addButton = leftActions.createEl('button', {
    cls: 'windy-view__add-reference clickable-icon',
    attr: {
      type: 'button',
      'aria-label': 'Add context or files',
    },
  });
  setIcon(addButton, 'plus');
  setTooltip(addButton, 'Add context or files');
  addButton.addEventListener('click', event => {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle('Add page context')
      .setIcon('file-text')
      .onClick(() => referenceComposer.openReferencePicker()));
    menu.addItem(item => item
      .setTitle('Add files')
      .setIcon('paperclip')
      .onClick(() => fileAttachments.openPicker()));
    menu.showAtMouseEvent(event);
  });
  const status = leftActions.createDiv('windy-view__status');
  status.createSpan('windy-view__status-dot');
  const statusText = status.createSpan();
  const rightActions = actions.createDiv('windy-view__composer-actions-right');
  renderModelPickerControl(rightActions, {
    selectedModel: options.selectedModel,
    disabled: isRunning,
    models: options.models,
    onSelect: options.onModelSelect,
  });
  renderReasoningEffortPickerControl(rightActions, {
    selectedModel: options.selectedModel,
    selectedReasoningEffort: options.selectedReasoningEffort,
    disabled: isRunning,
    models: options.models,
    onSelect: options.onReasoningEffortSelect,
  });
  const yoloControl = renderYoloControl(rightActions, options, isRunning);
  const stopButton = rightActions.createEl('button', {
    cls: 'windy-view__stop-button clickable-icon',
    attr: {
      type: 'button',
      'aria-label': 'Stop response',
    },
  });
  setIcon(stopButton, 'square');
  setTooltip(stopButton, 'Stop response');
  stopButton.addEventListener('click', options.onStop);
  const submitLabel = composerSubmitLabel(options.status);
  const sendButton = rightActions.createEl('button', {
    cls: 'windy-view__send-button clickable-icon',
    attr: {
      type: 'button',
      'aria-label': submitLabel,
    },
  });
  setIcon(sendButton, 'arrow-up');
  setTooltip(sendButton, submitLabel);
  updateSendState = (): void => {
    sendButton.disabled = !referenceComposer.getText().trim()
      && fileAttachments.getAttachments().length === 0;
  };
  updateSendState();
  referenceComposer.input.addEventListener('input', updateSendState);
  sendButton.addEventListener('click', () => {
    options.onSubmit(referenceComposer.getText());
  });

  const updateStatus = (nextStatus: ConversationTaskStatus): void => {
    const active = isActiveConversationStatus(nextStatus);
    status.className = `windy-view__status windy-view__status--${nextStatus}`;
    status.hidden = nextStatus === 'idle';
    statusText.setText(statusLabel(nextStatus));
    rightActions.querySelector<HTMLButtonElement>(
      '.windy-view__model-trigger',
    )?.toggleAttribute('disabled', active);
    rightActions.querySelector<HTMLButtonElement>(
      '.windy-view__effort-trigger',
    )?.toggleAttribute('disabled', active);
    yoloControl.setDisabled(active);
    stopButton.hidden = !active;
    const nextSubmitLabel = composerSubmitLabel(nextStatus);
    sendButton.setAttribute('aria-label', nextSubmitLabel);
    setTooltip(sendButton, nextSubmitLabel);
  };
  updateStatus(options.status);
  return { element: composer, updateStatus };
}

interface YoloControl {
  setDisabled(disabled: boolean): void;
}

function renderYoloControl(
  container: HTMLElement,
  options: WindyComposerOptions,
  disabled: boolean,
): YoloControl {
  let enabled = options.permissionMode === 'yolo';
  let saving = false;
  let currentDisabled = disabled;
  const control = container.createEl('button', {
    cls: 'windy-view__yolo-control',
    attr: {
      type: 'button',
      role: 'switch',
    },
  });
  control.createSpan({
    cls: 'windy-view__yolo-label',
    text: 'YOLO',
  });
  const track = control.createSpan('windy-view__yolo-track');
  track.createSpan('windy-view__yolo-thumb');

  const update = (): void => {
    control.toggleClass('is-active', enabled);
    control.setAttribute('aria-checked', String(enabled));
    control.setAttribute(
      'aria-label',
      enabled ? 'Disable YOLO mode' : 'Enable YOLO mode',
    );
    control.disabled = currentDisabled || saving;
    setTooltip(
      control,
      enabled
        ? 'YOLO is on: Codex runs without approvals and has full system access'
        : 'YOLO is off: Codex asks for approval before sensitive actions',
    );
  };
  update();

  control.addEventListener('click', () => {
    if (currentDisabled || saving) {
      return;
    }
    const nextMode: PermissionMode = enabled ? 'normal' : 'yolo';
    saving = true;
    update();
    void options.onPermissionModeSelect(nextMode).then(() => {
      enabled = nextMode === 'yolo';
      if (enabled) {
        new Notice(
          'YOLO enabled: approvals are disabled and Codex has full system access.',
        );
      }
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not change permission mode: ${message}`);
    }).finally(() => {
      saving = false;
      update();
    });
  });

  return {
    setDisabled(nextDisabled: boolean): void {
      currentDisabled = nextDisabled;
      update();
    },
  };
}

function statusLabel(status: ConversationTaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting-approval':
      return 'Needs approval';
    case 'waiting-input':
      return 'Needs input';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Ready';
  }
}
