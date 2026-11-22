export interface OperatingInputs {
  infrastructureUsd: number | null;
  proxiesUsd: number | null;
  paymentFeesUsd: number | null;
  refundsUsd: number | null;
  indirectTaxesUsd: number | null;
  supportAndOtherUsd: number | null;
  inrPerUsd: number | null;
}
/** Cash contribution, not accrual profit: sold credits may still be unconsumed. */
export function calculateEconomics(revenue: { USD: number; INR: number }, llmUsd: number, captchaUsd: number, inputs: OperatingInputs, unpricedCalls = 0) {
  const keys = ['infrastructureUsd','proxiesUsd','paymentFeesUsd','refundsUsd','indirectTaxesUsd','supportAndOtherUsd'] as const;
  const missing = keys.filter(k => inputs[k] === null || !Number.isFinite(inputs[k]) || inputs[k]! < 0) as string[];
  const fxOk = inputs.inrPerUsd !== null && Number.isFinite(inputs.inrPerUsd) && inputs.inrPerUsd > 0;
  if (revenue.INR && !fxOk) missing.push('inrPerUsd');
  if (unpricedCalls) missing.push('prices for all billed models');
  const receiptsUsd = revenue.INR && !fxOk ? null : revenue.USD + (revenue.INR ? revenue.INR / inputs.inrPerUsd! : 0);
  const knownRecordedVendorCostUsd = llmUsd + captchaUsd;
  const costUsd = missing.length ? null : knownRecordedVendorCostUsd + keys.reduce((sum, k) => sum + inputs[k]!, 0);
  const cashSurplusUsd = receiptsUsd !== null && costUsd !== null ? receiptsUsd - costUsd : null;
  return { missing, receiptsUsd, knownRecordedVendorCostUsd, costUsd, cashSurplusUsd, marginPercent: cashSurplusUsd !== null && receiptsUsd! > 0 ? cashSurplusUsd / receiptsUsd! * 100 : null };
}
