import type { MouseEvent } from "react";

type FileMenuProps = {
  canSave: boolean;
  onOpenAssetFolder: () => void;
  onOpenFbxFile: () => void;
  onSaveFbx: () => void;
};

function closeMenu(event: MouseEvent<HTMLButtonElement>) {
  const details = event.currentTarget.closest("details");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

export default function FileMenu({
  canSave,
  onOpenAssetFolder,
  onOpenFbxFile,
  onSaveFbx,
}: FileMenuProps) {
  return (
    <details className="open-model-menu">
      <summary
        className="primary-button open-model-trigger"
        aria-label="File menu"
      >
        File
        <span className="display-menu-chevron" aria-hidden="true" />
      </summary>
      <div className="open-model-menu-panel">
        <button
          type="button"
          className="open-model-menu-item"
          onClick={(event) => {
            onOpenAssetFolder();
            closeMenu(event);
          }}
        >
          <span className="open-model-menu-title">Open Asset Folder</span>
          <span className="open-model-menu-description">
            Load an FBX with its textures automatically
          </span>
        </button>
        <button
          type="button"
          className="open-model-menu-item"
          onClick={(event) => {
            onOpenFbxFile();
            closeMenu(event);
          }}
        >
          <span className="open-model-menu-title">Open FBX File</span>
          <span className="open-model-menu-description">
            Load a single FBX file
          </span>
        </button>
        <div className="open-model-menu-separator" role="separator" />
        <button
          type="button"
          className="open-model-menu-item"
          disabled={!canSave}
          title={
            canSave
              ? "Choose which FBX contents to export"
              : "Load an exportable character or animation first"
          }
          onClick={(event) => {
            onSaveFbx();
            closeMenu(event);
          }}
        >
          <span className="open-model-menu-title">Save FBX</span>
          <span className="open-model-menu-description">
            Export the character, current animation, or both
          </span>
        </button>
      </div>
    </details>
  );
}
