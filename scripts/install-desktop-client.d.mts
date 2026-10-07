export function desktopWrapper(options: { shim: string; desktop: string; codex: string }): string;
export function installDesktopClient(options?: {
  root?: string;
  home?: string;
  desktop?: string;
  codex?: string;
  systemDesktopFile?: string;
  uninstall?: boolean;
}): Promise<{
  wrapper: string;
  entry: string;
  defaultEntry: string;
  shim: string;
  requiresManualDesktopRestart: boolean;
} | { removed: boolean }>;
