// Preview-only, in-memory records and API adapters. All external data calls fail closed.
window.addEventListener('DOMContentLoaded', async () => {
  const projectId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222';
  document.title='Проверка навигации и участников — тестовые данные';
  Object.assign(S,{projects:[{id:projectId,title:'Тестовый проект',status:'active',area_key:'work'}],areas:[{key:'work',title:'Работа'}],participants:[{id:personId,name:'Анна · тест'}],tasks:Array.from({length:24},(_,i)=>({id:'test-task-'+i,description:'Тестовая задача '+(i+1),project_id:projectId,participant_id:personId,status:'open',direction:'internal',deadline:'2026-10-20'})),captureDrafts:[{description:'Подготовить тестовый образец',project_id:projectId,participant_id:personId,direction:'to_me',deadline:'2026-10-21'}]});
  window.fetch=async()=>{throw Error('Тестовая страница: внешние запросы отключены')};
  netFetch=async()=>{throw Error('Тестовая страница: внешние запросы отключены')};
  api=async(path,opt={})=>{if(opt.method==='POST'&&path==='/rest/v1/commitments'){return(Array.isArray(opt.body)?opt.body:[opt.body]).map(row=>({...row,id:uid()}))}if(opt.method==='PATCH')return[{...opt.body,id:'test-save'}];return []};
  edge=async()=>({drafts:[{description:'Подготовить тестовый образец',project_title:'Тестовый проект',who:'Анна · тест',direction:'to_me',deadline:'2026-10-21'}]});
  const records=new Map(S.participants.map(p=>[p.id,{...p}]));
  quickNotesRequest=async(path='',opt={})=>{
    if(path.startsWith('/participants')){const id=opt.body?.id||path.split('/').pop(),old=records.get(id),person={id,name:opt.body.name,created_at:old?.created_at||new Date().toISOString()};records.set(id,person);return{participant:{...person},replayed:!!old&&old.name===person.name}}
    if(path.includes('/brief'))return{revision:0,document:{goal:'',current_state:'',next_step:'',checkpoint_label:'',checkpoint_on:null,entries:[]},history:[]};
    return{notes:[],nextOffset:null,source:null};
  };
  const route=initDashboardNavigation();if(route)await applyDashboardRoute(route);else render();
});
