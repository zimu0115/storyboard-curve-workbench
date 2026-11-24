// The gallery stores ordered references; the actual pixels are shared across shots.
const boardLimit = 4;
const storyboardKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const rasterData = /^data:image\/(?:png|jpe?g|webp|gif|heic|heif|tiff|bmp|avif);base64,/i;
const boardLabel = /^\s*(?:\*\*)?(?:分镜图(?:片)?|故事板|Storyboard)(?:\*\*)?[\s：:]+(.+)$/i;
const boardUrl = key => 'storyboard-image://local/' + key;

function boardReferences(text) {
  if (typeof text !== 'string') return [];
  const refs = [];
  const markdown = /!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:[^()\s]|\([^()\n]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/g;
  for (const line of text.split('\n')) {
    const matches = Array.from(line.matchAll(markdown));
    if (matches.length) refs.push(...matches.map(m => m[1] || m[2]));
    else {
      const label = line.match(boardLabel);
      if (label) refs.push(label[1].trim().replace(/^<(.+)>$/, '$1'));
    }
  }
  return [...new Set(refs)];
}

function shotBoardKeys(shot) {
  const values = Array.isArray(shot?.storyboardImages) ? shot.storyboardImages : [shot?.storyboardImage];
  return [...new Set(values.filter(storyboardKey))].slice(0, boardLimit);
}

function writeBoardKeys(shot, keys) {
  // An explicit empty array also prevents a deleted image from returning on JSON import.
  shot.storyboardImages = keys;
  delete shot.storyboardImage;
  delete shot.storyboardRefs;
  delete shot.storyboardRef;
}

function setBoardPreview(image, shot, onResize) {
  const key = shotBoardKeys(shot)[0];
  const src = key ? boardUrl(key) : '';
  if ((image.getAttribute('src') || '') === src) return;
  image.hidden = true;
  if (!src) { image.removeAttribute('src'); return; }
  image.alt = '镜' + shot.id + '分镜图';
  image.src = src;
  image.decode().then(() => {
    if (image.getAttribute('src') !== src) return;
    image.hidden = false;
    onResize?.();
  }).catch(() => {});
}

function boardFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const busyBoards = new WeakSet();
const pendingBoardAdds = new Set();
let galleryShot = null, galleryOrder = '', boardPageView = null;

function setBoardSources(open) {
  workbenchPopups.setOpen($('boardSources'), open);
  $('addBoards').setAttribute('aria-expanded', String(open));
}

function updateBoardGallery(shot) {
  const grid = $('boardGallery'), add = $('addBoards'), keys = shotBoardKeys(shot);
  $('boardFoot').hidden = !shot;
  add.disabled = !shot || keys.length >= boardLimit || busyBoards.has(shot);
  add.title = keys.length >= boardLimit ? '本镜最多添加4张图片' : '选择本地图片或从剪贴板粘贴';
  const order = keys.join(',');
  if (shot === galleryShot && order === galleryOrder) return;
  setBoardSources(false);
  galleryShot = shot;
  galleryOrder = order;
  grid.hidden = true;
  grid.replaceChildren();
  keys.forEach((key, index) => {
    const tile = document.createElement('div'), open = document.createElement('button');
    const remove = document.createElement('button'), image = new Image();
    tile.className = 'board-tile';
    tile.hidden = true;
    open.type = remove.type = 'button';
    open.className = 'board-open';
    open.setAttribute('aria-label', '放大镜' + shot.id + '第' + (index + 1) + '张分镜图');
    open.addEventListener('click', () => openBoardViewer(shot, key));
    remove.className = 'board-remove';
    remove.setAttribute('aria-label', '移除第' + (index + 1) + '张分镜图');
    remove.addEventListener('click', () => {
      if (galleryShot !== shot || !confirm('从镜' + shot.id + '移除这张分镜图？本地原图会保留。')) return;
      writeBoardKeys(shot, shotBoardKeys(shot).filter(id => id !== key));
      mark(); hideBubble(); updateBoardGallery(shot); status();
      $('addBoards').focus({preventScroll:true});
    });
    image.alt = '';
    image.src = boardUrl(key);
    open.append(image);tile.append(open, remove);grid.append(tile);
    image.decode().then(() => {
      if (tile.parentNode !== grid) return;
      tile.hidden = false; grid.hidden = false;
    }).catch(() => {});
  });
}

function addShotBoards(source, files = []) {
  const task = addBoardsToSelection(source, files);
  pendingBoardAdds.add(task);
  task.then(() => pendingBoardAdds.delete(task), () => pendingBoardAdds.delete(task));
  return task;
}

async function addBoardsToSelection(source, files) {
  if (!nativeStudio || document.querySelector('dialog[open]') || !indices().includes(selected)) return;
  const project = p, shot = p.shots[selected], limit = boardLimit - shotBoardKeys(shot).length;
  setBoardSources(false);
  if (limit <= 0) { showToast('本镜已有4张分镜图'); return; }
  if (busyBoards.has(shot)) { showToast('正在添加本镜的图片'); return; }
  busyBoards.add(shot);
  if (galleryShot === shot) updateBoardGallery(shot);
  try {
    let result;
    if (source === 'files') {
      result = {keys:[], failed:0, excess:Math.max(0, files.length - limit)};
      for (const file of files.slice(0, limit)) {
        try { result.keys.push(await nativeStudio.postMessage({op:'storeStoryboard', bytes:await boardFileBytes(file)})); }
        catch { result.failed++; }
      }
    } else {
      result = await nativeStudio.postMessage({op:source === 'clipboard' ? 'pasteStoryboard' : 'chooseStoryboard', limit});
    }
    if (!result) return;
    if (p !== project) { showToast('剧本已切换，本次图片未添加'); return; }
    const existing = shotBoardKeys(shot);
    const next = [...new Set([...existing, ...result.keys.filter(storyboardKey)])].slice(0, boardLimit);
    if (next.length > existing.length) {
      writeBoardKeys(shot, next); mark(); status();
      if (galleryShot === shot) { hideBubble(); updateBoardGallery(shot); $('desk').scrollTop = 0; }
    }
    const notes = [];
    if (next.length > existing.length) notes.push('已为镜' + shot.id + '添加' + (next.length - existing.length) + '张');
    if (result.excess) notes.push('每镜最多4张');
    if (result.failed) notes.push(result.failed + '张未能读取');
    if (!notes.length) notes.push(result.keys.length ? '本镜已有这张图片' : '剪贴板里没有可用的图片');
    showToast(notes.join('，'));
  } catch { showToast('未能添加分镜图，请重试'); }
  finally {
    busyBoards.delete(shot);
    if (galleryShot === shot) updateBoardGallery(shot);
  }
}

function canPasteBoard() {
  const target = document.activeElement;
  return !!galleryShot && !document.querySelector('dialog[open]') && !target?.isContentEditable &&
    !target?.closest('textarea, input, [role="textbox"]');
}
window.chooseStoryboardImage = () => { void addShotBoards('picker'); };
window.pasteIntoShotGallery = () => {
  if (!canPasteBoard()) return false;
  void addShotBoards('clipboard');
  return true;
};

function paintBoardPage(index) {
  const view = boardPageView;
  if (!view || index < 0 || index >= view.keys.length) return;
  view.index = index;
  const photo = $('enlargedBoard');
  photo.alt = '镜' + view.shot.id + '第' + (index + 1) + '张分镜图';
  photo.src = boardUrl(view.keys[index]);
  $('boardPage').textContent = (index + 1) + ' / ' + view.keys.length;
  $('boardBack').disabled = index === 0;
  $('boardForward').disabled = index === view.keys.length - 1;
}

function openBoardViewer(shot, key) {
  const keys = shotBoardKeys(shot), index = keys.indexOf(key);
  if (index < 0 || galleryShot !== shot) return;
  boardPageView = {shot, keys, index};
  const group = p.groups[shot.group];
  $('boardViewerTitle').textContent = ['镜' + shot.id, group?.name, shot.title].filter(Boolean).join(' · ');
  const facts = $('boardFacts');
  facts.replaceChildren();
  for (const axis of ['size','pitch','height','pov','motion','sec']) {
    const term = document.createElement('dt'), detail = document.createElement('dd');
    const path = stagePath(shot, axis);
    term.textContent = dims[axis].name;
    detail.textContent = path ? pathLabel(path, axis) : valLabel(axis, value(shot, axis));
    const pair = document.createElement('div');pair.append(term, detail);facts.append(pair);
  }
  const story = $('boardStory');
  story.replaceChildren();
  const context = group?.context?.trim(), action = written(shot, 'action')?.trim();
  const synopsis = [context, action !== context ? action : ''].filter(Boolean).join('\n') || shot.title;
  const label = document.createElement('strong'), text = document.createElement('p');
  label.textContent = '故事梗概';text.textContent = synopsis;story.append(label, text);
  $('boardPaging').hidden = keys.length < 2;
  paintBoardPage(index);
  hideBubble();$('boardViewer').showModal();
}

function installBoardControls() {
  $('addBoards').onclick = () => setBoardSources(!workbenchPopups.isOpen($('boardSources')));
  $('pickBoards').onclick = () => { $('addBoards').focus(); void addShotBoards('picker'); };
  $('pasteBoards').onclick = () => { $('addBoards').focus(); void addShotBoards('clipboard'); };
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#boardFoot') && workbenchPopups.isOpen($('boardSources'))) setBoardSources(false);
  }, true);
  $('boardFoot').addEventListener('focusout', e => {
    if (!$('boardFoot').contains(e.relatedTarget)) setBoardSources(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && workbenchPopups.isOpen($('boardSources'))) {
      e.preventDefault();e.stopPropagation();setBoardSources(false);$('addBoards').focus();return;
    }
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyV' && canPasteBoard()) {
      e.preventDefault();e.stopPropagation();void addShotBoards('clipboard');
    }
  }, true);
  document.addEventListener('paste', e => {
    if (!canPasteBoard()) return;
    const files = Array.from(e.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (files.length) { e.preventDefault();void addShotBoards('files', files); }
  });
  const viewer = $('boardViewer');
  $('closeBoardViewer').onclick = () => viewer.close();
  $('boardBack').onclick = () => paintBoardPage(boardPageView.index - 1);
  $('boardForward').onclick = () => paintBoardPage(boardPageView.index + 1);
  viewer.addEventListener('keydown', e => {
    if (!['ArrowLeft','ArrowRight'].includes(e.key) || e.metaKey || e.altKey || e.ctrlKey) return;
    e.preventDefault();e.stopPropagation();
    paintBoardPage(boardPageView.index + (e.key === 'ArrowLeft' ? -1 : 1));
  });
  viewer.addEventListener('close', () => { boardPageView = null; $('enlargedBoard').removeAttribute('src'); });
}

