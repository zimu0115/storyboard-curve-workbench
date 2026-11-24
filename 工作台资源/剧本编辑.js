const writingFields={camera:'机位与取景',action:'人物与动作',sound:'对白、声音与切点',suggestion:'修改建议'};
let writingEditor=null,writingTarget=null,loadingWriting=false;

function manuscriptFieldLine(label,text){
 const gap=/^ {0,3}>/.test(text)?'\n\n':'　';
 return '**'+label+'**'+gap+text;
}
function workingManuscript(boardsByShot = []){
 const times=labelTimeLine(),lines=['# '+p.title];
 if(p.shots.some(s=>s.suggestion))lines.push(reviewBrief);
 const intro=(p.intro||'').replace(/^# [^\n]+\n?/,'').trim();
 if(intro)lines.push(intro);
 p.groups.forEach((g,group)=>{
  lines.push('## '+fmt(group+1)+'　'+g.name);
  if(g.context)lines.push(g.context);
  p.shots.forEach((s,i)=>{
   if(s.group!==group)return;
   const sec=value(s,'sec');
   lines.push('### 镜'+s.id+'　'+times[i]+(sec==null?'':'（'+sec+'秒）')+'｜'+s.title);
   for(const [slot,image] of (boardsByShot[i] || []).entries()){
    lines.push('![分镜图'+(slot+1)+'](分镜图/'+image.name+')');
   }
   lines.push(manuscriptFieldLine('机位与取景',camera(s)),'镜头用途：'+roleOfLabel(s));
   const phases=phaseText(s);if(phases)lines.push(phases);
   for(const key of ['action','sound']){
    const text=written(s,key);
    if(text)lines.push(manuscriptFieldLine(writingFields[key],text));
   }
   if(s.note)lines.push('**拍摄补充**　'+s.note);
   if(s.hold)lines.push('导演标记：此处有意保持。');
   if(s.suggestion)lines.push(suggestionSection(s));
  });
  if(g.assets.trim())lines.push('**本段所需素材**\n\n'+g.assets.trim());
 });
 return lines.join('\n\n')+'\n';
}
function followWrittenCamera(s,previous,text){
 if(s.demoAnchor&&s.id==='46')return;
 const oldTracks=readProfile({title:'',action:'',camera:previous,body:''}).tracks;
 const tracks=readProfile({title:'',action:'',camera:text,body:''}).tracks;
 const index=writingTarget.index;
 for(const k of cameraAxes){
  if(tracks[k]){
   if(JSON.stringify(tracks[k])!==JSON.stringify(oldTracks[k]))setPath(s,k,tracks[k]);
   continue;
  }
  const terms=[...new Set(text.match(cameraWords[k])||[])];
  if(terms.length!==1)continue;
  const before=[...new Set(previous.match(cameraWords[k])||[])];
  if(oldTracks[k])setPath(s,k,null);
  if(!stagePath(s,k)&&(before.length!==1||before[0]!==terms[0]))setValue(index,k,terms[0]);
 }
}
function writeText(s,key,text){
 if(key==='suggestion'){
  const content=trimFieldPadding(text.split(/\r?\n/));
  if(content!==s.suggestion){s.suggestion=content;mark();status()}
  return;
 }
 if(key==='camera'){
  followWrittenCamera(s,writingTarget.lastText,text);
  writingTarget.lastText=text;
  s.proseCameraValues=cameraValues(s);
 }
 if(text===written(s,key))return;
 if(text===s[key]){
  if(key==='camera')delete s.proseCameraValues;
  if(s.prose){delete s.prose[key];if(!Object.keys(s.prose).length)delete s.prose}
 }else{(s.prose??={})[key]=text}
 mark();status();
}
function showWorkingCamera(index){
 const readout=fieldButtons.get(index+'/camera')?.parentElement?.querySelector('.writingReadout');
 if(!readout||readout.hidden)return;
 const shot=p.shots[index];
 readout.textContent=[camera(shot),phaseText(shot)].filter(Boolean).join('\n');
}

const fieldButtons=new Map(),shotHeadings=[],outlineShots=[];
const writingOrder=Object.keys(writingFields);
const previewHost=document.createElement('div');
let manuscriptPreview,writingMode='wysiwyg',lastEditorValue=null;
let writingScope=null,writerSelected=-1,writerFrame=0,toolsFrame=0,formatSelection=null,blockRequest=null;
let slashDismissed=false,writerComposing=false;

function writerVisible(){return writingScope!==null}
function safeManuscriptHTML(html){
 return DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','iframe','object','audio','video','img','source']});
}
function makeWriterNode(tag,cls,text){
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(text!=null)node.textContent=text;
 return node;
}
function fieldText(shot,key){
 return key==='camera'?camera(shot):written(shot,key);
}
function createWritingEditor(el,text,mode,events={}){
 return new toastui.Editor({el,height:'auto',minHeight:'26px',language:'zh-CN',
  initialValue:text,initialEditType:mode,previewStyle:'tab',usageStatistics:false,autofocus:false,hideModeSwitch:true,
  customHTMLSanitizer:safeManuscriptHTML,toolbarItems:[],events});
}
function excerptCue(shot){
 return writingScope==='shot'&&scriptCue?.shot===shot?scriptCue:null;
}
function markCameraClauses(element,key,expected,exactOnly){
 const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
 const nodes=[];
 while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){
  const clauses=node.data.split(/([，。；！？\n]+)/);
  const matches=clauses.map(clause=>{
   const terms=clause.match(cameraWords[key]);
   if(expected!=null&&terms?.includes(expected))return true;
   return !exactOnly&&!terms&&camCues[key].test(clause);
  });
  if(matches.some(Boolean)){
   node.replaceWith(...clauses.map((clause,i)=>matches[i]
    ?makeWriterNode('mark','script-highlight',clause):document.createTextNode(clause)));
  }
 }
}
function refreshExcerptCue(index){
 const description=$('excerptCue');
 if(!description)return;
 const shot=p.shots[index],cue=excerptCue(shot);
 const cameraField=fieldButtons.get(index+'/camera');
 const path=cue&&stagePath(shot,cue.key);
 description.hidden=!cue||(!path&&!!cameraField?.querySelector('.script-highlight'));
 if(description.hidden)return;
 const label=dims[cue.key]?.name||'镜头用途';
 const text=cue.key==='role'?roleOfLabel(shot):valLabel(cue.key,value(shot,cue.key));
 description.replaceChildren();
 if(!path){
  description.append(makeWriterNode('mark','script-highlight',label+' '+text));
  return;
 }
 description.append(document.createTextNode('镜内'+label+' '));
 const stages=path.map((value,stage)=>({value,stage})).filter(({value,stage})=>value!=null||stage===cue.stage);
 if(!stages.length){
  description.append(makeWriterNode('mark','script-highlight','待标注'));
  return;
 }
 stages.forEach(({value,stage},i)=>{
  if(i)description.append(document.createTextNode(' → '));
  const stageText=stageNames[stage]+' '+valLabel(cue.key,value);
  description.append(cue.stage<0||cue.stage===stage
   ?makeWriterNode('mark','script-highlight',stageText):document.createTextNode(stageText));
 });
}
function refreshBlock(index,key){
 const el=fieldButtons.get(index+'/'+key);
 if(!el||el.hidden)return;
 const shot=p.shots[index],raw=fieldText(shot,key)||'';
 const cue=key==='camera'?excerptCue(shot):null;
 const path=cue&&stagePath(shot,cue.key);
 const expected=cue&&(path?path[cue.stage]:value(shot,cue.key));
 const unambiguousStage=path&&expected!=null&&path.filter(v=>v===expected).length===1;
 const axis=cue&&cameraAxes.includes(cue.key)&&(!path||unambiguousStage)?cue.key:null;
 const exactOnly=Boolean(path)||(axis&&expected==null&&Object.hasOwn(shot.edits,axis));
 const highlight=axis?axis+'/'+expected+'/'+exactOnly:'';
 if(el._source===raw&&el._mode===writingMode&&el._highlight===highlight)return;
 el._source=raw;el._mode=writingMode;el._highlight=highlight;
 if(!raw){el.replaceChildren();return}
 if(writingMode==='markdown'||!window.toastui?.Editor||!window.DOMPurify){
  el.replaceChildren(...raw.split(/\r?\n/).map(line=>{
   const p=makeWriterNode('p','',line);if(!line)p.append(document.createElement('br'));return p;
  }));
 }else if(!/[\n\r*_#>|\x60~\[\]<&\\]|^\s|^(?:[-+]|\d+[.)])\s/.test(raw)){
  el.replaceChildren(makeWriterNode('p','',raw));
 }else{
  // Match the editor's paragraph and break rules in the reading view.
  manuscriptPreview??=createWritingEditor(previewHost,'','wysiwyg');
  manuscriptPreview.setMarkdown(raw,false);
  el.innerHTML=safeManuscriptHTML(manuscriptPreview.getHTML());
 }
 if(axis)markCameraClauses(el,axis,expected,exactOnly);
}
function receiveWriting(){
 if(loadingWriting||!writingTarget)return;
 const {shot,key}=writingTarget;
 const text=writingEditor?writingEditor.getMarkdown():$('writingFallback').value;
 if(text===lastEditorValue)return;
 lastEditorValue=text;
 writingTarget.edited=true;
 writeText(shot,key,text);
 if(key==='camera')showWorkingCamera(writingTarget.index);
 if(!writerFrame)writerFrame=requestAnimationFrame(()=>{
  writerFrame=0;
  if(key==='camera'||writingTarget?.key==='camera'){drawGraph();diagnose()}
  if(editing)inspector();
 });
}
function hideEditingTools(){
 workbenchPopups.setOpen($('textFormatBar'),false);
 workbenchPopups.setOpen($('blockPalette'),false);
 formatSelection=blockRequest=null;
}
function finishWritingField(){
 if(!writingTarget)return;
 receiveWriting();
 const {index,key,edited}=writingTarget;
 writingTarget=null;hideEditingTools();
 if(writingEditor){writingEditor.destroy();writingEditor=null}
 $('writingSurface').replaceChildren();
 $('writingDock').hidden=true;
 const el=fieldButtons.get(index+'/'+key);
 el.hidden=false;refreshBlock(index,key);
 $('finishWriting').disabled=true;
 $('quoteWriting').disabled=true;$('quoteWriting').setAttribute('aria-pressed','false');
 writerComposing=false;
 if(edited&&dirty)void saveDraft(false);
}
function caretOffsets(el,event){
 const selection=window.getSelection();
 let range=selection.rangeCount?selection.getRangeAt(0):null;
 const hasSelection=range&&!range.collapsed&&el.contains(range.commonAncestorContainer);
 if(!hasSelection){
  if(!event)return null;
  range=document.caretRangeFromPoint?.(event.clientX,event.clientY);
 }
 if(!range||!el.contains(range.commonAncestorContainer))return null;
 function endpoint(node,offset){
  const prefix=document.createRange();prefix.selectNodeContents(el);prefix.setEnd(node,offset);
  if(el.querySelector('.script-highlight'))return prefix.toString().length;
  const path=[];
  for(let n=node;n!==el;n=n.parentNode)path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes,n));
  return {path,offset,type:node.nodeType,flat:prefix.toString().length};
 }
 return hasSelection?[endpoint(selection.anchorNode,selection.anchorOffset),endpoint(selection.focusNode,selection.focusOffset)]:
  [endpoint(range.startContainer,range.startOffset),endpoint(range.endContainer,range.endOffset)];
}
function placeCaret(root,offsets){
 if(!root||!offsets)return;
 function at(point){
  let offset=point;
  if(typeof point==='object'){
   let node=root;
   for(const i of point.path)node=node?.childNodes[i];
   if(node?.nodeType===point.type&&point.offset<=(node.nodeType===3?node.length:node.childNodes.length))return [node,point.offset];
   offset=point.flat;
  }
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let last=null,node;
  while((node=walker.nextNode())){
   if(offset<=node.length)return [node,offset];
   offset-=node.length;last=node;
  }
  return last?[last,last.length]:[root,0];
 }
 const [a,x]=at(offsets[0]),[b,y]=at(offsets[1]);
 window.getSelection().setBaseAndExtent(a,x,b,y);
}
function startWritingField(index,key,offsets=null,focus=true){
 const shot=p.shots[index],el=fieldButtons.get(index+'/'+key);
 if(!shot||!el)return;
 if(writingTarget?.index===index&&writingTarget.key===key){
  if(focus){if(writingEditor)writingEditor.focus();else $('writingFallback').focus()}
  return;
 }
 const scrollArea=writingScope==='shot'?$('desk'):$('writingSheet'),scroll=scrollArea.scrollTop;
 finishWritingField();
 const dock=$('writingDock'),fallback=$('writingFallback'),surface=$('writingSurface');
 el.after(dock);el.hidden=true;dock.hidden=false;dock.dataset.mode=writingMode;
 const text=fieldText(shot,key)||'';
 writingTarget={shot,key,index,lastText:text,edited:false};loadingWriting=true;
 slashDismissed=false;
 try{
  fallback.value=text;lastEditorValue=text;
  if(window.toastui?.Editor&&window.DOMPurify){
   writingEditor=createWritingEditor(surface,text,writingMode,{change:receiveWriting});
   lastEditorValue=writingEditor.getMarkdown();
  }
  fallback.hidden=!!writingEditor;surface.hidden=!writingEditor;
  if(!writingEditor)fitWritingFallback();
  $('finishWriting').disabled=false;
  $('quoteWriting').disabled=false;
 }finally{loadingWriting=false}
 if(focus){
  if(writingEditor){
   const root=surface.querySelector(writingMode==='wysiwyg'?'.toastui-editor-ww-container .ProseMirror':'.toastui-editor-md-container .ProseMirror');
   if(root){root.setAttribute('aria-label','镜'+shot.id+'，'+writingFields[key]);root.focus({preventScroll:true});placeCaret(root,offsets||[0,0])}
  }else{
   fallback.focus({preventScroll:true});
   const [a,b]=(offsets||[0,0]).map(point=>Math.min(text.length,point.flat??point));
   fallback.setSelectionRange(Math.min(a,b),Math.max(a,b),a>b?'backward':'forward');
  }
 }
 scrollArea.scrollTop=scroll;
 scheduleWritingTools();
}
function fitWritingFallback(){
 const field=$('writingFallback');
 field.style.height='0px';field.style.height=Math.max(26,field.scrollHeight)+'px';
}
function scrollInSheet(target){
 if(!target)return;
 const sheet=$('writingSheet');
 sheet.scrollTop+=target.getBoundingClientRect().top-sheet.getBoundingClientRect().top-16;
}
function setOutline(open){
 workbenchPopups.setOpen($('writingOutline'),open);
 $('outlineToggle').setAttribute('aria-expanded',String(open));
 if(open&&outlineShots[writerSelected]){
  const item=outlineShots[writerSelected];item.parentElement.open=true;
  const nav=$('writingOutline');nav.scrollTop=item.offsetTop-nav.clientHeight/3;
 }
}
function markWritingShot(index,scroll=false){
 if(writerSelected!==index){
  outlineShots[writerSelected]?.removeAttribute('aria-current');
  shotHeadings[writerSelected]?.removeAttribute('aria-current');
  writerSelected=index;
  outlineShots[index]?.setAttribute('aria-current','true');
  shotHeadings[index]?.setAttribute('aria-current','true');
 }
 if(scroll)scrollInSheet(shotHeadings[index]);
}
function syncWritingView(index,showExcerpt){
 if(writingScope!=='full'){
  if(!showExcerpt){if(writingScope==='shot')dismissWriting();return}
  if(writingScope!=='shot'||writerSelected!==index)mountWriting('shot',index);
 }
 if(!p.shots[index])return;
 for(const k of writingOrder)refreshBlock(index,k);
 if(writingScope==='shot')refreshExcerptCue(index);
 showWorkingCamera(index);
}
function buildWritingSheet(onlyIndex=null){
 const sheet=$('writingSheet'),outline=$('writingOutline');
 sheet.replaceChildren();outline.replaceChildren();
 if(onlyIndex===null)sheet.append(makeWriterNode('h1','doc-title',p.title));
 fieldButtons.clear();shotHeadings.length=outlineShots.length=0;
 let group=null,entry;
 function appendShot(shot,index){
  if(onlyIndex===null){
   if(group!==shot.group){
    group=shot.group;const name=p.groups[group]?.name||'剧本';
    sheet.append(makeWriterNode('h2','scene-heading',name));
    entry=makeWriterNode('details');entry.append(makeWriterNode('summary','',name));outline.append(entry);
   }
   const title=makeWriterNode('h3','shot-heading');
   title.append(makeWriterNode('span','','镜'+shot.id),document.createTextNode(shot.title));
   shotHeadings[index]=title;sheet.append(title);
   const jump=makeWriterNode('button','','镜'+shot.id+'　'+shot.title);
   jump.type='button';jump.dataset.jump=index;entry.append(jump);outlineShots[index]=jump;
  }
  for(const key of writingOrder){
   const block=makeWriterNode('section','doc-block'),el=makeWriterNode('div','manuscriptField toastui-editor-contents');
   el.dataset.index=index;el.dataset.field=key;el.dataset.placeholder=key==='suggestion'?'填写这镜想改的地方，留空表示无需修改':'点击输入';el.tabIndex=0;
   el.setAttribute('role','button');el.setAttribute('aria-label','编辑镜'+shot.id+'的'+writingFields[key]);
   fieldButtons.set(index+'/'+key,el);refreshBlock(index,key);
   const header=makeWriterNode('div','field-head');
   header.append(makeWriterNode('span','field-name',writingFields[key]));
   block.append(header,el);
   if(key==='camera'&&onlyIndex!==null){
    const description=makeWriterNode('p','excerpt-cue');
    description.id='excerptCue';description.hidden=true;
    header.after(description);
   }
   if(key==='camera'&&onlyIndex===null){
    const readout=makeWriterNode('p','writingReadout');
    readout.id='camera-readout-'+index;readout.hidden=true;
    const toggle=makeWriterNode('button','readout-toggle','当前拍摄描述');
    toggle.type='button';toggle.setAttribute('aria-controls',readout.id);
    toggle.setAttribute('aria-expanded','false');
    toggle.onclick=()=>{
     readout.hidden=!readout.hidden;toggle.setAttribute('aria-expanded',String(!readout.hidden));
     if(!readout.hidden)showWorkingCamera(index);
    };
    header.append(toggle);block.append(readout);
   }
   sheet.append(block);
  }
 }
 if(onlyIndex===null)p.shots.forEach(appendShot);
 else appendShot(p.shots[onlyIndex],onlyIndex);
}
function dismissWriting(){
 cancelRailFold();
 if(!writerVisible())return;
 finishWritingField();setOutline(false);hideEditingTools();
 const pane=$('writingPane');
 if(writingScope==='full')$('boardFoot').before($('continuity'));
 pane.querySelector('.writer-inner').append($('writingDock'));
 pane.hidden=true;pane.inert=true;delete pane.dataset.scope;
 $('rightRail').append(pane);$('studioLayout').classList.remove('has-writer');
 $('openWriting').setAttribute('aria-expanded','false');
 writingScope=null;writerSelected=-1;
}
function mountWriting(scope,index){
 dismissWriting();
 const full=scope==='full',pane=$('writingPane');
 (full?$('rightRail'):$('excerptPanel')).append(pane);
 if(full)pane.querySelector('.writer-foot').before($('continuity'));
 writingScope=scope;pane.dataset.scope=scope;pane.inert=false;pane.hidden=false;
 writingMode=full&&$('writingMode').getAttribute('aria-pressed')==='true'?'markdown':'wysiwyg';
 $('writingSheet').dataset.mode=writingMode;
 // A newly unhidden writer needs its off-screen position before entering.
 if(full&&!reduceMotion.matches)pane.getBoundingClientRect();
 $('studioLayout').classList.toggle('has-writer',full);
 $('openWriting').setAttribute('aria-expanded',String(full));
 buildWritingSheet(full?null:index);markWritingShot(index);
 $('writingSheet').scrollTop=0;
}
function openWriting(index=selected){
 if(!p.shots[index])return;
 cancelRailFold();
 if(writingScope!=='full')mountWriting('full',index);
 editing=true;inspector();
 markWritingShot(index,true);
 startWritingField(index,'action');
}
function closeWriting(){
 if(writingScope!=='full'){closeInspector(true);return}
 foldRail($('writingPane'),()=>{
  dismissWriting();
  inspector();
  const control=$('editManuscript');
  (control.getClientRects().length?control:$('editHere')).focus({preventScroll:true});
 });
}
function activateBlock(el,offsets){
 const index=Number(el.dataset.index);
 markWritingShot(index);
 if(index!==selected&&indices().includes(index))selectIndex(index);
 startWritingField(index,el.dataset.field,offsets);
}
$('writingSheet').addEventListener('click',e=>{
 const el=e.target.closest('.manuscriptField');if(!el)return;
 e.preventDefault();activateBlock(el,caretOffsets(el,e));
});
$('writingSheet').addEventListener('keydown',e=>{
 const el=e.target.closest('.manuscriptField');
 if(el&&(e.key==='Enter'||e.key===' ')){e.preventDefault();activateBlock(el,null)}
});
$('writingOutline').onclick=e=>{
 const item=e.target.closest('[data-jump]');if(!item)return;
 const index=Number(item.dataset.jump);setOutline(false);
 if(indices().includes(index)&&selected!==index)selectIndex(index);
 openWriting(index);
};
$('outlineToggle').onclick=()=>setOutline(!workbenchPopups.isOpen($('writingOutline')));
$('closeWriting').onclick=()=>closeWriting();
$('openWriting').setAttribute('aria-controls','writingPane');
$('openWriting').setAttribute('aria-expanded','false');
$('openWriting').onclick=()=>writingScope==='full'?closeWriting():openWriting(selected);
$('editManuscript').onclick=()=>openWriting(selected);
$('writeFromSource').onclick=()=>{$('sourceDialog').close();openWriting(selected)};
$('writingFallback').oninput=()=>{fitWritingFallback();receiveWriting()};
async function completeWriting(){
 const target=writingTarget;
 if(!target)return;
 receiveWriting();
 const version=revision;
 if(!await window.flushWorkbenchDraft()||target!==writingTarget||revision!==version)return;
 finishWritingField();
 fieldButtons.get(target.index+'/'+target.key)?.focus({preventScroll:true});
}
$('finishWriting').onclick=completeWriting;
$('writingMode').onclick=()=>{
 const target=writingTarget||{index:writerSelected,key:'action'};
 finishWritingField();writingMode=writingMode==='markdown'?'wysiwyg':'markdown';
 $('writingSheet').dataset.mode=writingMode;
 for(const el of fieldButtons.values())refreshBlock(Number(el.dataset.index),el.dataset.field);
 $('writingMode').setAttribute('aria-pressed',String(writingMode==='markdown'));
 $('writingMode').title=writingMode==='markdown'?'返回排版后的正文':'查看或编辑 Markdown 源码';
 startWritingField(target.index,target.key);
};
$('exportManuscript').onclick=()=>{receiveWriting();download(p.title+'·修改稿.md',workingManuscript(),'text/markdown;charset=utf-8')};

