(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.CoSGmail=factory()})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errors={gmail_request_failed:'Не удалось подключиться к Gmail. Нажмите «Подключить Gmail» ещё раз. Если ошибка повторится, сообщите об этом — её этап записан в журнале сервера.',gmail_temporarily_unavailable:'Сервер временно недоступен. Повторите подключение через минуту.',invalid_client:'Google отклонил настройки приложения. Нужно проверить OAuth-клиент на сервере.',unauthorized_client:'Google не разрешил этому приложению подключение. Нужно проверить настройки OAuth.',refresh_token_missing:'Google не выдал разрешение для фонового импорта. Подключите Gmail повторно.',oauth_failed:'Google не завершил вход. Начните подключение заново.',invalid_grant:'Google больше не принимает разрешение. Переподключите Gmail.',accessNotConfigured:'Нужно включить Gmail API в проекте Chief of Staff в Google Cloud.',missing_required_scopes:'Не предоставлен доступ к чтению Gmail. Подключитесь повторно и разрешите чтение.',insufficientPermissions:'Google не предоставил право читать письма. Переподключите Gmail.',scope_required:'Выберите хотя бы один ярлык или укажите рабочий адрес.',invalid_settings:'Проверьте адреса: нужны полные email, без имён и доменов отдельно.',unauthorized:'Сессия истекла. Войдите через Google.',import_paused:'Импорт на паузе. Сначала сохраните правила и включите импорт.',connection_busy:'Предыдущая операция ещё выполняется. Обновите статус через минуту.',denied:'Вы не предоставили доступ к Gmail.',invalid_state:'Подключение устарело. Начните его заново.',wrong_account:'Выберите Google-аккаунт владельца приложения.',analysis_consent_required:'Чтобы разобрать письма, разрешите анализ в настройках Gmail.',thread_import_failed:'Не удалось загрузить переписку. Повторим при следующей синхронизации.'};
  function errorText(code){return errors[code]||'Не удалось выполнить действие. Обновите статус и повторите.'}
  async function request(action,body){const response=await fetch('/api/gmail/'+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(110000)});let result;try{result=await response.json()}catch{throw Error('Сервер Gmail недоступен. Попробуйте обновить страницу.')}if(!response.ok||result.ok===false)throw Error(errorText(result.error||result.reason));return result;}
  function render(data,labels=[]){
    const c=data.connection,s=data.settings||{},connected=c?.status==='connected';
    const signIn=!data.authenticated||!connected?`<form action="/api/gmail/start" method="post"><button class="gm-button gm-primary" type="submit">${c?'Переподключить Gmail':'Подключить Gmail'}</button></form>`:'';
    if(!data.authenticated)return `<div class="gm-intro"><p>Выберите рабочие письма, и договорённости появятся во «Входящих» для проверки.</p><p>Google запросит доступ к чтению почты. После входа вы выберете ярлыки или адреса — до этого импорт выключен.</p>${signIn}</div>`;
    const available=[...labels];for(const id of s.label_ids||[])if(!available.some(l=>l.id===id))available.push({id,name:id});
    const list=(data.threads||[]).filter(t=>t.inbox_id).slice(0,12);
    return `<div class="gm-status"><strong>${escape(connected?s.enabled?'Импорт включён':'Импорт на паузе':c?'Нужно подключить снова':'Gmail не подключён')}</strong>${c?`<span>${escape(c.email)}</span>`:''}</div>${c?.last_error?`<p class="gm-error">${escape(errorText(c.last_error))}</p>`:''}${signIn}
      ${connected?`<form data-gm-settings><fieldset><legend>Какие переписки читаем</legend><p>Переписка подходит, если в ней есть выбранный ярлык <b>или</b> один из указанных адресов. Ответы из «Отправленных» тоже учитываются.</p><label class="gm-label">Ярлыки Gmail<select multiple size="5" name="labels" aria-label="Ярлыки Gmail">${available.map(l=>`<option value="${escape(l.id)}"${s.label_ids?.includes(l.id)?' selected':''}>${escape(l.name)}</option>`).join('')}</select></label><button type="button" class="gm-button" data-gm="labels">Загрузить ярлыки</button><label class="gm-label">Рабочие адреса<textarea name="emails" rows="3" placeholder="anton@company.ru&#10;supplier@example.com">${escape((s.emails||[]).join('\n'))}</textarea></label><p class="gm-small">Один адрес на строку. Google выдаёт доступ ко всей почте; выбранные ограничения применяет Chief of Staff.</p></fieldset>
      <fieldset><legend>Глубина чтения</legend><dl class="gm-depth"><dt>Поиск активных переписок</dt><dd>Последние 30 дней</dd><dt>Первый разбор</dt><dd>10 последних писем, до 90 дней назад</dd><dt>Если не хватает истории</dt><dd>Добавить по 10 писем, максимум 50. До 180 дней — отдельно для выбранной цепочки.</dd><dt>Вложения</dt><dd>Только названия, содержимое не читаем</dd></dl><p class="gm-small">Пилот — до 50 переписок. Импортированные тексты сохраняются в личных заметках. Исходная почта остаётся без изменений.</p></fieldset>
      <label class="gm-check"><input type="checkbox" name="ai"${s.ai_consent?' checked':''}><span>Разбирать выбранные письма с ИИ и предлагать изменения задач.<small>Текст выбранных писем и контекст задач передаются через OpenRouter модели Claude. Вложения не передаются.</small></span></label>
      <label class="gm-check"><input type="checkbox" name="enabled"${s.enabled?' checked':''}><span>Включить импорт каждые 5 минут</span></label><div class="gm-actions"><button type="submit" class="gm-button gm-primary">Сохранить правила</button><button type="button" class="gm-button" data-gm="sync">Синхронизировать сейчас</button><button type="button" class="gm-button" data-gm="disconnect">Отключить Gmail</button></div></form>`:''}
      ${data.pilot_full?'<p class="gm-notice">Достигнут предел пилота: 50 переписок. Новые цепочки пока не добавляются.</p>':''}
      ${c?.last_sync_at?`<p class="gm-small">Последняя проверка: ${escape(new Date(c.last_sync_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}))} · Москва</p>`:''}
      ${list.length?`<section class="gm-threads"><h3>Переписки во «Входящих»</h3>${list.map(t=>`<a href="/#/inbox/${escape(t.inbox_id)}" data-gm-open><span>${escape(t.subject||'Без темы')}</span><small>${t.last_error?'Ошибка загрузки':t.pending?'Есть новые письма':'Импортировано'}</small></a>`).join('')}</section>`:''}`;
  }
  function open(callback){
    if(document.getElementById('gmailSettingsDialog'))return;
    const dialog=document.createElement('dialog');dialog.id='gmailSettingsDialog';dialog.className='gm-dialog';dialog.setAttribute('aria-labelledby','gmailSettingsTitle');
    dialog.innerHTML='<header><div><small>ИСТОЧНИКИ</small><h2 id="gmailSettingsTitle">Рабочая почта</h2></div><button class="gm-button" type="button" data-gm-close>Закрыть</button></header><div class="gm-body"><p data-gm-notice role="status" aria-live="polite"></p><div data-gm-content>Проверяю подключение…</div></div>';
    document.body.appendChild(dialog);dialog.showModal();let busy=false,labels=[],data,dirty=false;
    const content=dialog.querySelector('[data-gm-content]'),notice=dialog.querySelector('[data-gm-notice]');
    const say=(message,error=false)=>{notice.textContent=message;notice.className=error?'gm-error':'gm-notice'};
    const refresh=async()=>{data=await request('status');content.innerHTML=render(data,labels);dirty=false;};
    const run=async fn=>{if(busy)return;busy=true;dialog.setAttribute('aria-busy','true');try{await fn()}catch(e){say(e.message,true)}finally{busy=false;dialog.removeAttribute('aria-busy')}};
    const formSettings=()=>{const f=content.querySelector('[data-gm-settings]');return {label_ids:[...f.elements.labels.selectedOptions].map(o=>o.value),emails:f.elements.emails.value.split(/[\s,;]+/).filter(Boolean),ai_consent:f.elements.ai.checked,enabled:f.elements.enabled.checked}};
    dialog.addEventListener('input',()=>{dirty=true});
    dialog.addEventListener('submit',e=>{if(!e.target.matches('[data-gm-settings]'))return;e.preventDefault();run(async()=>{await request('settings',formSettings());await refresh();say(data.settings.enabled?'Правила сохранены. Импорт начнётся при ближайшей проверке.':'Правила сохранены. Импорт на паузе.')})});
    dialog.addEventListener('click',e=>{
      if(e.target.closest('[data-gm-close]')){if(!dirty||confirm('Закрыть без сохранения правил?'))dialog.close();return;}
      if(e.target.closest('[data-gm-open]')){dialog.close();return;}
      const action=e.target.closest('[data-gm]')?.dataset.gm;if(!action)return;
      run(async()=>{
        if(action==='labels'){const draft=formSettings();labels=(await request('labels',{})).labels;content.innerHTML=render({...data,settings:draft},labels);say('Ярлыки загружены. Выберите рабочие.');return;}
        if(dirty){say('Сначала сохраните изменённые правила.',true);return;}
        if(action==='disconnect'){await request('disconnect',{});await refresh();say('Gmail отключён. Импортированные заметки сохранены.');return;}
        if(action==='sync'){say('Проверяю выбранные переписки…');const result=await request('sync',{});await refresh();say(result.waiting?'Новые письма ждут: сначала завершите текущий разбор этой цепочки.':result.imported?'Переписка добавлена во «Входящие».':'Проверка выполнена. Очередь продолжит обрабатываться автоматически.');}
      });
    });
    dialog.addEventListener('cancel',e=>{if(dirty&&!confirm('Закрыть без сохранения правил?'))e.preventDefault()});
    dialog.addEventListener('close',()=>dialog.remove());
    run(async()=>{await refresh();if(callback)say(callback.kind==='connected'?'Gmail подключён. Выберите рабочие ярлыки или адреса.':errorText(callback.reason),callback.kind!=='connected')});
  }
  function init(){
    document.getElementById('gmailSettings')?.addEventListener('click',()=>open());
    const url=new URL(location.href),kind=url.searchParams.get('gmail');if(!['connected','error'].includes(kind))return;
    const callback={kind,reason:url.searchParams.get('reason')};url.searchParams.delete('gmail');url.searchParams.delete('reason');history.replaceState(history.state,'',url.pathname+url.search+url.hash);open(callback);
  }
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();}
  return {render,errorText,open,request};
});
