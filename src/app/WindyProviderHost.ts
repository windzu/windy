import type { App } from 'obsidian';

import type { ProviderHost } from '../core/providers/ProviderHost';
import type {
  ProviderCliResolutionContext,
  ProviderId,
} from '../core/providers/types';
import type { WindySettings } from '../core/types';
import { getCodexProviderSettings } from '../providers/codex/settings';
import { resolveCodexExecutable } from '../providers/codex/runtime/CodexExecutableResolver';
import type { CodexExecutionTarget } from '../providers/codex/runtime/codexLaunchTypes';

export class WindyProviderHost implements ProviderHost {
  private readonly executableByTarget = new Map<string, string>();

  constructor(
    readonly app: App,
    readonly settings: WindySettings,
    readonly manifest: { version?: string },
  ) {}

  getActiveEnvironmentVariables(providerId: ProviderId): string {
    const shared = this.settings.sharedEnvironmentVariables.trim();
    const provider = providerId === 'codex'
      ? getCodexProviderSettings(this.settings).environmentVariables.trim()
      : '';
    return [shared, provider].filter(Boolean).join('\n');
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCliResolutionContext,
  ): Promise<string | null> {
    if (providerId !== 'codex') {
      return null;
    }
    const target = context?.executionTarget as CodexExecutionTarget | undefined;
    const key = target?.method === 'wsl' ? `wsl:${target.distroName ?? ''}` : 'native';
    const previous = this.executableByTarget.get(key);
    if (previous) {
      return previous;
    }
    const executable = resolveCodexExecutable({
      cliPath: getCodexProviderSettings(this.settings).cliPath,
      isWsl: target?.method === 'wsl',
    });
    // Keep active sessions on one executable until the plugin is reloaded.
    this.executableByTarget.set(key, executable);
    return executable;
  }
}
