import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from 'obsidian';

import {
  CODEX_DEFAULT_MODEL_SELECTION,
  MODEL_DEFAULT_REASONING_SELECTION,
} from '../app/settings';
import type { WindySettings } from '../core/types';
import type {
  ConversationModelOption,
  ConversationModelService,
} from '../models/types';
import { getCodexProviderSettings } from '../providers/codex/settings';
import { findDesktopCodex } from '../providers/codex/runtime/CodexExecutableResolver';

export class WindySettingTab extends PluginSettingTab {
  private renderGeneration = 0;
  private savingExecutable = false;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly settings: WindySettings,
    private readonly models: ConversationModelService,
    private readonly save: (settings: WindySettings) => Promise<void>,
    private readonly getExecutable: () => Promise<string | null>,
  ) {
    super(app, plugin);
  }

  display(): void {
    const generation = ++this.renderGeneration;
    const { containerEl } = this;
    containerEl.empty();
    this.renderRuntimeSettings();
    const modelContainer = containerEl.createDiv();
    new Setting(modelContainer).setName('Conversation defaults').setHeading();
    modelContainer.createEl('p', {
      text: 'Defaults apply only to conversations created after you change them. '
        + 'Each conversation stores the concrete model and reasoning effort it starts with.',
    });
    new Setting(modelContainer)
      .setName('New conversation model')
      .setDesc('Loading the live Codex model catalog…');

    void this.models.getOptions().then(options => {
      if (generation !== this.renderGeneration) {
        return;
      }
      this.renderModelSettings(options, modelContainer);
    }).catch(error => {
      if (generation !== this.renderGeneration) {
        return;
      }
      modelContainer.empty();
      new Setting(modelContainer).setName('Conversation defaults').setHeading();
      new Setting(modelContainer)
        .setName('Could not load Codex models')
        .setDesc(error instanceof Error ? error.message : String(error));
    });
  }

  private renderModelSettings(
    options: ConversationModelOption[],
    containerEl: HTMLElement,
  ): void {
    containerEl.empty();
    new Setting(containerEl).setName('Conversation defaults').setHeading();
    containerEl.createEl('p', {
      text: 'Defaults apply only to new conversations. Existing conversations keep '
        + 'their stored model and reasoning effort.',
    });

    const providerDefault = options.find(option => option.isDefault)
      ?? options[0];
    const configuredModel = this.settings.newConversationModel;
    const selectedModel = configuredModel === CODEX_DEFAULT_MODEL_SELECTION
      ? providerDefault
      : options.find(option => option.value === configuredModel) ?? providerDefault;

    new Setting(containerEl)
      .setName('New conversation model')
      .setDesc(
        'Follow the current Codex default, or pin a model for future conversations.',
      )
      .addDropdown(dropdown => {
        dropdown.addOption(
          CODEX_DEFAULT_MODEL_SELECTION,
          providerDefault
            ? `Codex default (${providerDefault.label})`
            : 'Codex default',
        );
        for (const option of options) {
          dropdown.addOption(option.value, option.label);
        }
        if (
          configuredModel !== CODEX_DEFAULT_MODEL_SELECTION
          && !options.some(option => option.value === configuredModel)
        ) {
          dropdown.addOption(
            configuredModel,
            `Unavailable (${configuredModel})`,
          );
        }
        dropdown.setValue(configuredModel);
        dropdown.onChange(value => {
          void this.updateModel(value, options);
        });
      });

    const configuredEffort = this.settings.newConversationReasoningEffort;
    new Setting(containerEl)
      .setName('New conversation reasoning')
      .setDesc(
        'Follow the selected model default, or pin an effort for future conversations.',
      )
      .addDropdown(dropdown => {
        const defaultEffort = selectedModel?.defaultReasoningEffort;
        dropdown.addOption(
          MODEL_DEFAULT_REASONING_SELECTION,
          defaultEffort
            ? `Model default (${this.formatEffort(defaultEffort)})`
            : 'Model default',
        );
        for (const effort of selectedModel?.reasoningEfforts ?? []) {
          dropdown.addOption(effort.value, effort.label);
        }
        if (
          configuredEffort !== MODEL_DEFAULT_REASONING_SELECTION
          && !selectedModel?.reasoningEfforts.some(
            effort => effort.value === configuredEffort,
          )
        ) {
          dropdown.addOption(
            configuredEffort,
            `Unavailable (${configuredEffort})`,
          );
        }
        dropdown.setValue(configuredEffort);
        dropdown.onChange(value => {
          void this.updateReasoningEffort(value);
        });
      });

    if (selectedModel) {
      const effectiveEffort = configuredEffort === MODEL_DEFAULT_REASONING_SELECTION
        || !selectedModel.reasoningEfforts.some(
          effort => effort.value === configuredEffort,
        )
        ? selectedModel.defaultReasoningEffort
        : configuredEffort;
      new Setting(containerEl)
        .setName('Resolved next conversation')
        .setDesc(
          `${selectedModel.label} · ${this.formatEffort(effectiveEffort)}. `
            + 'This concrete pair will be stored when a new conversation starts.',
        );
    }
  }

  private renderRuntimeSettings(): void {
    const { containerEl } = this;
    new Setting(containerEl).setName('Codex runtime').setHeading();
    const current = new Setting(containerEl)
      .setName('Selected executable')
      .setDesc('Resolving the executable used by this Windy session…');
    void this.getExecutable().then(executable => {
      current.setDesc(executable === 'codex'
        ? 'codex (resolved through PATH)'
        : executable ?? 'Not available');
    }).catch(error => {
      current.setDesc(error instanceof Error ? error.message : String(error));
    });
    let draft = getCodexProviderSettings(this.settings).cliPath;
    const setting = new Setting(containerEl)
      .setName('Codex executable')
      .setDesc('Leave empty to prefer the desktop app on macOS, then PATH. '
        + 'An explicit executable overrides automatic selection. Reload Windy after saving.')
      .addText(text => {
        text.setPlaceholder('Automatic').setValue(draft);
        text.onChange(value => { draft = value; });
      });
    setting.addButton(button => {
      button.setButtonText('Save').onClick(() => {
        button.setDisabled(true);
        void this.saveExecutable(draft.trim()).finally(() => button.setDisabled(false));
      });
    });
    const desktop = findDesktopCodex();
    if (desktop) {
      new Setting(containerEl)
        .setName('Use desktop app Codex')
        .setDesc(desktop)
        .addButton(button => {
          button.setButtonText('Use desktop app').onClick(() => {
            button.setDisabled(true);
            void this.saveExecutable(desktop).finally(() => button.setDisabled(false));
          });
        });
    }
  }

  private async saveExecutable(cliPath: string): Promise<void> {
    if (this.savingExecutable) {
      return;
    }
    this.savingExecutable = true;
    const codex = this.settings.providerConfigs.codex ??= {};
    const previous = codex.cliPath;
    codex.cliPath = cliPath;
    try {
      await this.save(this.settings);
      new Notice('Codex executable saved. Reload Windy to apply it.');
      this.display();
    } catch (error) {
      codex.cliPath = previous;
      new Notice(`Could not save Codex executable: ${
        error instanceof Error ? error.message : String(error)
      }`);
    } finally {
      this.savingExecutable = false;
    }
  }

  private async updateModel(
    value: string,
    options: ConversationModelOption[],
  ): Promise<void> {
    this.settings.newConversationModel = value;
    const model = value === CODEX_DEFAULT_MODEL_SELECTION
      ? options.find(option => option.isDefault) ?? options[0]
      : options.find(option => option.value === value);
    if (
      this.settings.newConversationReasoningEffort
        !== MODEL_DEFAULT_REASONING_SELECTION
      && !model?.reasoningEfforts.some(
        effort => effort.value === this.settings.newConversationReasoningEffort,
      )
    ) {
      this.settings.newConversationReasoningEffort
        = MODEL_DEFAULT_REASONING_SELECTION;
    }
    await this.persistAndRender();
  }

  private async updateReasoningEffort(value: string): Promise<void> {
    this.settings.newConversationReasoningEffort = value;
    await this.persistAndRender();
  }

  private async persistAndRender(): Promise<void> {
    try {
      await this.save(this.settings);
      this.display();
    } catch (error) {
      new Notice(`Could not save Windy settings: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  private formatEffort(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
