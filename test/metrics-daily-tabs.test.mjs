import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyTabsScript, setupDailyTabs } from '../src/metrics-daily-tabs.mjs';

class Element {
  constructor(id, panelId = null) { this.id = id; this.panelId = panelId; this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; this.focused = false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return name === 'aria-controls' ? this.panelId : this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  focus() { this.focused = true; }
  dispatch(type, key) { let prevented = false; this.listeners.get(type)?.({ key, preventDefault() { prevented = true; } }); return prevented; }
}
function fixture() {
  const token = new Element('token-tab', 'token-panel'), mcp = new Element('mcp-tab', 'mcp-panel');
  const tokenPanel = new Element('token-panel'), mcpPanel = new Element('mcp-panel');
  const byId = new Map([[tokenPanel.id, tokenPanel], [mcpPanel.id, mcpPanel]]);
  return { token, mcp, tokenPanel, mcpPanel, document: { querySelectorAll: selector => selector === '[role="tab"]' ? [token, mcp] : [], getElementById: id => byId.get(id) ?? null } };
}

test('tab controller defaults to Token and click synchronizes selected, tabindex, hidden and focus', () => {
  const dom = fixture(); setupDailyTabs(dom.document);
  assert.deepEqual([dom.token.getAttribute('aria-selected'), dom.token.getAttribute('tabindex'), dom.tokenPanel.hidden], ['true', '0', false]);
  assert.deepEqual([dom.mcp.getAttribute('aria-selected'), dom.mcp.getAttribute('tabindex'), dom.mcpPanel.hidden], ['false', '-1', true]);
  dom.mcp.dispatch('click');
  assert.deepEqual([dom.token.getAttribute('aria-selected'), dom.token.getAttribute('tabindex'), dom.tokenPanel.hidden], ['false', '-1', true]);
  assert.deepEqual([dom.mcp.getAttribute('aria-selected'), dom.mcp.getAttribute('tabindex'), dom.mcpPanel.hidden, dom.mcp.focused], ['true', '0', false, true]);
});

test('tab controller supports arrows, Home and End with wrapping', () => {
  for (const [start, key, selected] of [['token', 'ArrowRight', 'mcp'], ['token', 'ArrowLeft', 'mcp'], ['mcp', 'ArrowRight', 'token'], ['mcp', 'Home', 'token'], ['token', 'End', 'mcp']]) {
    const dom = fixture(); setupDailyTabs(dom.document); if (start === 'mcp') dom.mcp.dispatch('click');
    const source = start === 'mcp' ? dom.mcp : dom.token;
    assert.equal(source.dispatch('keydown', key), true);
    assert.equal(dom[selected].getAttribute('aria-selected'), 'true'); assert.equal(dom[selected].focused, true);
  }
});

test('embedded controller is fixed author code without data or network sinks', () => {
  assert.match(dailyTabsScript, /setupDailyTabs|aria-selected/);
  assert.doesNotMatch(dailyTabsScript, /innerHTML|outerHTML|insertAdjacentHTML|fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//i);
});

test('three peer tabs keep timeline exclusive and keyboard navigation wraps across all three',()=>{
 const tabs=['token','mcp','timeline'].map(id=>new Element(id+'-tab',id+'-panel'));
 const panels=tabs.map(tab=>new Element(tab.panelId));
 const doc={querySelectorAll:()=>tabs,getElementById:id=>panels.find(panel=>panel.id===id)};
 setupDailyTabs(doc);
 tabs[0].dispatch('keydown','End');
 assert.deepEqual(panels.map(panel=>panel.hidden),[true,true,false]);
 assert.deepEqual(tabs.map(tab=>tab.getAttribute('aria-selected')),['false','false','true']);
 tabs[2].dispatch('keydown','ArrowRight');
 assert.deepEqual(panels.map(panel=>panel.hidden),[false,true,true]);
 tabs[0].dispatch('keydown','ArrowLeft');
 assert.equal(panels[2].hidden,false);
 tabs[2].dispatch('keydown','Home');
 assert.equal(panels[0].hidden,false);
});
