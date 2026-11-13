'use strict';

// This function is serialized into Chromium. Keep it self-contained and free of
// source imports, clocks, random values or judgments about visual aesthetics.
function inspectDOM(options = {}) {
  const findings = [];
  const round = number => Math.round(number * 100) / 100;
  const rect = element => {
    const box = element.getBoundingClientRect();
    return { x: round(box.x), y: round(box.y), w: round(box.width), h: round(box.height) };
  };
  const visible = element => {
    if (typeof element.checkVisibility === 'function'
      && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    for (let details = element.parentElement?.closest('details:not([open])'); details;
      details = details.parentElement?.closest('details:not([open])')) {
      const summary = [...details.children].find(child => child.tagName === 'SUMMARY');
      if (!summary || !summary.contains(element)) return false;
    }
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden'
      && style.display !== 'none' && style.opacity !== '0'
      && !element.closest('[hidden], [inert], [aria-hidden="true"], [data-ui-probe-ignore], canvas');
  };
  function selector(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    if (element.hasAttribute('data-testid')) return '[data-testid=' + JSON.stringify(element.getAttribute('data-testid')) + ']';
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const peers = [...parent.children].filter(peer => peer.tagName === current.tagName);
        if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }
  function styles(element) {
    const computed = getComputedStyle(element);
    return Object.fromEntries(['display', 'position', 'overflowX', 'overflowY', 'whiteSpace', 'minWidth', 'fontSize', 'lineHeight']
      .map(key => [key, computed[key]]));
  }
  function report(code, element, actual, expected, extra = {}) {
    findings.push({
      code, sev: 'P1', selector: selector(element), rect: rect(element), styles: styles(element),
      metric: { actual: round(actual), expected, unit: 'px' }, sourceHint: options.sourceHint || null,
      dictHit: ['H_OVERFLOW', 'TAP_TARGET', 'BTN_WRAP', 'MISALIGN_TOP', 'MISALIGN_BOTTOM'].includes(code),
      ...extra,
    });
  }
  function intentionalScroll(element) {
    for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      if (parent.hasAttribute('data-intent-scroll')) return true;
      const style = getComputedStyle(parent);
      if (/auto|scroll/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return true;
    }
    return false;
  }
  if (document.documentElement.scrollWidth > innerWidth + 2) {
    report('H_OVERFLOW', document.documentElement, document.documentElement.scrollWidth - innerWidth, 0, { sev: 'P0' });
  }
  const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"]')].filter(visible);
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    const labels = [control.closest('label'), ...(control.id ? document.querySelectorAll('label[for=' + JSON.stringify(control.id) + ']') : [])]
      .filter(label => label && visible(label));
    const hitBoxes = [box, ...labels.map(label => label.getBoundingClientRect())];
    const effectiveMinimum = Math.max(...hitBoxes.map(hitBox => Math.min(hitBox.width, hitBox.height)));
    if (effectiveMinimum < 24) report('TAP_TARGET', control, effectiveMinimum, 24);
    if (!intentionalScroll(control)) {
      let clipLeft = 0;
      let clipRight = innerWidth;
      let clippedBy = 'viewport';
      const card = control.closest('article');
      if (card) {
        const boundary = card.getBoundingClientRect();
        clipLeft = Math.max(clipLeft, boundary.left);
        clipRight = Math.min(clipRight, boundary.right);
        clippedBy = selector(card);
      }
      for (let parent = control.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/hidden|clip/.test(style.overflowX)) {
          const boundary = parent.getBoundingClientRect();
          clipLeft = Math.max(clipLeft, boundary.left);
          clipRight = Math.min(clipRight, boundary.right);
          clippedBy = selector(parent);
        }
      }
      const excess = Math.max(clipLeft - box.left, box.right - clipRight, 0);
      if (excess > 2) report('H_OVERFLOW', control, excess, 0, { clippedBy });
    }
    if (control.matches('button, [data-slot="button"], [role="button"]')) {
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      const lines = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || node.parentElement.closest('.sr-only, [aria-hidden="true"]')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const part of range.getClientRects()) {
          if (part.width > 2 && part.height > 2 && !lines.some(y => Math.abs(y - part.y) < 3)) lines.push(part.y);
        }
      }
      const style = getComputedStyle(control);
      const naturalMultiline = style.whiteSpace === 'normal'
        && control.scrollHeight <= control.clientHeight + 1
        && control.scrollWidth <= control.clientWidth + 1;
      if (lines.length > 1 && !naturalMultiline) report('BTN_WRAP', control, lines.length, 1, { metric: { actual: lines.length, expected: 1, unit: 'count' } });
    }
  }
  for (const rule of options.alignmentRules || []) {
    const groups = [...document.querySelectorAll(rule.groupSelector)].filter(visible);
    const rows = [];
    for (const group of groups) {
      const box = group.getBoundingClientRect();
      const target = group.querySelector(rule.targetSelector);
      if (!target || !visible(target)) throw new Error('Alignment target missing: ' + rule.groupSelector + ' -> ' + rule.targetSelector);
      let row = rows.find(item => item.parent === group.parentElement && Math.abs(item.top - box.top) <= (rule.rowTolerance || 3));
      if (!row) { row = { top: box.top, parent: group.parentElement, items: [] }; rows.push(row); }
      row.items.push(target);
    }
    for (const row of rows) {
      if (row.items.length < 2) continue;
      const values = row.items.map(item => item.getBoundingClientRect()[rule.edge]);
      const reference = Math.min(...values);
      for (let index = 0; index < row.items.length; index++) {
        const difference = values[index] - reference;
        if (difference > (rule.tolerance ?? 2)) report(rule.code, row.items[index], difference, rule.tolerance ?? 2, {
          sourceHint: rule.sourceHint || options.sourceHint || null,
          alignment: { edge: rule.edge, referenceSelector: selector(row.items[values.indexOf(reference)]) },
        });
      }
    }
  }
  return findings.sort((a, b) => (a.code + a.selector).localeCompare(b.code + b.selector));
}

module.exports = { inspectDOM };
