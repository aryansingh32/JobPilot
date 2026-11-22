import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({query:vi.fn(),complete:vi.fn(),del:vi.fn(),set:vi.fn()}));
vi.mock('../../packages/shared/db/index.js',()=>({getPgPool:()=>({query:m.query}),cacheGet:async()=>null,cacheSet:m.set,cacheDelete:m.del,CacheKeys:{flowCache:(s:string,t:string)=>s+t}}));
vi.mock('../../packages/shared/llm/gateway.js',()=>({complete:m.complete}));
import { AIPlanner, buildSyntheticSnapshot } from '../../packages/ai-service/planner.js';
beforeEach(()=>{
 vi.clearAllMocks();
 m.query.mockImplementation(async(sql:string)=>({rows:sql.includes('starter_action_plan as "starterActionPlan"') ? [{id:'unrelated',name:'Pay tax',trigger:'pay tax',starterActionPlan:[{id:'pay',action:'payment'}]}]:[]}));
 m.complete.mockResolvedValue({text:JSON.stringify({confidence:0.8,actionPlan:[{id:'open',action:'navigate',value:'https://example.com/report'}]})});
});
it('does not match an unrelated workflow just because it has steps',async()=>{
 const result=await new AIPlanner().planTask('download report','site',buildSyntheticSnapshot('https://example.com/report'),[],false);
 expect(result.source).toBe('ai-generated');expect(m.complete).toHaveBeenCalledTimes(1);
 const reads=m.query.mock.calls.filter(([sql])=>sql.includes('FROM site_workflows'));
 expect(reads.every(([sql])=>sql.includes("status = 'published'"))).toBe(true);
});
it('does not count a newly generated plan as an execution success or cache it',async()=>{
 await new AIPlanner().planTask('download report','site',buildSyntheticSnapshot(),[],false);
 expect(m.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO cached_flows'))?.[0]).toContain('VALUES ($1, $2, $3, $4, 0)');
 expect(m.set).not.toHaveBeenCalled();expect(m.del).toHaveBeenCalled();
});
it('increments success only on execution feedback and invalidates failed cache entries',async()=>{
 await new AIPlanner().recordOutcome('site','download report',true);
 expect(m.query.mock.calls.some(([sql])=>sql.includes('success_count = success_count + 1'))).toBe(true);
 await new AIPlanner().recordOutcome('site','download report',false);
 expect(m.del).toHaveBeenCalledTimes(2);
});
