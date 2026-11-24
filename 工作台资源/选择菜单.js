/* Logical dismissal is immediate; the closing surface can finish folding away. */
const workbenchPopups = (() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const transitions = new WeakMap();
  const folded = {opacity: 0, transform: 'scale(.985, .84)'};
  const expanded = {opacity: 1, transform: 'none'};
  const isOpen = panel => !panel.hidden && !panel.inert;

  function setOpen(panel, open, newAnchor = false) {
    if (isOpen(panel) === open) return;
    const previous = transitions.get(panel);
    let start = open ? folded : expanded;
    if (previous) {
      if (!newAnchor) {
        const style = getComputedStyle(panel);
        start = {opacity: style.opacity, transform: style.transform};
      }
      previous.cancel();
      transitions.delete(panel);
    }
    panel.hidden = false;
    panel.inert = !open;
    const topLayer = panel.hasAttribute('popover') && typeof panel.showPopover === 'function';
    if (open && topLayer) panel.showPopover();
    function finish() {
      if (!open && topLayer && panel.matches(':popover-open')) panel.hidePopover();
      panel.hidden = !open;
    }
    if (motion.matches) {
      finish();
      return;
    }
    const animation = panel.animate([start, open ? expanded : folded], {
      duration: open ? 180 : 125,
      easing: open ? 'cubic-bezier(.2,.75,.25,1)' : 'ease-in',
      fill: 'both'
    });
    transitions.set(panel, animation);
    animation.onfinish = () => {
      if (transitions.get(panel) !== animation) return;
      finish();
      transitions.delete(panel);
      animation.cancel();
    };
  }
  return {isOpen, setOpen};
})();

