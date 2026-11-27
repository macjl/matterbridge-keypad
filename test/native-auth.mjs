import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const base='http://127.0.0.1:46204';
const plugins=['matterbridge-hybrid-poc','matterbridge-audio-poc','matterbridge-keypad'];
for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(250);}
async function request(path,method='POST',body={}){return fetch(base+path,{method,...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});}
for(const plugin of plugins) for(const method of ['GET','POST','PUT','PATCH','DELETE']) {
 const response=await request('/plugins/'+plugin+'/api/status',method,{key:'ancien-code-inutilisable'});
 assert.equal(response.status,401,plugin+' '+method);
}
for(const password of ['','wrong-password'])assert.equal((await(await request('/api/login','POST',{password})).json()).valid,false);
assert.equal((await request('/plugins/matterbridge-hybrid-poc/api/settings','POST',{homeDisarm:true})).status,401);
const password=readFileSync('/test/password','utf8');
assert.equal((await(await request('/api/login','POST',{password})).json()).valid,true);
for(const plugin of plugins){const response=await request('/plugins/'+plugin+'/api/status');assert.equal(response.status,200);const data=await response.json();assert.ifError(data.error);}
const response=await request('/plugins/matterbridge-keypad/api/settings','POST',{settings:{usbEnabled:false,devicePath:'/dev/input/alarm-keypad',exclusive:true,inputSeconds:20,maxAttempts:4,lockSeconds:30}});
assert.equal((await response.json()).settings.inputSeconds,20);
console.log('Authentification native avec mot de passe : 15 accès anonymes bloqués ; mot de passe vide/erroné refusé ; lecture et modification autorisées après connexion, sans clé de plugin.');
