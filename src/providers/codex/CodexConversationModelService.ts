import type { WindySettings } from '../../core/types';
import {
  CODEX_DEFAULT_MODEL_SELECTION,
  MODEL_DEFAULT_REASONING_SELECTION,
} from '../../app/settings';
import type {
  ConversationModelOption,
  ConversationModelService,
  ConversationReasoningEffortOption,
  ResolvedConversationSelection,
} from '../../models/types';
import { formatReasoningValueLabel } from '../../core/providers/reasoning';
import { formatCodexModelLabel } from './types/models';
import type {
  AppServerModel,
  ModelListResult,
} from './runtime/codexAppServerTypes';

export interface ModelCatalogGateway {
  ensureReady(): Promise<unknown>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
}

export interface ConversationModelTarget {
  setSelection(
    conversationId: string,
    model: string,
    reasoningEffort: string,
  ): Promise<void>;
  setReasoningEffort(
    conversationId: string,
    reasoningEffort: string,
  ): Promise<void>;
}

export class CodexConversationModelService implements ConversationModelService {
  private options: ConversationModelOption[] | null = null;
  private refreshFlight: Promise<ConversationModelOption[]> | null = null;

  constructor(
    private readonly gateway: ModelCatalogGateway,
    private readonly target: ConversationModelTarget,
    private readonly settings: WindySettings,
  ) {}

  async getOptions(): Promise<ConversationModelOption[]> {
    if (!this.refreshFlight) {
      this.refreshFlight = this.loadOptions().finally(() => {
        this.refreshFlight = null;
      });
    }
    return structuredClone(await this.refreshFlight);
  }

  async getNewConversationDefaults(): Promise<ResolvedConversationSelection> {
    return this.resolveConfiguredSelection(
      this.settings.newConversationModel,
      this.settings.newConversationReasoningEffort,
      await this.getOptions(),
    );
  }

  async getLegacyConversationDefaults(
    selectedModel?: string,
    selectedReasoningEffort?: string,
  ): Promise<ResolvedConversationSelection> {
    const options = await this.getOptions();
    const model = this.resolveModel(
      selectedModel || this.settings.model || undefined,
      options,
    );
    if (!model) {
      throw new Error('Codex did not return any available models.');
    }
    const configuredEffort = selectedReasoningEffort || this.settings.effortLevel;
    const reasoningEffort = model.reasoningEfforts.some(
      option => option.value === configuredEffort,
    )
      ? configuredEffort
      : model.defaultReasoningEffort;
    return { model: model.value, reasoningEffort };
  }

  async getSelectionForModel(
    model: string | null,
  ): Promise<ResolvedConversationSelection> {
    if (model === null) {
      return this.getNewConversationDefaults();
    }
    const options = await this.getOptions();
    const selected = options.find(option => option.value === model);
    if (!selected) {
      throw new Error(`Model "${model}" is not available.`);
    }
    return {
      model: selected.value,
      reasoningEffort: selected.defaultReasoningEffort,
    };
  }

  getSelectionLabel(
    selectedModel: string | undefined,
    options: ConversationModelOption[] = this.options ?? [],
  ): string {
    if (!selectedModel) {
      return 'Loading…';
    }
    return options.find(option => option.value === selectedModel)?.label
      ?? formatCodexModelLabel(selectedModel);
  }

  async getReasoningOptions(
    selectedModel: string | undefined,
  ): Promise<ConversationReasoningEffortOption[]> {
    const model = this.resolveModel(selectedModel, await this.getOptions());
    return structuredClone(model?.reasoningEfforts ?? []);
  }

  getReasoningSelectionLabel(
    selectedModel: string | undefined,
    selectedReasoningEffort: string | undefined,
    options: ConversationModelOption[] = this.options ?? [],
  ): string {
    const effort = selectedReasoningEffort
      ?? this.resolveModel(selectedModel, options)?.defaultReasoningEffort
      ?? '';
    return effort ? formatReasoningValueLabel(effort) : 'Loading…';
  }

  async select(
    conversationId: string,
    model: string | null,
  ): Promise<void> {
    const selection = await this.getSelectionForModel(model);
    await this.target.setSelection(
      conversationId,
      selection.model,
      selection.reasoningEffort,
    );
  }

  async selectReasoningEffort(
    conversationId: string,
    selectedModel: string | undefined,
    reasoningEffort: string | null,
  ): Promise<void> {
    const model = this.resolveModel(selectedModel, await this.getOptions());
    if (!model) {
      throw new Error('Codex did not return any available models.');
    }
    const selectedEffort = reasoningEffort ?? model.defaultReasoningEffort;
    if (!model.reasoningEfforts.some(option => option.value === selectedEffort)) {
      throw new Error(
        `Reasoning effort "${selectedEffort}" is not available for this model.`,
      );
    }
    await this.target.setReasoningEffort(
      conversationId,
      selectedEffort,
    );
  }

  private async loadOptions(): Promise<ConversationModelOption[]> {
    await this.gateway.ensureReady();
    const models: AppServerModel[] = [];
    let cursor: string | null | undefined;
    do {
      const result = await this.gateway.request<ModelListResult>(
        'model/list',
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      );
      models.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);

    this.options = models
      .filter(model => !model.hidden)
      .map(model => ({
        value: model.model || model.id,
        label: formatCodexModelLabel(model.model || model.id),
        description: model.description,
        isDefault: model.isDefault,
        reasoningEfforts: model.supportedReasoningEfforts.map(option => ({
          value: option.reasoningEffort,
          label: formatReasoningValueLabel(option.reasoningEffort),
          description: option.description,
          isDefault: option.reasoningEffort === model.defaultReasoningEffort,
        })),
        defaultReasoningEffort: model.defaultReasoningEffort,
      }));
    return this.options;
  }

  private resolveModel(
    selectedModel: string | undefined,
    options: ConversationModelOption[],
  ): ConversationModelOption | null {
    const modelId = selectedModel;
    return options.find(option => option.value === modelId)
      ?? options.find(option => option.isDefault)
      ?? options[0]
      ?? null;
  }

  private resolveConfiguredSelection(
    configuredModel: string,
    configuredEffort: string,
    options: ConversationModelOption[],
  ): ResolvedConversationSelection {
    const requestedModel = configuredModel === CODEX_DEFAULT_MODEL_SELECTION
      ? undefined
      : configuredModel;
    const model = this.resolveModel(requestedModel || undefined, options);
    if (!model) {
      throw new Error('Codex did not return any available models.');
    }
    const requestedEffort = configuredEffort === MODEL_DEFAULT_REASONING_SELECTION
      ? undefined
      : configuredEffort;
    const reasoningEffort = requestedEffort && model.reasoningEfforts.some(
      option => option.value === requestedEffort,
    )
      ? requestedEffort
      : model.defaultReasoningEffort;
    return { model: model.value, reasoningEffort };
  }
}
