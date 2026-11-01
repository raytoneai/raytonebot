export type PermissionMode = "request" | "auto" | "allow-all";
import { useEffect, useRef, useState } from "react";

import { type SettingsCopy } from "../../i18n/copy/settings";
import { useCopy } from "../../i18n/LocaleContext";
import { AGENT_PRESETS } from "../../pi/harnessCatalog";
import { clearApprovalMemory, type PiRuntimeState } from "../../pi/piClient";
import { useBotNames } from "../shell/ShellExtras";
import { Button } from "../ui";
import { CopyButton, Dot } from "./SettingsShared";

export function PermissionsSection({ t, runtime, permissionDefault, onPermissionDefaultChange }: { t: SettingsCopy; runtime?: PiRuntimeState; permissionDefault?: PermissionMode; onPermissionDefaultChange: (mode: PermissionMode | undefined) => void }) {
  const frame = useCopy().composer.frame;
  const label = (mode: PermissionMode) =>
    mode === "request" ? frame.toolPermissionRequest : mode === "auto" ? frame.toolPermissionAuto : frame.toolPermissionAllowAll;
  const hint = (mode: PermissionMode) =>
    mode === "request" ? frame.toolPermissionRequestHint : mode === "auto" ? frame.toolPermissionAutoHint : frame.toolPermissionAllowAllHint;
  const hostMode = runtime?.defaultPermissionMode ?? "request";
  const current = permissionDefault ?? "host";
  return (
    <>
      <p className="settings-intro">{t.permissions.intro}</p>
      <div className="settings-list">
        {(["host", "request", "auto", "allow-all"] as const).map((mode) => (
          <label className="settings-row settings-radio-row" key={mode} data-selected={current === mode}>
            <input
              type="radio"
              name="permission-default"
              checked={current === mode}
              onChange={() => onPermissionDefaultChange(mode === "host" ? undefined : mode)}
            />
            <span className="settings-row-main">
              <span className="settings-row-title"><strong>{mode === "host" ? t.permissions.hostDefault(label(hostMode)) : label(mode)}</strong></span>
              <span className="settings-row-sub">{mode === "host" ? t.permissions.hostHint : hint(mode)}</span>
              {mode === "allow-all" ? <span className="settings-status" data-tone="error"><Dot />{t.permissions.allowAllWarning}</span> : null}
            </span>
          </label>
        ))}
      </div>
      <h3 className="settings-subhead">{t.permissions.workspace}</h3>
      <WorkspaceList t={t} runtime={runtime} />
      <h3 className="settings-subhead">{t.permissions.alwaysTitle}</h3>
      <p className="settings-intro">{t.permissions.alwaysHint}</p>
      <AlwaysAllowedList t={t} runtime={runtime} />
      <h3 className="settings-subhead">{t.permissions.secretTitle}</h3>
      <p className="settings-intro">{t.permissions.secretHint}</p>
      <PermissionPathDetails t={t} paths={runtime?.secretPaths ?? []} />
      <h3 className="settings-subhead">{t.permissions.protectedTitle}</h3>
      <p className="settings-intro">{t.permissions.protectedHint}</p>
      <PermissionPathDetails t={t} paths={runtime?.protectedPaths ?? []} />
      {runtime?.readOnlyPaths?.length ? (
        <>
          <h3 className="settings-subhead">{t.permissions.readOnlyTitle}</h3>
          <p className="settings-intro">{t.permissions.readOnlyHint}</p>
          <PermissionPathDetails t={t} paths={runtime.readOnlyPaths} />
        </>
      ) : null}
    </>
  );
}

function PermissionPathDetails({ t, paths }: { t: SettingsCopy; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <details className="settings-permission-paths">
      <summary>{t.permissions.showPaths(paths.length)}</summary>
      <div className="settings-list settings-code-list">
        {paths.map((path) => <code key={path}>{path}</code>)}
      </div>
    </details>
  );
}

function AlwaysAllowedList({ t, runtime }: { t: SettingsCopy; runtime?: PiRuntimeState }) {
  const botNames = useBotNames();
  const [granted, setGranted] = useState<Record<string, string[]>>(runtime?.alwaysAllowed ?? {});
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => setGranted(runtime?.alwaysAllowed ?? {}), [runtime?.alwaysAllowed]);
  const clear = async (preset: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(preset);
    setFailed(undefined);
    try {
      const next = await clearApprovalMemory(preset);
      if (!mounted.current) return;
      setGranted(next);
    } catch {
      if (mounted.current) setFailed(preset);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(undefined);
    }
  };
  const agents = AGENT_PRESETS.filter((preset) => granted[preset.id]?.length);
  if (agents.length === 0) return <p className="settings-intro">{t.permissions.alwaysEmpty}</p>;
  return (
    <div className="settings-list">
      {agents.map((preset) => (
        <div className="settings-row" key={preset.id}>
          <span className="settings-row-main">
            <span className="settings-row-title"><strong>{botNames[preset.id]}</strong></span>
            <span className="settings-row-sub">{granted[preset.id].join(", ")}</span>
            {pending === preset.id ? <span className="settings-row-sub" role="status">{t.permissions.alwaysClearing}</span> : null}
            {failed === preset.id ? <span className="settings-row-sub" role="alert">{t.permissions.alwaysClearFailed}</span> : null}
          </span>
          <Button size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void clear(preset.id)}>
            {failed === preset.id ? t.permissions.alwaysRetry : pending === preset.id ? t.permissions.alwaysClearing : t.permissions.alwaysClear}
          </Button>
        </div>
      ))}
    </div>
  );
}

function WorkspaceList({ t, runtime }: { t: SettingsCopy; runtime?: PiRuntimeState }) {
  const botNames = useBotNames();
  const agents = runtime?.workspace?.agents ?? {};
  const rows: [string, string, string][] = [
    ...AGENT_PRESETS.map((preset): [string, string, string] => [preset.id, botNames[preset.id], agents[preset.id] ?? runtime?.cwd ?? "—"]),
    ...(runtime?.workspace?.shared ? [["shared", t.permissions.shared, runtime.workspace.shared] as [string, string, string]] : []),
  ];
  return (
    <div className="settings-list">
      {rows.map(([id, label, path]) => (
        <div className="settings-row settings-about-row" key={id}>
          <span className="settings-about-label">{label}</span>
          <code>{path}</code>
          {path !== "—" ? <CopyButton t={t.about} value={path} /> : null}
        </div>
      ))}
    </div>
  );
}
