import {serveProtected} from '../_shared/legacy-auth.ts';
// Retired prototype. Business data is available only through the owner dashboard.
serveProtected(()=>new Response(JSON.stringify({error:'legacy_endpoint_retired',app:'https://nikodim.vercel.app'}),{status:410,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
