import { expect, it, vi } from 'vitest';
vi.mock('../../packages/shared/llm/gateway.js',()=>({completeJSON:()=>{throw new Error('No LLM call is needed for compilation');}}));
import { generalizeSteps } from '../../packages/execution-service/llm-generalizer.js';
it('returns executable deterministic steps without losing recorded values',async()=>{
 const steps=await generalizeSteps([{action:'fill',target:{selectors:['#title']},value:'My task',timestamp:1}]);
 expect(steps[0]).toMatchObject({id:'s1',action:'fill',target:{value:'#title',type:'css'},value:'My task'});
});
