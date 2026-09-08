export type TopbarMenuId = "file" | "lan";

export const TOPBAR_MENU_EVENT = "fbx-topbar-menu";

export function announceTopbarMenu(menu: TopbarMenuId) {
  window.dispatchEvent(new CustomEvent<TopbarMenuId>(TOPBAR_MENU_EVENT, { detail: menu }));
}

export function closeOpenFileMenus() {
  document
    .querySelectorAll<HTMLDetailsElement>("details.open-model-menu[open]")
    .forEach((details) => {
      details.open = false;
    });
}
