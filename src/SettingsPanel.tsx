import type { ReactElement } from 'react'
import CloudCredentials from './CloudCredentials'
import { clampZoom, MAX_ZOOM, MIN_ZOOM, type Settings, type ThemeMode } from './settings'

type SettingsPanelProps = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'System default', value: '' },
  { label: 'Cascadia / Consolas', value: "'Cascadia Code', Cascadia, Consolas, monospace" },
  { label: 'Menlo / Monaco', value: "Menlo, Monaco, 'DejaVu Sans Mono', monospace" },
  { label: 'DejaVu Sans Mono (Linux)', value: "'DejaVu Sans Mono', monospace" },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" }
]

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: 'Follow OS', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' }
]

// Preference drawer rendered at the bottom of the left sidebar. The sidebar keeps
// a hardcoded light background in both OS themes, so controls use explicit colors.
const SettingsPanel = ({ settings, onChange, onReset }: SettingsPanelProps): ReactElement => (
  <div className="settings-drawer">
    <label className="settings-row" htmlFor="settings-zoom">
      <span>Code zoom</span>
      <input
        id="settings-zoom"
        type="range"
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        step={10}
        value={settings.zoom}
        onChange={e => onChange({ zoom: clampZoom(Number(e.target.value)) })}
      />
    </label>
    <span className="settings-value">{settings.zoom}%</span>

    <label className="settings-row settings-check" htmlFor="settings-wrap">
      <input
        id="settings-wrap"
        type="checkbox"
        checked={settings.wordWrap}
        onChange={e => onChange({ wordWrap: e.target.checked })}
      />
      <span>Word wrap</span>
    </label>

    <label className="settings-row settings-col" htmlFor="settings-font">
      <span>Font family</span>
      <select id="settings-font" value={settings.fontFamily} onChange={e => onChange({ fontFamily: e.target.value })}>
        {FONT_OPTIONS.map(o => (
          <option key={o.label} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>

    <label className="settings-row settings-col" htmlFor="settings-theme">
      <span>Theme</span>
      <select id="settings-theme" value={settings.theme} onChange={e => onChange({ theme: e.target.value as ThemeMode })}>
        {THEME_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>

    <button type="button" className="settings-reset" onClick={onReset}>
      Reset to defaults
    </button>

    {/* Cloud credential registration (global encrypted store; login happens from the Terraform panel). */}
    <CloudCredentials />
  </div>
)

export default SettingsPanel
