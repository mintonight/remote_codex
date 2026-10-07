export interface DesktopIdentity { pid: number; startedTicks: string; executable: string; }
export function desktopProcess(pid: number): Promise<(DesktopIdentity & { parentPid: number; main: boolean; shared: boolean; appServer: boolean }) | null>;
export function matchesDesktop(actual: (DesktopIdentity & { main: boolean }) | null, expected: DesktopIdentity): boolean;
export function desktopAttachment(raw: string, since: number): { servicePid: number; appServerPid: number; clientKind: string } | null;
export function restartDesktopClient(expected: DesktopIdentity, launcher: string, receipt: string): Promise<void>;
