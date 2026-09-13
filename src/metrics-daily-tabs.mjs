export function setupDailyTabs(document) {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  if (tabs.length < 2 || panels.some(panel => panel === null)) return;
  const activate = (index, moveFocus) => {
    tabs.forEach((tab, itemIndex) => {
      const active = itemIndex === index;
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
      panels[itemIndex].hidden = !active;
    });
    if (moveFocus) tabs[index].focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(index, true));
    tab.addEventListener('keydown', event => {
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault(); activate(next, true);
    });
  });
  const selected = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
  activate(selected < 0 ? 0 : selected, false);
}

export const dailyTabsScript = `(${setupDailyTabs.toString()})(document);`;
