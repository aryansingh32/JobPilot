import { expect, it } from 'vitest';
import { calculateEconomics, type OperatingInputs } from './economics.js';
const inputs: OperatingInputs = {infrastructureUsd:100,proxiesUsd:10,paymentFeesUsd:5,refundsUsd:5,indirectTaxesUsd:0,supportAndOtherUsd:20,inrPerUsd:100};
it('combines currencies only with an explicit FX rate and subtracts all costs',()=>{
  expect(calculateEconomics({USD:100,INR:10000},5,5,inputs)).toMatchObject({receiptsUsd:200,costUsd:150,cashSurplusUsd:50,marginPercent:25});
});
it('never reports a profit when costs or pricing are missing',()=>{
  expect(calculateEconomics({USD:100,INR:0},0,0,{...inputs,proxiesUsd:null}).cashSurplusUsd).toBeNull();
  expect(calculateEconomics({USD:100,INR:0},0,0,inputs,1).cashSurplusUsd).toBeNull();
  expect(calculateEconomics({USD:0,INR:100},0,0,{...inputs,inrPerUsd:null}).receiptsUsd).toBeNull();
});