function boardShotId(id) {
  const match = /^0*(\d+)([a-z]?)$/i.exec(String(id).trim());
  return match ? match[1] + match[2].toUpperCase() : '';
}

function boardShotCounts(shots) {
  const counts = new Map();
  for (const shot of shots) {
    const id = boardShotId(shot.id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function namedBoardFiles(files) {
  const shots = new Map();
  for (const file of files) {
    const match = /^镜(\d+[a-z]?)-0?([1-4])\.(?:jpe?g|png|webp|gif|heic|heif|tiff?|bmp|avif)$/i.exec(file.name);
    if (!match) continue;
    const id = boardShotId(match[1]), slot = Number(match[2]);
    if (!shots.has(id)) shots.set(id, new Map());
    const slots = shots.get(id);
    slots.set(slot, slots.has(slot) ? null : file);
  }
  return shots;
}

function boardBasename(source) {
  const name = source.slice(source.lastIndexOf('/') + 1);
  try { return decodeURIComponent(name).normalize('NFC'); }
  catch { return name.normalize('NFC'); }
}

async function importShotBoards(project, documentName, files) {
  const assets = project.storyboardAssets || {}, restored = new Map();
  const counts = boardShotCounts(project.shots);
  const declared = project.shots.map(shot => {
    const refs = shot.storyboardImages ?? shot.storyboardRefs ?? [shot.storyboardImage || shot.storyboardRef].filter(Boolean);
    if (!Array.isArray(refs)) throw Error('图片分镜列表格式无效。');
    return refs.length || Array.isArray(shot.storyboardImages) ? refs : boardReferences(shot.body);
  });
  const reserved = new Set(declared.flat().filter(ref => typeof ref === 'string' && !storyboardKey(ref) && !rasterData.test(ref)).map(boardBasename));
  const byName = namedBoardFiles(files.filter(file => !reserved.has(file.name.normalize('NFC'))));
  const used = new Set();
  let missing = 0;
  async function resolve(source) {
    if (restored.has(source)) return restored.get(source);
    let key;
    try {
      if (storyboardKey(source)) {
        if (Object.hasOwn(assets, source)) key = await nativeStudio.postMessage({op:'storeStoryboard',key:source,bytes:assets[source]});
        else if (await nativeStudio.postMessage({op:'hasStoryboard',key:source})) key = source;
      } else if (rasterData.test(source)) {
        key = await nativeStudio.postMessage({op:'storeStoryboard',bytes:source.replace(rasterData,'')});
      } else {
        const name = boardBasename(source);
        const matches = files.filter(file => name === file.name.normalize('NFC'));
        if (documentName) {
          try { key = await nativeStudio.postMessage({op:'importStoryboard',path:source,document:documentName}); }
          catch (error) { if (matches.length !== 1) throw error; }
        }
        if (!key && matches.length === 1) key = await nativeStudio.postMessage({op:'storeStoryboard',bytes:await boardFileBytes(matches[0])});
        if (key && matches.length === 1) used.add(matches[0]);
      }
    } catch { /* Keep importing the script when an image is unavailable. */ }
    restored.set(source, key);
    return key;
  }
  for (const [index, shot] of project.shots.entries()) {
    let sources = declared[index];
    if (!sources.length && !Array.isArray(shot.storyboardImages)) {
      const id = boardShotId(shot.id), slots = byName.get(id);
      if (slots && counts.get(id) === 1) {
        sources = [...slots.keys()].sort((a,b) => a-b).map(slot => slots.get(slot)?.name).filter(Boolean);
      }
    }
    if (!sources.length) continue;
    const keys = []; let failed = false;
    for (const src of new Set(sources)) {
      if (keys.length === boardLimit) break;
      if (typeof src !== 'string') { failed = true; continue; }
      const key = await resolve(src);
      if (!storyboardKey(key)) failed = true;
      else if (!keys.includes(key)) keys.push(key);
    }
    writeBoardKeys(shot, keys);
    if (failed) missing++;
  }
  delete project.storyboardAssets;
  return {missing, unused:files.length - used.size};
}

function exportBoardPackage(project) {
  const counts = boardShotCounts(project.shots);
  const boardsByShot = project.shots.map((shot, index) => {
    const ordinal = '序' + String(index + 1).padStart(3, '0');
    const id = boardShotId(shot.id);
    const prefix = id ? '镜' + String(shot.id).trim() + (counts.get(id) > 1 ? '-' + ordinal : '') : ordinal;
    return shotBoardKeys(shot).map((key, slot) => ({key, name:prefix + '-0' + (slot + 1) + '.jpg'}));
  });
  return nativeStudio.postMessage({op:'exportBoardPackage', name:project.title + '·图文分镜.zip',
    manuscript:workingManuscript(boardsByShot), images:boardsByShot.flat()});
}

async function exportBoardProject(project) {
  const data = copyObj(project);
  const keys = new Set(data.shots.flatMap(shotBoardKeys));
  if (keys.size) {
    data.storyboardAssets = {};
    for (const key of keys) data.storyboardAssets[key] = await nativeStudio.postMessage({op:'exportStoryboard',key});
  }
  return download(data.title+'·分镜曲线.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');
}
