// Deterministic Moscow dates and conservative evidence validation, Node 24.
const {test}=require('node:test');const assert=require('node:assert/strict');
const implementation=import('../../supabase/functions/telegram-webhook/date-evidence.mjs');
const ref='2026-09-24T18:00:00.000Z'; // Thursday, 21:00 Moscow.
test('Moscow calendar dates change at 21:00 UTC and use one frozen reference',async()=>{
  const {exactDay}=await implementation;
  assert.equal(exactDay('сегодня','2026-09-24T20:59:59.000Z').day,'2026-09-24');
  assert.equal(exactDay('сегодня','2026-09-24T21:00:00.000Z').day,'2026-09-25');
  assert.equal(exactDay('завтра','2026-09-24T21:00:00.000Z').day,'2026-09-26');
  assert.equal(exactDay('вчера','2026-09-24T21:00:00.000Z').day,'2026-09-24');
  assert.equal(exactDay('позавчера',ref).day,'2026-09-22');
  assert.equal(exactDay('сегодня в 15:00',ref).day,'2026-09-24'); // Earlier clock time must not become next week.
});
test('explicit past dates stay past; impossible and ambiguous yearless dates remain empty',async()=>{
  const {exactDay}=await implementation;
  for(const quote of ['2025-09-20','20.09.2025','20 сентября 2025 года'])assert.equal(exactDay(quote,ref).day,'2025-09-20',quote);
  for(const quote of ['25.09','25 сентября'])assert.equal(exactDay(quote,ref).day,'2026-09-25',quote);
  for(const quote of ['2026-02-30','30.02.2026','31 апреля 2026','20 сентября','5 января','05.01'])assert.equal(exactDay(quote,ref).day,null,quote);
  assert.equal(exactDay('5 января','2026-12-30T12:00:00Z').day,null);
  assert.equal(exactDay('5 января 2027','2026-12-30T12:00:00Z').day,'2027-01-05');
  assert.equal(exactDay('29 февраля 2028',ref).day,'2028-02-29');
});
test('weekday modifiers use calendar weeks and ordinary weekday includes today',async()=>{
  const {exactDay}=await implementation;
  for(const [quote,day] of [['в пятницу','2026-09-25'],['до пятницы','2026-09-25'],['в четверг','2026-09-24'],['в следующую пятницу','2026-10-02'],['до следующей среды','2026-09-30'],['в пятницу следующей недели','2026-10-02'],['на следующей неделе в пятницу','2026-10-02'],['в эту среду','2026-09-23'],['в прошлый понедельник','2026-09-14']])assert.equal(exactDay(quote,ref).day,day,quote);
});
test('clear day/week offsets are exact and uncertain or unknown phrases are not guessed',async()=>{
  const {exactDay}=await implementation;
  assert.equal(exactDay('через 3 дня',ref).day,'2026-09-27');
  assert.equal(exactDay('через неделю',ref).day,'2026-10-01');
  assert.equal(exactDay('через 2 недели',ref).day,'2026-10-08');
  for(const quote of ['через месяц','неделю назад','в середине октября','на следующей неделе','15:00'])assert.equal(exactDay(quote,ref).day,null,quote);
});
test('source quote validation catches omitted dates, intervals and altered negation',async()=>{
  const {dateEvidence}=await implementation;
  const evidence=(source,date,status='explicit')=>dateEvidence({source_text:source,date_text:date,date_status:status},source);
  assert.deepEqual(evidence('Не забудь отправить образец завтра','завтра'),{quote:'завтра',warning:false});
  assert.deepEqual(evidence('Запросить КП',null,'none'),{warning:false});
  assert.deepEqual(evidence('Запросить КП через 3 дня',null,'none'),{warning:true});
  assert.deepEqual(evidence('Встреча завтра не состоится','завтра'),{warning:true});
  assert.deepEqual(evidence('Отправить образец не позже пятницы','пятницы'),{warning:true});
  assert.deepEqual(evidence('Образец 25–27 сентября','27 сентября'),{warning:true});
  assert.deepEqual(dateEvidence({source_text:'Чертежи завтра',date_text:'завтра',date_status:'explicit'},'Чертежи без срока'),{warning:true});
});
