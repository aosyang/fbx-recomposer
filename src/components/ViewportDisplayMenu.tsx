export type MaterialRenderMode = "material" | "solid";

type ViewportDisplayMenuProps = {
  className?: string;
  open: boolean;
  hasBones: boolean;
  hasSelectedBone: boolean;
  showBones: boolean;
  showBoneName: boolean;
  materialRenderMode: MaterialRenderMode;
  onOpenChange: (open: boolean) => void;
  onShowBonesChange: (show: boolean) => void;
  onShowBoneNameChange: (show: boolean) => void;
  onMaterialRenderModeChange: (mode: MaterialRenderMode) => void;
};

export default function ViewportDisplayMenu({
  className = "",
  open,
  hasBones,
  hasSelectedBone,
  showBones,
  showBoneName,
  materialRenderMode,
  onOpenChange,
  onShowBonesChange,
  onShowBoneNameChange,
  onMaterialRenderModeChange,
}: ViewportDisplayMenuProps) {
  return (
    <div
      className={`viewport-display ${className}`.trim()}
      aria-label="Viewport display controls"
    >
      <div
        className="display-menu"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          className={`display-menu-trigger ${open ? "is-open" : ""}`}
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => onOpenChange(!open)}
        >
          Display
          <span className="display-menu-chevron" aria-hidden="true" />
        </button>
        {open && (
          <div className="display-menu-popover" role="menu">
            <button
              className={`display-menu-item ${showBones ? "is-active" : ""}`}
              type="button"
              role="menuitemcheckbox"
              aria-checked={showBones}
              disabled={!hasBones}
              title={hasBones ? "Toggle skeleton overlay" : "This model has no bones"}
              onClick={() => onShowBonesChange(!showBones)}
            >
              <span className="display-check" aria-hidden="true" />
              Bones
            </button>
            <button
              className={`display-menu-item ${showBoneName ? "is-active" : ""}`}
              type="button"
              role="menuitemcheckbox"
              aria-checked={showBoneName}
              title={
                hasSelectedBone
                  ? "Show the selected bone name in the viewport"
                  : "Show selected bone names when a bone is selected"
              }
              onClick={() => onShowBoneNameChange(!showBoneName)}
            >
              <span className="display-check" aria-hidden="true" />
              Bone Names
            </button>
            <div className="display-menu-separator" role="separator" />
            <div className="display-menu-label">Material</div>
            <button
              className={`display-menu-item ${
                materialRenderMode === "material" ? "is-active" : ""
              }`}
              type="button"
              role="menuitemradio"
              aria-checked={materialRenderMode === "material"}
              onClick={() => onMaterialRenderModeChange("material")}
            >
              <span className="display-radio" aria-hidden="true" />
              Original Materials
            </button>
            <button
              className={`display-menu-item ${
                materialRenderMode === "solid" ? "is-active" : ""
              }`}
              type="button"
              role="menuitemradio"
              aria-checked={materialRenderMode === "solid"}
              onClick={() => onMaterialRenderModeChange("solid")}
            >
              <span className="display-radio" aria-hidden="true" />
              Solid Color
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
