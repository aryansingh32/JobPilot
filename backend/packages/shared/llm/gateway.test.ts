import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn(),query:vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[]})),incr:vi.fn(),cost:vi.fn()}));
vi.mock('./index.js',()=>({isDummyLLMKey:()=>false,getProviderFallbackModel:()=> 'test',getLLMProviders:()=>[{name:'test',client:{chat:{completions:{create:mocks.create}}}}]}));
vi.mock('../config/settings.js',()=>({getBool:async()=>false,getNumber:async()=>0,getString:async()=> 'test',getSetting:async()=>({test:{input:1,output:2}})}));
vi.mock('../db/index.js',()=>({getPgPool:()=>({query:mocks.query}),getRedisClient:async()=>({get:async()=>null,multi:()=>{const m:any={incrBy:(...a:any[])=>{mocks.incr(...a);return m;},incrByFloat:(...a:any[])=>{mocks.cost(...a);return m;},expire:()=>m,exec:async()=>[]};return m;}})}));
import { complete } from './gateway.js';
beforeEach(()=>vi.clearAllMocks());
it('records billable empty output and updates budgets even when the call fails',async()=>{
 mocks.create.mockResolvedValue({model:'test',choices:[{message:{content:''}}],usage:{prompt_tokens:100,completion_tokens:50}});
 await expect(complete({purpose:'planner',messages:[],maxTokens:100,userId:'u'})).rejects.toThrow('Empty reply');
 expect(mocks.query).toHaveBeenCalledTimes(1);
 expect(mocks.query.mock.calls[0][1]).toEqual(expect.arrayContaining([100,50,0.0002,false,'Empty provider reply']));
 expect(mocks.incr).toHaveBeenCalledWith(expect.any(String),150);
 expect(mocks.cost).toHaveBeenCalledWith(expect.any(String),0.0002);
 expect(mocks.create.mock.calls[0][1].maxRetries).toBe(0);
});
it('uses explicit provider-reported cost',async()=>{
 mocks.create.mockResolvedValue({model:'test',choices:[{message:{content:'ok'}}],usage:{prompt_tokens:100,completion_tokens:50,cost:0.007}});
 expect((await complete({purpose:'planner',messages:[],maxTokens:100})).costUsd).toBe(0.007);
});
it('rejects unbounded output settings before contacting a provider',async()=>{
 await expect(complete({purpose:'planner',messages:[],maxTokens:Infinity})).rejects.toThrow();
 expect(mocks.create).not.toHaveBeenCalled();
});
