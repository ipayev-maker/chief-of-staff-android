// Preview-only synthetic communications. Every external data call fails closed.
window.addEventListener('DOMContentLoaded',async()=>{
  document.title='Входящие — тестовые данные';
  const project='11111111-1111-4111-8111-111111111111',person='22222222-2222-4222-8222-222222222222',task='33333333-3333-4333-8333-333333333333';
  const first='44444444-4444-4444-8444-444444444444',second='55555555-5555-4555-8555-555555555555',third='66666666-6666-4666-8666-666666666666';
  const change=(id,kind,text,extra={})=>({id,kind,text,selected:true,project_id:project,participant_id:person,direction:'to_me',deadline:null,deadline_time:null,next_check_on:null,task_id:null,task_version:null,status:'open',entry_kind:null,brief_revision:null,evidence:'Анна пришлёт обновлённые чертежи в пятницу. Цвет согласовали.',...extra});
  Object.assign(S,{section:'inbox',inboxId:first,projects:[{id:project,title:'Тестовый проект · оборудование',status:'active',area_key:'work'},{id:'99999999-9999-4999-8999-999999999999',title:'Неактивный тестовый проект',status:'paused',area_key:'work'}],areas:[{key:'work',title:'Работа'}],participants:[{id:person,name:'Анна · тест'}],tasks:[{id:task,description:'Получить чертежи оборудования',project_id:project,participant_id:person,status:'open',direction:'to_me',deadline:'2026-10-01',cos_version:2}],meetings:[],notes:[]});
  const source='После встречи: Анна пришлёт обновлённые чертежи в пятницу, 2 октября, к 14:00. Цвет согласовали — графит. Смету пока не утвердили, ждём перерасчёт. В четверг я уточню готовность чертежей.';
  const rows=new Map([
    [first,{id:first,note_id:first,status:'ready',revision:2,created_at:'2026-09-29T12:40:00Z',updated_at:'2026-09-29T12:40:12Z',source_text:'',transcript:source,source_meta:{type:'voice',audio_path:'fixture/voice.wav'},proposal:{version:1,time_zone:'Europe/Berlin',summary:'Чертежи — к пятнице. Цвет согласован; смета ждёт перерасчёта.',questions:[],context:{briefs:[{project_id:project,revision:0,current_state:'Обсуждаем чертежи и цвет оборудования.'}]},changes:[
      change('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','task_update','Получить обновлённые чертежи',{task_id:task,task_version:2,deadline:'2026-10-02',deadline_time:'14:00',next_check_on:'2026-10-01',before:{text:'Получить чертежи оборудования',deadline:'2026-10-01',status:'open'}}),
      change('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','project_entry','Согласован цвет оборудования — графит',{entry_kind:'decision',brief_revision:0}),
      change('cccccccc-cccc-4ccc-8ccc-cccccccccccc','project_state','Ждём обновлённые чертежи и перерасчёт сметы. Цвет оборудования согласован.',{participant_id:null,brief_revision:0})
    ]}}],
    [second,{id:second,note_id:second,status:'ready',revision:1,created_at:'2026-09-29T11:20:00Z',source_text:'Нужно запросить образец у Сергея. Обсудили по телефону, проект уточню позже.',transcript:null,source_meta:{type:'text'},proposal:{version:1,time_zone:'Europe/Berlin',summary:'Запросить образец. Проект и участник требуют уточнения.',questions:['К какому проекту относится образец?','Какого Сергея вы имеете в виду?'],changes:[change('dddddddd-dddd-4ddd-8ddd-dddddddddddd','task_create','Запросить образец',{project_id:null,participant_id:null,direction:'internal',evidence:'Нужно запросить образец у Сергея.'})]}}],
    [third,{id:third,note_id:third,status:'deferred',revision:1,created_at:'2026-09-28T16:15:00Z',source_text:'Заказчику понравилась идея модульных полок. Вернуться к ней при обсуждении следующего магазина.',transcript:null,source_meta:{type:'text'},proposal:{version:1,time_zone:'Europe/Berlin',summary:'Идея модульных полок для следующего магазина.',questions:[],changes:[]}}]
  ]);
  const copy=value=>JSON.parse(JSON.stringify(value)),replays=new Map();
  window.fetch=async()=>{throw Error('Тестовая страница: внешние запросы отключены')};
  netFetch=async()=>{throw Error('Тестовая страница: внешние запросы отключены')};
  api=async(path)=>path.includes('commitments')?copy(S.tasks):[];
  edge=async()=>{throw Error('Тестовая страница: внешние запросы отключены')};
  quickNotesRequest=async(path='',opt={})=>{
    if(path.startsWith('/projects/')&&path.endsWith('/brief'))return{project_id:project,revision:0,document:{goal:'',current_state:'Обсуждаем чертежи и цвет оборудования.',next_step:'',checkpoint_label:'',checkpoint_on:null,entries:[]},history:[]};
    if(path.startsWith('/inbox?')){
      const search=new URLSearchParams(path.split('?')[1]),status=search.get('status'),offset=Number(search.get('offset')||0);
      const items=[...rows.values()].filter(row=>status==='all'||(status==='pending'?!['deferred','applied'].includes(row.status):row.status===status));
      return{items:copy(items.slice(offset,offset+50)),nextOffset:offset+50<items.length?offset+50:null};
    }
    const match=path.match(/^\/inbox\/([a-f0-9-]+)(?:\/(analyze|apply|defer))?$/);
    if(!match)throw Error('Неизвестный тестовый маршрут');
    const item=rows.get(match[1]),action=match[2];
    if(!item)throw Object.assign(Error('not found'),{status:404});
    if(!action)return{item:copy(item)};
    const body=opt.body||{};
    if(body.request_id&&replays.has(body.request_id))return copy(replays.get(body.request_id));
    if(body.revision!==item.revision)throw Object.assign(Error('conflict'),{status:409,code:'inbox_conflict'});
    if(action==='analyze'){
      if(body.correction){item.proposal.summary='Предложения уточнены по вашему комментарию: '+body.correction;item.proposal.questions=[];}
      item.status='ready';
    }else{
      if(body.proposal)item.proposal.changes=copy(body.proposal.changes);
      item.status=action==='apply'?'applied':'deferred';
      if(action==='apply')item.applied_at=new Date().toISOString();
    }
    item.revision++;item.updated_at=new Date().toISOString();
    const result={item:copy(item)};if(body.request_id)replays.set(body.request_id,copy(result));return result;
  };
  // One second of locally generated silence: the audio control never reaches production storage.
  const wav=new ArrayBuffer(8044),data=new DataView(wav),write=(offset,string)=>{for(let i=0;i<string.length;i++)data.setUint8(offset+i,string.charCodeAt(i));};
  write(0,'RIFF');data.setUint32(4,8036,true);write(8,'WAVE');write(12,'fmt ');data.setUint32(16,16,true);data.setUint16(20,1,true);data.setUint16(22,1,true);data.setUint32(24,8000,true);data.setUint32(28,8000,true);data.setUint16(32,1,true);data.setUint16(34,8,true);write(36,'data');data.setUint32(40,8000,true);new Uint8Array(wav,44).fill(128);
  const localAudio=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));
  const mount=window.CoSInbox.mount;window.CoSInbox.mount=(container,options)=>mount(container,{...options,audioSource:()=>localAudio});
  if(!location.hash)history.replaceState(null,'','#/inbox/'+first);
  const route=initDashboardNavigation();if(route)await applyDashboardRoute(route);else render();
});
