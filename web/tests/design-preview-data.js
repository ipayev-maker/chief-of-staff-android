// Synthetic examples for visual checks, using the workflow preview's isolated API adapters.
const previewDay=delta=>{const d=new Date();d.setDate(d.getDate()+delta);return localDate(d)};
const previewTime=delta=>new Date(Date.now()+delta*60000).toISOString();
S.projects=[
 {id:projectId,title:'Торговое оборудование',status:'active',area_key:'work',risk_level:'yellow'},
 {id:'preview-design',title:'Новый шоурум',status:'active',area_key:'work',risk_level:'green'},
 {id:'preview-next',title:'Запуск производства',status:'active',area_key:'work',risk_level:'red'}
];
S.tasks=[
 {id:'sample-drawings',description:'Согласовать чертежи торговой стойки',project_id:projectId,status:'open',direction:'internal',planned_on:previewDay(0),deadline:previewDay(1)},
 {id:'sample-overdue',description:'Получить от поставщика подтверждение срока образца',project_id:projectId,status:'open',direction:'to_me',deadline:previewDay(-2)},
 {id:'sample-check',description:'Уточнить замечания по материалам и отделке',project_id:'preview-design',status:'open',direction:'to_me',next_check_on:previewDay(0),deadline:previewDay(2)},
 {id:'sample-quote',description:'Отправить обновлённое коммерческое предложение',project_id:'preview-design',status:'open',direction:'from_me',deadline:previewDay(3)}
];
S.meetings=[{id:'sample-meeting',title:'Обсуждение образца с производством',project_id:projectId,status:'planned',starts_at:previewTime(60),ends_at:previewTime(90)}];
S.captureDrafts=[];QN.loaded=true;
