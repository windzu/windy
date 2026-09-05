import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface CodexExecutableOptions {
  cliPath?: string;
  isWsl?: boolean;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  isExecutable?: (candidate: string) => boolean;
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findDesktopCodex(
  options: CodexExecutableOptions = {},
): string | null {
  if (options.isWsl || (options.platform ?? process.platform) !== 'darwin') {
    return null;
  }
  const home = options.homeDirectory ?? homedir();
  const isExecutable = options.isExecutable ?? isExecutableFile;
  for (const app of ['ChatGPT.app', 'Codex.app']) {
    for (const directory of ['/Applications', path.join(home, 'Applications')]) {
      const candidate = path.join(directory, app, 'Contents', 'Resources', 'codex');
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function resolveCodexExecutable(
  options: CodexExecutableOptions = {},
): string {
  const configured = options.cliPath?.trim();
  if (configured) {
    if (
      !options.isWsl
      && /[/\\]/.test(configured)
      && !(options.isExecutable ?? isExecutableFile)(configured)
    ) {
      throw new Error(
        `The configured Codex executable is unavailable: ${configured}. `
        + 'Update the Codex executable setting in Windy.',
      );
    }
    return configured;
  }
  return findDesktopCodex(options) ?? 'codex';
}

export function formatCodexRuntimeError(
  error: unknown,
  executable?: string,
  userAgent?: string,
): string {
  const message = error instanceof Error ? error.message : 'Unknown Codex error';
  if (!message.includes('paginated_threads is not supported yet')) {
    return message;
  }
  const runtime = [executable, userAgent].filter(Boolean).join(' · ');
  return 'This Codex runtime cannot restore the conversation’s paginated history. '
    + (runtime ? `Runtime: ${runtime}. ` : '')
    + 'Select a compatible desktop-app Codex executable in Windy settings, '
    + 'then reload Windy and retry this conversation. The saved history has been kept.';
}
