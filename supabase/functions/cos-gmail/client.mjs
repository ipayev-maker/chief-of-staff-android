import {GoogleError} from '../cos-google-calendar/google.mjs';
import {validId} from './mail.mjs';
const BASE='https://gmail.googleapis.com/gmail/v1/users/me/';
export function createMailClient(token,{fetchImpl=fetch,deadline=Date.now()+70000}={}){
  if(typeof token!=='string'||!token||/\s/.test(token))throw Error('invalid_access_token');
  async function get(path,params={}){
    if(!/^(profile|labels|threads|history|threads\/[a-zA-Z0-9_-]+|messages\/[a-zA-Z0-9_-]+|messages\/[a-zA-Z0-9_-]+\/attachments\/[a-zA-Z0-9_-]+)$/.test(path))throw Error('invalid_gmail_path');
    const url=new URL(path,BASE);url.search=new URLSearchParams(params).toString();
    const remaining=deadline-Date.now();if(remaining<1000)throw new GoogleError(503,'gmail_network_error');
    let response;try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(Math.min(12000,remaining))})}catch{throw new GoogleError(503,'gmail_network_error')}
    const raw=await response.text();if(raw.length>12000000)throw Error('mail_too_large');
    let data;try{data=JSON.parse(raw)}catch{throw new GoogleError(502,'invalid_gmail_response')}
    if(!response.ok){const reason=data?.error?.errors?.[0]?.reason;throw new GoogleError(response.status,['accessNotConfigured','insufficientPermissions','rateLimitExceeded','userRateLimitExceeded','notFound'].includes(reason)?reason:response.status===401?'invalid_grant':'gmail_request_failed')}
    return data;
  }
  return {get,
    profile:()=>get('profile'),labels:()=>get('labels'),
    thread:id=>{if(!validId(id))throw Error('invalid_thread');return get('threads/'+id,{format:'metadata',fields:'id,historyId,messages(id,threadId,internalDate,labelIds,payload/headers)'})},
    attachment:(messageId,id)=>{if(!validId(messageId)||typeof id!=='string'||!/^[-\w]{1,1024}$/.test(id))throw Error('invalid_attachment');return get('messages/'+messageId+'/attachments/'+id)},
    message:id=>{if(!validId(id))throw Error('invalid_message');return get('messages/'+id,{format:'full'})},
  };
}
