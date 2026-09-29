// Inbox date resolution uses the original communication time and business zone.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const implementation=import('../../supabase/functions/telegram-webhook/date-evidence.mjs');

test('configured midnight differs from legacy Moscow without changing legacy behavior',async()=>{
  const {exactDay}=await implementation;
  const ref='2026-09-29T21:30:00.000Z';
  assert.equal(exactDay('сегодня',ref).day,'2026-09-30');
  assert.equal(exactDay('сегодня',ref,{timeZone:'Europe/Berlin'}).day,'2026-09-29');
  assert.equal(exactDay('завтра',ref,{timeZone:'Europe/Berlin'}).day,'2026-09-30');
  assert.equal(exactDay('сегодня','2026-09-29T22:00:00.000Z',{timeZone:'Europe/Berlin'}).day,'2026-09-30');
});

test('date and time syntax retains configured zone through recursive resolution',async()=>{
  const {exactDay}=await implementation;
  const ref='2026-09-29T21:30:00.000Z';
  assert.equal(exactDay('завтра в 15:00',ref,{timeZone:'Europe/Berlin'}).day,'2026-09-30');
  assert.equal(exactDay('завтра в 15:00',ref).day,'2026-10-01');
  assert.equal(exactDay('15:00',ref,{timeZone:'Europe/Berlin'}).day,null);
});

test('next-week recursion uses local calendar week at the Sunday boundary',async()=>{
  const {exactDay}=await implementation;
  const ref='2026-09-27T21:30:00.000Z'; // Sunday in Berlin, Monday in Moscow.
  for(const quote of ['на следующей неделе в пятницу','в пятницу следующей недели','в пятницу следующей недели в 15:00']){
    assert.equal(exactDay(quote,ref,{timeZone:'Europe/Berlin'}).day,'2026-10-02',quote);
    assert.equal(exactDay(quote,ref).day,'2026-10-09',quote);
  }
});

test('yearless dates use the source local year and never roll past dates forward',async()=>{
  const {exactDay}=await implementation;
  const ref='2026-12-31T22:30:00.000Z';
  assert.equal(exactDay('31 декабря',ref,{timeZone:'Europe/Berlin'}).day,'2026-12-31');
  assert.equal(exactDay('1 января',ref,{timeZone:'Europe/Berlin'}).day,null);
  assert.equal(exactDay('1 января',ref).day,'2027-01-01');
});

test('calendar offsets stay date-based across daylight-saving transitions',async()=>{
  const {exactDay}=await implementation;
  for(const [ref,expected] of [['2026-03-28T23:30:00.000Z','2026-03-30'],['2026-10-24T22:30:00.000Z','2026-10-26']]){
    assert.equal(exactDay('завтра',ref,{timeZone:'Europe/Berlin'}).day,expected);
  }
});

test('reprocessing forwarded material keeps the original reference date',async()=>{
  const {exactDay}=await implementation;
  const sourceTime='2026-09-24T08:00:00.000Z';
  const receivedTime='2026-09-29T08:00:00.000Z';
  const options={timeZone:'Europe/Berlin'};
  assert.equal(exactDay('завтра',sourceTime,options).day,'2026-09-25');
  assert.notEqual(exactDay('завтра',sourceTime,options).day,exactDay('завтра',receivedTime,options).day);
  assert.equal(exactDay('вчера',sourceTime,options).day,'2026-09-23');
  assert.throws(()=>exactDay('завтра',sourceTime,{timeZone:'Invalid/Zone'}),RangeError);
});
