export type AppWorkspace = "viewer" | "animation";

type WorkspaceSwitcherProps = {
  value: AppWorkspace;
  onChange: (workspace: AppWorkspace) => void;
};

export default function WorkspaceSwitcher({ value, onChange }: WorkspaceSwitcherProps) {
  return (
    <div className="workspace-switcher" role="group" aria-label="Workspace">
      <button
        type="button"
        className={value === "viewer" ? "is-active" : ""}
        aria-pressed={value === "viewer"}
        onClick={() => onChange("viewer")}
      >
        Viewer
      </button>
      <button
        type="button"
        className={value === "animation" ? "is-active" : ""}
        aria-pressed={value === "animation"}
        onClick={() => onChange("animation")}
      >
        <span className="workspace-label-desktop">Animation Workshop</span>
        <span className="workspace-label-mobile">Animation</span>
      </button>
    </div>
  );
}
