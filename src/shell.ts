/**
 * App shell: window chrome + navigation, independent of any page's business logic.
 *
 * Owns exactly two things:
 *  - Sidebar nav → view switching (which `.view` section is visible)
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
}

function initSidebarNav() {
  const sidebarItems = document.querySelectorAll<HTMLButtonElement>(".sidebar-item");
  sidebarItems.forEach((item) => {
    item.addEventListener("click", () => {
      const targetView = item.dataset.view;
      sidebarItems.forEach((other) => other.classList.toggle("active", other === item));
      document.querySelectorAll<HTMLElement>(".view").forEach((view) => {
        view.hidden = view.id !== `view-${targetView}`;
      });
    });
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
