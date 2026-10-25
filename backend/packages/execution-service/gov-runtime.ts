import type { BrowserContext, Page } from 'playwright';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FormField } from './form-filler.js';
import { imageRule, type ImageRule } from './gov-forms.js';

// Browser-side helpers for recruitment portals (see gov-forms.ts for the rules).

/** The text around a field — where portals print "JPG, 20-50 KB" and "Click Generate OTP". */
export async function nearbyText(page: Page, field: FormField): Promise<string> {
  return page
    .locator(`[data-jp-field="${field.idx}"]`)
    .first()
    .evaluate((el) => {
      const clean = (n: Element | null) => n?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      // Flat markup (hints sit right after the box, before the next label/box): read just those.
      const after: string[] = [];
      for (let sib = el.nextElementSibling, k = 0; sib && k < 4; sib = sib.nextElementSibling, k++) {
        if (/^(LABEL|INPUT|SELECT|TEXTAREA|BUTTON)$/.test(sib.tagName) || sib.querySelector('input, select, textarea')) break;
        after.push(clean(sib));
      }
      if (after.join('').length > 8) return after.join(' ').slice(0, 400);
      // Grouped markup: the smallest container that holds more than the box itself.
      let node: Element | null = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node || node.querySelectorAll('input:not([type=hidden]), select, textarea').length > 2) break;
        const t = clean(node);
        if (t.length > 40) return t.slice(0, 400);
      }
      return '';
    })
    .catch(() => '');
}

/** The "Generate OTP" / "Send OTP" button beside a code box, if the portal needs it pressed first. */
export async function pressOtpButton(page: Page, field: FormField): Promise<boolean> {
  const box = page.locator(`[data-jp-field="${field.idx}"]`).first();
  const clicked = await box
    .evaluate((el) => {
      const re = /(generate|send|get|request|resend).{0,12}(otp|code)|^\s*(otp|code)\s*$/i;
      const isBtn = (n: Element) => n.matches('button, input[type=button], input[type=submit], a[role=button], a.btn');
      const text = (n: Element) => (n as HTMLElement).innerText || (n as HTMLInputElement).value || '';
      // The button right after the box (flat markup: several OTP rows in one form) …
      let sib = el.nextElementSibling;
      for (let k = 0; sib && k < 3; k++, sib = sib.nextElementSibling) {
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(sib.tagName) && !isBtn(sib)) break;
        const btn = isBtn(sib) ? sib : sib.querySelector('button, a.btn');
        if (btn && re.test(text(btn))) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      // … else a container that holds just this box (and at most one neighbour).
      let node: Element | null = el;
      for (let i = 0; i < 4 && node; i++) {
        node = node.parentElement;
        if (!node || node.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit])').length > 2) continue;
        const btn = [...node.querySelectorAll('button, input[type=button], input[type=submit], a[role=button]')].find((b) => re.test(text(b)));
        if (btn) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  if (clicked) await page.waitForTimeout(800);
  return clicked;
}

/**
 * Re-encode an image in the portal's own browser so it meets "20–50 KB, 200×230 px":
 * resize if sizes are stated, then lower JPEG quality until it fits.
 */
export async function fitImage(ctx: BrowserContext, srcPath: string, rule: ImageRule, outDir: string): Promise<string> {
  if (!rule.maxKB && !rule.minKB && !rule.width) return srcPath;
  const bytes = await readFile(srcPath);
  const mime = /\.png$/i.test(srcPath) ? 'image/png' : 'image/jpeg';
  const page = await ctx.newPage();
  try {
    const out = await page.evaluate(
      async ({ b64, mime, rule }) => {
        // esbuild's keep-names helper doesn't exist in the page.
        (globalThis as { __name?: (f: unknown) => unknown }).__name ??= (f) => f;
        const img = new Image();
        await new Promise<void>((ok, bad) => {
          img.onload = () => ok();
          img.onerror = () => bad(new Error('unreadable image'));
          img.src = `data:${mime};base64,${b64}`;
        });
        const w = rule.width ?? img.naturalWidth;
        const h = rule.height ?? img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        const toBytes = async (q: number) => {
          const blob: Blob = await new Promise((r) => c.toBlob((x) => r(x!), 'image/jpeg', q));
          return new Uint8Array(await blob.arrayBuffer());
        };
        // Highest quality that stays under the cap (binary search).
        const cap = (rule.maxKB ?? Infinity) * 1024;
        let lo = 0.05;
        let hi = 0.95;
        let best = await toBytes(hi);
        if (best.length > cap) {
          best = await toBytes(lo);
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) / 2;
            const t = await toBytes(mid);
            if (t.length <= cap) {
              best = t;
              lo = mid;
            } else hi = mid;
          }
        }
        // Under the stated minimum (a small, flat image encodes tiny): pad with JPEG comment
        // segments, which every decoder skips, rather than degrade the picture.
        const floor = Math.ceil((rule.minKB ?? 0) * 1024) + 512;
        if (best.length < floor) {
          const parts: number[][] = [];
          let need = floor - best.length;
          while (need > 0) {
            const n = Math.min(need, 65000);
            parts.push([0xff, 0xfe, ((n + 2) >> 8) & 0xff, (n + 2) & 0xff, ...new Array(n).fill(0x20)]);
            need -= n + 4;
          }
          const pad = parts.flat();
          const padded = new Uint8Array(best.length + pad.length);
          padded.set(best.subarray(0, 2), 0);
          padded.set(pad, 2);
          padded.set(best.subarray(2), 2 + pad.length);
          best = padded;
        }
        let s = '';
        for (let i = 0; i < best.length; i += 0x8000) s += String.fromCharCode(...best.subarray(i, i + 0x8000));
        return { b64: btoa(s), size: best.length };
      },
      { b64: bytes.toString('base64'), mime, rule },
    );
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `fit-${Date.now()}.jpg`);
    await writeFile(file, Buffer.from(out.b64, 'base64'));
    return file;
  } finally {
    await page.close().catch(() => {});
  }
}

export { imageRule };
