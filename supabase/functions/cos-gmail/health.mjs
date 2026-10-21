// Read-only provider diagnostics. Never return API keys, labels or user IDs.
export async function modelHealth({key,fetchImpl=fetch}){
  if(!key)return {configured:false};
  try{
    const response=await fetchImpl('https://openrouter.ai/api/v1/key',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return {configured:true,provider_status:response.status};
    const {data}=await response.json();
    const creditResponse=await fetchImpl('https://openrouter.ai/api/v1/credits',{headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
    const creditData=creditResponse.ok?(await creditResponse.json()).data:null;
    const balance=Number.isFinite(creditData?.total_credits)&&Number.isFinite(creditData?.total_usage)?creditData.total_credits-creditData.total_usage:null;
    return {configured:true,provider_status:200,balance,credits_status:creditResponse.status,...Object.fromEntries(['limit','limit_remaining','usage','usage_daily','usage_monthly','limit_reset','is_free_tier','expires_at'].filter(k=>data&&Object.hasOwn(data,k)).map(k=>[k,data[k]]))};
  }catch{return {configured:true,provider_status:0};}
}
