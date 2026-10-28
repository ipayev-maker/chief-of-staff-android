const {test}=require('node:test');
const assert=require('node:assert/strict');
const modulePromise=Promise.all([
 import('../../supabase/functions/cos-notes/communication-entities.mjs'),
 import('../../supabase/functions/cos-notes/communication-intent.mjs')
]);
const P1='11111111-1111-4111-8111-111111111111',P2='22222222-2222-4222-8222-222222222222';
const PERSON='33333333-3333-4333-8333-333333333333';
const partial={allowPartial:true};

test('explicit inflected project names bind, including recovery when model omitted the ID',async()=>{
 const [{projectFor}]=await modulePromise;
 const context={projects:[{id:P1,title:'Интершарм',status:'active'}]};
 for(const project_id of [P1,null,P2])assert.equal(projectFor({project_id},context,'Сегодня в 12 встреча с Антоном по Интершарму'),P1);
 assert.equal(projectFor({}, {projects:[{id:P1,title:'Новая линия'}]},'Обсудить монтаж по Новой линии'),P1);
});

test('projects require complete names and never fuzzy-match or use an ungrounded ID',async()=>{
 const [{projectFor}]=await modulePromise;
 const context={projects:[{id:P1,title:'Интершарм'}]};
 for(const evidence of ['Встреча с Антоном','Монтаж Интершармаплюс','Подготовить для Интершармк'])assert.equal(projectFor({project_id:P1},context,evidence),null);
 assert.equal(projectFor({project_id:P1},{projects:[{id:P1,title:'Интершарм выставка'}]},'Встреча по Интершарму'),null);
 assert.equal(projectFor({project_id:P1},{projects:[{id:P1,title:'Интершарм',status:'archived'}]},'Встреча по Интершарму'),null);
});

test('project ambiguity is not resolved by an invented model choice',async()=>{
 const [{projectFor}]=await modulePromise;
 assert.equal(projectFor({project_id:P1},{projects:[{id:P1,title:'Интершарм'},{id:P2,title:'Интершарм'}]},'Встреча по Интершарму'),null);
 assert.equal(projectFor({project_id:P1},{projects:[{id:P1,title:'Мила'},{id:P2,title:'Мила новая'}]},'Встреча по Мила новая'),null);
 const context={projects:[{id:P1,title:'Интершарм'},{id:P2,title:'Мила'}]};
 assert.equal(projectFor({},context,'Сравнить Интершарм и Милу'),null);
 assert.equal(projectFor({project_id:P1},context,'Сравнить Интершарм и Милу'),P1);
});

test('unique first name and surname in Russian cases bind to existing full participant',async()=>{
 const [,{participantFor}]=await modulePromise;
 const context={participants:[{id:PERSON,name:'Антон Иванов'}]};
 for(const participant_mention of ['Антоном','Ивановым','Антоном Ивановым'])assert.deepEqual(participantFor({participant_mention},context,'Встреча с '+participant_mention,partial),{id:PERSON,suggestion:null});
 assert.equal(participantFor({participant_mention:'Вяловой'},{participants:[{id:PERSON,name:'Ольга Вяловая'}]},'Встреча с Вяловой',partial).id,PERSON);
 assert.equal(participantFor({participant_mention:'Акимовым'},{participants:[{id:PERSON,name:'Акимов Андрей'}]},'Встреча с Акимовым',partial).id,PERSON);
});

test('partial name cannot disambiguate several people even with a model UUID',async()=>{
 const [,{participantFor}]=await modulePromise;
 const context={participants:[{id:PERSON,name:'Антон Иванов'},{id:P1,name:'Антон Петров'}]};
 const result=participantFor({participant_id:PERSON,participant_mention:'Антоном'},context,'Встреча с Антоном',partial);
 assert.equal(result.id,null);assert.deepEqual(result.suggestion.existing_ids,[PERSON,P1]);
 assert.equal(participantFor({participant_id:PERSON,participant_mention:'Антоном Ивановым'},context,'Встреча с Антоном Ивановым',partial).id,PERSON);
 assert.equal(participantFor({participant_id:PERSON},context,'Встреча с Антоном',partial).id,null);
});

test('unquoted and fabricated participant names are rejected; omitted mention can use literal evidence',async()=>{
 const [,{participantFor}]=await modulePromise;
 const context={participants:[{id:PERSON,name:'Антон Иванов'}]};
 assert.deepEqual(participantFor({participant_id:PERSON,participant_mention:'Антоном'},context,'Встреча завтра',partial),{id:null,suggestion:null});
 assert.equal(participantFor({participant_id:PERSON},context,'Встреча с Антоном',partial).id,PERSON);
 assert.equal(participantFor({participant_mention:'Анна'},{participants:[{id:PERSON,name:'Аннализа Петрова'}]},'Анна пришлёт чертёж',partial).id,null);
 assert.deepEqual(participantFor({participant_name:'Николай',participant_mention:'Николаем'},{participants:[]},'Встреча с Николаем',partial),{id:null,suggestion:{name:'Николай',mention:'Николаем',existing_ids:[]}});
});

test('default participant matching keeps legacy behavior for mail callers',async()=>{
 const [,{participantFor}]=await modulePromise;
 const result=participantFor({participant_mention:'Антоном'}, {participants:[{id:PERSON,name:'Антон Иванов'}]},'Встреча с Антоном');
 assert.equal(result.id,null);assert.deepEqual(result.suggestion.existing_ids,[PERSON]);
});
