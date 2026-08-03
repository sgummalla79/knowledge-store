/**
 * App shell: window chrome + navigation, independent of any page's business logic.
 *
 * Owns exactly two things:
 *  - Sidebar nav → view switching (which `.view` section is visible), announced via a
 *    `view-changed` CustomEvent on `document` so page-specific code (main.ts) can react without
 *    this module needing to know what any given view actually does.
 *  - The collapse/expand toggle next to the traffic lights, including its
 *    collapsed-state hover flyout
 *
 * Positioning/z-index here must stay in sync with the `.drag-region` /
 * `.collapse-toggle` rules in styles.css (which mirror pragna2_desktop_app's
 * AppTitleBar.tsx + TitlebarCollapseToggle.tsx geometry).
 */

const FLYOUT_CLOSE_DELAY_MS = 200;

export function initShell() {
  initSidebarNav();
  initCollapseToggle();
  initSidebarSettingsMenu();
}

function initSidebarNav() {
  document.querySelectorAll<HTMLButtonElement>(".sidebar-item").forEach((item) => {
    item.addEventListener("click", () => {
      const targetView = item.dataset.view;
      if (targetView) switchToView(targetView);
    });
  });
}

// Exported so main.ts can drive the same view switch from dynamically-rendered rows that aren't
// present in the DOM yet when initSidebarNav wires up the static ones at startup (the sidebar's
// per-library tree rows, and the Knowledge page's own library list rows) — re-queries .sidebar-item
// fresh every call rather than relying on a closure-captured list, so it stays correct as rows are
// added/removed. Static .sidebar-item elements get "active" here based on data-view matching;
// dynamic per-library rows all share data-view="library" (there's no static view per library) and
// so are deliberately never matched here — main.ts manages which specific library row is active
// separately, since that's data this module has no reason to know about.
export function switchToView(viewId: string) {
  document.querySelectorAll<HTMLButtonElement>(".sidebar-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewId);
  });
  document.querySelectorAll<HTMLElement>(".view").forEach((view) => {
    view.hidden = view.id !== `view-${viewId}`;
  });
  document.dispatchEvent(new CustomEvent("view-changed", { detail: { view: viewId } }));
}

// Bottom-anchored "Settings" row that pops its menu open above itself (Configuration is the only
// entry today) rather than sitting inline as its own permanent nav section. The Configuration
// button inside keeps the plain .sidebar-item class, so initSidebarNav's own click handling
// (view switch + active state) applies to it unchanged — this only owns open/close of the popover
// around it.
function initSidebarSettingsMenu() {
  const trigger = document.querySelector<HTMLButtonElement>("#sidebar-settings-trigger")!;
  const menu = document.querySelector<HTMLElement>("#sidebar-settings-menu")!;

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  }

  trigger.addEventListener("click", (event) => {
    // Stops this same click from immediately reaching the document listener below and closing
    // the menu it just opened.
    event.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  // Any other click in the app — including a menu item, which switches views — closes the popover.
  document.addEventListener("click", () => {
    if (!menu.hidden) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) closeMenu();
  });
}

function initCollapseToggle() {
  const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
  const toggle = document.querySelector<HTMLButtonElement>("#collapse-toggle")!;
  let flyoutHideTimer: number | undefined;

  function showFlyout() {
    if (!sidebar.classList.contains("collapsed")) return;
    window.clearTimeout(flyoutHideTimer);
    sidebar.classList.add("flyout-visible");
  }

  function scheduleHideFlyout() {
    window.clearTimeout(flyoutHideTimer);
    flyoutHideTimer = window.setTimeout(() => {
      sidebar.classList.remove("flyout-visible");
    }, FLYOUT_CLOSE_DELAY_MS);
  }

  toggle.addEventListener("click", () => {
    const collapsed = !sidebar.classList.contains("collapsed");
    sidebar.classList.toggle("collapsed", collapsed);
    toggle.classList.toggle("state-collapsed", collapsed);
    sidebar.classList.remove("flyout-visible");
  });

  toggle.addEventListener("mouseenter", showFlyout);
  toggle.addEventListener("mouseleave", scheduleHideFlyout);
  sidebar.addEventListener("mouseenter", showFlyout);
  sidebar.addEventListener("mouseleave", scheduleHideFlyout);
}
