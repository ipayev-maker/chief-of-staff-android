const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES=new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf','audio/mpeg','audio/mp4','audio/wav','audio/ogg','video/mp4','video/webm','video/quicktime']);
const fail=(status,code)=>{throw Object.assign(Error(code),{status,code,mediaError:true})};
const eq=(k,v)=>k+'=eq.'+encodeURIComponent(v);
export function createNoteMedia({store,url,serviceKey,fetchImpl=fetch,uuid=()=>crypto.randomUUID()}){
 const base=new URL(url);if(base.protocol!=='https:'||base.username||base.password)throw Error('invalid_storage_config');
 async function sign(bucket,path,upload=false){
  if(!['cos-note-media','project-media'].includes(bucket)||!path||path.split('/').some(p=>p==='..'||p==='.'))fail(400,'invalid_media');
  const encoded=bucket+'/'+path.split('/').map(encodeURIComponent).join('/');
  const response=await fetchImpl(new URL('/storage/v1/object/'+(upload?'upload/sign/':'sign/')+encoded,base),{method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},body:JSON.stringify(upload?{}:{expiresIn:3600}),redirect:'error',signal:AbortSignal.timeout(12000)});
  if(!response.ok)fail(503,'media_storage_unavailable');const result=await response.json();
  const relative=result.url||result.signedURL||result.signedUrl;if(typeof relative!=='string'||!relative.startsWith('/object/'))fail(503,'media_storage_unavailable');
  return new URL('/storage/v1'+relative,base).href;
 }
 async function note(id,write=false){if(!UUID.test(id))fail(400,'invalid_media');const rows=await store.page('quick_notes',eq('id',id)+'&deleted_at=is.null&limit=1');if(!rows[0])fail(404,'note_not_found');if(write&&rows[0].archived_at)fail(409,'note_archived');return rows[0];}
 return {
  async list(id){await note(id);const rows=await store.page('cos_note_assets',eq('note_id',id)+'&pending=eq.false&deleted_at=is.null&order=created_at.asc&limit=100');return {assets:await Promise.all(rows.map(async row=>({...row,url:await sign(row.storage_bucket,row.storage_path)})))};},
  async prepare(id,data){await note(id,true);if(!data||Object.keys(data).some(k=>!['name','mime_type','size_bytes'].includes(k))||typeof data.name!=='string'||!data.name.trim()||data.name.length>255||!TYPES.has(data.mime_type)||!Number.isSafeInteger(data.size_bytes)||data.size_bytes<1||data.size_bytes>50*1024*1024)fail(400,'invalid_media');
   const assetId=uuid(),path=id+'/'+assetId;const upload_url=await sign('cos-note-media',path,true);
   const asset=await store.insert('cos_note_assets',{id:assetId,note_id:id,storage_bucket:'cos-note-media',storage_path:path,original_name:data.name,mime_type:data.mime_type,size_bytes:data.size_bytes,pending:true});return {asset,upload_url};},
  async complete(id,data){await note(id,true);if(!data||Object.keys(data).length!==1||!UUID.test(data.asset_id||''))fail(400,'invalid_media');await store.rpc('cos_note_media_complete',{p_note:id,p_asset:data.asset_id});return this.list(id);},
  async remove(id,data){await note(id,true);if(!data||Object.keys(data).length!==1||!UUID.test(data.asset_id||''))fail(400,'invalid_media');await store.patch('cos_note_assets',eq('note_id',id)+'&'+eq('id',data.asset_id),{deleted_at:new Date().toISOString()});return {ok:true};}
 };
}
