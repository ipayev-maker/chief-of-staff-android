(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CoSInteractions=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function plainClick(event){return (event.button===0||event.button===undefined)&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&!event.defaultPrevented;}
  function install({document:doc,closeTask,hasTask,closeAssistant,hasAssistant,closeDatePicker}){
    function escape(event){
      if(event.key!=='Escape'||event.defaultPrevented||event.repeat)return;
      const picker=doc.querySelector('#cos-date-picker:not([hidden])');
      // A calendar inside a modal is above its parent. Close only that layer.
      if(picker){event.preventDefault();event.stopPropagation();closeDatePicker();return;}
      // Native modal dialogs dispatch cancel to the topmost dialog. Keep its
      // dirty/busy guards and never also close an underlying drawer.
      if(doc.querySelector('dialog[open]'))return;
      if(hasTask()){event.preventDefault();event.stopPropagation();closeTask();return;}
      if(hasAssistant()){event.preventDefault();event.stopPropagation();closeAssistant();return;}
      const menus=[...doc.querySelectorAll('.project-menu[open]')];
      if(menus.length){event.preventDefault();const menu=menus.at(-1);menu.open=false;menu.querySelector('summary')?.focus();}
    }
    doc.addEventListener('keydown',escape,true);
    return ()=>doc.removeEventListener('keydown',escape,true);
  }
  return {plainClick,install};
});
