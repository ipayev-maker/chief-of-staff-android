(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CoSRecentTasks=api})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const WINDOW_MS=7*24*60*60*1000;
  function select(tasks,{now=Date.now(),area='all',areaOf=()=>'',query='',projectName=()=>''}={}){
    const q=String(query).trim().toLocaleLowerCase('ru');
    return tasks.filter(t=>{const at=Date.parse(t.created_at);return !t.deleted_at&&!['completed','cancelled'].includes(t.status)&&!/^Разобрать письмо:\s*/u.test(t.description||'')&&Number.isFinite(at)&&at<=now&&at>=now-WINDOW_MS&&(area==='all'||areaOf(t)===area)&&(!q||(t.description+' '+projectName(t.project_id)).toLocaleLowerCase('ru').includes(q))}).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||String(a.id).localeCompare(String(b.id)));
  }
  function age(instant,now=Date.now()){
    const minutes=Math.max(0,Math.floor((now-Date.parse(instant))/60000));
    if(!Number.isFinite(minutes))return '';
    if(minutes<1)return 'только что';if(minutes<60)return minutes+' мин назад';
    if(minutes<1440)return Math.floor(minutes/60)+' ч назад';
    return new Date(instant).toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
  }
  return {select,age,WINDOW_MS};
});
