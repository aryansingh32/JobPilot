import { describe, expect, it } from 'vitest';
import { compileRecordingDetailed } from '../../packages/shared/workflows/compile-recording.js';

const sel = (s: string, tag = 'button', text?: string) => ({ selectors: [s], tag, text, label: text });

describe('compileRecording on portal-style recordings', () => {
  it('arms the alert handler before the click that raises it', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'navigate', url: 'https://portal.gov.in/', value: 'https://portal.gov.in/' },
      { action: 'click', target: sel('#btnSubmit', 'button', 'Submit') },
      { action: 'dialog', value: 'Saved successfully' },
    ]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'acceptDialog', 'click']);
  });

  it('turns Enter into pressKey after the typed value, and a download click into a download step', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'navigate', url: 'https://portal.gov.in/' },
      { action: 'fill', target: { selectors: ['#txtAppNo'], tag: 'input', label: 'Application No' }, value: 'AB123' },
      { action: 'press', target: { selectors: ['#txtAppNo'], tag: 'input', label: 'Application No' }, value: 'Enter' },
      { action: 'click', target: sel('#lnkPdf', 'a', 'Download receipt') },
      { action: 'download', value: 'receipt.pdf' },
    ]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'pressKey', 'download']);
  });

  it('follows a popup window and returns to the first one', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'navigate', url: 'https://portal.gov.in/' },
      { action: 'click', target: sel('#open', 'a', 'Open form') },
      { action: 'click', target: sel('#ok', 'button', 'Continue'), tab: 1 },
      { action: 'click', target: sel('#home', 'a', 'Home') },
    ]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'click', 'wait', 'switchTab', 'click', 'wait', 'switchTab', 'click']);
    expect(steps[3].value).toBe('1');
    expect(steps[6].value).toBe('0');
  });

  it('wraps iframe events in an iframe step that matches the frame by URL', () => {
    const { steps } = compileRecordingDetailed([
      { action: 'navigate', url: 'https://portal.gov.in/' },
      { action: 'click', target: sel('#a', 'button', 'Start'), frameUrl: 'https://forms.gov.in/app?x=1' },
      { action: 'click', target: sel('#b', 'button', 'Next'), frameUrl: 'https://forms.gov.in/app?x=1' },
    ]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'iframe']);
    expect(steps[1].trueSteps).toHaveLength(2);
    expect(new RegExp(steps[1].value!).test('https://forms.gov.in/app?x=1')).toBe(true);
  });
});
