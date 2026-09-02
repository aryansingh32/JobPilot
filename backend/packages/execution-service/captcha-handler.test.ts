import { test, expect } from 'vitest';
import { OpenSourceSolver } from './captcha-handler.js';
import type { Page } from 'playwright';

test('OpenSourceSolver.solveHCaptcha catches and returns errors', async () => {
  const solver = new OpenSourceSolver();

  const mockPage = {
    frameLocator: () => {
      throw new Error('Mocked frameLocator error');
    }
  } as unknown as Page;

  const result = await solver.solveHCaptcha(mockPage, 'dummy-sitekey');

  expect(result.solved).toBe(false);
  expect(result.method).toBe('open-source');
  expect(result.error).toBe('Mocked frameLocator error');
});

test('OpenSourceSolver.solveHCaptcha successfully solves', async () => {
  const solver = new OpenSourceSolver();

  let checkboxClicked = false;

  const mockLocator = {
    click: async () => { checkboxClicked = true; },
    count: async () => 1
  };

  const mockPage = {
    frameLocator: () => {
      return {
        locator: (selector: string) => {
          return mockLocator;
        }
      }
    }
  } as unknown as Page;

  const result = await solver.solveHCaptcha(mockPage, 'dummy-sitekey');

  expect(result.solved).toBe(true);
  expect(result.method).toBe('open-source');
  expect(result.error).toBeUndefined();
  expect(checkboxClicked).toBe(true);
});

test('OpenSourceSolver.solveHCaptcha challenge required', async () => {
  const solver = new OpenSourceSolver();

  const mockLocator = {
    click: async () => {},
    count: async () => 0
  };

  const mockPage = {
    frameLocator: () => {
      return {
        locator: (selector: string) => mockLocator
      }
    }
  } as unknown as Page;

  const result = await solver.solveHCaptcha(mockPage, 'dummy-sitekey');

  expect(result.solved).toBe(false);
  expect(result.method).toBe('open-source');
  expect(result.error).toBe('hCaptcha challenge required');
});