/* One listbox for the workbench. The original select remains the data source. */
const workbenchMenus = (() => {
  const list = document.createElement('div');
  list.id = 'workbench-choice-list';
  list.className = 'choice-list';
  list.setAttribute('popover', 'manual');
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  const buttons = new WeakMap();
  let active = null;
  let lastButtonId = '';
  let cursor = -1;
  let prefix = '';
  let lastKeyTime = 0;

  function idFor(select) {
    if (select.id) return select.id + '-choice';
    if (select.hasAttribute('data-phase')) return 'phase-choice-' + select.dataset.phase;
    return 'field-choice-' + select.dataset.i + '-' + select.dataset.k;
  }

  function close() {
    if (!active) return;
    const button = buttons.get(active);
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-activedescendant');
    button.removeAttribute('aria-controls');
    resize.disconnect();
    workbenchPopups.setOpen(list, false);
    active = null;
    prefix = '';
  }

  function position() {
    if (!active) return;
    const button = buttons.get(active);
    if (!button.getClientRects().length || button.closest('[hidden], [inert]')) return close();
    const box = button.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const inset = 8, gap = 4;
    if (box.bottom <= 0 || box.top >= height) return close();
    list.style.minWidth = Math.min(Math.max(152, box.width), width - inset * 2) + 'px';
    const below = height - box.bottom - inset - gap;
    const above = box.top - inset - gap;
    const flip = below < Math.min(list.scrollHeight, 336) && above > below;
    list.dataset.popupAbove = String(flip);
    list.style.maxHeight = Math.max(0, Math.min(336, flip ? above : below)) + 'px';
    const start = button.closest('.filterPair') ? box.right - list.offsetWidth : box.left;
    list.style.left = Math.max(inset, Math.min(start, width - inset - list.offsetWidth)) + 'px';
    list.style.top = (flip ? box.top - gap - list.offsetHeight : box.bottom + gap) + 'px';
  }

  const resize = new ResizeObserver(position);

  function highlight(index, reveal) {
    const row = list.children[index];
    if (!row) return;
    list.children[cursor]?.classList.remove('is-current');
    cursor = index;
    row.classList.add('is-current');
    buttons.get(active).setAttribute('aria-activedescendant', row.id);
    if (reveal) {
      const top = row.offsetTop - 5;
      const bottom = top + row.offsetHeight + 10;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }

  function open(select) {
    close();
    const button = buttons.get(select);
    if (select.disabled || !select.options.length) return;
    active = select;
    cursor = -1;
    list.replaceChildren();
    list.setAttribute('aria-label', button.dataset.field);
    for (const option of select.options) {
      const row = document.createElement('div');
      row.id = 'workbench-option-' + option.index;
      row.dataset.index = String(option.index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected));
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      row.textContent = option.label;
      list.append(row);
    }
    (button.closest('dialog[open]') || document.body).append(list);
    button.focus({preventScroll:true});
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', list.id);
    workbenchPopups.setOpen(list, true, button.id !== lastButtonId);
    lastButtonId = button.id;
    position();
    if (!active) return;
    resize.observe(button);
    highlight(select.selectedIndex >= 0 ? select.selectedIndex : 0, true);
  }

  function sync(select) {
    let button = buttons.get(select);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-trigger';
      button.id = idFor(select);
      button.setAttribute('role', 'combobox');
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      const label = select.labels[0];
      button.dataset.field = select.getAttribute('aria-label') || label?.firstChild?.textContent.trim() || '选择';
      if (label) label.htmlFor = button.id;
      button.append(document.createElement('span'));
      select.hidden = true;
      select.after(button);
      buttons.set(select, button);
      button.addEventListener('click', () => active === select ? close() : open(select));
      button.addEventListener('keydown', event => keydown(event, select));
    }
    const value = select.selectedOptions[0]?.label || '';
    button.firstChild.textContent = value;
    button.setAttribute('aria-label', value ? button.dataset.field + '，' + value : button.dataset.field);
    button.title = value;
    button.disabled = select.disabled;
  }

  function setValue(select, value) {
    select.value = value;
    sync(select);
  }

  function choose(index) {
    const select = active;
    const option = select?.options[index];
    if (!option || option.disabled) return;
    const button = buttons.get(select);
    close();
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    sync(select);
    if (changed) select.dispatchEvent(new Event('change', {bubbles:true}));
    // Editing a shot rebuilds its fields. Keep keyboard navigation on that field.
    if (!button.isConnected && document.activeElement === document.body) {
      document.getElementById(button.id)?.focus({preventScroll:true});
    }
  }

  function keydown(event, select) {
    const key = event.key;
    if (event.metaKey || event.ctrlKey || event.isComposing) return;
    if (key === 'Tab') { close(); return; }
    if (key === 'Escape' && active !== select) return;
    const search = key.length === 1 && key !== ' ' && !event.altKey;
    if (!search && !['Enter',' ','Escape','ArrowDown','ArrowUp','Home','End'].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'Escape') { close(); return; }
    const wasOpen = active === select;
    if (!wasOpen) open(select);
    if (!active) return;
    if (key === 'Enter' || key === ' ') {
      if (wasOpen) choose(cursor);
      return;
    }
    const options = Array.from(select.options).filter(option => !option.disabled);
    if (!options.length) return;
    const current = options.findIndex(option => option.index === cursor);
    let next;
    if (search) {
      const now = performance.now();
      prefix = (now - lastKeyTime < 650 ? prefix : '') + key.toLocaleLowerCase();
      lastKeyTime = now;
      const cycle = options.slice(current + 1).concat(options.slice(0, current + 1));
      next = cycle.find(option => option.label.toLocaleLowerCase().startsWith(prefix));
    } else if (key === 'Home') next = options[0];
    else if (key === 'End') next = options[options.length - 1];
    else if (wasOpen) next = options[Math.max(0, Math.min(options.length - 1, current + (key === 'ArrowDown' ? 1 : -1)))];
    if (next) highlight(next.index, true);
  }

  list.addEventListener('pointermove', event => {
    const row = event.target.closest('[role=option]');
    if (row && !row.hasAttribute('aria-disabled') && event.pointerType !== 'touch') highlight(Number(row.dataset.index), false);
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const row = event.target.closest('[role=option]');
    if (row) choose(Number(row.dataset.index));
  });
  function dismissOutside(event) {
    if (active && !list.contains(event.target) && !buttons.get(active).contains(event.target)) close();
  }
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside, true);
  document.addEventListener('scroll', event => { if (active && event.target !== list) position(); }, true);
  document.addEventListener('close', event => { if (active && event.target.contains(active)) close(); }, true);
  window.addEventListener('resize', position);
  window.addEventListener('blur', close);

  function enhance(root) { root.querySelectorAll('select').forEach(sync); }
  enhance(document);
  return {sync, setValue, enhance};
})();
