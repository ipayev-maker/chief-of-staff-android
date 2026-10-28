-- Native login uses the same Google-owner session and still requires the PIN.
alter table public.cos_calendar_oauth_states drop constraint cos_calendar_oauth_states_return_to_check;
alter table public.cos_calendar_oauth_states add constraint cos_calendar_oauth_states_return_to_check check (
  return_to is null
  or (return_to='/android' and return_challenge is not null)
  or (char_length(return_to) in (8,45) and return_to ~ '^/#/inbox(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$')
);

-- Service-only, idempotent capture: retries refer to the same immutable audio.
create function public.cos_inbox_capture_android(p_id uuid,p_audio_hash text,p_bytes integer,p_seconds integer,p_recorded_at timestamptz)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare item public.cos_communication_inbox%rowtype; note_id uuid;
begin
  perform public.cos_inbox_require_service();
  if p_id is null or p_audio_hash is null or p_audio_hash !~ '^[a-f0-9]{64}$'
    or p_bytes is null or p_bytes not between 32 and 3145728
    or p_seconds is null or p_seconds not between 1 and 600 or p_recorded_at is null
    or p_recorded_at>clock_timestamp()+interval '5 minutes' then
    raise exception using errcode='PT400',message='invalid_mobile_audio';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('android_capture:'||p_id::text,0));
  select * into item from public.cos_communication_inbox where id=p_id;
  if found then
    if item.source_meta->>'channel' is distinct from 'android' or item.source_meta->>'audio_hash' is distinct from p_audio_hash
      or (item.source_meta->>'audio_size_bytes')::integer is distinct from p_bytes
      or (item.source_meta->>'audio_duration_seconds')::integer is distinct from p_seconds
      or (item.source_meta->>'message_date')::timestamptz is distinct from p_recorded_at then
      raise exception using errcode='PT409',message='mobile_capture_conflict';
    end if;
    perform 1 from public.quick_notes where id=item.note_id and archived_at is null and deleted_at is null;
    if not found then raise exception using errcode='PT410',message='source_archived_or_deleted';end if;
    return jsonb_build_object('item',to_jsonb(item),'duplicate',true);
  end if;
  insert into public.quick_notes(title,plain_text,source) values ('','[Голосовое сообщение]','web') returning id into note_id;
  insert into public.cos_communication_inbox(id,note_id,source_text,source_meta)
    values(p_id,note_id,'[Голосовое сообщение]',jsonb_build_object('channel','android','type','voice','auto_create',false,
      'message_date',p_recorded_at,'audio_hash',p_audio_hash,'audio_path','android/'||p_id::text||'/voice.m4a',
      'audio_bucket','cos-communication-audio','audio_mime_type','audio/mp4','audio_size_bytes',p_bytes,'audio_duration_seconds',p_seconds))
    returning * into item;
  return jsonb_build_object('item',to_jsonb(item),'duplicate',false);
end;
$$;
revoke all on function public.cos_inbox_capture_android(uuid,text,integer,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.cos_inbox_capture_android(uuid,text,integer,integer,timestamptz) to service_role;
