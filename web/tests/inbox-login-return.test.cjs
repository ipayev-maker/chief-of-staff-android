const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const navigation=require('../navigation.js');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const source=html.match(/function initCalendarSettings\(\)\{[\s\S]*?\n\}/)[0];
const ID='300971f1-6acd-4547-a8b6-0e52790acbf5';
function callback(url){
  const calls={dialogs:[],toasts:[],urls:[]},trigger={};
  vm.runInNewContext('('+source+')()',{
    URL,location:new URL(url),window:{CoSNavigation:navigation},
    history:{state:{existing:true},replaceState:(state,unused,url)=>calls.urls.push(url)},
    $:()=>trigger,openCalendarSettings:value=>calls.dialogs.push(value),toast:value=>calls.toasts.push(value)
  });
  return calls;
}
test('successful card sign-in preserves deep link and leaves the card visible',()=>{
  const calls=callback('https://example.test/?calendar=connected#/inbox/'+ID);
  assert.deepEqual(calls.urls,['/#/inbox/'+ID]);
  assert.equal(calls.dialogs.length,0);
  assert.equal(calls.toasts.length,1);
});
test('ordinary calendar callback still opens settings and reports errors',()=>{
  const success=callback('https://example.test/?calendar=connected');
  assert.equal(success.dialogs[0].kind,'connected');
  const failure=callback('https://example.test/?calendar=error&reason=wrong_account#/inbox/'+ID);
  assert.deepEqual(failure.urls,['/#/inbox/'+ID]);
  assert.equal(failure.dialogs[0].reason,'wrong_account');
});
