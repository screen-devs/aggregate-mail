import { Segmented } from "../ui/Segmented";
import { useContext, useEffect, useId, useState } from "react";
import { PrivacyContext } from "../ui/Privacy";
import { mailNotice } from "../../shared/notifications";
import { notificationDefaults, type NotificationPreferences } from "../notifications";

export function NotificationSettings({ value, onChange, onPreview }: {
  value: NotificationPreferences;
  onChange: (value: NotificationPreferences) => void;
  onPreview: () => void;
}) {
  const prefix = useId();
  const { on: privacy } = useContext(PrivacyContext);
  const [preview, setPreview] = useState(false);
  const bridge = window.desktop?.notifications;
  const [custom, setCustom] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void bridge?.audio("status").then((result) => { if (active) setCustom(result.custom); }).catch(() => { if (active) setError("Notification audio is unavailable."); });
    return () => { active = false; };
  }, [bridge]);
  const audio = async (command: "choose" | "remove") => {
    if (!bridge || audioBusy) return;
    setAudioBusy(true); setError("");
    try {
      const result = await bridge.audio(command);
      setCustom(result.custom);
      if (result.error) setError(result.error);
      else if (command === "choose" && result.imported) onChange({ ...value, sound: "custom" });
      else if (command === "remove") onChange({ ...value, sound: "system" });
    } catch { setError("Notification audio could not be changed."); }
    finally { setAudioBusy(false); }
  };
  return <section aria-label="Notification settings">
    <p className="note">Choose how new mail gets your attention. Errors stay visible until dismissed.</p>
    <div className="settings-group">
      <label className="settings-row"><span>In-app new mail</span><input type="checkbox" role="switch" checked={value.newMail}
        onChange={(event) => onChange({ ...value, newMail: event.target.checked })} /></label>
      <label className="settings-row"><span>Action confirmations</span><input type="checkbox" role="switch" checked={value.confirmations}
        onChange={(event) => onChange({ ...value, confirmations: event.target.checked })} /></label>
      <div className="settings-row stacked"><span id={`${prefix}-position`}>Position</span>
        <Segmented labelledBy={`${prefix}-position`} value={value.position}
          choices={[{ id: "bottom-right", label: "Bottom right" }, { id: "bottom-center", label: "Bottom center" }, { id: "top-right", label: "Top right" }]}
          onChange={(position) => onChange({ ...value, position })} /></div>
      <div className="settings-row stacked"><span id={`${prefix}-duration`}>Duration</span>
        <Segmented labelledBy={`${prefix}-duration`} value={value.duration}
          choices={[{ id: 3000, label: "3 seconds" }, { id: 6000, label: "6 seconds" }, { id: 10000, label: "10 seconds" }, { id: 0, label: "Until dismissed" }]}
          onChange={(duration) => onChange({ ...value, duration })} /></div>
    </div>
    <div className="settings-group">
      {([ ["desktop", "Desktop new mail"], ["sender", "Show sender"], ["subject", "Show subject"], ["preview", "Show email preview"], ["openMail", "Click to open the email"] ] as const).map(([key, label]) =>
        <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" role="switch" checked={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.checked })} /></label>)}
      <div className="settings-row stacked"><span id={`${prefix}-sound`}>New-mail sound</span>
        <Segmented labelledBy={`${prefix}-sound`} value={value.sound}
          choices={[{ id: "system", label: "System default" }, { id: "off", label: "Off" }, { id: "custom", label: "Custom audio" }]}
          disabled={(sound) => audioBusy || sound === "custom" && !custom}
          onChange={(sound) => onChange({ ...value, sound })} /></div>
      <div className="settings-row"><span>{custom ? "Custom audio selected" : "Local audio file"}</span><div>
        <button type="button" className="button" disabled={!bridge || audioBusy} onClick={() => void audio("choose")}>Choose audio file</button>{" "}
        {custom && <button type="button" className="button" disabled={audioBusy} onClick={() => void audio("remove")}>Remove audio</button>}
      </div></div>
    </div>
    <p className="note">Choose a WAV, MP3 or Ogg file up to 2 MB. Playback stops after 30 seconds. Custom audio requires the desktop app and replaces the system sound, including while the window is hidden.</p>
    {error && <p role="alert" className="note">{error}</p>}
    {preview && <div className="notification-preview" role="status" aria-label="Notification preview settings">
      <strong>{value.newMail || value.desktop ? "New-mail preview" : "New-mail notifications are off"}</strong>
      {(value.newMail || value.desktop) && <p>{mailNotice({ id: "sample", sender: "Sample sender", subject: "Sample subject", preview: "A short sample email preview." }, value, privacy)}</p>}
      <dl><dt>In-app</dt><dd>{value.newMail ? `${value.position.replaceAll("-", " ")} · ${value.duration ? `${value.duration / 1000} seconds` : "until dismissed"}` : "Off"}</dd>
        <dt>Desktop</dt><dd>{value.desktop ? bridge ? "On" : "Requires the desktop app" : "Off"}</dd>
        <dt>Sound</dt><dd>{!value.newMail && !value.desktop ? "Off" : value.sound === "off" ? "Off" : value.sound === "custom" ? "Custom audio" : "System default"}</dd>
        <dt>Details</dt><dd>{privacy ? "Hidden by privacy mode" : [value.sender && "Sender", value.subject && "Subject", value.preview && "Preview"].filter(Boolean).join(", ") || "Hidden"}</dd>
        <dt>Open email</dt><dd>{value.openMail ? "On" : "Off"}</dd>
        <dt>Confirmations</dt><dd>{value.confirmations ? "On" : "Off"}</dd></dl>
    </div>}
    <button type="button" className="button settings-action" onClick={() => { setPreview(true); onPreview(); }}>Preview notification</button>{" "}
    <button type="button" className="button settings-action" disabled={audioBusy} onClick={async () => {
      if (bridge) {
        setAudioBusy(true);
        try {
          const result = await bridge.audio("remove");
          if (result.error) { setError(result.error); return; }
          setCustom(false);
        } catch { setError("Notification audio could not be reset."); return; }
        finally { setAudioBusy(false); }
      }
      onChange({ ...notificationDefaults });
    }}>Reset notification defaults</button>
  </section>;
}