const inlineFormats=[
 ['bold','加粗（⌘B）','B'],['italic','斜体（⌘I）','I'],['strike','删除线','S'],['code','行内代码','‹›'],['blockQuote','段落引用','引用']
];
const paragraphFormats=[
 {name:'一级标题',icon:'H1',command:'heading',params:{level:1}},
 {name:'二级标题',icon:'H2',command:'heading',params:{level:2}},
 {name:'三级标题',icon:'H3',command:'heading',params:{level:3}},
 {name:'无序列表',icon:'•',command:'bulletList'},
 {name:'有序列表',icon:'1.',command:'orderedList'},
 {name:'待办事项',icon:'☑',command:'taskList'},
 {name:'引用',icon:'❝',command:'blockQuote'}
];
for(const [command,label,glyph] of inlineFormats){
 const b=makeWriterNode('button','format-'+command,glyph);b.type='button';b.title=label;
 b.setAttribute('aria-label',label);b.dataset.command=command;$('textFormatBar').append(b);
}
const addParagraph=makeWriterNode('button','paragraph-add','+');
addParagraph.type='button';addParagraph.title='段落样式（行首输入 /）';
addParagraph.setAttribute('aria-label','选择段落样式');addParagraph.setAttribute('aria-haspopup','listbox');
$('writingDock').prepend(addParagraph);
function activeWriterRoot(){
 return writingEditor?.isWysiwygMode()?$('writingSurface').querySelector('.toastui-editor-ww-container .ProseMirror'):null;
}
function richQuoteRange(){
 const {$from,$to}=writingEditor.wwEditor.view.state.selection;
 return $from.blockRange($to,node=>node.type.name==='blockQuote');
}
const quotePrefix=/^( {0,3})>[ \t]?/;
function sourceQuoteSelection(){
 const fallback=$('writingFallback'),source=writingEditor?writingEditor.getMarkdown():fallback.value;
 const lines=source.split('\n');
 function position(offset){
  const before=source.slice(0,offset).split('\n');
  return [before.length,before.at(-1).length+1];
 }
 const [from,to]=writingEditor?writingEditor.getSelection():[position(fallback.selectionStart),position(fallback.selectionEnd)];
 const first=from[0]-1,last=to[0]-1-(to[1]===1&&to[0]>from[0]?1:0);
 const rows=lines.slice(first,last+1);
 return {from,to,first,last,rows,lines,quoted:rows.every(line=>quotePrefix.test(line))};
}
function updateQuoteState(){
 if(!writingTarget)return;
 const quoted=writingEditor?.isWysiwygMode()?!!richQuoteRange():sourceQuoteSelection().quoted;
 for(const button of [$('quoteWriting'),$('textFormatBar').querySelector('[data-command="blockQuote"]')]){
  button.setAttribute('aria-pressed',String(quoted));button.title=quoted?'取消段落引用':'设为段落引用';
 }
}
function toggleWritingQuote(){
 if(!writingTarget||writerComposing)return;
 if(writingEditor?.isWysiwygMode()){
  const range=richQuoteRange(),view=writingEditor.wwEditor.view;
  if(range)view.dispatch(view.state.tr.lift(range,range.depth-1));
  else writingEditor.exec('blockQuote');
  writingEditor.focus();
 }else{
  const {from,to,first,last,rows,lines,quoted}=sourceQuoteSelection();
  const updated=rows.map(line=>quoted?line.replace(quotePrefix,'$1'):'> '+line);
  function mapped([line,col]){
   const i=line-1-first;
   if(i<0||i>=rows.length)return [line,col];
   const shift=updated[i].length-rows[i].length;
   return [line,Math.max(1,col+shift)];
  }
  const start=[first+1,1],end=[last+1,rows.at(-1).length+1],replacement=updated.join('\n');
  if(writingEditor){
   writingEditor.replaceSelection(replacement,start,end);
   writingEditor.setSelection(mapped(from),mapped(to));writingEditor.focus();
  }else{
   const field=$('writingFallback');
   const offset=([line,col])=>lines.slice(0,line-1).reduce((n,s)=>n+s.length+1,0)+col-1;
   const direction=field.selectionDirection;
   field.setRangeText(replacement,offset(start),offset(end));
   lines.splice(first,rows.length,...updated);
   field.focus();field.setSelectionRange(offset(mapped(from)),offset(mapped(to)),direction);
   fitWritingFallback();
  }
 }
 receiveWriting();updateQuoteState();scheduleWritingTools();
}
$('quoteWriting').onmousedown=e=>e.preventDefault();
$('quoteWriting').onclick=toggleWritingQuote;
$('writingSurface').addEventListener('beforeinput',event=>{
 if(event.inputType!=='insertText'||event.data!==' '||event.isComposing||writerComposing||
    !event.cancelable||!writingEditor?.isWysiwygMode())return;
 const view=writingEditor.wwEditor.view,{selection,schema,tr}=view.state,{$from}=selection;
 if(!selection.empty||$from.parent.type.name!=='paragraph'||$from.parentOffset!==1||
    $from.parent.textBetween(0,1)!=='>')return;
 const range=$from.blockRange(),quote=schema.nodes.blockQuote;
 if(!range||!range.parent.canReplaceWith(range.startIndex,range.endIndex,quote))return;
 event.preventDefault();
 tr.delete(selection.from-1,selection.from);
 tr.wrap(tr.selection.$from.blockRange(),[{type:quote}]);
 view.dispatch(tr.scrollIntoView());receiveWriting();scheduleWritingTools();
},true);
function placeWriterMenu(menu,anchor,above=false){
 workbenchPopups.setOpen(menu,true);
 const area=(writingScope==='shot'?$('desk'):$('writingSheet')).getBoundingClientRect();
 const sheet={left:Math.max(0,area.left),right:Math.min(innerWidth,area.right),top:Math.max(0,area.top),bottom:Math.min(innerHeight,area.bottom)};
 menu.style.maxWidth=Math.max(1,sheet.right-sheet.left-10)+'px';
 menu.style.maxHeight=Math.max(1,Math.min(245,sheet.bottom-sheet.top-6))+'px';
 const size={width:menu.offsetWidth,height:menu.offsetHeight};
 const left=above?(anchor.left+anchor.right-size.width)/2:anchor.left;
 menu.style.left=Math.max(sheet.left+5,Math.min(left,sheet.right-size.width-5))+'px';
 const up=anchor.top-size.height-6,down=anchor.bottom+5;
 const top=above&&up>=sheet.top?up:down+size.height<=sheet.bottom?down:Math.max(sheet.top+3,up);
 menu.dataset.popupAbove=String(top<anchor.top);
 menu.style.top=top+'px';
}
function readEditorRange(){
 const root=activeWriterRoot(),sel=window.getSelection();
 if(!root||!sel?.rangeCount||!root.contains(sel.anchorNode)||!root.contains(sel.focusNode))return null;
 return sel.getRangeAt(0);
}
function slashAtCursor(range){
 if(!range?.collapsed||!writingEditor)return null;
 const root=activeWriterRoot(),node=range.startContainer,element=node.nodeType===1?node:node.parentElement;
 const paragraph=element.closest('p');if(!paragraph||!root.contains(paragraph))return null;
 const lead=range.cloneRange();lead.selectNodeContents(paragraph);lead.setEnd(node,range.startOffset);
 const token=lead.toString();
 if(!/^\/[^\s/]{0,12}$/.test(token))return null;
 const [from,to]=writingEditor.getSelection();
 if(from!==to||!Number.isInteger(to))return null;
 return {from:to-token.length,to,query:token.slice(1),typed:true};
}
function showParagraphMenu(request,anchor){
 const matches=paragraphFormats.filter(item=>item.name.includes(request.query)||item.icon.toLowerCase().includes(request.query.toLowerCase()));
 if(!matches.length){workbenchPopups.setOpen($('blockPalette'),false);blockRequest=null;return}
 const previous=blockRequest;
 const active=previous&&previous.query===request.query?Math.min(previous.active,matches.length-1):0;
 blockRequest={...request,matches,active};
 const menu=$('blockPalette');
 menu.replaceChildren(...matches.map((item,i)=>{
  const button=makeWriterNode('button');button.type='button';button.tabIndex=-1;button.dataset.item=i;
  button.setAttribute('role','option');button.setAttribute('aria-selected',String(i===active));
  button.append(makeWriterNode('span','',item.icon),document.createTextNode(item.name));return button;
 }));
 placeWriterMenu(menu,anchor);
}
function refreshEditingTools(){
 updateQuoteState();
 const range=readEditorRange();
 if(writerComposing||!range||!$('writingSheet').contains(document.activeElement)){hideEditingTools();return}
 const rect=range.getBoundingClientRect(),bounds=$('writingSheet').getBoundingClientRect();
 if(rect.bottom<bounds.top||rect.top>bounds.bottom){hideEditingTools();return}
 if(blockRequest&&!blockRequest.typed)return;
 if(!range.collapsed){
  workbenchPopups.setOpen($('blockPalette'),false);blockRequest=null;formatSelection=writingEditor.getSelection();
  placeWriterMenu($('textFormatBar'),rect,true);return;
 }
 workbenchPopups.setOpen($('textFormatBar'),false);formatSelection=null;
 const slash=!slashDismissed&&slashAtCursor(range);
 if(slash)showParagraphMenu(slash,rect);
 else{blockRequest=null;workbenchPopups.setOpen($('blockPalette'),false)}
}
function scheduleWritingTools(){
 if(!toolsFrame&&writingTarget)toolsFrame=requestAnimationFrame(()=>{toolsFrame=0;refreshEditingTools()});
}
function applyParagraph(item){
 const request=blockRequest;if(!request||!writingEditor||!item)return;
 if(request.typed){
  const fresh=slashAtCursor(readEditorRange());
  if(!fresh||fresh.from!==request.from||fresh.to!==request.to){hideEditingTools();return}
 }
 hideEditingTools();slashDismissed=true;
 writingEditor.setSelection(request.from,request.to);
 if(request.typed)writingEditor.deleteSelection(request.from,request.to);
 if(item.command==='blockQuote'){toggleWritingQuote();return}
 writingEditor.exec(item.command,item.params);
 writingEditor.focus();receiveWriting();
}
addParagraph.onmousedown=e=>e.preventDefault();
addParagraph.onclick=()=>{
 if(!activeWriterRoot())return;
 if(blockRequest&&!blockRequest.typed){hideEditingTools();return}
 const [from,to]=writingEditor.getSelection();
 workbenchPopups.setOpen($('textFormatBar'),false);
 showParagraphMenu({from,to,query:'',typed:false},addParagraph.getBoundingClientRect());
};
for(const id of ['textFormatBar','blockPalette'])$(id).addEventListener('mousedown',e=>e.preventDefault());
$('textFormatBar').onclick=e=>{
 const cmd=e.target.closest('button')?.dataset.command;
 if(!cmd||!formatSelection||!writingEditor)return;
 writingEditor.setSelection(...formatSelection);
 if(cmd==='blockQuote'){toggleWritingQuote();return}
 writingEditor.exec(cmd);writingEditor.focus();
 receiveWriting();scheduleWritingTools();
};
$('blockPalette').onclick=e=>{
 const button=e.target.closest('[data-item]');
 if(button&&blockRequest)applyParagraph(blockRequest.matches[Number(button.dataset.item)]);
};
document.addEventListener('selectionchange',scheduleWritingTools);
$('writingSurface').addEventListener('input',()=>{slashDismissed=false;scheduleWritingTools()});
$('writingSurface').addEventListener('compositionstart',()=>{writerComposing=true;hideEditingTools()});
$('writingSurface').addEventListener('compositionend',()=>{writerComposing=false;slashDismissed=false;scheduleWritingTools()});
for(const scrollArea of [$('writingSheet'),$('desk')]){
 scrollArea.addEventListener('scroll',()=>{if(blockRequest&&!blockRequest.typed)hideEditingTools();scheduleWritingTools()},{passive:true});
}
function adaptWritingTools(){
 if(writingTarget&&!writingEditor)fitWritingFallback();
 if(blockRequest&&!blockRequest.typed)placeWriterMenu($('blockPalette'),addParagraph.getBoundingClientRect());
 scheduleWritingTools();
}
window.addEventListener('resize',adaptWritingTools);
let lastWritingWidth=0;
new ResizeObserver(([entry])=>{
 const width=entry.contentRect.width;
 if(width!==lastWritingWidth){lastWritingWidth=width;adaptWritingTools()}
}).observe($('writingPane'));
window.addEventListener('scroll',scheduleWritingTools,{passive:true});
function finishAfterFocusChange(){
 const target=writingTarget;
 if(target)setTimeout(()=>{if(target===writingTarget&&!writerComposing)finishWritingField()},0);
}
$('writingDock').addEventListener('focusout',e=>{
 const next=e.relatedTarget;
 if(next&&!next.closest('#writingDock,.writer-foot,.writer-head,#writingOutline,#textFormatBar,#blockPalette'))finishAfterFocusChange();
});
document.addEventListener('pointerdown',e=>{
 if(!writerVisible())return;
 if(e.target.closest('#railDivider'))return;
 if(!e.target.closest('#writingOutline,#outlineToggle'))setOutline(false);
 if(!e.target.closest('#textFormatBar,#blockPalette,.paragraph-add'))hideEditingTools();
 if(!e.target.closest('#writingDock,.manuscriptField,.writer-foot,.writer-head,#writingOutline,#textFormatBar,#blockPalette,#graph,#overview'))finishAfterFocusChange();
},true);
document.addEventListener('keydown',e=>{
 if(!writerVisible()||e.isComposing||writerComposing||document.querySelector('dialog[open]'))return;
 const within=e.target.closest('#writingPane,#textFormatBar,#blockPalette');
 if(!within)return;
 if(e.key==='Escape'){
  e.preventDefault();e.stopImmediatePropagation();
  if(blockRequest||workbenchPopups.isOpen($('textFormatBar'))){slashDismissed=true;hideEditingTools();return}
  if(workbenchPopups.isOpen($('writingOutline'))){setOutline(false);$('outlineToggle').focus();return}
  if(writingTarget){void completeWriting();return}
  closeWriting();return;
 }
 if(blockRequest&&['ArrowUp','ArrowDown','Enter'].includes(e.key)){
  e.preventDefault();e.stopImmediatePropagation();
  if(e.key==='Enter'){applyParagraph(blockRequest.matches[blockRequest.active]);return}
  const len=blockRequest.matches.length;
  blockRequest.active=(blockRequest.active+len+(e.key==='ArrowUp'?-1:1))%len;
  Array.from($('blockPalette').children).forEach((b,i)=>b.setAttribute('aria-selected',String(i===blockRequest.active)));
  return;
 }
 if(!writingTarget||!(e.key==='ArrowUp'||e.key==='ArrowDown')||e.shiftKey||e.metaKey||e.altKey||e.ctrlKey)return;
 const range=readEditorRange();if(!range?.collapsed)return;
 const root=activeWriterRoot(),test=range.cloneRange(),back=e.key==='ArrowUp';
 test.selectNodeContents(root);
 if(back)test.setEnd(range.startContainer,range.startOffset);else test.setStart(range.endContainer,range.endOffset);
 const edge=writingEditor.getSelection()[0],size=writingEditor.wwEditor?.view.state.doc.content.size;
 if(test.toString().length||(back?edge!==1:edge!==size-1))return;
 const flat=writingTarget.index*writingOrder.length+writingOrder.indexOf(writingTarget.key)+(back?-1:1);
 if(flat<0||flat>=p.shots.length*writingOrder.length)return;
 if(writingScope==='shot'&&Math.floor(flat/writingOrder.length)!==writingTarget.index)return;
 e.preventDefault();e.stopImmediatePropagation();
 const index=Math.floor(flat/writingOrder.length),key=writingOrder[flat%writingOrder.length];
 activateBlock(fieldButtons.get(index+'/'+key),back?[Infinity,Infinity]:[0,0]);
 const scrollArea=writingScope==='shot'?$('desk'):$('writingSheet');
 const dock=$('writingDock').getBoundingClientRect(),sheet=scrollArea.getBoundingClientRect();
 if(dock.top<sheet.top)scrollArea.scrollTop+=dock.top-sheet.top-24;
 else if(dock.bottom>sheet.bottom)scrollArea.scrollTop+=dock.bottom-sheet.bottom+20;
},true);

